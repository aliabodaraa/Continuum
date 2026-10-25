"""Effect of the voting-packet length (6, 10 and 20 windows) on the DEPLOYED typing model (arm A200 of experiment KS).

The paper's packet-length table (paper Table 4, thesis Table 11) used to be computed from the baseline score file
(`artifacts/xai/population_scores.json`, negatives = KeyRecs participants 0-39, the REF arm), which is not the model
that is deployed. This script recomputes it from the saved per-target scores of the deployed arm, with exactly the
decision definition of Table 3 and of the adaptive-retraining experiments:
  * decisions are step-disjoint blocks of n windows (`eval_decision_level.blocks`, gap 4), the score of a block is its mean;
  * pooled EER and AUC over all users' decisions, and the mean over users of the per-user AUC (the paper's AUC); FAR/FRR at the live rule (a window is low below 0.50, a block is suspicious
    when at least half of its windows are low); TAR at FAR = 1% from the pooled block-mean scores.
Check: n = 20 reproduces the A200 column of Table 3 (FAR 11.9%, FRR 3.3%, pooled EER 7.8%).

    python services/model-api/analysis/phase3/packet_length_a200.py
Output: artifacts/phase3/packet_length_a200.json
"""
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(HERE, "..", "phase1"))
import eval_decision_level as E  # noqa: E402

LENGTHS = (6, 10, 20)
THRESHOLD = 0.50
VOTE_FRACTION = 0.5


def load(arm):
    users = []
    for f in sorted(glob.glob(os.path.join(ROOT, "artifacts", "phase3", "parts", arm, "*.json"))):
        x = json.load(open(f, encoding="utf-8"))
        if x.get("eligible"):
            users.append((x["participant"], np.asarray(x["genuine"], float), [np.asarray(v, float) for v in x["runs"].values()]))
    return users


def decisions(users, n):
    out = []
    for pid, g, runs in users:
        gb = E.blocks(g, n)
        ib = [b for v in runs for b in E.blocks(v, n)]
        if not gb or not ib:
            continue
        out.append({"id": pid,
                    "g": np.array([b.mean() for b in gb]), "i": np.array([b.mean() for b in ib]),
                    "gLow": np.array([(b < THRESHOLD).mean() >= VOTE_FRACTION for b in gb]),
                    "iLow": np.array([(b < THRESHOLD).mean() >= VOTE_FRACTION for b in ib])})
    return out


def summarise(dec):
    g = np.concatenate([d["g"] for d in dec])
    i = np.concatenate([d["i"] for d in dec])
    gl = np.concatenate([d["gLow"] for d in dec])
    il = np.concatenate([d["iLow"] for d in dec])
    return {"users": len(dec), "decisionsGenuine": int(len(g)), "decisionsImpostor": int(len(i)),
            "far": float(1 - il.mean()), "frr": float(gl.mean()),
            "eer": E.eer_fast(g, i), "auc": E.auc_fast(g, i),
            "aucPerUserMean": float(np.mean([E.auc_fast(d["g"], d["i"]) for d in dec])),
            "tarAtFar1": float(1 - E.frr_at_far(g, i, 0.01)), "tarAtFar5": float(1 - E.frr_at_far(g, i, 0.05))}


def main():
    result = {"arm": "A200", "method": __doc__.split("\n\n")[1].strip(), "lengths": {}}
    per_user_frr = {}
    for arm in ("A200", "REF"):
        users = load(arm)
        for n in LENGTHS:
            dec = decisions(users, n)
            s = summarise(dec)
            if arm == "A200":
                result["lengths"][str(n)] = s
            else:
                result.setdefault("refCheck", {})[str(n)] = s
            per_user_frr[(arm, n)] = {d["id"]: float(d["gLow"].mean()) for d in dec}
    for arm in ("A200", "REF"):
        a, b = per_user_frr[(arm, 6)], per_user_frr[(arm, 20)]
        ids = sorted(set(a) & set(b))
        key = "lowerFrr20vs6" if arm == "A200" else "refLowerFrr20vs6"
        result[key] = {"lower": int(sum(b[k] < a[k] for k in ids)), "equal": int(sum(b[k] == a[k] for k in ids)),
                       "higher": int(sum(b[k] > a[k] for k in ids)), "users": len(ids)}
    out = os.path.join(ROOT, "artifacts", "phase3", "packet_length_a200.json")
    json.dump(result, open(out, "w", encoding="utf-8"), indent=2)
    for n in LENGTHS:
        s = result["lengths"][str(n)]
        print("n=%2d  FAR %.1f%%  FRR %.1f%%  EER %.2f%%  pooled AUC %.3f  per-user AUC %.4f  TAR@FAR1%% %.1f%%  (users %d)" % (
            n, 100 * s["far"], 100 * s["frr"], 100 * s["eer"], s["auc"], s["aucPerUserMean"], 100 * s["tarAtFar1"], s["users"]))
    print("users with a lower FRR at 20 than at 6 windows:", result["lowerFrr20vs6"], "| REF:", result["refLowerFrr20vs6"])
    print("wrote", out)


if __name__ == "__main__":
    main()
