"""Protocol J, Phase P6: the single lockbox evaluation (PREREGISTRATION_J.md §6, AMENDMENT_J1.md §2-3).

S0 (deployed: 330 windows, model-api's contiguous tail, 1st percentile, vote 30 of 60) against
S1 (new: 440 windows, leave-one-sample-out threshold at the 20th percentile, vote 33 of 60) on the 20
lockbox users, which no earlier phase has read. Scored once.

    python protocol_j_p6.py --worker 0 --workers 2   # -> parts/J_P6/<user>.json
    python protocol_j_p6.py --analyze                # -> analysis_J_P6.json
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

PARTS = os.path.join(J.STUDY, "parts", "J_P6")
OUT = os.path.join(J.STUDY, "analysis_J_P6.json")
MODELS = "/app/artifacts/protocol_j/models/P6"
AMEND = os.path.join(J.STUDY, "AMENDMENT_J1.md")
S0 = {"name": "S0", "budget": 330, "method": "A", "q": 1, "rule": "vote", "n": 60, "k": 30}
S1 = {"name": "S1", "budget": 440, "method": "B", "q": 20, "rule": "vote", "n": 60, "k": 33}


def run(worker, workers):
    hashes = {**J.verify_frozen(), "amendmentJ1Sha256": J.sha(AMEND)}
    os.environ["MOUSE_BASE_MODEL_PATH"] = J.BASE80["base"]
    os.environ["MOUSE_SCALER_PATH"] = J.BASE80["scaler"]
    os.environ["MOUSE_NEG_DATASET_PATH"] = J.BASE80["neg"]
    import api
    import tensorflow as tf
    R = J.Reader("P6")                       # the only phase allowed to read lockbox users
    lock = J.split()["lockbox"]
    test = {u: R.windows(R.sessions(u)[1]) for u in lock if R.sessions(u)[1]}
    targets = [u for u in lock if R.sessions(u)[0] and len(R.windows(R.sessions(u)[0])) >= S1["budget"]]
    os.makedirs(PARTS, exist_ok=True)
    for u in targets[worker::workers]:
        out_path = os.path.join(PARTS, f"{u}.json")
        if os.path.exists(out_path):
            print(f"[P6 w{worker}] {u} done already"); continue
        full = R.windows(R.sessions(u)[0])
        streams = {"genuine": test[u], "impostor": {o: x[:J.IMP_RUN] for o, x in test.items() if o != u and len(x)}}
        rec = {**hashes, "phase": "P6", "participant": u, "systems": {}}

        # ---- S0: exactly the production recipe (contiguous tail, no explicit split) ----
        enrol0 = full[:S0["budget"]]
        mpath = f"{MODELS}/{u}/S0"
        res, code = api.train_user_payload({
            "userId": f"j-p6-{u}-S0", "modality": "mouse", "modelPath": mpath,
            "positiveWindows": enrol0.tolist(), "overlapGap": 5, "minPositiveWindows": S0["budget"],
            "epochs": 15, "batchSize": 32})
        if code != 200:
            raise RuntimeError(f"{u} S0: train failed {code} {res}")
        sc = {k: (P1._pred(api, f"j-p6-{u}-S0", mpath, v) if not isinstance(v, dict)
                  else {kk: P1._pred(api, f"j-p6-{u}-S0", mpath, vv) for kk, vv in v.items()})
              for k, v in {"enrol": enrol0, **streams}.items()}
        api.invalidate_user_model_cache(mpath); shutil.rmtree(mpath, ignore_errors=True)
        rec["systems"]["S0"] = {**sc, "info": {"negatives": res.get("negativeWindowCount"), "split": res.get("splitStrategy")}}
        tf.keras.backend.clear_session(); gc.collect()

        # ---- S1: 8 samples, leave-one-sample-out threshold ----
        enrol1 = full[:S1["budget"]]
        order = list(range(S1["budget"] // 55))
        od, tr, va, _ = P1.plan_folds(order, [])
        sc, info = P1.fit_and_score(api, f"j-p6-{u}-S1-F", f"{MODELS}/{u}/S1F", enrol1, od, tr, va, streams)
        oof = np.full(S1["budget"], np.nan)
        for s in order:
            od, tr, va, held = P1.plan_folds(order, [s])
            hs, _ = P1.fit_and_score(api, f"j-p6-{u}-S1-B{s}", f"{MODELS}/{u}/S1B{s}", enrol1, od, tr, va, {"held": enrol1[held]})
            oof[held] = hs["held"]
        rec["systems"]["S1"] = {**sc, "oof": [round(float(v), 6) for v in oof], "info": info}
        json.dump(rec, open(out_path + ".tmp", "w"))
        os.replace(out_path + ".tmp", out_path)
        shutil.rmtree(f"{MODELS}/{u}", ignore_errors=True)
        tf.keras.backend.clear_session(); gc.collect()
        print(f"[P6 w{worker}] wrote {out_path}", flush=True)


def analyze():
    hashes = {**J.verify_frozen(), "amendmentJ1Sha256": J.sha(AMEND)}
    import repr_arch_analyze as RA
    from keystroke_user_sweep import auc_of, eer_of, tar_at_far
    recs = []
    for f in sorted(os.listdir(PARTS)):
        if f.endswith(".json"):
            r = json.load(open(os.path.join(PARTS, f)))
            for k, v in hashes.items():
                if r.get(k) != v:
                    raise SystemExit(f"{f}: produced under another {k}")
            recs.append(r)
    users = sorted(r["participant"] for r in recs)
    per = {"S0": {}, "S1": {}}
    for r in recs:
        u = r["participant"]
        for S in (S0, S1):
            d = r["systems"][S["name"]]
            src = np.asarray(d["enrol"] if S["method"] == "A" else d["oof"], float)
            tau = float(np.percentile(src, S["q"]))
            h = {"g": np.asarray(d["genuine"], float), "runs": {k: np.asarray(v, float) for k, v in d["impostor"].items()}}
            x = J.per_user(h, tau, S["rule"], S["n"], S["k"])
            imp = np.concatenate(list(h["runs"].values()))
            per[S["name"]][u] = {"threshold": tau, "promptsPerMin": x["promptsPerMin"], "prompts": x["prompts"],
                                 "interruption": x["interruption"], "lowWindowRate": x["lowWindowRate"],
                                 "runsCaught": float(np.mean(x["caught"])), "impostorRuns": len(x["caught"]),
                                 "timeToCatchMedianS": float(np.median(x["times"])) if x["times"] else None,
                                 "auc": float(auc_of(h["g"], imp)), "eer": float(eer_of(h["g"], imp)[0]),
                                 "tar01": float(tar_at_far(h["g"], imp, 0.01)[0])}
    summ = {}
    for name in ("S0", "S1"):
        p = per[name]
        summ[name] = {k: float(np.nanmean([p[u][k] for u in users])) for k in ("promptsPerMin", "runsCaught", "auc", "eer", "tar01", "lowWindowRate", "threshold")}
        summ[name]["promptsPerMinMedian"] = float(np.nanmedian([p[u]["promptsPerMin"] for u in users]))
        summ[name]["usersNeverPrompted"] = int(sum(p[u]["prompts"] == 0 for u in users))
        t = [p[u]["timeToCatchMedianS"] for u in users if p[u]["timeToCatchMedianS"] is not None]
        summ[name]["timeToCatchMedianS"] = float(np.median(t)) if t else None
        summ[name]["usersBelow80pctCapture"] = int(sum(p[u]["runsCaught"] < 0.8 for u in users))
    tests = {k: RA.boot([per["S0"][u][k] for u in users], [per["S1"][u][k] for u in users])
             for k in ("promptsPerMin", "runsCaught", "auc", "eer", "tar01")}
    for k, ph in zip(("promptsPerMin", "runsCaught"), RA.holm([tests["promptsPerMin"]["p"], tests["runsCaught"]["p"]])):
        tests[k]["pHolm"] = float(ph)
    margins_ok = tests["promptsPerMin"]["ci95"][1] <= 0.1 and tests["runsCaught"]["ci95"][0] >= -0.05
    improved = (tests["promptsPerMin"]["meanDiff"] < 0 and tests["promptsPerMin"]["pHolm"] < 0.05) or \
               (tests["runsCaught"]["meanDiff"] > 0 and tests["runsCaught"]["pHolm"] < 0.05)
    decision = "S1 is better" if (margins_ok and improved) else "S0 stands"
    out = {**hashes, "phase": "P6", "users": users, "S0": S0, "S1": S1, "summary": summ, "tests": tests,
           "marginsMet": bool(margins_ok), "significantImprovement": bool(improved), "decision": decision, "perUser": per}
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"P6 (lockbox, {len(users)} users, scored once)")
    for name in ("S0", "S1"):
        s = summ[name]
        print(f"  {name}: prompts/min {s['promptsPerMin']:.2f} (median {s['promptsPerMinMedian']:.2f}, never prompted "
              f"{s['usersNeverPrompted']}/{len(users)}) | runs caught {s['runsCaught']*100:.1f}% (users <80%: {s['usersBelow80pctCapture']}) | "
              f"time to catch {s['timeToCatchMedianS']} | AUC {s['auc']:.3f} EER {s['eer']*100:.1f}% TAR@1% {s['tar01']*100:.1f}%")
    for k in ("promptsPerMin", "runsCaught", "auc", "eer", "tar01"):
        t = tests[k]
        ph = f" pHolm {t['pHolm']:.4f}" if "pHolm" in t else ""
        print(f"  S1 - S0 {k:14s} {t['meanDiff']:+.4f} [{t['ci95'][0]:+.4f}, {t['ci95'][1]:+.4f}] p {t['p']:.4f}{ph} | better for {t['bBetter']}/{t['n']}")
    print(f"  margins met: {margins_ok} | significant improvement: {improved} -> DECISION: {decision}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", type=int, default=0)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--analyze", action="store_true")
    a = ap.parse_args()
    analyze() if a.analyze else run(a.worker, a.workers)
