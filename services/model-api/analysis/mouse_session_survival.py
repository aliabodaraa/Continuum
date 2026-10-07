"""
Mouse session-level survival: can an impostor get through a whole sitting?

Same method as keystroke's session_survival.py, adapted to the real deployed rule (15-of-20,
not 3-of-6) and to mouse's much faster step rate. 128 windows is used as one sitting because it
is the minimum available 1-min-session length across all 20 holdout users — every one of the
380 (target, impostor) pairs therefore contributes a full, untruncated sitting of equal length,
rather than a truncation that shortchanges users with more data.
"""
import json

import numpy as np
import sys

sys.path.insert(0, "services/model-api")
from decision_sweep import fire_vote, fire_mean  # noqa: E402

doc = json.load(open("artifacts/xai/mouse_population.json"))
users = [u for u in doc["perUser"] if u.get("_impostorRuns")]
TAU = 0.50
SIT_LEN = 128
DT = 0.017  # measured median inter-step interval, seconds

CFG = {
    "live: vote 15/20 (deployed)": (20, "vote", 15),
    "vote 10/20": (20, "vote", 10),
    "mean k=20": (20, "mean", None),
}

results = {}
for name, (k, rule, m) in CFG.items():
    escapes = 0
    total = 0
    detect_steps = []
    genuine_interrupted = 0
    for u in users:
        g = u["_genuineScores"]
        if rule == "vote":
            gf = fire_vote(g, k, TAU, m)
        else:
            gf = fire_mean(g, k, TAU)
        if len(gf) and gf.any():
            genuine_interrupted += 1

        for iu, run in u["_impostorRuns"].items():
            r = run[:SIT_LEN]
            if len(r) < SIT_LEN:
                continue
            if rule == "vote":
                f = fire_vote(r, k, TAU, m)
            else:
                f = fire_mean(r, k, TAU)
            total += 1
            if not len(f) or not f.any():
                escapes += 1
            else:
                detect_steps.append(int(np.argmax(f)) + k)

    results[name] = {
        "escapeRate": escapes / total, "nSessions": total,
        "medianDetectSteps": float(np.median(detect_steps)) if detect_steps else None,
        "medianDetectSeconds": float(np.median(detect_steps) * DT) if detect_steps else None,
        "genuineInterrupted": genuine_interrupted / len(users),
    }

print(f"IMPOSTOR SESSION SURVIVAL — {SIT_LEN} contiguous windows "
      f"(~{SIT_LEN*DT/60:.1f} min of mouse motion, one sitting)\n")
print(f"  {'config':<32}{'escaping':>18}{'median detect':>16}{'genuine interrupted':>22}")
for n, r in results.items():
    print(f"  {n:<32}{r['escapeRate']:>8.2%} ({r['nSessions']:4d})"
          f"  {r['medianDetectSeconds']:>8.2f}s ({r['medianDetectSteps']:.0f} steps)"
          f"  {r['genuineInterrupted']:>10.2%} ({r['genuineInterrupted']*len(users):.0f}/{len(users)})")

json.dump(results, open("artifacts/xai/mouse_session_survival.json", "w"), indent=1)
print("\nwrote artifacts/xai/mouse_session_survival.json")
