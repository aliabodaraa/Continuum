"""
Subject-disjoint evaluation of ONE user's trained keystroke model.

The question this answers
------------------------
The dashboard reports, for user `ali`, TAR 91.1% / FRR 8.9%. Those are one measurement,
not two: ca-service computes them as genuine_count/total and suspicious_count/total over
`auth_decisions`, a table that contains ONLY that user's own sessions. So they describe
how often the legitimate user is bothered (usability) and say nothing about whether an
impostor gets in (security). A model that accepted everything would also score 91.1%.

This script supplies the missing half — FAR from real, unseen people — and therefore the
honest operating curve: TAR at a FIXED FAR, EER, AUC, all with bootstrap confidence
intervals, at both the deployed threshold (0.50) and the user's calibrated one.

Why the impostors come from Aalto
---------------------------------
Two other sources were rejected:
  * data/Rand_WS50.h5 has NO subject labels, so a "held-out" split there cannot be
    subject-disjoint — the same typist may sit on both sides.
  * The other app users are already baked into this model: the profile records
    negativeSource="app-users+dataset", so scoring against them is train/test
    contamination, and several of them are duplicate identities of the same human
    (identical event counts under a demo id and a hashed CA uid).
Aalto participants have never been seen by the base model or the per-user head.

Genuine windows come from the user's is_training=0 samples — real typing that was
never used to fit the head — so TAR is out-of-sample too.

Usage (inside the model-api container):
    python keystroke_user_sweep.py --user-id 1 \
        --impostors /app/data/aalto_impostors.h5 \
        --out /app/artifacts/keystroke_sweep_user1.json
"""
import argparse
import json
import os
import sqlite3
import urllib.request

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

MODEL_API = os.getenv("MODEL_API", "http://localhost:5000")
CA_DB = os.getenv("CA_DB", "/app/ca.db")

# Must match ca-service/lib/keystrokeSecurity.js — see aalto_to_windows.py.
WINDOW_SIZE, WINDOW_STRIDE = 50, 10
PAUSE_DD_SECONDS = 1.0
MIN_HUMAN_DD_SECONDS = 0.015
MIN_HUMAN_DWELL_SECONDS = 0.01
KEYCODE_SCALE = 254.0
LIVE_THRESHOLD = 0.5          # DEFAULT_CNN_THRESHOLD — what production actually uses


def clamp01(v):
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def build_steps(events):
    """events: [(keycode, type, t_ms, field)] -> 6-feature digraph rows.
    Port of buildSteps(): pair consecutive keydowns within one field, drop impossible
    timings, then drop >1s gaps without breaking the run."""
    downs, key_ups, last_down = [], {}, {}
    for kc, typ, t, field in events:
        k = f"{field}:{kc}"
        if typ == "keydown":
            last_down[k] = (kc, t, field)
            downs.append((kc, t, field))
        else:
            d = last_down.pop(k, None)
            if d is not None:
                key_ups[d] = t

    raw = []
    for i in range(len(downs) - 1):
        a, b = downs[i], downs[i + 1]
        if a[2] != b[2]:                       # digraph must stay within one field
            continue
        au, bu = key_ups.get(a), key_ups.get(b)
        if au is None or bu is None:
            continue
        dwell1 = (au - a[1]) / 1000.0
        dwell2 = (bu - b[1]) / 1000.0
        dd = (b[1] - a[1]) / 1000.0
        ud = (b[1] - au) / 1000.0
        if dwell1 < 0 or dwell2 < 0 or dd < 0:
            continue
        if (dd < MIN_HUMAN_DD_SECONDS
                or dwell1 < MIN_HUMAN_DWELL_SECONDS
                or dwell2 < MIN_HUMAN_DWELL_SECONDS):
            continue
        raw.append(([clamp01(a[0] / KEYCODE_SCALE), clamp01(b[0] / KEYCODE_SCALE),
                     dwell1, dwell2, dd, ud], dd))
    return [r for r, dd in raw if dd <= PAUSE_DD_SECONDS]


def steps_to_windows(steps):
    if len(steps) < WINDOW_SIZE:
        return []
    a = np.asarray(steps, dtype=np.float32)
    return [a[s:s + WINDOW_SIZE]
            for s in range(0, len(a) - WINDOW_SIZE + 1, WINDOW_STRIDE)]


