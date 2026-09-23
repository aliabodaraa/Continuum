"""Decision-level accuracy of the deployed mouse rule (descriptive, not pre-registered).

Per-window AUC/EER describe one 1.2-s window; the live decision looks at the last 60 windows
(~17 s). This scores every 60-window group on Experiment F's test halves (the deployed server
model, 19 held-out users) and reports per-user AUC and EER for two group statistics:
  count60 -- how many of the 60 windows fall below the user's threshold (the statistic the
             30-of-60 rule thresholds), and
  mean60  -- the mean window score.
Groups slide by one window, so neighbouring groups overlap heavily: each user's test half gives
about 40 genuine groups but far fewer independent ones, so these figures are optimistic.

    python repr_decision_level.py   ->  artifacts/repr_arch_study/decision_level.json
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import repr_arch_analyze as RA  # noqa: E402
from keystroke_user_sweep import auc_of, eer_of  # noqa: E402

ART = os.path.join(HERE, "..", "..", "artifacts", "repr_arch_study")
if not os.path.isdir(ART):
    ART = "/app/artifacts/repr_arch_study"
N, Q = 60, 1


def groups(s):
    s = np.asarray(s, float)
    return [s[i - N:i] for i in range(N, len(s) + 1)]


F = json.load(open(os.path.join(ART, "parts", "F_new.json")))
per = {}
for r in F["perUser"]:
    h = RA.halves(r)[1]
    tau = float(np.percentile(r["_enrolScores"], Q))
    g, imp = h["g"], np.concatenate(list(h["runs"].values()))
    gg = groups(g)
    ig = [x for run in h["runs"].values() for x in groups(run)]
    stats = {"window": (g, imp),
             "mean60": (np.array([x.mean() for x in gg]), np.array([x.mean() for x in ig])),
             "count60": (np.array([-(x < tau).sum() for x in gg], float), np.array([-(x < tau).sum() for x in ig], float))}
    per[r["participant"]] = {k: {"auc": float(auc_of(a, b)), "eer": float(eer_of(a, b)[0])} for k, (a, b) in stats.items()}
    per[r["participant"]]["genuineGroups"] = len(gg)

out = {"note": "descriptive, not pre-registered; Experiment F test halves; 60-window groups slide by one window (overlapping)",
       "users": len(per), "summary": {}, "perUser": per}
for k in ("window", "mean60", "count60"):
    a = np.array([v[k]["auc"] for v in per.values()])
    e = np.array([v[k]["eer"] for v in per.values()])
    out["summary"][k] = {"aucMean": float(a.mean()), "aucMedian": float(np.median(a)),
                         "eerMean": float(e.mean()), "eerMedian": float(np.median(e))}
    print(f"{k:8s} AUC mean {a.mean():.3f} median {np.median(a):.3f} | EER mean {e.mean()*100:.1f}% median {np.median(e)*100:.1f}%")
json.dump(out, open(os.path.join(ART, "decision_level.json"), "w"), indent=1)
print("wrote decision_level.json")
