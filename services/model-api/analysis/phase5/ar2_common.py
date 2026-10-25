"""Shared code for experiment AR2, adaptive retraining with the sample rule as built
(artifacts/phase5/PREREGISTRATION_AR2.md).

AR2 repeats experiment AR (artifacts/phase4, sealed) with one thing changed: the rule that decides which
typing becomes a training sample. Everything else is AR's, imported unchanged from phase4/ar_common.py:
the KeyRecs timeline, the per-user training recipe (KS arm A200), the Aalto negatives, the 20-window
decisions and the impostors.

The sample rule as built (ca-service lib/keystrokeSecurity.js and server.js, 2026-10-19):
  - a sample is exactly SAMPLE_WINDOWS (20) consecutive windows; by default the last 20 of the stretch
    offered ("end"), or, if the organisation chooses so, the newest run of 20 that would be accepted ("any");
  - it is accepted if the mean of its 20 window scores is at least MEAN_MIN, each of its newest NEWEST (3)
    windows is at least FLOOR, and its own timing is consistent with the user's history (rhythm check);
  - only those 20 windows are learned;
  - the user retrains after RETRAIN_EVERY accepted samples (1, 2 or 3; 3 by default).
"""
import hashlib
import importlib.util
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "phase4"))
import ar_common as AC  # noqa: E402  (sealed AR code: data, timeline, training, scoring; not changed)

ROOT = AC.ROOT
STUDY = os.path.join(ROOT, "artifacts", "phase5")
SMOKE = os.path.join(STUDY, "smoke")
SHA_FILE = os.path.join(STUDY, "PREREGISTRATION_AR2.sha256")

# ---- the sample rule as built ----
SAMPLE_WINDOWS = 20
NEWEST = 3                    # SAMPLE_FLOOR_WINDOWS
MEAN_MIN = 0.80               # ADAPTIVE_CONFIDENCE_MIN (the mean over the sample's 20 windows)
FLOOR = 0.80                  # ADAPTIVE_WINDOW_FLOOR
STRIDE, WINDOW = 10, 50
SAMPLE_STEPS_N = (SAMPLE_WINDOWS - 1) * STRIDE + WINDOW      # 240 steps behind 20 windows

# arm -> (accepted samples that allow a retrain, where the sample is taken from)
VARIANTS = {"B": (3, "end"), "B1": (1, "end"), "B2": (2, "end"), "Bany": (3, "any")}
ARMS = ("A", "B", "B1", "B2", "Bany", "D", "R")
SEED_OFFSET = {**AC.SEED_OFFSET, "B1": 600000, "B2": 700000, "Bany": 800000}

FROZEN = ["artifacts/phase5/PREREGISTRATION_AR2.md",
          "services/model-api/analysis/phase5/ar2_common.py",
          "services/model-api/analysis/phase5/run_ar2.py",
          "services/model-api/analysis/phase5/analyze_ar2.py",
          "services/model-api/analysis/phase4/ar_common.py",
          "services/model-api/analysis/phase1/eval_decision_level.py",
          "services/model-api/analysis/phase1/p1lib.py",
          "data/keyrecs/free-text.csv",
          "data/keyrecs_impostors.h5",
          "artifacts/phase3/aalto_pool_ks.json",
          "artifacts/phase4/ar_result.json"]          # fixed so that A can be compared with AR's A


def current_hashes():
    out = {rel: AC.sha(os.path.join(ROOT, rel)) for rel in FROZEN}
    for m in AC.FROZEN_MODULES:
        out[f"module:{m}"] = AC.sha(importlib.util.find_spec(m).origin)
    return out


def freeze():
    """Write PREREGISTRATION_AR2.sha256 (once, before any result)."""
    if os.path.exists(SHA_FILE):
        raise SystemExit(f"{SHA_FILE} exists: AR2 is frozen already")
    got = current_hashes()
    with open(SHA_FILE, "w") as f:
        for k in sorted(got):
            f.write(f"{got[k]} {k}\n")
    print(f"frozen {len(got)} files -> {SHA_FILE}")


