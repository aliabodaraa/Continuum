"""Shared code for experiment AR, adaptive retraining (artifacts/phase4/PREREGISTRATION_AR.md).

The question: does the deployed adaptive-retraining loop (a clean stretch of typing is offered as a
training sample; the server accepts it only past its quality gates, at most one per day; the model
is retrained after every three accepted samples) make a user's model better on their LATER typing,
without making impostors easier to accept? Compared with a "learn from the lock" variant and an
upper bound, on KeyRecs' two recording sessions.

Everything that is not the adaptation itself is experiment KS's live recipe (arm A200), reused
line for line: windows (keyrecs_to_windows, the port of ca-service buildSteps), per-user training
(population_sweep's split, base and optimiser), Aalto negatives (the KS pool, first 200 typists),
20-window decisions (eval_decision_level.blocks) and the KeyRecs impostors ids[40:80].
"""
import csv
import hashlib
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
MODEL_API = os.path.join(ROOT, "services", "model-api")
STUDY = os.path.join(ROOT, "artifacts", "phase4")
SMOKE = os.path.join(STUDY, "smoke")
KEYRECS_CSV = os.path.join(ROOT, "data", "keyrecs", "free-text.csv")
KEYRECS_H5 = os.path.join(ROOT, "data", "keyrecs_impostors.h5")
KS_POOL_MANIFEST = os.path.join(ROOT, "artifacts", "phase3", "aalto_pool_ks.json")
BASE = os.path.join(ROOT, "artifacts", "ws50-gru-v2", "final_model")
SCALER = os.path.join(ROOT, "artifacts", "ws50-gru-v2", "scaler.json")
os.environ.setdefault("KS_BASE_MODEL", BASE)
os.environ.setdefault("KS_SCALER", SCALER)
sys.path.insert(0, MODEL_API)
sys.path.insert(0, os.path.join(HERE, "..", "phase1"))

# ---- per-user timeline, in steps (key pairs that survive the live filter) ----
SAMPLE_STEPS = 330            # one enrolment passage, and one day's contribution
ENROL_SAMPLES = 5             # the live enrolment: 5 samples
ENROL_STEPS = SAMPLE_STEPS * ENROL_SAMPLES
MIN_S2_STEPS = 1000           # session 2 must leave >= 500 test steps (>= 2 decisions)
MIN_DAYS = 3                  # at least one possible retrain

# ---- the deployed adaptive gates (ca-service server.js + lib/keystrokeSecurity.js, 2026-10-03) ----
SCORED_N = 20                 # SCORED_WINDOW_COUNT: the last windows scored for a contribution
ROLLING_N = 18                # ROLLING_WINDOW_COUNT: rolling mean over these
CONTRIB_N = 6                 # CONTRIBUTE_WINDOW_COUNT: need this many, and each of the last 6 >= floor
CONF_MIN = 0.80               # ADAPTIVE_CONFIDENCE_MIN
WINDOW_FLOOR = 0.80           # ADAPTIVE_WINDOW_FLOOR
RHYTHM_IDX = (2, 3, 4)        # dwell1, dwell2, dd
RHYTHM_Z = 3.0                # RHYTHM_Z_SCORE_LIMIT
RHYTHM_MIN_HIST = 100         # RHYTHM_MIN_HISTORY_DIGRAPHS
RETRAIN_EVERY = 3             # ADAPTIVE_RETRAIN_EVERY

# ---- the live keystroke decision rule (lu-050-10of20-warm8, with the 2-of-3 debounce) ----
N_PACKET, VOTE_FRACTION, LIVE_THRESHOLD = 20, 0.5, 0.5
WARM_MIN, WARM_FRAC = 8, 0.75
DEBOUNCE_WINDOW, DEBOUNCE_MIN = 3, 2

EPOCHS = 30
A_POOL = 200                  # Aalto typists, as live (KS arm A200)
ARMS = ("A", "B", "C", "D", "R")     # R: A retrained with another seed and no new data (noise reference)
SEED_OFFSET = {"A": 0, "B": 100000, "C": 200000, "D": 300000, "S2": 400000, "R": 500000}

