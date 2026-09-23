"""
Experiment H (artifacts/repr_arch_study/PREREGISTRATION_H.md): where should the per-user threshold
come from? One model per target, trained through model-api's own train_user_payload exactly as in
Experiment F; the run records every score stream the three threshold sources need:

  _enrolScores     the model's scores on its own 330 training windows        (ENR)
  _valScores       its scores on the genuine windows api.py held out          (VAL)
  _genuineScores   the whole 1-minute session; its first 55 windows are USE's calibration windows
  _impostorRuns    every other held-out user's 1-minute session, first 150 windows

    python repr_threshold_h.py              # writes parts/H_run.json
    python repr_threshold_h.py --analyze    # writes analysis_H.json
"""
import argparse
import glob
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = "/app/artifacts/repr_arch_study"
PREREG_H = os.path.join(ROOT, "PREREGISTRATION_H.md")
DATA = "/app/data/sapimouse"
HOLDOUT = "/app/artifacts/mouse-ws50-aligned/holdout_users.json"
BUDGET, IMP_RUN, USE_N = 330, 150, 55
Q_GRID = [1, 2, 5, 10, 15, 20, 30, 40, 50]
ARMS = ["ENR", "VAL", "USE"]


def run(limit=0, out_dir=None):
    os.environ["MOUSE_BASE_MODEL_PATH"] = "/app/artifacts/mouse-fcn-a5/final_model"
    os.environ["MOUSE_SCALER_PATH"] = "/app/artifacts/mouse-fcn-a5/scaler.json"
    os.environ["MOUSE_NEG_DATASET_PATH"] = "/app/data/mouse_only/Mouse_A5_W50_base.h5"
    sys.path.insert(0, HERE)
    import api
    from repr_arch_study import raw_steps, windows, session_scale, _read_events
    sha = hashlib.sha256(open(PREREG_H, "rb").read()).hexdigest()

    def wins(csv):
        ev = _read_events(csv)
        return windows(raw_steps(ev), session_scale(ev), "A5")

    def sessions(u):
        cs = sorted(glob.glob(os.path.join(DATA, u, "*.csv")))
        lo = [c for c in cs if "3min" in os.path.basename(c)]
        sh = [c for c in cs if "1min" in os.path.basename(c)]
        return (lo[0] if lo else None), (sh[0] if sh else None)

    holdout = json.load(open(HOLDOUT))["holdout_users"]
    test = {u: wins(sessions(u)[1]) for u in holdout if sessions(u)[1]}
    targets = [u for u in holdout if sessions(u)[0] and len(wins(sessions(u)[0])) >= BUDGET]
    if limit:
        targets = targets[:limit]
    print(f"[H] targets {len(targets)} | prereg {sha[:12]}")
    rows = []
    for u in targets:
        enrol = wins(sessions(u)[0])[:BUDGET]
        mpath = f"/app/artifacts/final_eval/h/{u}/mouse_model"
        res, code = api.train_user_payload({
            "userId": f"h-{u}", "modality": "mouse", "modelPath": mpath,
            "positiveWindows": enrol.tolist(), "positiveGroups": [0] * len(enrol),
            "overlapGap": 5, "minPositiveWindows": BUDGET, "epochs": 15, "batchSize": 32})
        if code != 200:
            raise RuntimeError(f"{u}: train failed {code} {res}")

        def P(X):
            r, c = api.predict_user_payload({"userId": f"h-{u}", "modality": "mouse",
                                             "modelPath": mpath, "windows": X.tolist()})
            if c != 200:
                raise RuntimeError(f"{u}: predict failed {c} {r}")
            return [p[1] for p in r["prediction"]]
        rows.append({"participant": u, "_enrolScores": P(enrol), "_valScores": res["validationGenuineScores"],
                     "_genuineScores": P(test[u]),
                     "_impostorRuns": {o: P(x[:IMP_RUN]) for o, x in test.items() if o != u and len(x)}})
        print(f"  {u:>8}  val windows {len(res['validationGenuineScores'])}  epochs {res.get('epochsTrained')}")
    out = os.path.join(out_dir or os.path.join(ROOT, "parts"), "H_run.json")
    json.dump({"preregistrationHSha256": sha, "budget": BUDGET, "useWindows": USE_N, "perUser": rows}, open(out, "w"))
    print(f"wrote {out}")