def verify_frozen():
    """Refuse to run unless every frozen file matches PREREGISTRATION_AR2.sha256."""
    if not os.path.exists(SHA_FILE):
        raise SystemExit(f"{SHA_FILE} missing: the pre-registration is not frozen")
    want = {}
    for line in open(SHA_FILE):
        if line.strip():
            h, name = line.split(maxsplit=1)
            want[name.strip()] = h
    got = current_hashes()
    bad = [k for k in got if want.get(k) != got[k]]
    if bad:
        raise SystemExit("differs from PREREGISTRATION_AR2.sha256: " + ", ".join(bad) + "; refusing to run")
    return {"preregistrationAR2Sha256": got["artifacts/phase5/PREREGISTRATION_AR2.md"],
            "frozenSetSha256": hashlib.sha256("".join(f"{k}{got[k]}" for k in sorted(got)).encode()).hexdigest()}


# ---------------------------------------------------------------- the sample rule as built ----
def block_starts(n_windows, mode):
    """Starts of the candidate 20-window runs, newest first: the last run ("end") or every run ("any")."""
    last = n_windows - SAMPLE_WINDOWS
    if last < 0:
        return []
    return [last] if mode == "end" else list(range(last, -1, -1))


def scores_ok(block):
    return bool(block.mean() >= MEAN_MIN and block[-NEWEST:].min() >= FLOOR)


def sample_gate(scores, steps, history_steps, mode="end"):
    """The server's decision on one stretch offered as a sample (ca-service /v1/keystroke/contribute):
    pick the sample (the last 20 windows, or the newest run that passes the score checks), then the
    checks in the server's order: mean, newest windows, rhythm."""
    s = np.asarray(scores, float)
    starts = block_starts(len(s), mode)
    if not starts:
        return {"accepted": False, "reason": "windows", "start": None, "mean": 0.0, "worstNewest": 0.0, "z": 0.0}
    pick = next((st for st in starts if scores_ok(s[st:st + SAMPLE_WINDOWS])), None)
    st = pick if pick is not None else starts[0]
    blk = s[st:st + SAMPLE_WINDOWS]
    mean, worst = float(blk.mean()), float(blk[-NEWEST:].min())
    z = AC.rhythm_z(steps[st * STRIDE: st * STRIDE + SAMPLE_STEPS_N], history_steps)
    if mean < MEAN_MIN:
        reason = "mean"
    elif worst < FLOOR:
        reason = "newest"
    elif z > AC.RHYTHM_Z:
        reason = "rhythm"
    else:
        reason = "ok"
    return {"accepted": reason == "ok", "reason": reason, "start": int(st), "mean": round(mean, 4),
            "worstNewest": round(worst, 4), "z": round(float(z), 3)}


def sample_windows(W, st):
    """The 20 windows a sample made of the run starting at window `st` contributes to training."""
    return W[st:st + SAMPLE_WINDOWS]


def sample_steps(steps, st):
    return steps[st * STRIDE: st * STRIDE + SAMPLE_STEPS_N]


# ---------------------------------------------------------------- the live lock rule as it is now ----
def replay_locks(scores):
    """Passkey triggers along one contiguous stream, one check per new window, as ca-service decides since
    2026-10-19: warm-up while <= 20 windows unless overwhelming (>= 8 windows and >= 75% of the last <= 20
    below 0.50); suspicious = >= 10 of the last 20 below 0.50; a suspicious check triggers at once (no
    confirmation by later checks); after a trigger the stream restarts at the next window."""
    s = np.asarray(scores, float)
    locks, start = [], 0
    for i in range(1, len(s) + 1):
        w = s[start:i]
        recent = w[-AC.N_PACKET:]
        low = int((recent < AC.LIVE_THRESHOLD).sum())
        overwhelming = len(recent) >= AC.WARM_MIN and low >= math.ceil(len(recent) * AC.WARM_FRAC)
        warm = len(w) <= AC.N_PACKET and not overwhelming
        suspicious = (not warm) and len(recent) > 0 and low / len(recent) >= AC.VOTE_FRACTION
        if suspicious:
            locks.append(i - 1)
            start = i
    return locks