def genuine_windows(user_id, training_flag=0):
    """Windows from this user's stored samples. training_flag=0 selects samples that
    were NOT used to fit the head, so TAR is measured out-of-sample."""
    con = sqlite3.connect(f"file:{CA_DB}?mode=ro", uri=True)
    texts = con.execute(
        "SELECT id FROM keystroke_texts WHERE user_id=? AND is_training=?",
        (user_id, training_flag)).fetchall()
    wins = []
    for (tid,) in texts:
        ev = con.execute(
            "SELECT key_code, event_type, timestamp_relative, field_name "
            "FROM keystroke_events WHERE keystroke_text_id=? ORDER BY id", (tid,)).fetchall()
        if ev:
            wins.extend(steps_to_windows(build_steps(ev)))
    con.close()
    return wins


def model_path_for(user_id):
    con = sqlite3.connect(f"file:{CA_DB}?mode=ro", uri=True)
    row = con.execute("SELECT model_json FROM user_typing_profiles WHERE user_id=?",
                      (user_id,)).fetchone()
    con.close()
    if not row:
        raise SystemExit(f"user {user_id} has no trained typing profile")
    p = json.loads(row[0])
    return p["modelPath"], p


def score(windows, user_id, model_path, batch=256):
    """Genuine-class probability per window, via the same endpoint ca-service uses."""
    out = []
    for i in range(0, len(windows), batch):
        chunk = [w.tolist() if hasattr(w, "tolist") else w for w in windows[i:i + batch]]
        body = json.dumps({"userId": str(user_id), "windows": chunk,
                           "modelPath": model_path, "threshold": LIVE_THRESHOLD}).encode()
        req = urllib.request.Request(MODEL_API + "/api/user/predict", data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as r:
            res = json.load(r)
        out.extend(float(p[1]) for p in res.get("prediction", []))
    return np.asarray(out)


# ---- metrics -------------------------------------------------------------
def roc(gen, imp):
    """FAR/FRR across all thresholds. FAR = impostor windows accepted;
    FRR = genuine windows rejected."""
    ths = np.unique(np.concatenate([gen, imp, [0.0, 1.0]]))
    far = np.array([(imp >= t).mean() for t in ths])
    frr = np.array([(gen < t).mean() for t in ths])
    return ths, far, frr


def eer_of(gen, imp):
    ths, far, frr = roc(gen, imp)
    i = int(np.argmin(np.abs(far - frr)))
    return float((far[i] + frr[i]) / 2), float(ths[i])


def auc_of(gen, imp):
    """Probability a random genuine window outranks a random impostor window
    (Mann-Whitney U / AUC), ties counted as half."""
    if not len(gen) or not len(imp):
        return float("nan")
    allv = np.concatenate([gen, imp])
    order = allv.argsort()
    ranks = np.empty(len(allv), float)
    ranks[order] = np.arange(1, len(allv) + 1)
    # average ranks for ties
    _, inv, cnt = np.unique(allv, return_inverse=True, return_counts=True)
    sums = np.zeros(len(cnt))
    np.add.at(sums, inv, ranks)
    ranks = (sums / cnt)[inv]
    rg = ranks[:len(gen)].sum()
    return float((rg - len(gen) * (len(gen) + 1) / 2) / (len(gen) * len(imp)))


def tar_at_far(gen, imp, target_far):
    """The honest ceiling: the best acceptance rate achievable while holding impostor
    acceptance at target_far. 'Maximum TAR' without a FAR constraint is always 100%."""
    t = np.quantile(imp, 1.0 - target_far)          # threshold giving that FAR
    return float((gen >= t).mean()), float(t)


def boot_ci(fn, gen, imp, n=1000, seed=7):
    """Percentile bootstrap over windows. Windows within a session are correlated, so
    this understates true uncertainty — it is a lower bound on the interval."""
    rng = np.random.default_rng(seed)
    vals = []
    for _ in range(n):
        g = gen[rng.integers(0, len(gen), len(gen))]
        i = imp[rng.integers(0, len(imp), len(imp))]
        try:
            v = fn(g, i)
            vals.append(v[0] if isinstance(v, tuple) else v)
        except Exception:
            pass
    if not vals:
        return (float("nan"), float("nan"))
    return (float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5)))


