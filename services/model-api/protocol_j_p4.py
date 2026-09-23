"""Protocol J, Phase P4: enrolment quality (PREREGISTRATION_J.md, section 6).

For each development target, 10 enrolments of E windows (E = P3's budget) from evenly spaced offsets
of the 3-min session, each trained with the P1 method (B, identity order) and scored at the frozen
point. Seven candidate quality measures, fixed in the protocol, are computed on each enrolment's span
and related within users to three outcomes (genuine prompts/min, impostor runs caught, per-window AUC).

    python protocol_j_p4.py --worker 0 --workers 6   # -> parts/J_P4/<user>.json
    python protocol_j_p4.py --analyze                # -> analysis_J_P4.json
"""
import argparse
import gc
import json
import os
import shutil
import sys

import numpy as np

os.environ.setdefault("TF_NUM_INTRAOP_THREADS", "5")
os.environ.setdefault("TF_NUM_INTEROP_THREADS", "2")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import protocol_j_common as J  # noqa: E402
import protocol_j_p1 as P1  # noqa: E402
from repr_arch_study import WS, STRIDE, _read_events, raw_steps, window_starts  # noqa: E402

PARTS = os.path.join(J.STUDY, "parts", "J_P4")
OUT = os.path.join(J.STUDY, "analysis_J_P4.json")
MODELS = "/app/artifacts/protocol_j/models/P4"
N_ENROL = 10
IDLE_MS = 500.0
CANDIDATES = ["meanWindowPathPx", "medianStepPx", "dragShare", "idleSplitsPer100Steps",
              "duplicateWindowShare", "rejectedWindowShare", "stepIqrPx"]
OUTCOMES = ["promptsPerMin", "runsCaught", "auc"]


def budget_and_point():
    p3 = json.load(open(os.path.join(J.STUDY, "analysis_J_P3.json")))
    p2b = os.path.join(J.STUDY, "analysis_J_P2b.json")
    op = json.load(open(p2b))["operatingPoint"] if os.path.exists(p2b) else json.load(open(os.path.join(J.STUDY, "analysis_J_P2.json")))["operatingPoint"]
    return int(p3["selectedBudget"]), op


def candidates(R, events_t, starts, wins, o, E):
    ws = wins[o:o + E]
    s0, s_last = starts[o], starts[o + E - 1]
    span = R[s0:s_last + WS]
    mag = np.hypot(span[:, 3], span[:, 4])
    t0, t1 = span[0, 0], span[-1, 0]
    et = events_t[(events_t >= t0) & (events_t <= t1)]
    idle = int((np.diff(et) > IDLE_MS).sum()) if len(et) > 1 else 0
    keys = [w.tobytes() for w in ws]
    counts = {}
    for k in keys:
        counts[k] = counts.get(k, 0) + 1
    kept = set(starts[o:o + E])
    cand = [c for c in range(0, len(R) - WS + 1, STRIDE) if s0 <= c <= s_last]
    q75, q25 = np.percentile(mag, [75, 25])
    return {"meanWindowPathPx": float(np.mean(np.hypot(ws[:, :, 0], ws[:, :, 1]).sum(1))),
            "medianStepPx": float(np.median(mag)), "dragShare": float((span[:, 10] == 1).mean()),
            "idleSplitsPer100Steps": 100.0 * idle / len(span),
            "duplicateWindowShare": float(sum(1 for k in keys if counts[k] > 1) / E),
            "rejectedWindowShare": float(1 - len(kept) / len(cand)) if cand else 0.0,
            "stepIqrPx": float(q75 - q25)}


