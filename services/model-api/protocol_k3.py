"""Pre-registration K, K3: one confirmation on a second untouched group (PREREGISTRATION_K.md §K3).

S0 (deployed: 330 windows, Method A, 1st percentile, vote 30 of 60) against S2 (K2's budget: the whole
3-minute session, Method B, the point re-selected on the development calibration halves at that budget)
on 20 users drawn for K3, with the shared network retrained on the remaining 60 base users. Scored once.

    python protocol_k3.py --worker 0 --workers 2   # -> parts/K3/<user>.json
    python protocol_k3.py --analyze                # -> analysis_K3.json
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

SAMPLE = 55
PARTS = os.path.join(J.STUDY, "parts", "K3")
OUT = os.path.join(J.STUDY, "analysis_K3.json")
MODELS = "/app/artifacts/protocol_j/models/K3"
SPLIT3 = os.path.join(J.STUDY, "SPLIT_K3.json")
PREREG = os.path.join(J.STUDY, "PREREGISTRATION_K.md")
BASE60 = {"base": "/app/artifacts/mouse-fcn-a5-k60/final_model",
          "scaler": "/app/artifacts/mouse-fcn-a5-k60/scaler.json",
          "neg": "/app/data/mouse_only/Mouse_A5_W50_base60.h5"}
S0 = {"name": "S0", "budget": 330, "method": "A", "q": 1, "rule": "vote", "n": 60, "k": 30}


def s2_point():
    op = json.load(open(os.path.join(J.STUDY, "analysis_K2_point.json")))["operatingPoint"]
    return {"name": "S2", "budget": "FULL", "method": "B", **{k: op[k] for k in ("q", "rule", "n", "k")}}


def hashes():
    return {**J.verify_frozen(), "preregistrationKSha256": J.sha(PREREG), "splitK3Sha256": J.sha(SPLIT3)}


class K3Reader(J.Reader):
    """Reads the second untouched group; still refuses the first lockbox."""

    def __init__(self):
        super().__init__("K3")
        self.allowed = set(json.load(open(SPLIT3))["lockbox2"])

    def sessions(self, u):
        if u in self.allowed:
            import glob
            cs = sorted(glob.glob(os.path.join(J.DATA, u, "*.csv")))
            lo = [c for c in cs if "3min" in os.path.basename(c)]
            sh = [c for c in cs if "1min" in os.path.basename(c)]
            return (lo[0] if lo else None), (sh[0] if sh else None)
        return super().sessions(u)


def run(worker, workers):
    H = hashes()
    S2 = s2_point()
    for p in BASE60.values():
        if not os.path.exists(p):
            raise SystemExit(f"base-60 artefact missing: {p}")
    os.environ["MOUSE_BASE_MODEL_PATH"] = BASE60["base"]
    os.environ["MOUSE_SCALER_PATH"] = BASE60["scaler"]
    os.environ["MOUSE_NEG_DATASET_PATH"] = BASE60["neg"]
    import api
    import tensorflow as tf
    R = K3Reader()
    lock2 = json.load(open(SPLIT3))["lockbox2"]
    test = {u: R.windows(R.sessions(u)[1]) for u in lock2 if R.sessions(u)[1]}
    targets = [u for u in lock2 if R.sessions(u)[0] and len(R.windows(R.sessions(u)[0])) >= 650]
    os.makedirs(PARTS, exist_ok=True)
    for u in targets[worker::workers]:
        out_path = os.path.join(PARTS, f"{u}.json")
        if os.path.exists(out_path):
            print(f"[K3 w{worker}] {u} done already"); continue
        full = R.windows(R.sessions(u)[0])
        streams = {"genuine": test[u], "impostor": {o: x[:J.IMP_RUN] for o, x in test.items() if o != u and len(x)}}
        rec = {**H, "phase": "K3", "participant": u, "sessionWindows": int(len(full)), "systems": {}}

        enrol0 = full[:S0["budget"]]
        mpath = f"{MODELS}/{u}/S0"
        res, code = api.train_user_payload({
            "userId": f"k3-{u}-S0", "modality": "mouse", "modelPath": mpath, "positiveWindows": enrol0.tolist(),
            "overlapGap": 5, "minPositiveWindows": S0["budget"], "epochs": 15, "batchSize": 32})
        if code != 200:
            raise RuntimeError(f"{u} S0: train failed {code} {res}")
        sc = {k: (P1._pred(api, f"k3-{u}-S0", mpath, v) if not isinstance(v, dict)
                  else {kk: P1._pred(api, f"k3-{u}-S0", mpath, vv) for kk, vv in v.items()})
              for k, v in {"enrol": enrol0, **streams}.items()}
        api.invalidate_user_model_cache(mpath); shutil.rmtree(mpath, ignore_errors=True)
        rec["systems"]["S0"] = {**sc, "windows": int(len(enrol0))}
        tf.keras.backend.clear_session(); gc.collect()

        E = (len(full) // SAMPLE) * SAMPLE
        enrol2 = full[:E]
        order = list(range(E // SAMPLE))
        od, tr, va, _ = P1.plan_folds(order, [])
        sc, info = P1.fit_and_score(api, f"k3-{u}-S2-F", f"{MODELS}/{u}/S2F", enrol2, od, tr, va, streams)
        oof = np.full(E, np.nan)
        for s in order:
            od, tr, va, held = P1.plan_folds(order, [s])
            hs, _ = P1.fit_and_score(api, f"k3-{u}-S2-B{s}", f"{MODELS}/{u}/S2B{s}", enrol2, od, tr, va, {"held": enrol2[held]})
            oof[held] = hs["held"]
        rec["systems"]["S2"] = {**sc, "oof": [round(float(v), 6) for v in oof], "windows": int(E), "info": info}
        json.dump(rec, open(out_path + ".tmp", "w"))
        os.replace(out_path + ".tmp", out_path)
        shutil.rmtree(f"{MODELS}/{u}", ignore_errors=True)
        tf.keras.backend.clear_session(); gc.collect()
        print(f"[K3 w{worker}] wrote {out_path} (S2 on {E} windows)", flush=True)


def analyze():
    H = hashes()
    S2 = s2_point()
    import repr_arch_analyze as RA
    from keystroke_user_sweep import auc_of, eer_of, tar_at_far
    recs = []
    for f in sorted(os.listdir(PARTS)):
        if f.endswith(".json"):
            r = json.load(open(os.path.join(PARTS, f)))
            for k, v in H.items():
                if r.get(k) != v:
                    raise SystemExit(f"{f}: produced under another {k}")
            recs.append(r)
    users = sorted(r["participant"] for r in recs)
    per = {"S0": {}, "S2": {}}
    for r in recs:
        for S in (S0, S2):
            d = r["systems"][S["name"]]
            src = np.asarray(d["enrol"] if S["method"] == "A" else d["oof"], float)
            tau = float(np.percentile(src, S["q"]))
            h = {"g": np.asarray(d["genuine"], float), "runs": {k: np.asarray(v, float) for k, v in d["impostor"].items()}}
            x = J.per_user(h, tau, S["rule"], S["n"], S["k"])
            imp = np.concatenate(list(h["runs"].values()))
            per[S["name"]][r["participant"]] = {
                "threshold": tau, "windows": d["windows"], "promptsPerMin": x["promptsPerMin"], "prompts": x["prompts"],
                "runsCaught": float(np.mean(x["caught"])), "timeToCatchMedianS": float(np.median(x["times"])) if x["times"] else None,
                "auc": float(auc_of(h["g"], imp)), "eer": float(eer_of(h["g"], imp)[0]), "tar01": float(tar_at_far(h["g"], imp, 0.01)[0])}
    summ = {}
    for name in ("S0", "S2"):
        p = per[name]
        summ[name] = {k: float(np.nanmean([p[u][k] for u in users])) for k in ("promptsPerMin", "runsCaught", "auc", "eer", "tar01", "threshold", "windows")}
        summ[name]["usersNeverPrompted"] = int(sum(p[u]["prompts"] == 0 for u in users))
        summ[name]["usersBelow80pctCapture"] = int(sum(p[u]["runsCaught"] < 0.8 for u in users))
        t = [p[u]["timeToCatchMedianS"] for u in users if p[u]["timeToCatchMedianS"] is not None]
        summ[name]["timeToCatchMedianS"] = float(np.median(t)) if t else None
    tests = {k: RA.boot([per["S0"][u][k] for u in users], [per["S2"][u][k] for u in users])
             for k in ("promptsPerMin", "runsCaught", "auc", "eer", "tar01")}
    for k, ph in zip(("promptsPerMin", "runsCaught"), RA.holm([tests["promptsPerMin"]["p"], tests["runsCaught"]["p"]])):
        tests[k]["pHolm"] = float(ph)
    margins = tests["promptsPerMin"]["ci95"][1] <= 0.1 and tests["runsCaught"]["ci95"][0] >= -0.05
    improved = (tests["promptsPerMin"]["meanDiff"] < 0 and tests["promptsPerMin"]["pHolm"] < 0.05) or \
               (tests["runsCaught"]["meanDiff"] > 0 and tests["runsCaught"]["pHolm"] < 0.05)
    decision = "S2 is better" if (margins and improved) else "S0 stands"
    security_first = {"S2reaches90pctCapture": bool(summ["S2"]["runsCaught"] >= 0.90),
                      "S2promptsPerMin": summ["S2"]["promptsPerMin"], "S0capture": summ["S0"]["runsCaught"],
                      "S0promptsPerMin": summ["S0"]["promptsPerMin"]}
    out = {**H, "phase": "K3", "users": users, "S0": S0, "S2": S2, "base": BASE60, "summary": summ,
           "tests": tests, "marginsMet": bool(margins), "significantImprovement": bool(improved),
           "decision": decision, "securityFirstReading": security_first, "perUser": per}
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"K3 (second untouched group, {len(users)} users, scored once; base trained on 60 users)")
    for name in ("S0", "S2"):
        s = summ[name]
        print(f"  {name}: {s['windows']:.0f} enrolment windows | prompts/min {s['promptsPerMin']:.2f} (never prompted {s['usersNeverPrompted']}/{len(users)}) | "
              f"runs caught {s['runsCaught']*100:.1f}% (users <80%: {s['usersBelow80pctCapture']}) | time to catch {s['timeToCatchMedianS']} | "
              f"AUC {s['auc']:.3f} EER {s['eer']*100:.1f}%")
    for k in ("promptsPerMin", "runsCaught", "auc", "eer", "tar01"):
        t = tests[k]
        ph = f" pHolm {t['pHolm']:.4f}" if "pHolm" in t else ""
        print(f"  S2 - S0 {k:14s} {t['meanDiff']:+.4f} [{t['ci95'][0]:+.4f}, {t['ci95'][1]:+.4f}] p {t['p']:.4f}{ph} | better for {t['bBetter']}/{t['n']}")
    print(f"  margins met: {margins} | significant improvement: {improved} -> DECISION: {decision}")
    print(f"  security-first reading: {security_first}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", type=int, default=0)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--analyze", action="store_true")
    a = ap.parse_args()
    analyze() if a.analyze else run(a.worker, a.workers)
