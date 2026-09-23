"""Pre-registration K, K1: do click marks carry identity? (PREREGISTRATION_K.md)

A click reaches the model only as a step with no movement. KEEP = windows as today; DROP = the same
sessions with every zero-displacement step removed before windowing. Production recipe (Method A, 330
enrolment windows), 19 development targets, base-80. Lockbox users are never read.

    python protocol_k1.py --worker 0 --workers 2   # -> parts/K1/<user>.json
    python protocol_k1.py --analyze                # -> analysis_K1.json
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
from repr_arch_study import _read_events, raw_steps, session_scale, windows  # noqa: E402

BUDGET = 330
DEPLOYED = {"q": 1, "rule": "vote", "n": 60, "k": 30}
PARTS = os.path.join(J.STUDY, "parts", "K1")
OUT = os.path.join(J.STUDY, "analysis_K1.json")
MODELS = "/app/artifacts/protocol_j/models/K1"
PREREG = os.path.join(J.STUDY, "PREREGISTRATION_K.md")


def arms(csv):
    """KEEP: windows as today. DROP: the same session with zero-movement steps removed first."""
    ev = _read_events(csv)
    R, s = raw_steps(ev), session_scale(ev)
    keep = windows(R, s, "A5")
    moved = R[np.hypot(R[:, 3], R[:, 4]) > 0]
    drop = windows(moved, s, "A5")
    return {"KEEP": keep, "DROP": drop}


def run(worker, workers):
    hashes = {**J.verify_frozen(), "preregistrationKSha256": J.sha(PREREG)}
    os.environ["MOUSE_BASE_MODEL_PATH"] = J.BASE80["base"]
    os.environ["MOUSE_SCALER_PATH"] = J.BASE80["scaler"]
    os.environ["MOUSE_NEG_DATASET_PATH"] = J.BASE80["neg"]
    import api
    import tensorflow as tf
    R = J.Reader("K1")
    dev = J.split()["development"]
    test = {u: arms(R.sessions(u)[1]) for u in dev if R.sessions(u)[1]}
    targets = [u for u in dev if R.sessions(u)[0] and len(arms(R.sessions(u)[0])["KEEP"]) >= BUDGET]
    os.makedirs(PARTS, exist_ok=True)
    for u in targets[worker::workers]:
        out_path = os.path.join(PARTS, f"{u}.json")
        if os.path.exists(out_path):
            print(f"[K1 w{worker}] {u} done already"); continue
        enrol_arms = arms(R.sessions(u)[0])
        rec = {**hashes, "phase": "K1", "participant": u, "arms": {}}
        for arm in ("KEEP", "DROP"):
            enrol = enrol_arms[arm][:BUDGET]
            if len(enrol) < BUDGET:
                print(f"  {u} {arm}: only {len(enrol)} windows, skipped"); rec["arms"][arm] = None; continue
            streams = {"genuine": test[u][arm], "impostor": {o: x[arm][:J.IMP_RUN] for o, x in test.items() if o != u and len(x[arm])}}
            mpath = f"{MODELS}/{u}/{arm}"
            res, code = api.train_user_payload({
                "userId": f"k1-{u}-{arm}", "modality": "mouse", "modelPath": mpath,
                "positiveWindows": enrol.tolist(), "overlapGap": 5, "minPositiveWindows": BUDGET,
                "epochs": 15, "batchSize": 32})
            if code != 200:
                raise RuntimeError(f"{u} {arm}: train failed {code} {res}")
            sc = {k: (P1._pred(api, f"k1-{u}-{arm}", mpath, v) if not isinstance(v, dict)
                      else {kk: P1._pred(api, f"k1-{u}-{arm}", mpath, vv) for kk, vv in v.items()})
                  for k, v in {"enrol": enrol, **streams}.items()}
            api.invalidate_user_model_cache(mpath); shutil.rmtree(mpath, ignore_errors=True)
            rec["arms"][arm] = {**sc, "zeroStepShare": float((np.hypot(enrol[:, :, 0], enrol[:, :, 1]) == 0).mean()),
                                "windowsAvailable": int(len(enrol_arms[arm]))}
            tf.keras.backend.clear_session(); gc.collect()
        json.dump(rec, open(out_path + ".tmp", "w"))
        os.replace(out_path + ".tmp", out_path)
        shutil.rmtree(f"{MODELS}/{u}", ignore_errors=True)
        print(f"[K1 w{worker}] wrote {out_path}", flush=True)


def analyze():
    hashes = {**J.verify_frozen(), "preregistrationKSha256": J.sha(PREREG)}
    import repr_arch_analyze as RA
    from keystroke_user_sweep import auc_of, eer_of, tar_at_far
    recs = []
    for f in sorted(os.listdir(PARTS)):
        if f.endswith(".json"):
            r = json.load(open(os.path.join(PARTS, f)))
            for k, v in hashes.items():
                if r.get(k) != v:
                    raise SystemExit(f"{f}: produced under another {k}")
            if r["arms"].get("KEEP") and r["arms"].get("DROP"):
                recs.append(r)
    users = sorted(r["participant"] for r in recs)
    per = {"KEEP": {}, "DROP": {}}
    for r in recs:
        for arm in ("KEEP", "DROP"):
            d = r["arms"][arm]
            tau = float(np.percentile(d["enrol"], DEPLOYED["q"]))
            h = J.halves({"_genuineScores": d["genuine"], "_impostorRuns": d["impostor"]})[1]
            imp = np.concatenate(list(h["runs"].values()))
            x = J.per_user(h, tau, DEPLOYED["rule"], DEPLOYED["n"], DEPLOYED["k"])
            per[arm][r["participant"]] = {"auc": float(auc_of(h["g"], imp)), "eer": float(eer_of(h["g"], imp)[0]),
                                          "tar01": float(tar_at_far(h["g"], imp, 0.01)[0]), "threshold": tau,
                                          "promptsPerMin": x["promptsPerMin"], "runsCaught": float(np.mean(x["caught"])),
                                          "zeroStepShare": d["zeroStepShare"]}
    tests = {k: RA.boot([per["KEEP"][u][k] for u in users], [per["DROP"][u][k] for u in users])
             for k in ("auc", "eer", "tar01", "promptsPerMin", "runsCaught")}
    a = tests["auc"]
    verdict = ("clicks carry no measurable identity (AUC interval inside ±0.02)" if a["ci95"][0] >= -0.02 and a["ci95"][1] <= 0.02
               else "clicks matter: dropping them costs more than the margin" if a["ci95"][1] < -0.02
               else "dropping clicks helps by more than the margin" if a["ci95"][0] > 0.02 else "inconclusive")
    summ = {arm: {k: float(np.mean([per[arm][u][k] for u in users])) for k in ("auc", "eer", "tar01", "promptsPerMin", "runsCaught", "zeroStepShare")}
            for arm in ("KEEP", "DROP")}
    out = {**hashes, "phase": "K1", "users": users, "deployedPoint": DEPLOYED, "summary": summ, "tests": tests, "verdict": verdict}
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"K1: {len(users)} development targets, production recipe, 330 windows")
    for arm in ("KEEP", "DROP"):
        s = summ[arm]
        print(f"  {arm:4s}: AUC {s['auc']:.3f} EER {s['eer']*100:4.1f}% TAR@1% {s['tar01']*100:4.1f}% | prompts/min {s['promptsPerMin']:.2f} "
              f"runs caught {s['runsCaught']*100:5.1f}% | zero-movement steps in enrolment {s['zeroStepShare']*100:.1f}%")
    for k in ("auc", "eer", "tar01", "promptsPerMin", "runsCaught"):
        t = tests[k]
        print(f"  DROP - KEEP {k:14s} {t['meanDiff']:+.4f} [{t['ci95'][0]:+.4f}, {t['ci95'][1]:+.4f}] p {t['p']:.4f} | better for {t['bBetter']}/{t['n']}")
    print(f"  VERDICT: {verdict}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", type=int, default=0)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--analyze", action="store_true")
    a = ap.parse_args()
    analyze() if a.analyze else run(a.worker, a.workers)
