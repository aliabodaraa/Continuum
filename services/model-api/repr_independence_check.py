"""
How much would assuming independent windows flatter impostor capture? For the deployed server
operating point (Experiment F: per-user threshold = 5th percentile of enrolment scores, lock at 12 of
the last 20 windows), compare, on the test half:

  * measured capture: the rule run over each impostor's contiguous run of windows (as deployed)
  * independence prediction: P(X >= 12), X ~ Binomial(20, p), with p the same impostor's per-window
    low rate -- what the rule would catch if consecutive windows were independent

Also reports the spread of the per-user thresholds themselves.

    python repr_independence_check.py      # writes independence_check.json
"""
import json
import os
from math import comb

import numpy as np

ROOT = "/app/artifacts/repr_arch_study"
Q, N, K = 5, 20, 12


def binom_ge(n, k, p):
    return sum(comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k, n + 1))


def main():
    F = json.load(open(os.path.join(ROOT, "parts", "F_new.json")))
    pred, meas = [], []
    for r in F["perUser"]:
        tau = float(np.percentile(r["_enrolScores"], Q))
        ids = sorted(r["_impostorRuns"])
        caps, preds = [], []
        for k in ids[1::2]:                                   # test-half identities, as in the analyses
            s = np.asarray(r["_impostorRuns"][k], float)
            if len(s) < N:
                continue
            low = (s < tau).astype(int)
            c = np.concatenate([[0], np.cumsum(low)])
            caps.append(float(((c[N:] - c[:-N]) >= K).mean()))
            preds.append(binom_ge(N, K, float(low.mean())))
        pred.append(float(np.mean(preds)))
        meas.append(float(np.mean(caps)))
    thr = [float(np.percentile(r["_enrolScores"], Q)) for r in F["perUser"]]
    # Genuine test-half windows below the user's own threshold (5% of enrolment windows are, by construction).
    below = []
    for r, t in zip(F["perUser"], thr):
        g = np.asarray(r["_genuineScores"], float)
        below.append(float(np.mean(g[len(g) // 2:] < t)))
    out = {"operatingPoint": {"q": Q, "n": N, "k": K}, "users": len(meas),
           "thresholdMin": min(thr), "thresholdMax": max(thr), "thresholdMedian": float(np.median(thr)),
           "genuineBelowThresholdMedian": float(np.median(below)), "genuineBelowThresholdMax": max(below),
           "usersWithMostGenuineBelow": int(sum(b > 0.5 for b in below)),
           "measuredCaptureMedian": float(np.median(meas)), "measuredCaptureMean": float(np.mean(meas)),
           "independencePredictedMedian": float(np.median(pred)), "independencePredictedMean": float(np.mean(pred))}
    json.dump(out, open(os.path.join(ROOT, "independence_check.json"), "w"), indent=1)
    print(out)


if __name__ == "__main__":
    main()