# ------------------------------------------------------------------------------ analysis ----
def units(row, arm, genuine_key="_genuineScores", enrol_key="_enrolScores", val_key="_valScores"):
    """(calibration half, test half, threshold-source scores) for one user and arm. The genuine
    evaluation stream always starts after the first USE_N windows, whatever the arm."""
    import repr_arch_analyze as RA
    g = list(row[genuine_key])
    stream = {"_genuineScores": g[USE_N:], "_impostorRuns": row["_impostorRuns"]}
    cal, test = RA.halves(stream)
    src = {"ENR": row[enrol_key], "VAL": row.get(val_key) or [], "USE": g[:USE_N]}[arm]
    return cal, test, np.asarray(src, float)


def choose(units_by_user, budget):
    import repr_arch_analyze as RA
    best = None
    for q in Q_GRID:
        for rule, n, k in RA.RULES:
            fl, cap = [], []
            for cal, _t, src in units_by_user.values():
                if not len(src):
                    continue
                r = RA.rates(cal, float(np.percentile(src, q)), rule, n, k)
                if r:
                    fl.append(r["fl"]); cap.append(r["cap"])
            if len(fl) < 3:
                continue
            mfl, mcap = float(np.median(fl)), float(np.median(cap))
            if mfl <= budget and (best is None or mcap > best["calCap"]):
                best = {"q": q, "rule": rule, "n": n, "k": k, "calFL": mfl, "calCap": mcap, "flBudget": budget}
    return best


def evaluate(units_by_user, op):
    import repr_arch_analyze as RA
    per = {}
    for u, (_c, test, src) in units_by_user.items():
        if not len(src):
            continue
        r = RA.rates(test, float(np.percentile(src, op["q"])), op["rule"], op["n"], op["k"])
        if r:
            per[u] = r
    return per


def arm_result(rows, arm, keys=None):
    keys = keys or {}
    U = {r["participant"]: units(r, arm, **keys) for r in rows}
    op = next((o for b in (0.01, 0.02, 0.05) for o in [choose(U, b)] if o), None)
    per = evaluate(U, op) if op else {}
    lat = [v["latencyWindows"] for v in per.values() if v["latencyWindows"] is not None]
    summary = None
    if per:
        fl = [v["fl"] for v in per.values()]
        cap = [v["cap"] for v in per.values()]
        summary = {"flMean": float(np.mean(fl)), "flMedian": float(np.median(fl)),
                   "capMean": float(np.mean(cap)), "capMedian": float(np.median(cap)),
                   "interruptedShare": float(np.mean([v["interrupted"] for v in per.values()])),
                   "neverLockedShare": float(np.mean([not v["interrupted"] for v in per.values()])),
                   "neverDetectedShare": float(1 - np.mean([v["detected"] for v in per.values()])),
                   "latencyWindowsMedian": float(np.median(lat)) if lat else None,
                   "usersWithFlAbove20pct": int(sum(f > 0.20 for f in fl))}
    return op, per, summary


