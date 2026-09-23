"""Protocol J, Phase P3: minimum sufficient enrolment (PREREGISTRATION_J.md, section 6).

Budgets E = 55..440 windows (1..8 samples of 55), 19 development targets, the P1 method (B) and the
P2 point fixed. For b >= 2 samples, Method B under the identity order and two rotations (threshold
stability); b = 1 cannot support B and is reported with Method A for reference only.

    python protocol_j_p3.py --worker 0 --workers 6   # trains + scores -> parts/J_P3/<user>.json
    python protocol_j_p3.py --analyze                # -> analysis_J_P3.json
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
BUDGETS = [SAMPLE * b for b in range(1, 9)]
PARTS = os.path.join(J.STUDY, "parts", "J_P3")
OUT = os.path.join(J.STUDY, "analysis_J_P3.json")
MODELS = "/app/artifacts/protocol_j/models/P3"


def orders_for(b):
    """Identity and two rotations (by 1 and 2 positions); duplicates removed for b <= 2."""
    out = []
    for r in (0, 1, 2):
        o = [(r + i) % b for i in range(b)]
        if o not in out:
            out.append(o)
    return out


def plan_A_b(order):
    arr = [t for s in order for t in P1.sample_idx(s)]
    n_val = int(round(0.2 * len(arr)))
    cut = len(arr) - n_val
    val = arr[cut:]
    return arr, P1.purge([arr[p] for p in range(0, max(cut - 5, 0))], set(val)), val


def run(worker, workers):
    hashes = J.verify_frozen()
    os.environ["MOUSE_BASE_MODEL_PATH"] = J.BASE80["base"]
    os.environ["MOUSE_SCALER_PATH"] = J.BASE80["scaler"]
    os.environ["MOUSE_NEG_DATASET_PATH"] = J.BASE80["neg"]
    import api
    import tensorflow as tf
    R = J.Reader("P3")
    dev = J.split()["development"]
    test = {u: R.windows(R.sessions(u)[1]) for u in dev if R.sessions(u)[1]}
    targets = [u for u in dev if R.sessions(u)[0] and len(R.windows(R.sessions(u)[0])) >= max(BUDGETS)]
    os.makedirs(PARTS, exist_ok=True)
    for u in targets[worker::workers]:
        out_path = os.path.join(PARTS, f"{u}.json")
        if os.path.exists(out_path):
            print(f"[P3 w{worker}] {u} done already"); continue
        full = R.windows(R.sessions(u)[0])
        streams = {"genuine": test[u], "impostor": {o: x[:J.IMP_RUN] for o, x in test.items() if o != u and len(x)}}
        rec = {**hashes, "phase": "P3", "participant": u, "budgets": {}}
        for E in BUDGETS:
            b = E // SAMPLE
            enrol = full[:E]
            ents = []
            for oi, order in enumerate(orders_for(b)):
                base = f"{MODELS}/{u}/E{E}/o{oi}"
                if b == 1:       # reference only: Method A
                    arr, tr, va = plan_A_b(order)
                    sc, info = P1.fit_and_score(api, f"j-p3-{u}-{E}-o{oi}-A", f"{base}/A", enrol, arr, tr, va, {"enrol": enrol, **streams})
                    ents.append({"order": order, "method": "A", "model": {**sc, "info": info}})
                    continue
                od, tr, va, _ = P1.plan_folds(order, [])
                sc, info = P1.fit_and_score(api, f"j-p3-{u}-{E}-o{oi}-F", f"{base}/F", enrol, od, tr, va, streams)
                oof = np.full(E, np.nan)
                for s in order:
                    od, tr, va, held = P1.plan_folds(order, [s])
                    hs, _ = P1.fit_and_score(api, f"j-p3-{u}-{E}-o{oi}-B{s}", f"{base}/B{s}", enrol, od, tr, va, {"held": enrol[held]})
                    oof[held] = hs["held"]
                ents.append({"order": order, "method": "B", "model": {**sc, "info": info}, "oof": [round(float(v), 6) for v in oof]})
            rec["budgets"][str(E)] = ents
            print(f"[P3 w{worker}] {u} E={E} ({len(ents)} orders)", flush=True)
            # Release TensorFlow's per-call state after every budget, not only after every user:
            # 124 trainings per user otherwise accumulate memory until the Docker VM stalls.
            tf.keras.backend.clear_session(); gc.collect()
        json.dump(rec, open(out_path + ".tmp", "w"))
        os.replace(out_path + ".tmp", out_path)
        shutil.rmtree(f"{MODELS}/{u}", ignore_errors=True)
        tf.keras.backend.clear_session(); gc.collect()
        print(f"[P3 w{worker}] wrote {out_path}", flush=True)


def analyze():
    hashes = J.verify_frozen()
    import repr_arch_analyze as RA
    from keystroke_user_sweep import auc_of, eer_of, tar_at_far
    p1 = json.load(open(P1.OUT))
    p2 = json.load(open(os.path.join(J.STUDY, "analysis_J_P2.json")))
    op, opA = p2["operatingPoint"], p1["methods"]["A"]["operatingPoint"]
    recs = []
    for f in sorted(os.listdir(PARTS)):
        if f.endswith(".json"):
            r = json.load(open(os.path.join(PARTS, f)))
            for k, v in hashes.items():
                if r.get(k) != v:
                    raise SystemExit(f"{f}: produced under another {k}")
            recs.append(r)
    users = sorted(r["participant"] for r in recs)
    per = {E: {} for E in BUDGETS}
    for r in recs:
        u = r["participant"]
        for E in BUDGETS:
            vals = []
            for e in r["budgets"][str(E)]:
                m = e["model"]
                src = np.asarray(m["enrol"] if e["method"] == "A" else e["oof"], float)
                o = opA if e["method"] == "A" else op
                tau = float(np.percentile(src, o["q"]))
                h = J.halves({"_genuineScores": m["genuine"], "_impostorRuns": m["impostor"]})[1]
                imp = np.concatenate(list(h["runs"].values()))
                x = J.per_user(h, tau, o["rule"], o["n"], o["k"])
                vals.append({"threshold": tau, "runsCaught": float(np.mean(x["caught"])), "promptsPerMin": x["promptsPerMin"],
                             "lowWindowRate": x["lowWindowRate"], "timeToCatch": float(np.median(x["times"])) if x["times"] else np.nan,
                             "auc": float(auc_of(h["g"], imp)), "eer": float(eer_of(h["g"], imp)[0]),
                             "tar01": float(tar_at_far(h["g"], imp, 0.01)[0])})
            mean = {k: float(np.nanmean([v[k] for v in vals])) for k in vals[0]}
            mean["thresholdSD"] = float(np.std([v["threshold"] for v in vals], ddof=1)) if len(vals) > 1 else None
            mean["method"] = r["budgets"][str(E)][0]["method"]
            per[E][u] = mean
    ref = max(BUDGETS)
    comp, selected = {}, None
    for E in BUDGETS:
        s = {k: float(np.nanmean([per[E][u][k] for u in users])) for k in ("runsCaught", "promptsPerMin", "auc", "eer", "tar01", "lowWindowRate", "timeToCatch", "threshold")}
        sd = [per[E][u]["thresholdSD"] for u in users if per[E][u]["thresholdSD"] is not None]
        s["thresholdSDMean"] = float(np.mean(sd)) if sd else None
        s["method"] = per[E][users[0]]["method"]
        s["enrolSeconds"] = round((50 + 10 * (E - 1)) * 0.0269, 1)
        c = {}
        if E != ref:
            c = {k: RA.boot([per[ref][u][k] for u in users], [per[E][u][k] for u in users]) for k in ("runsCaught", "auc", "promptsPerMin")}
            ok = (s["method"] == "B" and c["runsCaught"]["ci95"][0] >= -0.05 and c["auc"]["ci95"][0] >= -0.02
                  and c["promptsPerMin"]["ci95"][1] <= 0.1)
            c["meetsMargins"] = bool(ok)
            if ok and selected is None:
                selected = E
        comp[str(E)] = {"summary": s, "vs440": c}
    if selected is None:
        selected = ref
    out = {**hashes, "phase": "P3", "method": p2["method"], "operatingPoint": op, "referenceA": opA, "budgets": comp,
           "perUser": {str(E): per[E] for E in BUDGETS}, "selectedBudget": selected, "rerunP2": selected != 330}
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"P3: {len(users)} development targets, method {p2['method']} at its P2 point; E=55 with A for reference")
    for E in BUDGETS:
        s, c = comp[str(E)]["summary"], comp[str(E)]["vs440"]
        tail = "" if not c else (f" | vs 440: caught {c['runsCaught']['meanDiff']*100:+.1f} [{c['runsCaught']['ci95'][0]*100:+.1f}], "
                                 f"AUC {c['auc']['meanDiff']:+.3f} [{c['auc']['ci95'][0]:+.3f}], prompts {c['promptsPerMin']['meanDiff']:+.2f} "
                                 f"[..{c['promptsPerMin']['ci95'][1]:+.2f}] -> {'OK' if c['meetsMargins'] else 'no'}")
        print(f"  E={E:3d} ({s['enrolSeconds']:5.1f} s, {s['method']}): caught {s['runsCaught']*100:5.1f}% prompts {s['promptsPerMin']:.2f} "
              f"AUC {s['auc']:.3f} EER {s['eer']*100:4.1f}% thr SD {s['thresholdSDMean'] if s['thresholdSDMean'] is None else round(s['thresholdSDMean'],3)}{tail}")
    print(f"  SELECTED enrolment budget: {selected} windows ({selected // SAMPLE} samples); re-run P2 at this budget: {selected != 330}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", type=int, default=0)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--analyze", action="store_true")
    a = ap.parse_args()
    analyze() if a.analyze else run(a.worker, a.workers)
