"""
Experiment F (artifacts/repr_arch_study/PREREGISTRATION_F.md): final held-out evaluation of the
deployed mouse pipeline through model-api's OWN code path (train_user_payload /
predict_user_payload), NEW (A5 + FCN) vs OLD (7 features + Conv1D/2xGRU), identical protocol.

    python final_mouse_eval.py --pipeline new        # writes parts/F_new.json
    python final_mouse_eval.py --pipeline old
    python final_mouse_eval.py --analyze
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
PREREG_F = os.path.join(ROOT, "PREREGISTRATION_F.md")
DATA = "/app/data/sapimouse"
HOLDOUT = "/app/artifacts/mouse-ws50-aligned/holdout_users.json"
PIPE = {
    "new": {"rep": "A5", "base": "/app/artifacts/mouse-fcn-a5/final_model",
            "scaler": "/app/artifacts/mouse-fcn-a5/scaler.json",
            "neg": "/app/data/mouse_only/Mouse_A5_W50_base.h5"},
    "old": {"rep": "A1", "base": "/app/artifacts/mouse-ws50-aligned/final_model",
            "scaler": "/app/artifacts/mouse-ws50-aligned/scaler.json",
            "neg": "/app/data/mouse_only/Mouse_WS50_base.h5"},
}
BUDGET, IMP_RUN = 330, 150


def ensure_old_negatives(path):
    """Base-user-only 7-feature negatives (the production file pools all 120 users)."""
    if os.path.exists(path):
        return
    import h5py
    from repr_arch_study import raw_steps, windows, session_scale, _read_events
    hold = set(json.load(open(HOLDOUT))["holdout_users"])
    parts = []
    for d in sorted(glob.glob(os.path.join(DATA, "user*"))):
        u = os.path.basename(d)
        if u in hold:
            continue
        lo = [c for c in sorted(glob.glob(os.path.join(d, "*.csv"))) if "3min" in os.path.basename(c)]
        if lo:
            ev = _read_events(lo[0])
            parts.append(windows(raw_steps(ev), session_scale(ev), "A1"))
    X = np.concatenate(parts).astype(np.float32)
    with h5py.File(path, "w") as f:
        f.create_dataset("X", data=X, compression="gzip")
        f.attrs["users"] = "base users only (holdout excluded)"
    print(f"built {path}: {X.shape}")


def run(pipeline, limit=0, out_dir=None):
    cfg = PIPE[pipeline]
    if pipeline == "old":
        sys.path.insert(0, HERE)
        ensure_old_negatives(cfg["neg"])
    # api.py reads these at import time
    os.environ["MOUSE_BASE_MODEL_PATH"] = cfg["base"]
    os.environ["MOUSE_SCALER_PATH"] = cfg["scaler"]
    os.environ["MOUSE_NEG_DATASET_PATH"] = cfg["neg"]
    sys.path.insert(0, HERE)
    import api
    from repr_arch_study import raw_steps, windows, session_scale, _read_events
    sha = hashlib.sha256(open(PREREG_F, "rb").read()).hexdigest()

    def wins(csv):
        ev = _read_events(csv)
        return windows(raw_steps(ev), session_scale(ev), cfg["rep"])

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
    print(f"[F {pipeline}] targets {len(targets)} | base {cfg['base']}")
    rows = []
    for u in targets:
        enrol = wins(sessions(u)[0])[:BUDGET]
        mpath = f"/app/artifacts/final_eval/{pipeline}/{u}/mouse_model"
        res, code = api.train_user_payload({
            "userId": f"final-{pipeline}-{u}", "modality": "mouse", "modelPath": mpath,
            "positiveWindows": enrol.tolist(), "positiveGroups": [0] * len(enrol),
            "overlapGap": 5, "minPositiveWindows": BUDGET, "epochs": 15, "batchSize": 32})
        if code != 200:
            raise RuntimeError(f"{u}: train failed {code} {res}")

        def P(X):
            r, c = api.predict_user_payload({"userId": f"final-{pipeline}-{u}", "modality": "mouse",
                                             "modelPath": mpath, "windows": X.tolist()})
            if c != 200:
                raise RuntimeError(f"{u}: predict failed {c} {r}")
            return [p[1] for p in r["prediction"]]
        rows.append({"participant": u, "trainedFrom": res.get("trainedFrom"),
                     "negativeSource": res.get("negativeSource"),
                     "negativeWindowCount": res.get("negativeWindowCount"),
                     "epochsTrained": res.get("epochsTrained"),
                     "_enrolScores": P(enrol), "_genuineScores": P(test[u]),
                     "_impostorRuns": {o: P(x[:IMP_RUN]) for o, x in test.items() if o != u and len(x)}})
        print(f"  {u:>8}  trainedFrom={res.get('trainedFrom')}  negatives={res.get('negativeWindowCount')} "
              f"({res.get('negativeSource')})  epochs={res.get('epochsTrained')}")
    out = os.path.join(out_dir or os.path.join(ROOT, "parts"), f"F_{pipeline}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    json.dump({"preregistrationFSha256": sha, "pipeline": pipeline, "config": cfg, "budget": BUDGET,
               "perUser": rows}, open(out, "w"))
    print(f"wrote {out}")


def analyze():
    sys.path.insert(0, HERE)
    import repr_arch_analyze as RA
    import repr_enrol_analyze as RE
    sha = hashlib.sha256(open(PREREG_F, "rb").read()).hexdigest()
    docs = {p: json.load(open(os.path.join(ROOT, "parts", f"F_{p}.json"))) for p in ("new", "old")}
    if any(d["preregistrationFSha256"] != sha for d in docs.values()):
        sys.exit("REFUSING: F results under a different pre-registration")
    out = {"preregistrationFSha256": sha}
    per = {}
    for p, d in docs.items():
        for r in d["perUser"]:
            cal, test = RA.halves(r)
            per.setdefault(p, {})[r["participant"]] = RA.window_metrics(test)
        users = sorted(per[p])
        f = lambda k: [per[p][u][k] for u in users]
        print(f"\n{p.upper():>4}: {len(users)} users | test half: AUC mean {np.mean(f('auc')):.3f} median "
              f"{np.median(f('auc')):.3f} | EER {np.mean(f('eer'))*100:.1f}% | TAR@FAR1% {np.mean(f('tar01'))*100:.1f}%")
        ops = {}
        for bud in (0.01, 0.02, 0.05):
            doc = {"perUser": [{"participant": r["participant"], "M": {str(d['budget']): r}} for r in d["perUser"]],
                   "seedIndex": 0}
            op = RE.pooled_op([doc], "M", d["budget"], bud)
            ops[str(bud)] = op
            if op:
                print(f"   FL budget {bud:.0%}: q={op['q']:>2} {op['rule']:<6} n={op['n']:>2} k={op['k']} | test FL "
                      f"median {op['testFLmedian']*100:4.1f}% mean {op['testFLmean']*100:4.1f}% | capture median "
                      f"{op['testCaptureMedian']*100:4.1f}% mean {op['testCaptureMean']*100:4.1f}% | interrupted "
                      f"{op['interruptedShare']*100:3.0f}% | never detected {op['neverDetectedShare']*100:.1f}% | "
                      f"latency {op['latencySecondsMedian'] or float('nan'):.1f} s")
            else:
                print(f"   FL budget {bud:.0%}: none meets it on calibration")
        out[p] = {"window": {k: float(np.mean(f(k))) for k in ("auc", "eer", "tar01")},
                  "aucMedian": float(np.median(f("auc"))), "ops": ops}
    users = sorted(set(per["new"]) & set(per["old"]))
    for k in ("auc", "tar01", "eer"):
        r = RA.boot([per["old"][u][k] for u in users], [per["new"][u][k] for u in users])
        print(f"NEW - OLD {k:>5}: {r['meanDiff']:+.4f} [{r['ci95'][0]:+.4f}, {r['ci95'][1]:+.4f}] p {r['p']:.4f}")
        out[f"diff_{k}"] = r
    deployed = next((out["new"]["ops"][b] for b in ("0.01", "0.02", "0.05") if out["new"]["ops"][b]), None)
    out["deployedOperatingPoint"] = deployed
    print(f"\nDEPLOYED OPERATING POINT (pre-registered: 1% budget first): {deployed and {k: deployed[k] for k in ('q','rule','n','k','flBudget')}}")
    json.dump(out, open(os.path.join(ROOT, "analysis_F.json"), "w"), indent=1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--pipeline", choices=["new", "old"])
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="smoke test only")
    ap.add_argument("--out-dir", default=None, help="smoke test only")
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    analyze() if a.analyze else run(a.pipeline, a.limit, a.out_dir)
