"""Protocol J, Phase P0 (artifacts/repr_arch_study/PREREGISTRATION_J.md, section 6).

The current system S0 (Method A: model-api's contiguous validation tail, threshold = 1st percentile of
the enrolment scores, vote 30 of the last 60, 330 enrolment windows) re-measured on the development
users with the base-80 model (artifacts/mouse-fcn-a5-j80). A development sanity report: it decides
nothing. Lockbox users are never read.

    python protocol_j_p0.py            # trains + scores  -> parts/J_P0_S0.json
    python protocol_j_p0.py --analyze  #                   -> analysis_J_P0.json
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import protocol_j_common as J  # noqa: E402

BUDGET = 330
S0 = {"method": "A", "q": 1, "rule": "vote", "n": 60, "k": 30}
PART = os.path.join(J.STUDY, "parts", "J_P0_S0.json")
OUT = os.path.join(J.STUDY, "analysis_J_P0.json")


def run():
    hashes = J.verify_frozen()
    for p in J.BASE80.values():
        if not os.path.exists(p):
            raise SystemExit(f"base-80 artefact missing: {p} (run train_mouse_fcn.py first)")
    os.environ["MOUSE_BASE_MODEL_PATH"] = J.BASE80["base"]
    os.environ["MOUSE_SCALER_PATH"] = J.BASE80["scaler"]
    os.environ["MOUSE_NEG_DATASET_PATH"] = J.BASE80["neg"]
    import api                                           # reads the paths above at import time

    R = J.Reader("P0")
    dev = J.split()["development"]
    test = {u: R.windows(R.sessions(u)[1]) for u in dev if R.sessions(u)[1]}
    targets = [u for u in dev if R.sessions(u)[0] and len(R.windows(R.sessions(u)[0])) >= BUDGET]
    print(f"[P0] {len(targets)} targets, {len(test)} impostor sources | base {J.BASE80['base']}")
    rows = []
    for u in targets:
        enrol = R.windows(R.sessions(u)[0])[:BUDGET]
        mpath = f"/app/artifacts/protocol_j/models/P0/{u}/mouse_model"
        res, code = api.train_user_payload({
            "userId": f"j-p0-{u}", "modality": "mouse", "modelPath": mpath,
            "positiveWindows": enrol.tolist(), "overlapGap": 5, "minPositiveWindows": BUDGET,
            "epochs": 15, "batchSize": 32})
        if code != 200:
            raise RuntimeError(f"{u}: train failed {code} {res}")

        def P(X):
            r, c = api.predict_user_payload({"userId": f"j-p0-{u}", "modality": "mouse",
                                             "modelPath": mpath, "windows": X.tolist()})
            if c != 200:
                raise RuntimeError(f"{u}: predict failed {c} {r}")
            return [float(p[1]) for p in r["prediction"]]
        rows.append({"participant": u, "trainedFrom": res.get("trainedFrom"),
                     "negativeSource": res.get("negativeSource"), "negativeWindowCount": res.get("negativeWindowCount"),
                     "enrolScorePercentiles": res.get("enrolScorePercentiles"),
                     "_enrolScores": P(enrol), "_genuineScores": P(test[u]),
                     "_impostorRuns": {o: P(x[:J.IMP_RUN]) for o, x in test.items() if o != u and len(x)}})
        print(f"  {u:>8}  from={res.get('trainedFrom')} neg={res.get('negativeWindowCount')} ({res.get('negativeSource')})")
    os.makedirs(os.path.dirname(PART), exist_ok=True)
    json.dump({**hashes, "phase": "P0", "system": S0, "budget": BUDGET, "base": J.BASE80, "perUser": rows},
              open(PART, "w"))
    print(f"wrote {PART}")


def analyze():
    hashes = J.verify_frozen()
    from keystroke_user_sweep import auc_of, eer_of, tar_at_far
    P = json.load(open(PART))
    for k, v in hashes.items():
        if P.get(k) != v:
            raise SystemExit(f"{PART} was produced under another {k}; refusing")
    per, per_every = {}, {}
    for u in P["perUser"]:
        cal, tst = J.halves(u)
        tau = float(np.percentile(u["_enrolScores"], S0["q"]))
        imp = np.concatenate(list(tst["runs"].values()))
        r = J.per_user(tst, tau, S0["rule"], S0["n"], S0["k"])
        per[u["participant"]] = {"threshold": tau, "auc": float(auc_of(tst["g"], imp)),
                                 "eer": float(eer_of(tst["g"], imp)[0]), "tar01": float(tar_at_far(tst["g"], imp, 0.01)[0]),
                                 **{k: v for k, v in r.items() if k not in ("caught", "times")},
                                 "runsCaught": float(np.mean(r["caught"])), "impostorRuns": len(r["caught"]),
                                 "timeToCatchMedianS": float(np.median(r["times"])) if r["times"] else None}
        per_every[u["participant"]] = J.per_user(tst, tau, S0["rule"], S0["n"], S0["k"], cadence=1)
    # Pooled capture and times need the raw per-run lists, so the live summary uses the replays.
    full = {}
    for u in P["perUser"]:
        cal, tst = J.halves(u)
        tau = per[u["participant"]]["threshold"]
        full[u["participant"]] = J.per_user(tst, tau, S0["rule"], S0["n"], S0["k"])
    live = J.summary(full)
    every = J.summary(per_every)
    win = {m: {"mean": float(np.mean([v[m] for v in per.values()])), "median": float(np.median([v[m] for v in per.values()]))}
           for m in ("auc", "eer", "tar01", "threshold", "lowWindowRate")}
    out = {**hashes, "phase": "P0", "note": "development sanity report (decides nothing); development test halves",
           "system": S0, "targets": len(per), "perWindow": win, "liveCadence": live, "everyWindowCadence": every,
           "perUser": per}
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"S0 on base-80, {len(per)} development targets, test halves")
    print("  per window: AUC mean %.3f median %.3f | EER mean %.1f%% | TAR@FAR1%% mean %.1f%%" %
          (win["auc"]["mean"], win["auc"]["median"], win["eer"]["mean"] * 100, win["tar01"]["mean"] * 100))
    for name, s in (("live cadence (6)", live), ("every window", every)):
        print(f"  {name:17s}: prompts/min mean {s['promptsPerMinMean']:.2f} median {s['promptsPerMinMedian']:.2f} | never prompted "
              f"{s['usersNeverPrompted']*100:.0f}% | interruption {s['interruptionMean']*100:.1f}% | runs caught "
              f"{s['impostorRunsCaught']*100:.1f}% | time to catch {s['timeToCatchMedianS']}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true")
    a = ap.parse_args()
    analyze() if a.analyze else run()