FROZEN = ["artifacts/phase4/PREREGISTRATION_AR.md",
          "services/model-api/analysis/phase4/ar_common.py",
          "services/model-api/analysis/phase4/run_ar.py",
          "services/model-api/analysis/phase4/analyze_ar.py",
          "services/model-api/analysis/phase1/eval_decision_level.py",
          "services/model-api/analysis/phase1/p1lib.py",
          "data/keyrecs/free-text.csv",
          "data/keyrecs_impostors.h5",
          "artifacts/phase3/aalto_pool_ks.json"]
FROZEN_MODULES = ("population_sweep", "keyrecs_to_windows", "preprocessing")
SHA_FILE = os.path.join(STUDY, "PREREGISTRATION_AR.sha256")


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def current_hashes():
    import importlib.util
    out = {rel: sha(os.path.join(ROOT, rel)) for rel in FROZEN}
    for m in FROZEN_MODULES:
        out[f"module:{m}"] = sha(importlib.util.find_spec(m).origin)
    return out


def freeze():
    """Write PREREGISTRATION_AR.sha256 (once, before any result)."""
    if os.path.exists(SHA_FILE):
        raise SystemExit(f"{SHA_FILE} exists: AR is frozen already")
    got = current_hashes()
    with open(SHA_FILE, "w") as f:
        for k in sorted(got):
            f.write(f"{got[k]} {k}\n")
    print(f"frozen {len(got)} files -> {SHA_FILE}")


def verify_frozen():
    """Refuse to run unless every frozen file matches PREREGISTRATION_AR.sha256."""
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
        raise SystemExit("differs from PREREGISTRATION_AR.sha256: " + ", ".join(bad) + "; refusing to run")
    return {"preregistrationARSha256": got["artifacts/phase4/PREREGISTRATION_AR.md"],
            "frozenSetSha256": hashlib.sha256("".join(f"{k}{got[k]}" for k in sorted(got)).encode()).hexdigest()}


def write_json(path, obj, **kw):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, **kw)
    os.replace(tmp, path)


# ---------------------------------------------------------------- data ----
def load_sessions():
    """{target id: [steps of session 1, steps of session 2]} in the file's session order.

    Target ids are the keyrecs_impostors.h5 ids (participant codes sorted). Steps are
    keyrecs_to_windows.build_steps rows: [id1, id2, dwell1, dwell2, dd, ud]."""
    from keyrecs_to_windows import build_steps
    sessions, order = {}, []
    with open(KEYRECS_CSV, "r", encoding="utf-8", errors="ignore", newline="") as f:
        rdr = csv.reader(f)
        header = [h.strip() for h in next(rdr)]
        for parts in rdr:
            if not parts:
                continue
            r = {header[i]: parts[i] for i in range(min(len(header), len(parts)))}
            p = (r.get("participant") or "").strip()
            if not p:
                continue
            key = (p, (r.get("session") or "").strip())
            if key not in sessions:
                sessions[key] = []
                order.append(key)
            sessions[key].append(r)
    codes = sorted({p for p, _ in order})
    out = {}
    for tid, p in enumerate(codes):
        keys = [k for k in order if k[0] == p]
        out[tid] = {"code": p, "sessionLabels": [s for _, s in keys],
                    "steps": [np.asarray(build_steps(sessions[k]), np.float32).reshape(-1, 6) for k in keys]}
    return out


def windows(steps):
    """Windows of one contiguous stream (keyrecs_to_windows.steps_to_windows)."""
    from keyrecs_to_windows import steps_to_windows
    w = steps_to_windows(list(steps))
    return np.asarray(w, np.float32).reshape(-1, 50, 6)


def check_parity(sess, K, kpid):
    """The session-wise rebuild must give exactly the windows experiment KS used."""
    for tid, s in sess.items():
        mine = np.concatenate([windows(x) for x in s["steps"] if len(x)] or [np.zeros((0, 50, 6), np.float32)])
        ks = K[kpid == tid]
        if mine.shape != ks.shape or not np.array_equal(mine, ks):
            raise SystemExit(f"target {tid} ({s['code']}): rebuilt windows differ from keyrecs_impostors.h5")


