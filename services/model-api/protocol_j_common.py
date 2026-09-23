"""Shared code for protocol J (artifacts/repr_arch_study/PREREGISTRATION_J.md).

* Verifies the frozen protocol and split against PREREGISTRATION_J.sha256 before anything runs, and
  stamps both hashes into every result.
* Reads SapiMouse windows through the study's own functions (repr_arch_study), and refuses to read a
  lockbox user unless the caller is Phase P6.
* Replays the live decision loop at the live cadence (one check per 6 new windows; after a prompt the
  buffer empties) and, as a secondary, at every window (Experiment I).
"""
import glob
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from repr_arch_study import _read_events, raw_steps, session_scale, windows  # noqa: E402

ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
STUDY = os.path.join(ROOT, "artifacts", "repr_arch_study")
DATA = os.path.join(ROOT, "data", "sapimouse")
PREREG = os.path.join(STUDY, "PREREGISTRATION_J.md")
SPLIT = os.path.join(STUDY, "SPLIT_J.json")
HASHES = os.path.join(STUDY, "PREREGISTRATION_J.sha256")

BASE80 = {"base": os.path.join(ROOT, "artifacts", "mouse-fcn-a5-j80", "final_model"),
          "scaler": os.path.join(ROOT, "artifacts", "mouse-fcn-a5-j80", "scaler.json"),
          "neg": os.path.join(ROOT, "data", "mouse_only", "Mouse_A5_W50_base80.h5")}
SEC_PER_WINDOW = 10 * 0.0269            # stride 10 steps at SapiMouse's 0.0269 s per step
CADENCE = 6                             # new windows per live check (~1.6 s)
IMP_RUN = 150
Q_GRID = [1, 2, 5, 10, 15, 20, 30, 40, 50]


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def verify_frozen():
    """Refuse to run if the protocol or the split differs from the frozen hashes."""
    want = {}
    for line in open(HASHES):
        h, name = line.split()
        want[os.path.basename(name)] = h
    got = {"PREREGISTRATION_J.md": sha(PREREG), "SPLIT_J.json": sha(SPLIT)}
    for name, h in got.items():
        if want.get(name) != h:
            raise SystemExit(f"{name} does not match its frozen hash ({h[:8]} vs {want.get(name, '?')[:8]}); refusing to run")
    return {"preregistrationJSha256": got["PREREGISTRATION_J.md"], "splitJSha256": got["SPLIT_J.json"]}


def split():
    return json.load(open(SPLIT))


class Reader:
    """Window access for one phase. Lockbox users are readable only in Phase P6."""

    def __init__(self, phase):
        self.phase = phase
        s = split()
        self.lockbox = set(s["lockbox"])
        self._cache = {}

    def sessions(self, u):
        if u in self.lockbox and self.phase != "P6":
            raise PermissionError(f"{u} is a lockbox user; only Phase P6 may read it")
        cs = sorted(glob.glob(os.path.join(DATA, u, "*.csv")))
        lo = [c for c in cs if "3min" in os.path.basename(c)]
        sh = [c for c in cs if "1min" in os.path.basename(c)]
        return (lo[0] if lo else None), (sh[0] if sh else None)

    def windows(self, csv):
        if csv not in self._cache:
            ev = _read_events(csv)
            self._cache[csv] = windows(raw_steps(ev), session_scale(ev), "A5")
        return self._cache[csv]


# ------------------------------------------------------------------ decision replay --
def fires(win, tau, rule, k):
    if rule == "vote":
        return int((win < tau).sum()) >= k
    stat = win.mean() if rule == "mean" else np.median(win)
    return stat < tau


def replay(seq, tau, rule, n, k, cadence=CADENCE):
    """Live loop over one stream. A decision is taken at every `cadence`-th window (a check) once
    the buffer holds n windows collected since the last prompt; a prompt empties the buffer.
    cadence=1 reproduces Experiment I. Returns prompts, index of the first prompt, decisions."""
    s = np.asarray(seq, float)
    start, prompts, first, decisions = 0, 0, None, 0
    for i in range(len(s)):
        if (i + 1) % cadence:
            continue
        if i - start + 1 < n:
            continue
        decisions += 1
        if fires(s[i - n + 1:i + 1], tau, rule, k):
            prompts += 1
            if first is None:
                first = i
            start = i + 1
    return prompts, first, decisions


def seconds_at(idx):
    return (50 + 10 * idx) * 0.0269


def per_user(half, tau, rule, n, k, cadence=CADENCE):
    g = half["g"]
    cnt, _, dec = replay(g, tau, rule, n, k, cadence)
    minutes = len(g) * SEC_PER_WINDOW / 60.0
    caught, times = [], []
    for r in half["runs"].values():
        c, f, _ = replay(r, tau, rule, n, k, cadence)
        caught.append(c > 0)
        if c:
            times.append(seconds_at(f))
    return {"promptsPerMin": cnt / minutes if minutes > 0 else float("nan"), "prompts": cnt,
            "decisions": dec, "interruption": (cnt / dec) if dec else 0.0,
            "lowWindowRate": float((np.asarray(g) < tau).mean()) if len(g) else float("nan"),
            "caught": caught, "times": times}


def summary(res):
    rates = np.array([v["promptsPerMin"] for v in res.values()], float)
    caught = [c for v in res.values() for c in v["caught"]]
    times = [t for v in res.values() for t in v["times"]]
    inter = np.array([v["interruption"] for v in res.values()], float)
    return {"promptsPerMinMean": float(np.nanmean(rates)), "promptsPerMinMedian": float(np.nanmedian(rates)),
            "usersNeverPrompted": float(np.mean([v["prompts"] == 0 for v in res.values()])),
            "interruptionMean": float(inter.mean()),
            "impostorRunsCaught": float(np.mean(caught)) if caught else 0.0,
            "impostorRunsNeverCaught": float(1 - np.mean(caught)) if caught else 1.0,
            "timeToCatchMedianS": float(np.median(times)) if times else None}


def halves(u):
    """Development calibration / test halves, exactly as in Experiments A-I."""
    g = np.asarray(u["_genuineScores"], float)
    cut = len(g) // 2
    ids = sorted(u["_impostorRuns"])
    runs = {k: np.asarray(u["_impostorRuns"][k], float) for k in ids}
    return ({"g": g[:cut], "runs": {k: runs[k] for k in ids[0::2]}},
            {"g": g[cut:], "runs": {k: runs[k] for k in ids[1::2]}})