def packet_rate(p_low, k=3, n=6):
    """Window-level low-rate -> probability the 6-window packet vote fires (>=k low).
    This is how a per-window error rate becomes a per-decision one."""
    from math import comb
    return sum(comb(n, i) * p_low**i * (1 - p_low)**(n - i) for i in range(k, n + 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user-id", type=int, required=True)
    ap.add_argument("--impostors", required=True, help="h5 from aalto_to_windows.py")
    ap.add_argument("--out", default=None)
    ap.add_argument("--max-impostor-windows", type=int, default=4000)
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    model_path, profile = model_path_for(args.user_id)
    print(f"user {args.user_id}: model={model_path}")
    print(f"  trained on {profile.get('sampleCount')} samples, "
          f"{profile.get('positiveWindowCount')} pos / {profile.get('negativeWindowCount')} neg windows")
    print(f"  calibrated threshold={profile.get('threshold')} ({profile.get('thresholdSource')}), "
          f"live threshold={LIVE_THRESHOLD}")

    gen_w = genuine_windows(args.user_id, training_flag=0)
    print(f"genuine (held-out, is_training=0): {len(gen_w)} windows")
    if len(gen_w) < 30:
        print("  WARNING: few held-out genuine windows; TAR estimate will be noisy")

    with h5py.File(args.impostors, "r") as f:
        imp_all = np.asarray(f["windows"])
        parts = np.asarray(f["participant"])
    if len(imp_all) > args.max_impostor_windows:
        rng = np.random.default_rng(11)
        sel = rng.choice(len(imp_all), args.max_impostor_windows, replace=False)
        imp_all, parts = imp_all[sel], parts[sel]
    print(f"impostors: {len(imp_all)} windows from {len(np.unique(parts))} unseen participants")

    gen = score(gen_w, args.user_id, model_path)
    imp = score(list(imp_all), args.user_id, model_path)
    print(f"scored: genuine={len(gen)} mean={gen.mean():.3f} | impostor={len(imp)} mean={imp.mean():.3f}")

    eer, eer_t = eer_of(gen, imp)
    auc = auc_of(gen, imp)
    far_live = float((imp >= LIVE_THRESHOLD).mean())
    frr_live = float((gen < LIVE_THRESHOLD).mean())

    res = {
        "userId": args.user_id, "modelPath": model_path,
        "protocol": "subject-disjoint (impostors = unseen Aalto participants; "
                    "genuine = user's is_training=0 samples)",
        "impostorSource": "Aalto 136M keystrokes (Dhakal et al., CHI 2018)",
        "nGenuineWindows": int(len(gen)), "nImpostorWindows": int(len(imp)),
        "nImpostorSubjects": int(len(np.unique(parts))),
        "genuineMean": float(gen.mean()), "impostorMean": float(imp.mean()),
        "auc": auc, "aucCI": boot_ci(auc_of, gen, imp),
        "eer": eer, "eerCI": boot_ci(lambda g, i: eer_of(g, i)[0], gen, imp),
        "eerThreshold": eer_t,
        "atLiveThreshold": {
            "threshold": LIVE_THRESHOLD, "far": far_live, "frr": frr_live,
            "tar": 1 - frr_live,
            "packetFalseLockRate": packet_rate(frr_live),
            "packetImpostorCatchRate": packet_rate(1 - far_live),
        },
        "tarAtFar": {},
    }
    for tf in (0.01, 0.05, 0.10):
        t, thr = tar_at_far(gen, imp, tf)
        res["tarAtFar"][f"{tf:.0%}"] = {
            "tar": t, "threshold": thr,
            "ci": boot_ci(lambda g, i, _tf=tf: tar_at_far(g, i, _tf)[0], gen, imp),
        }

    print("\n=== RESULTS (subject-disjoint) ===")
    print(f"  AUC   {auc:.3f}  CI{tuple(round(v,3) for v in res['aucCI'])}")
    print(f"  EER   {eer:.1%}  CI{tuple(f'{v:.1%}' for v in res['eerCI'])}  (at score {eer_t:.3f})")
    print(f"  @live threshold 0.50:  TAR {1-frr_live:.1%}   FAR {far_live:.1%}")
    print(f"     packet vote -> false-lock {res['atLiveThreshold']['packetFalseLockRate']:.2%} "
          f"per decision, impostor caught {res['atLiveThreshold']['packetImpostorCatchRate']:.1%}")
    for k, v in res["tarAtFar"].items():
        print(f"  TAR @ FAR={k}:  {v['tar']:.1%}  CI({v['ci'][0]:.1%}, {v['ci'][1]:.1%})")

    if args.out:
        with open(args.out, "w") as f:
            json.dump(res, f, indent=2)
        print("\nwrote", args.out)


if __name__ == "__main__":
    main()
