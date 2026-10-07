"""Shared code for the keystroke experiment KS (artifacts/phase3/PREREGISTRATION_KS.md).

Lu et al. (2020) per-user training, unchanged (population_sweep.py's recipe, the frozen KeyRecs
baseline), with ONE thing varied: where the training negatives come from and how many different
people they come from.

  REF    negatives from KeyRecs participants ids[0:40]  (the frozen baseline, as published)
  A40    negatives from 40 Aalto typists
  A200   negatives from 200 Aalto typists   (A40 is a subset)
  A1000  negatives from 1,000 Aalto typists (A200 is a subset)

The NUMBER of negative windows is the recipe's own (2 x the positive windows, at least 60), so the
arms differ in the diversity of the people behind the negatives, not in how many there are.
Everything is tested on the same KeyRecs targets against the same KeyRecs impostors (ids[40:80]).
"""
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
MODEL_API = os.path.join(ROOT, "services", "model-api")
STUDY = os.path.join(ROOT, "artifacts", "phase3")
PARTS = os.path.join(STUDY, "parts")
SMOKE = os.path.join(STUDY, "smoke")
KEYRECS = os.path.join(ROOT, "data", "keyrecs_impostors.h5")
AALTO_ZIP = os.path.join(ROOT, "data", "Keystrokes.zip")
POOL = os.path.join(ROOT, "data", "aalto_pool_ks.h5")
BASE = os.path.join(ROOT, "artifacts", "ws50-gru-v2", "final_model")
SCALER = os.path.join(ROOT, "artifacts", "ws50-gru-v2", "scaler.json")
os.environ.setdefault("KS_BASE_MODEL", BASE)
os.environ.setdefault("KS_SCALER", SCALER)
sys.path.insert(0, MODEL_API)
sys.path.insert(0, os.path.join(HERE, "..", "phase1"))

ARMS = ("REF", "A40", "A200", "A1000")
POOL_SIZES = {"A40": 40, "A200": 200, "A1000": 1000}
POOL_SEED, MIN_POOL_WINDOWS = 20260924, 10
N_PACKET, VOTE_FRACTION, LIVE_THRESHOLD = 20, 0.5, 0.5     # the live rule: >= 10 of 20 below 0.50
EPOCHS = 30

FROZEN = ["artifacts/phase3/PREREGISTRATION_KS.md",
          "services/model-api/analysis/phase3/ks_common.py",
          "services/model-api/analysis/phase3/make_pool_ks.py",
          "services/model-api/analysis/phase3/run_ks.py",
          "services/model-api/analysis/phase3/analyze_ks.py",
          "services/model-api/analysis/phase1/eval_decision_level.py",
          "services/model-api/analysis/phase1/p1lib.py"]
FROZEN_MODULES = ("population_sweep", "keystroke_user_sweep", "aalto_to_windows", "preprocessing")
SHA_FILE = os.path.join(STUDY, "PREREGISTRATION_KS.sha256")


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def current_hashes():
    import importlib.util
    out = {rel: sha(os.path.join(ROOT, rel)) for rel in FROZEN}
    for m in FROZEN_MODULES:
        out[f"module:{m}"] = sha(importlib.util.find_spec(m).origin)
    return out


def verify_frozen():
    """Refuse to run unless every frozen file matches PREREGISTRATION_KS.sha256."""
    if not os.path.exists(SHA_FILE):
        raise SystemExit(f"{SHA_FILE} missing: the pre-registration is not frozen")
    want = {}
    for line in open(SHA_FILE):
        if line.strip():
            h, name = line.split()
            want[name] = h
    got = current_hashes()
    bad = [k for k in got if want.get(k) != got[k]]
    if bad:
        raise SystemExit("differs from PREREGISTRATION_KS.sha256: " + ", ".join(bad) + "; refusing to run")
    return {"preregistrationKSSha256": got["artifacts/phase3/PREREGISTRATION_KS.md"],
            "frozenSetSha256": hashlib.sha256("".join(f"{k}{got[k]}" for k in sorted(got)).encode()).hexdigest()}


def write_json(path, obj, **kw):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, **kw)
    os.replace(tmp, path)


def load_h5(path):
    import h5py
    with h5py.File(path, "r") as f:
        return np.asarray(f["windows"], np.float32), np.asarray(f["participant"]).astype(np.int64)


def keyrecs_pools(pid):
    """The frozen baseline's pools: negatives ids[0:40], impostors ids[40:80]."""
    from population_sweep import IMP_POOL_SIZE, NEG_POOL_SIZE
    ids = np.sort(np.unique(pid))
    return ids, ids[:NEG_POOL_SIZE], ids[NEG_POOL_SIZE:NEG_POOL_SIZE + IMP_POOL_SIZE]


def load_scaler():
    from preprocessing import FeatureScaler
    return FeatureScaler.load(os.environ["KS_SCALER"])


def blocks(seq, n=N_PACKET):
    import eval_decision_level as E
    return E.blocks(seq, n)
