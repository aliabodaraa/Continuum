"""Data split for the frozen protocol J (artifacts/repr_arch_study/PREREGISTRATION_J.md).

Development users = the 20 held-out users used in Experiments A-I (holdout_users.json, seed 13).
Lockbox (untouched final test) = 20 users drawn, with a fixed seed, from the base users that meet the
eligibility rule below. Base-training users = every remaining base user.

Eligibility was fixed before any count was taken and uses only data volume, never a score:
  * both SapiMouse sessions present;
  * >= 440 windows (A5, 50 steps, stride 10, deployed step filter) in the 3-minute session, the
    largest enrolment budget Phase P3 can select;
  * >= 150 windows in the 1-minute session, one full impostor run.
The lockbox is drawn by numpy.random.default_rng(SEED).choice over the sorted eligible ids.

    python make_split_j.py   ->  artifacts/repr_arch_study/SPLIT_J.json
"""
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from repr_arch_study import _read_events, raw_steps, session_scale, windows  # noqa: E402

ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
DATA = os.path.join(ROOT, "data", "sapimouse")
HOLDOUT = os.path.join(ROOT, "artifacts", "mouse-ws50-aligned", "holdout_users.json")
OUT = os.path.join(ROOT, "artifacts", "repr_arch_study", "SPLIT_J.json")
SEED, N_LOCKBOX, MIN_ENROL, MIN_TEST = 20260915, 20, 440, 150


def n_windows(csv):
    ev = _read_events(csv)
    return int(len(windows(raw_steps(ev), session_scale(ev), "A5")))


def uid_key(u):
    return int(u.replace("user", ""))


users = sorted((os.path.basename(p) for p in glob.glob(os.path.join(DATA, "user*")) if os.path.isdir(p)), key=uid_key)
dev = json.load(open(HOLDOUT))["holdout_users"]
counts = {}
for u in users:
    cs = sorted(glob.glob(os.path.join(DATA, u, "*.csv")))
    lo = [c for c in cs if "3min" in os.path.basename(c)]
    sh = [c for c in cs if "1min" in os.path.basename(c)]
    counts[u] = {"enrol3min": n_windows(lo[0]) if lo else 0, "test1min": n_windows(sh[0]) if sh else 0}

base = [u for u in users if u not in set(dev)]
eligible = [u for u in base if counts[u]["enrol3min"] >= MIN_ENROL and counts[u]["test1min"] >= MIN_TEST]
rng = np.random.default_rng(SEED)
lockbox = sorted(rng.choice(eligible, size=N_LOCKBOX, replace=False).tolist(), key=uid_key)
train = [u for u in base if u not in set(lockbox)]

split = {
    "protocol": "J", "seed": SEED,
    "eligibility": {"enrol3minWindowsAtLeast": MIN_ENROL, "test1minWindowsAtLeast": MIN_TEST,
                    "representation": "A5, 50 steps, stride 10, deployed step filter"},
    "development": sorted(dev, key=uid_key),
    "lockbox": lockbox,
    "baseTraining": train,
    "counts": counts,
    "summary": {"users": len(users), "development": len(dev), "base": len(base), "eligibleBase": len(eligible),
                "lockbox": len(lockbox), "baseTraining": len(train),
                "developmentEligibleFor440": [u for u in dev if counts[u]["enrol3min"] >= MIN_ENROL],
                "developmentEligibleFor330": [u for u in dev if counts[u]["enrol3min"] >= 330]},
}
json.dump(split, open(OUT, "w"), indent=1)
print(json.dumps(split["summary"], indent=1))
print("lockbox:", lockbox)
