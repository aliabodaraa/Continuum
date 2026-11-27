"""One-sitting enrolment check, Question 3 (27 Nov 2026): the amendment in COORDINATION.md (commit 53ec500), fixed after
run_onesit.py and before any number of this file was computed.

run_onesit.py's impostors play the SapiMouse game, so a profile built from the owner's browsing (U_d) may separate
browsing from that game rather than him from other people. Here the impostors are the free use of the 10 Balabit users
(training_files, legal sessions only), read as SapiMouse is read (client time in ms, the same step filter, A5 windows),
the first 1,200 windows of each user, disjoint 60-window decisions, raw and scaled to A's median step. The arms are
rebuilt exactly as in run_onesit.py (their thresholds must equal artifacts/phase7/onesit_result.json).
Rule: U_d and PU_d pass when their capture is not more than 5 points below M's, raw and scaled, for every d.

    docker run --rm -m 6g -v <repo>:/repo -v <private dir>:/data:ro -w /repo continuum/model-api:local \
        python /repo/services/model-api/analysis/phase7/run_onesit_q3.py --old /data/owner_mouse_2026-11-24.json \
        --new /data/owner_mouse_2026-11-25.json --today /data/owner_mouse_2026-11-27.json \
        --balabit /repo/data/balabit/training_files --out /repo/artifacts/phase7
"""
import argparse
import glob
import hashlib
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import run_ru as RU  # noqa: E402
import run_onesit as OS  # noqa: E402
import repr_arch_study as RAS  # noqa: E402  (on the path through run_ru)

PER_USER = 1200
MARGIN = -5.0
FIRST = "artifacts/phase7/onesit_result.json"


def balabit_events(path):
    out = []
    with open(path, encoding="utf-8", errors="ignore") as f:
        next(f, None)
        for line in f:
            p = line.rstrip("\n").split(",")
            if len(p) != 6:
                continue
            try:
                t, x, y = float(p[1]) * 1000.0, float(p[4]), float(p[5])
            except ValueError:
                continue
            out.append((t, p[2], p[3], x, y))
    return out


def balabit_windows(root):
    data = {}
    for udir in sorted(glob.glob(os.path.join(root, "user*"))):
        got = []
        for s in sorted(glob.glob(os.path.join(udir, "session_*"))):
            W = RAS.windows(RAS.raw_steps(balabit_events(s)), 1.0, "A5")
            if len(W):
                got.append(W)
            if sum(len(w) for w in got) >= PER_USER:
                break
        X = np.concatenate(got)[:PER_USER] if got else np.zeros((0, 50, 2), np.float32)
        data[os.path.basename(udir)] = X
    return data


