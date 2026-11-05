"""
Per-user false-lock and impostor-capture rates per packet length (the figures the console's setting text
quotes: "about 10% of their verdicts at 6, 6% at 10, 3% at 20"), computed as decision_paired.py does
(decision_sweep.rates_for_user: honest sliding packets per user, median over users, bootstrap CI over
users), for the 2- and 4-window packets added on 2026-11-05 with the measured lengths alongside.

    docker run --rm -v "<continuum>:/app" -w /app continuum/model-api:local \
        python services/model-api/analysis/decision_user_rates_2_4.py [out.json]

Writes artifacts/xai/keystroke_decision_user_rates_2_4.json by default.
"""
import json
import sys

import numpy as np

sys.path.insert(0, "services/model-api")
from decision_sweep import rates_for_user  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else "artifacts/xai/keystroke_decision_user_rates_2_4.json"
TAU = 0.50
PAIRS = [(2, 1), (4, 2), (6, 3), (10, 5), (20, 10)]

doc = json.load(open("artifacts/xai/population_scores.json"))
users = [u for u in doc["perUser"] if u.get("_impostorRuns") and u.get("_genuineScores")]
print(f"n = {len(users)} users")


def boot_ci(v, n=2000, seed=0):
    rng = np.random.default_rng(seed)
    v = np.asarray(v)
    m = [float(np.median(v[rng.integers(0, len(v), len(v))])) for _ in range(n)]
    return [float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))]


out = []
for k, m in PAIRS:
    lock, catch = [], []
    for u in users:
        a, b = rates_for_user(u, k, "vote", TAU, m)
        if a is None:
            continue
        lock.append(a)
        catch.append(float(np.mean(b)))
    lock, catch = np.array(lock), np.array(catch)
    r = dict(K=k, votes=m, nUsers=int(len(lock)),
             falseLockMedian=float(np.median(lock)), falseLockMean=float(np.mean(lock)), falseLockCI=boot_ci(lock),
             usersOver10pct=int((lock > 0.10).sum()), usersOver25pct=int((lock > 0.25).sum()),
             impostorCaughtMedian=float(np.median(catch)), impostorCaughtMean=float(np.mean(catch)), impostorCaughtCI=boot_ci(catch))
    print(f"K={k:2d} ({m} of {k}): false lock per decision median {r['falseLockMedian']:.2%} (mean {r['falseLockMean']:.2%}, CI {r['falseLockCI'][0]:.2%}-{r['falseLockCI'][1]:.2%}); "
          f"users >10%: {r['usersOver10pct']}, >25%: {r['usersOver25pct']}; impostor caught median {r['impostorCaughtMedian']:.2%} (mean {r['impostorCaughtMean']:.2%})")
    out.append(r)
json.dump(out, open(OUT, "w"), indent=2)
print(f"wrote {OUT}")