def timeline(s):
    """(enrol samples, days, test steps) for one participant, or None if ineligible."""
    st = s["steps"]
    if len(st) != 2 or len(st[0]) < ENROL_STEPS or len(st[1]) < MIN_S2_STEPS:
        return None
    s1, s2 = st
    enrol = [s1[i * SAMPLE_STEPS:(i + 1) * SAMPLE_STEPS] for i in range(ENROL_SAMPLES)]
    rest1 = s1[ENROL_STEPS:]
    half = len(s2) // 2
    days = [rest1[k * SAMPLE_STEPS:(k + 1) * SAMPLE_STEPS] for k in range(len(rest1) // SAMPLE_STEPS)]
    days += [s2[k * SAMPLE_STEPS:(k + 1) * SAMPLE_STEPS] for k in range(half // SAMPLE_STEPS)]
    if len(days) < MIN_DAYS:
        return None
    return enrol, days, s2[half:]


# ---------------------------------------------------------------- the deployed gates ----
def rhythm_z(candidate_steps, history_steps):
    """checkRhythmConsistency: |mean of the candidate's digraphs - pooled history mean| / pooled std."""
    hist = np.concatenate(history_steps)[:, RHYTHM_IDX].astype(np.float64)
    if len(hist) < RHYTHM_MIN_HIST or len(candidate_steps) == 0:
        return 0.0
    m = hist.mean(0)
    sd = np.sqrt(np.maximum((hist ** 2).mean(0) - m ** 2, 1e-8))
    c = candidate_steps[:, RHYTHM_IDX].astype(np.float64).mean(0)
    return float(np.abs((c - m) / sd).max())


def gate(scores, candidate_steps, history_steps):
    """The server's contribution gates, in its order. Returns (accepted, reason, rolling mean, worst, z)."""
    s = np.asarray(scores, float)[-SCORED_N:]
    rolling = s[-ROLLING_N:]
    rm = float(rolling.mean()) if len(rolling) else 0.0
    worst = float(s[-CONTRIB_N:].min()) if len(s) else 0.0
    z = rhythm_z(candidate_steps, history_steps)
    if len(rolling) < CONTRIB_N:
        return False, "windows", rm, worst, z
    if rm < CONF_MIN:
        return False, "rolling", rm, worst, z
    if worst < WINDOW_FLOOR:
        return False, "floor", rm, worst, z
    if z > RHYTHM_Z:
        return False, "rhythm", rm, worst, z
    return True, "ok", rm, worst, z


# ---------------------------------------------------------------- the live lock rule ----
def replay_locks(scores):
    """Passkey triggers along one contiguous stream, one check per new window, as ca-service decides:
    warm-up while <= 20 windows unless overwhelming (>= 8 windows, >= 75% of the last <= 20 below 0.50);
    suspicious = >= 10 of the last 20 below 0.50; trigger = suspicious and (overwhelming or >= 2 of the
    last 3 checks suspicious); a trigger resets the debounce history (the step-up resets the tracker)."""
    s = np.asarray(scores, float)
    locks, hist, start = [], [], 0
    for i in range(1, len(s) + 1):
        w = s[start:i]
        recent = w[-N_PACKET:]
        low = int((recent < LIVE_THRESHOLD).sum())
        overwhelming = len(recent) >= WARM_MIN and low >= math.ceil(len(recent) * WARM_FRAC)
        warm = len(w) <= N_PACKET and not overwhelming
        suspicious = (not warm) and len(recent) > 0 and low / len(recent) >= VOTE_FRACTION
        hist = (hist + [suspicious])[-DEBOUNCE_WINDOW:]
        if suspicious and (overwhelming or sum(hist) >= DEBOUNCE_MIN):
            locks.append(i - 1)
            hist, start = [], i          # after the step-up the tracker restarts from the next window
    return locks


# ---------------------------------------------------------------- training (KS run_target recipe) ----
def load_negatives(smoke):
    """The KS Aalto pool, first A_POOL kept typists (KS arm A200 = the live negatives)."""
    import h5py
    manifest = json.load(open(KS_POOL_MANIFEST))
    pool_h5 = os.path.join(ROOT, manifest["poolH5"])
    if not smoke and sha(pool_h5) != manifest["poolH5Sha256"]:
        raise SystemExit(f"{pool_h5} differs from its manifest")
    with h5py.File(pool_h5, "r") as f:
        W, P = np.asarray(f["windows"], np.float32), np.asarray(f["participant"]).astype(np.int64)
    ids = [int(x) for x in manifest["kept"]][:A_POOL]
    m = np.isin(P, ids)
    return W[m], P[m], ids


def train(pos_samples, seed, NEG, npid, neg_pool, scaler, epochs):
    """population_sweep / run_ks.run_target, with the positives given (samples in time order)."""
    import tensorflow as tf
    from tensorflow.keras.callbacks import EarlyStopping
    from population_sweep import VAL_FRAC, build_model, scale, split_with_gap
    rng = np.random.default_rng(seed)
    tf.keras.utils.set_random_seed(seed)
    pos = np.concatenate(pos_samples)
    tr_idx, va_idx = split_with_gap(len(pos), 1.0 - VAL_FRAC)
    pos_tr, pos_va = pos[tr_idx], pos[va_idx]
    neg_parts = np.array(neg_pool)
    n_va = max(4, len(neg_parts) // 5)
    va_parts, tr_parts = neg_parts[:n_va], neg_parts[n_va:]
    want = max(len(pos_tr) * 2, 60)
    neg_tr_all, neg_va_all = NEG[np.isin(npid, tr_parts)], NEG[np.isin(npid, va_parts)]
    neg_tr = neg_tr_all[rng.choice(len(neg_tr_all), min(want, len(neg_tr_all)), replace=False)]
    neg_va = neg_va_all[rng.choice(len(neg_va_all), min(max(len(pos_va) * 2, 30), len(neg_va_all)), replace=False)]
    X_tr = scale(np.concatenate([pos_tr, neg_tr]), scaler)
    y_tr = np.concatenate([np.ones(len(pos_tr)), np.zeros(len(neg_tr))]).astype(np.int64)
    X_va = scale(np.concatenate([pos_va, neg_va]), scaler)
    y_va = np.concatenate([np.ones(len(pos_va)), np.zeros(len(neg_va))]).astype(np.int64)
    sh = rng.permutation(len(X_tr))
    model = build_model(pos.shape[1:])
    hist = model.fit(X_tr[sh], y_tr[sh], validation_data=(X_va, y_va), epochs=epochs, batch_size=16, verbose=0,
                     callbacks=[EarlyStopping(patience=6, restore_best_weights=True, monitor="val_loss")])
    return model, {"nPosTrain": int(len(pos_tr)), "nPosVal": int(len(pos_va)), "nNegTrain": int(len(neg_tr)),
                   "epochsRun": len(hist.history["loss"])}


def score(model, W, scaler):
    from population_sweep import scale
    if len(W) == 0:
        return np.zeros(0)
    p = model.predict(scale(W, scaler), batch_size=256, verbose=0)[:, 1]
    if not np.isfinite(p).all():
        raise SystemExit("non-finite scores (technical failure: re-run, log it)")
    return p.astype(float)


def blocks(seq, n=N_PACKET):
    import eval_decision_level as E
    return E.blocks(seq, n)


def load_scaler():
    from preprocessing import FeatureScaler
    return FeatureScaler.load(os.environ["KS_SCALER"])


def load_h5(path):
    import h5py
    with h5py.File(path, "r") as f:
        return np.asarray(f["windows"], np.float32), np.asarray(f["participant"]).astype(np.int64)


def impostor_pool(kpid):
    from population_sweep import IMP_POOL_SIZE, NEG_POOL_SIZE
    ids = np.sort(np.unique(kpid))
    return ids, ids[NEG_POOL_SIZE:NEG_POOL_SIZE + IMP_POOL_SIZE]


if __name__ == "__main__":
    if sys.argv[1:] == ["--freeze"]:
        freeze()
    else:
        raise SystemExit("usage: python ar_common.py --freeze")
