"""Per-user threshold spread at several enrolment percentiles (server model, Experiment F scores).

Descriptive only, no decision: for each percentile q, the range of the per-user thresholds (q-th
percentile of each user's 330 enrolment scores) and, on the test half of each user's genuine
1-minute stream, the share of genuine windows that fall below the user's own threshold. q = 1 is
the deployed server point (Experiment I, owner's choice); q = 5 reproduces independence_check.json.

    python repr_threshold_spread.py   ->  artifacts/repr_arch_study/threshold_spread.json
"""
import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, "..", "..", "artifacts", "repr_arch_study")
if not os.path.isdir(ART):
    ART = "/artifacts/repr_arch_study"

F = json.load(open(os.path.join(ART, "parts", "F_new.json")))
out = {"source": "parts/F_new.json", "users": len(F["perUser"]), "byPercentile": {}}
for q in (1, 2, 5, 10):
    thr, below = [], []
    for r in F["perUser"]:
        t = float(np.percentile(r["_enrolScores"], q))
        g = np.asarray(r["_genuineScores"])
        test = g[len(g) // 2:]                     # test half, as in every analysis
        thr.append(t)
        below.append(float((test < t).mean()))
    out["byPercentile"][str(q)] = {
        "thresholdMin": min(thr), "thresholdMax": max(thr), "thresholdMedian": float(np.median(thr)),
        "genuineTestBelowThresholdMedian": float(np.median(below)),
        "usersWithAllGenuineBelow": int(sum(b == 1.0 for b in below)),
        "usersWithOverHalfGenuineBelow": int(sum(b > 0.5 for b in below)),
    }
    print(f"q={q:>2}: threshold {min(thr):.3f}..{max(thr):.3f}; genuine test windows below: median "
          f"{np.median(below):.3f}; all below {out['byPercentile'][str(q)]['usersWithAllGenuineBelow']}, "
          f"over half {out['byPercentile'][str(q)]['usersWithOverHalfGenuineBelow']}")
json.dump(out, open(os.path.join(ART, "threshold_spread.json"), "w"), indent=1)
print("wrote threshold_spread.json")