def run(worker, workers):
    hashes = J.verify_frozen()
    E, op = budget_and_point()
    os.environ["MOUSE_BASE_MODEL_PATH"] = J.BASE80["base"]
    os.environ["MOUSE_SCALER_PATH"] = J.BASE80["scaler"]
    os.environ["MOUSE_NEG_DATASET_PATH"] = J.BASE80["neg"]
    import api
    import tensorflow as tf
    R_ = J.Reader("P4")
    dev = J.split()["development"]
    test = {u: R_.windows(R_.sessions(u)[1]) for u in dev if R_.sessions(u)[1]}
    targets = [u for u in dev if R_.sessions(u)[0] and len(R_.windows(R_.sessions(u)[0])) >= 440]
    os.makedirs(PARTS, exist_ok=True)
    b = E // 55
    order = list(range(b))
    for u in targets[worker::workers]:
        out_path = os.path.join(PARTS, f"{u}.json")
        if os.path.exists(out_path):
            print(f"[P4 w{worker}] {u} done already"); continue
        csv = R_.sessions(u)[0]
        ev = _read_events(csv)
        R = raw_steps(ev)
        starts = window_starts(R)
        wins = R_.windows(csv)
        assert len(wins) == len(starts)
        events_t = np.asarray([e[0] for e in ev], float)
        n = len(wins)
        offsets = [int(round(k * (n - E) / (N_ENROL - 1))) for k in range(N_ENROL)]
        streams = {"genuine": test[u], "impostor": {o: x[:J.IMP_RUN] for o, x in test.items() if o != u and len(x)}}
        rec = {**hashes, "phase": "P4", "participant": u, "budget": E, "offsets": offsets, "enrolments": []}
        for ki, o in enumerate(offsets):
            enrol = wins[o:o + E]
            base = f"{MODELS}/{u}/k{ki}"
            od, tr, va, _ = P1.plan_folds(order, [])
            sc, info = P1.fit_and_score(api, f"j-p4-{u}-k{ki}-F", f"{base}/F", enrol, od, tr, va, streams)
            oof = np.full(E, np.nan)
            for s in order:
                od, tr, va, held = P1.plan_folds(order, [s])
                hs, _ = P1.fit_and_score(api, f"j-p4-{u}-k{ki}-B{s}", f"{base}/B{s}", enrol, od, tr, va, {"held": enrol[held]})
                oof[held] = hs["held"]
            rec["enrolments"].append({"offset": o, "candidates": candidates(R, events_t, starts, wins, o, E),
                                      "model": {**sc, "info": info}, "oof": [round(float(v), 6) for v in oof]})
            print(f"[P4 w{worker}] {u} enrolment {ki + 1}/{N_ENROL} offset {o}", flush=True)
            tf.keras.backend.clear_session(); gc.collect()
        json.dump(rec, open(out_path + ".tmp", "w"))
        os.replace(out_path + ".tmp", out_path)
        shutil.rmtree(f"{MODELS}/{u}", ignore_errors=True)
        tf.keras.backend.clear_session(); gc.collect()
        print(f"[P4 w{worker}] wrote {out_path}", flush=True)


def spearman(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    if np.ptp(a) == 0 or np.ptp(b) == 0:
        return np.nan
    ra, rb = np.argsort(np.argsort(a)).astype(float), np.argsort(np.argsort(b)).astype(float)
    return float(np.corrcoef(ra, rb)[0, 1])


def analyze():
    hashes = J.verify_frozen()
    import repr_arch_analyze as RA
    from keystroke_user_sweep import auc_of
    E, op = budget_and_point()
    recs = []
    for f in sorted(os.listdir(PARTS)):
        if f.endswith(".json"):
            r = json.load(open(os.path.join(PARTS, f)))
            for k, v in hashes.items():
                if r.get(k) != v:
                    raise SystemExit(f"{f}: produced under another {k}")
            recs.append(r)
    per_user = {}
    for r in recs:
        rows = []
        for e in r["enrolments"]:
            m = e["model"]
            tau = float(np.percentile(np.asarray(e["oof"], float), op["q"]))
            h = J.halves({"_genuineScores": m["genuine"], "_impostorRuns": m["impostor"]})[1]
            x = J.per_user(h, tau, op["rule"], op["n"], op["k"])
            imp = np.concatenate(list(h["runs"].values()))
            rows.append({**e["candidates"], "promptsPerMin": x["promptsPerMin"], "runsCaught": float(np.mean(x["caught"])),
                         "auc": float(auc_of(h["g"], imp))})
        per_user[r["participant"]] = rows
    users = sorted(per_user)
    tests, ps, keys = {}, [], []
    for c in CANDIDATES:
        for o in OUTCOMES:
            rho = [spearman([x[c] for x in per_user[u]], [x[o] for x in per_user[u]]) for u in users]
            vals = np.array([v for v in rho if np.isfinite(v)])
            if len(vals) >= 3:
                t = RA.boot(np.zeros(len(vals)), vals)
            else:
                t = {"meanDiff": float(np.mean(vals)) if len(vals) else float("nan"), "ci95": [float("nan")] * 2, "p": 1.0, "n": int(len(vals))}
            t["usersWithDefinedCorrelation"] = int(len(vals))
            tests[f"{c}~{o}"] = t
            ps.append(t["p"]); keys.append(f"{c}~{o}")
    for k, ph in zip(keys, RA.holm(ps)):
        tests[k]["pHolm"] = float(ph)
    surviving = [k for k in keys if tests[k]["pHolm"] < 0.05]
    out = {**hashes, "phase": "P4", "budget": E, "operatingPoint": op, "tests": tests, "surviving": surviving,
           "decision": "no quality gate" if not surviving else "association found: gate to be specified by amendment before P6",
           "perUser": per_user}
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"P4: {len(users)} users x {N_ENROL} enrolments of {E} windows; within-user Spearman, mean over users, Holm over {len(keys)}")
    for k in keys:
        t = tests[k]
        print(f"  {k:36s} mean rho {t['meanDiff']:+.2f} [{t['ci95'][0]:+.2f}, {t['ci95'][1]:+.2f}] n={t['usersWithDefinedCorrelation']:2d} pHolm {t['pHolm']:.3f}")
    print(f"  DECISION: {out['decision']} {surviving if surviving else ''}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", type=int, default=0)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--analyze", action="store_true")
    a = ap.parse_args()
    analyze() if a.analyze else run(a.worker, a.workers)