def main():
    ap = argparse.ArgumentParser()
    for k in ("old", "new", "today", "balabit", "out"):
        ap.add_argument("--" + k, required=True)
    a = ap.parse_args()
    t0 = time.time()
    old, new, today = (json.load(open(p, encoding="utf-8")) for p in (a.old, a.new, a.today))
    samples = {}
    for ex in (old, new, today):
        samples.update({s["id"]: s["windows"] for s in ex["samples"]})
    cat = lambda ids: np.concatenate([np.asarray(samples[i], np.float32) for i in ids])  # noqa: E731
    olds = sorted(old["checks"], key=lambda c: int(c["decision_id"]))
    days = sorted({c["checked_at"][:10] for c in olds})

    arms = {k: RU.build(cat(ids)) for k, ids in (("A", OS.A_IDS), ("M", OS.M_IDS), ("N", OS.N_IDS), ("T", OS.T_IDS))}
    for d in days:
        X, _ = OS.first_distinct([c for c in olds if c["checked_at"][:10] == d], OS.ENROL_WINDOWS)
        if X is None:
            continue
        arms["U_" + d] = RU.build(X)
        arms["PU_" + d] = RU.build(np.concatenate([cat(OS.T_IDS[4:]), X[:4 * OS.SAMPLE]]))
    first = json.load(open(FIRST, encoding="utf-8"))["thresholds"]
    v_th = {k: abs(arms[k]["threshold"] - first[k]) for k in arms}
    valid = set(first) == set(arms) and all(x < 1e-9 for x in v_th.values())

    own_med = float(np.median(np.hypot(cat(OS.A_IDS)[..., 0], cat(OS.A_IDS)[..., 1])))
    raw = balabit_windows(a.balabit)
    imp = {}
    for u, X in raw.items():
        med = float(np.median(np.hypot(X[..., 0], X[..., 1]))) if len(X) else 0.0
        k = own_med / med if med > 0 else 1.0
        imp[u] = {"raw": X, "scaled": np.round(X * k).astype(np.float32), "median": med, "windows": int(len(X))}
    isc = RU.Scorer()
    ikeys = {u: {v: isc.add(dd[v]) for v in ("raw", "scaled")} for u, dd in imp.items()}
    isc.embed()
    iwin = {k: isc.scores(arm["head"]) for k, arm in arms.items()}
    per = {k: {v: {u: RU.disjoint_caught(iwin[k][np.asarray(ikeys[u][v])], arms[k]["threshold"]) for u in imp}
               for v in ("raw", "scaled")} for k in arms}
    cap = {k: {v: 100 * sum(sum(x) for x in per[k][v].values()) / sum(len(x) for x in per[k][v].values()) for v in ("raw", "scaled")}
           for k in arms}
    per_user = {k: {u: round(100 * np.mean(per[k]["raw"][u]), 1) if per[k]["raw"][u] else None for u in imp} for k in arms}

    # his real use against Balabit, threshold-free (descriptive)
    sc = RU.Scorer()
    for c in olds:
        sc.add(c["windows"])
    sc.embed()
    gwin = {k: sc.scores(arm["head"]) for k, arm in arms.items()}
    sep = {k: {v: OS.auc(gwin[k], np.concatenate([iwin[k][np.asarray(ikeys[u][v])] for u in imp])) for v in ("raw", "scaled")}
           for k in arms}

    Q3 = {}
    for k in arms:
        if k in ("A", "M"):
            continue
        d = {v: RU.users_ci(per["M"][v], per[k][v]) for v in ("raw", "scaled")}
        Q3[k] = {"capture": cap[k], "deltaPoints": {v: d[v][0] for v in d}, "ci95": {v: [d[v][1], d[v][2]] for v in d},
                 "decisions": d["raw"][5], "passes": bool(valid and all(d[v][0] >= MARGIN for v in d))}
    verdict = {"U_pass": all(Q3[k]["passes"] for k in Q3 if k.startswith("U_")),
               "PU_pass": all(Q3[k]["passes"] for k in Q3 if k.startswith("PU_"))}

    code = hashlib.sha256(open(os.path.abspath(__file__), "rb").read()).hexdigest()
    res = {"code": code, "seconds": round(time.time() - t0, 1), "valid": valid, "thresholdsVsFirstRun": v_th,
           "ownerMedianStepA": own_med, "balabit": {u: {"windows": x["windows"], "medianStep": x["median"]} for u, x in imp.items()},
           "capture": cap, "capturePerUserRaw": per_user, "aucRealUseVsBalabit": sep, "Q3": Q3, "verdict": verdict}
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "onesit_q3_result.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, indent=1)
    L = [f"Question 3, code {code[:12]}, valid {valid} (thresholds = first run, max diff {max(v_th.values()):.1e}); {res['seconds']} s",
         "Balabit users (windows, median step px): " + ", ".join(f"{u} {x['windows']}/{x['median']:.1f}" for u, x in imp.items())
         + f"; his A median step {own_med:.1f}"]
    for k in arms:
        L.append(f"  {k:<14} threshold {arms[k]['threshold']:.4f}  capture raw {cap[k]['raw']:.1f}% scaled {cap[k]['scaled']:.1f}%  "
                 f"AUC his use vs Balabit raw {sep[k]['raw']:.3f} scaled {sep[k]['scaled']:.3f}  per user raw {list(per_user[k].values())}")
    for k, x in Q3.items():
        L.append(f"Q3 {k}: raw {x['capture']['raw']:.1f}% ({x['deltaPoints']['raw']:+.1f} vs M, 95% [{x['ci95']['raw'][0]:+.1f}, {x['ci95']['raw'][1]:+.1f}]), "
                 f"scaled {x['capture']['scaled']:.1f}% ({x['deltaPoints']['scaled']:+.1f}, 95% [{x['ci95']['scaled'][0]:+.1f}, {x['ci95']['scaled'][1]:+.1f}]); "
                 f"{x['decisions']} decisions; passes {x['passes']}")
    L.append(f"verdict: {json.dumps(verdict)}")
    txt = "\n".join(L)
    open(os.path.join(a.out, "onesit_q3_result.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
