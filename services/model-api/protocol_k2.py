"""Pre-registration K, K2: enrolment length up to SapiMouse's own 3-minute session.

Budgets 330, 440, 550 and FULL (every window of the user's 3-minute session), Method B
(leave-one-sample-out over 55-window samples) at the P2b point (20th percentile of the out-of-sample
scores, vote 33 of the last 60). Identity order at 330/440/550 and three orders at FULL
(AMENDMENT_K2.md). Development users only; the lockboxes are never read here.

    python protocol_k2.py --worker 0 --workers 3   # -> parts/K2/<user>.json
    python protocol_k2.py --analyze                # -> analysis_K2.json
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
import protocol_j_p3 as P3  # noqa: E402

SAMPLE = 55
FIXED = [330, 440, 550]
PARTS = os.path.join(J.STUDY, "parts", "K2")
OUT = os.path.join(J.STUDY, "analysis_K2.json")
MODELS = "/app/artifacts/protocol_j/models/K2"
PREREG = os.path.join(J.STUDY, "PREREGISTRATION_K.md")
AMEND = os.path.join(J.STUDY, "AMENDMENT_K2.md")


def point():
    p2b = os.path.join(J.STUDY, "analysis_J_P2b.json")
    return json.load(open(p2b))["operatingPoint"]


def budgets_for(n):
    """Fixed budgets the session supports, then FULL = whole session (a whole number of samples)."""
    out = [(E, 1) for E in FIXED if E <= n]
    full = (n // SAMPLE) * SAMPLE
    if full > (out[-1][0] if out else 0):
        out.append((full, 3))
    return out


def run(worker, workers):
    hashes = {**J.verify_frozen(), "preregistrationKSha256": J.sha(PREREG), "amendmentK2Sha256": J.sha(AMEND)}
    os.environ["MOUSE_BASE_MODEL_PATH"] = J.BASE80["base"]
    os.environ["MOUSE_SCALER_PATH"] = J.BASE80["scaler"]
    os.environ["MOUSE_NEG_DATASET_PATH"] = J.BASE80["neg"]
    import api
    import tensorflow as tf
    R = J.Reader("K2")
    dev = J.split()["development"]
    test = {u: R.windows(R.sessions(u)[1]) for u in dev if R.sessions(u)[1]}
    targets = [u for u in dev if R.sessions(u)[0] and len(R.windows(R.sessions(u)[0])) >= 440]
    os.makedirs(PARTS, exist_ok=True)
    for u in targets[worker::workers]:
        out_path = os.path.join(PARTS, f"{u}.json")
        if os.path.exists(out_path):
            print(f"[K2 w{worker}] {u} done already"); continue
        full = R.windows(R.sessions(u)[0])
        streams = {"genuine": test[u], "impostor": {o: x[:J.IMP_RUN] for o, x in test.items() if o != u and len(x)}}
        rec = {**hashes, "phase": "K2", "participant": u, "sessionWindows": int(len(full)), "budgets": {}}
        for E, n_orders in budgets_for(len(full)):
            enrol = full[:E]
            b = E // SAMPLE
            ents = []
            for oi, order in enumerate(P3.orders_for(b)[:n_orders]):
                base = f"{MODELS}/{u}/E{E}/o{oi}"
                od, tr, va, _ = P1.plan_folds(order, [])
                sc, info = P1.fit_and_score(api, f"k2-{u}-{E}-o{oi}-F", f"{base}/F", enrol, od, tr, va, streams)
                oof = np.full(E, np.nan)
                for s in order:
                    od, tr, va, held = P1.plan_folds(order, [s])
                    hs, _ = P1.fit_and_score(api, f"k2-{u}-{E}-o{oi}-B{s}", f"{base}/B{s}", enrol, od, tr, va, {"held": enrol[held]})
                    oof[held] = hs["held"]
                ents.append({"order": order, "model": {**sc, "info": info}, "oof": [round(float(v), 6) for v in oof]})
            rec["budgets"][str(E)] = ents
            print(f"[K2 w{worker}] {u} E={E} ({b} samples, {len(ents)} order(s))", flush=True)
            tf.keras.backend.clear_session(); gc.collect()
        json.dump(rec, open(out_path + ".tmp", "w"))
        os.replace(out_path + ".tmp", out_path)
        shutil.rmtree(f"{MODELS}/{u}", ignore_errors=True)
        print(f"[K2 w{worker}] wrote {out_path}", flush=True)


def analyze():
    hashes = {**J.verify_frozen(), "preregistrationKSha256": J.sha(PREREG), "amendmentK2Sha256": J.sha(AMEND)}
    import repr_arch_analyze as RA
    from keystroke_user_sweep import auc_of, eer_of, tar_at_far
    op = point()
    recs = []
    for f in sorted(os.listdir(PARTS)):
        if f.endswith(".json"):
            r = json.load(open(os.path.join(PARTS, f)))
            for k, v in hashes.items():
                if r.get(k) != v:
                    raise SystemExit(f"{f}: produced under another {k}")
            recs.append(r)
    users = sorted(r["participant"] for r in recs)
    per = {}                                    # per[label][user] = metrics
    for r in recs:
        u = r["participant"]
        full_E = max(int(E) for E in r["budgets"])
        for E, ents in r["budgets"].items():
            label = "FULL" if int(E) == full_E else E
            vals = []
            for e in ents:
                m = e["model"]
                tau = float(np.percentile(np.asarray(e["oof"], float), op["q"]))
                h = J.halves({"_genuineScores": m["genuine"], "_impostorRuns": m["impostor"]})[1]
                imp = np.concatenate(list(h["runs"].values()))
                x = J.per_user(h, tau, op["rule"], op["n"], op["k"])
                vals.append({"threshold": tau, "runsCaught": float(np.mean(x["caught"])), "promptsPerMin": x["promptsPerMin"],
                             "auc": float(auc_of(h["g"], imp)), "eer": float(eer_of(h["g"], imp)[0]),
                             "tar01": float(tar_at_far(h["g"], imp, 0.01)[0]),
                             "timeToCatch": float(np.median(x["times"])) if x["times"] else np.nan})
            d = {k: float(np.nanmean([v[k] for v in vals])) for k in vals[0]}
            d["thresholdSD"] = float(np.std([v["threshold"] for v in vals], ddof=1)) if len(vals) > 1 else None
            d["windows"] = int(E)
            per.setdefault(label, {})[u] = d
    ref = "FULL"
    labels = [x for x in ("330", "440", "550") if x in per] + [ref]
    comp, selected = {}, None
    for lab in labels:
        common = [u for u in users if u in per[lab] and u in per[ref]]
        s = {k: float(np.nanmean([per[lab][u][k] for u in common])) for k in ("runsCaught", "promptsPerMin", "auc", "eer", "tar01", "threshold", "timeToCatch", "windows")}
        sd = [per[lab][u]["thresholdSD"] for u in common if per[lab][u]["thresholdSD"] is not None]
        s["thresholdSDMean"] = float(np.mean(sd)) if sd else None
        s["users"] = len(common)
        s["enrolSeconds"] = round((50 + 10 * (s["windows"] - 1)) * 0.0269, 1)
        c = {}
        if lab != ref:
            c = {k: RA.boot([per[ref][u][k] for u in common], [per[lab][u][k] for u in common]) for k in ("runsCaught", "auc", "promptsPerMin")}
            c["meetsMargins"] = bool(c["runsCaught"]["ci95"][0] >= -0.05 and c["auc"]["ci95"][0] >= -0.02 and c["promptsPerMin"]["ci95"][1] <= 0.1)
            if c["meetsMargins"] and selected is None:
                selected = lab
        comp[lab] = {"summary": s, "vsFull": c}
    if selected is None:
        selected = ref
    out = {**hashes, "phase": "K2", "operatingPoint": op, "users": users, "budgets": comp,
           "perUser": per, "selected": selected,
           "selectedWindowsMean": comp[selected]["summary"]["windows"], "proposesChange": selected != "330"}
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"K2: {len(users)} development targets, method B at the {op['q']}th percentile, vote {op['k']} of {op['n']}")
    for lab in labels:
        s, c = comp[lab]["summary"], comp[lab]["vsFull"]
        tail = "" if not c else (f" | vs FULL: caught {c['runsCaught']['meanDiff']*100:+.1f} [{c['runsCaught']['ci95'][0]*100:+.1f}], "
                                 f"AUC {c['auc']['meanDiff']:+.3f} [{c['auc']['ci95'][0]:+.3f}], prompts {c['promptsPerMin']['meanDiff']:+.2f} "
                                 f"[..{c['promptsPerMin']['ci95'][1]:+.2f}] -> {'OK' if c['meetsMargins'] else 'no'}")
        print(f"  {lab:>4} ({s['windows']:4.0f} windows, {s['enrolSeconds']:5.1f} s, n={s['users']:2d}): caught {s['runsCaught']*100:5.1f}% "
              f"prompts {s['promptsPerMin']:.2f} AUC {s['auc']:.3f} EER {s['eer']*100:4.1f}%{tail}")
    print(f"  SELECTED: {selected} (proposes a product change: {out['proposesChange']}) -> K3 confirms on a second untouched group")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", type=int, default=0)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--analyze", action="store_true")
    a = ap.parse_args()
    analyze() if a.analyze else run(a.worker, a.workers)