def analyze():
    sys.path.insert(0, HERE)
    import repr_arch_analyze as RA
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    sha = hashlib.sha256(open(PREREG_H, "rb").read()).hexdigest()
    doc = json.load(open(os.path.join(ROOT, "parts", "H_run.json")))
    if doc["preregistrationHSha256"] != sha:
        sys.exit("REFUSING: H results under a different pre-registration")
    rows = doc["perUser"]
    out = {"preregistrationHSha256": sha, "users": len(rows), "arms": {}}
    per = {}
    for arm in ARMS:
        op, p, s = arm_result(rows, arm)
        per[arm] = p
        out["arms"][arm] = {"operatingPoint": op, "test": s,
                            "perUser": {u: {"fl": v["fl"], "cap": v["cap"]} for u, v in p.items()}}
        print(f"{arm}: op {op and {k: op[k] for k in ('q', 'rule', 'n', 'k', 'flBudget')}}")
        if s:
            print(f"      test FL mean {s['flMean']*100:5.1f}%  median {s['flMedian']*100:5.1f}%  | capture mean "
                  f"{s['capMean']*100:5.1f}% median {s['capMedian']*100:5.1f}% | interrupted {s['interruptedShare']*100:3.0f}% "
                  f"| users FL>20% {s['usersWithFlAbove20pct']} | never detected {s['neverDetectedShare']*100:.1f}%")
    comps = {}
    ps = []
    for arm in ("VAL", "USE"):
        users = sorted(set(per["ENR"]) & set(per[arm]))
        dfl = RA.boot([per["ENR"][u]["fl"] for u in users], [per[arm][u]["fl"] for u in users])
        dcap = RA.boot([per["ENR"][u]["cap"] for u in users], [per[arm][u]["cap"] for u in users])
        comps[arm] = {"fl": dfl, "cap": dcap, "users": len(users)}
        ps.append(dfl["p"])
    adj = RA.holm(ps)
    qualified = []
    for arm, pa in zip(("VAL", "USE"), adj):
        c = comps[arm]
        c["fl"]["pHolm"] = pa
        c["qualifies"] = bool(c["fl"]["meanDiff"] < 0 and pa < 0.05 and c["cap"]["ci95"][0] >= -0.05)
        print(f"{arm} - ENR: FL {c['fl']['meanDiff']*100:+.1f} pp [{c['fl']['ci95'][0]*100:+.1f}, {c['fl']['ci95'][1]*100:+.1f}] "
              f"Holm p {pa:.4f} | capture {c['cap']['meanDiff']*100:+.1f} pp [{c['cap']['ci95'][0]*100:+.1f}, "
              f"{c['cap']['ci95'][1]*100:+.1f}] -> {'QUALIFIES' if c['qualifies'] else 'does not qualify'}")
        if c["qualifies"]:
            qualified.append(arm)
    if len(qualified) == 2:
        adopted = min(qualified, key=lambda a: out["arms"][a]["test"]["flMean"])
    elif qualified:
        adopted = qualified[0]
    else:
        adopted = "ENR"
    out["comparisons"] = comps
    out["adopted"] = adopted
    print(f"\nDECISION (pre-registered): threshold source = {adopted}")

    # Secondary, decides nothing for the server: the extension's head (Experiment G), ENR vs USE.
    G = json.load(open(os.path.join(ROOT, "parts", "G_device.json")))
    sec = {}
    for arm in ("ENR", "USE"):
        ops, flm, capm = [], [], []
        for d in G["seeds"]:
            grows = [{"participant": r["participant"], "_enrolScores": r["M"]["330"]["_enrolScores"],
                      "_genuineScores": r["M"]["330"]["_genuineScores"], "_impostorRuns": r["M"]["330"]["_impostorRuns"]}
                     for r in d["perUser"]]
            op, p, s = arm_result(grows, arm)
            ops.append(op and {k: op[k] for k in ("q", "rule", "n", "k", "flBudget")})
            if s:
                flm.append(s["flMean"]); capm.append(s["capMedian"])
        sec[arm] = {"operatingPoints": ops, "flMeanOverSeeds": float(np.mean(flm)) if flm else None,
                    "capMedianOverSeeds": float(np.mean(capm)) if capm else None}
        print(f"[extension, secondary] {arm}: FL mean {np.mean(flm)*100:.1f}%  capture median {np.mean(capm)*100:.1f}%  ops {ops}")
    out["extensionSecondary"] = sec
    json.dump(out, open(os.path.join(ROOT, "analysis_H.json"), "w"), indent=1)
    print("wrote analysis_H.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="smoke test only")
    ap.add_argument("--out-dir", default=None, help="smoke test only")
    a = ap.parse_args()
    analyze() if a.analyze else run(a.limit, a.out_dir)
