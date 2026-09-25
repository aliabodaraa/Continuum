"""Shared code for protocol L, stage C (PREREGISTRATION_L.md sections 3, 5 and 6; Amendments L-1, L-2).

Stage C tests Q2 on the Bogazici Mouse Dynamics Dataset: is F2 (the deployed network, frozen, with
the per-user logistic head) non-inferior to REF (S1 exactly as deployed)? Q1 (L) is not tested:
L stopped at stage D (stage_D.json, commit 19c57b6).

* REF = S1 as deployed: api.train_user_loso_payload with the payload mouse.js sends (8 samples of 55,
  leave-one-sample-out, overlap gap 5, 15 epochs, batch 32), on the deployed base-100 network, its
  scaler and its negatives file; then api.predict_user_payload.
* F2 = the same base-100 network, frozen; GAP embedding centred on the cohort mean (40 windows from
  each of the 100 users it was trained on, seed 7) and L2-normalised; logistic head (C = 1, lbfgs)
  on the 440 enrolment windows vs 880 cohort windows (seed 21); leave-one-sample-out threshold source.
  The cohort includes lockbox-1's 20 users because they are among the network's 100 training users
  (Amendment L-2 records this); they serve as cohort/negatives only, never as test users. The 20
  development users (the network's hold-out) are never read.
* Decisions never straddle two sessions: every Bogazici session is its own stream, and blocks
  (eval_decision_level.blocks, gap 4) are cut inside each stream. The statistics are those of
  eval_decision_level.user_decisions, applied stream by stream.
"""
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402
import eval_decision_level as E  # noqa: E402

DEPLOYED = {"base": os.path.join(LC.ROOT, "artifacts", "mouse-fcn-a5", "final_model"),
            "scaler": os.path.join(LC.ROOT, "artifacts", "mouse-fcn-a5", "scaler.json"),
            "neg": os.path.join(LC.ROOT, "data", "mouse_only", "Mouse_A5_W50_base.h5"),
            "holdout": os.path.join(LC.ROOT, "artifacts", "mouse-fcn-a5", "holdout_users.json")}
OUT_C = os.path.join(LC.OUT, "stageC")
AMEND = {"L-1": os.path.join(LC.STUDY, "AMENDMENT_L1.md"), "L-2": os.path.join(LC.STUDY, "AMENDMENT_L2.md")}
AMEND_SHA = os.path.join(LC.STUDY, "AMENDMENT_L2.sha256")
Q2_MARGIN = -0.010
# Seconds of movement per window step (stride 10) in Bogazici, fixed by Amendment L-1 from the structure-only
# inspection (bogazici_inspect.json): the median over the 19 users of 10 x the mean step duration of their first
# training session after 60-Hz coalescing (per user 0.250-0.352 s; SapiMouse: 10 x 0.0269 s). It only converts
# the live loop to minutes.
SEC_PER_WINDOW_B = 0.2897181464995065
REF_PAYLOAD = {"modality": "mouse", "thresholdScheme": "leave-one-sample-out", "sampleWindows": LC.SAMPLE,
               "overlapGap": 5, "epochs": 15, "batchSize": 32}

# Files whose bytes stage C depends on; their hashes are frozen in AMENDMENT_L2.sha256.
STAGE_C_FILES = ["artifacts/repr_arch_study/AMENDMENT_L1.md", "artifacts/repr_arch_study/AMENDMENT_L2.md",
                 "services/model-api/analysis/phase2/c_common.py", "services/model-api/analysis/phase2/bogazici_l.py",
                 "services/model-api/analysis/phase2/score_c.py", "services/model-api/analysis/phase2/analyze_c.py",
                 "services/model-api/analysis/phase2/l_common.py", "services/model-api/analysis/phase1/p1lib.py",
                 "services/model-api/api.py", "services/model-api/loso.py",
                 "artifacts/mouse-fcn-a5/scaler.json", "artifacts/mouse-fcn-a5/holdout_users.json",
                 "data/mouse_only/Mouse_A5_W50_base.h5"]


def stage_c_hashes():
    import importlib.util
    out = {rel: LC.sha(os.path.join(LC.ROOT, rel)) for rel in STAGE_C_FILES}
    out["artifacts/mouse-fcn-a5/final_model"] = dir_sha(DEPLOYED["base"])
    for mod in ("repr_arch_study", "preprocess_mouse"):
        out[f"module:{mod}"] = LC.sha(importlib.util.find_spec(mod).origin)
    return out


def dir_sha(path):
    import hashlib
    h = hashlib.sha256()
    for base, _, files in sorted(os.walk(path)):
        for f in sorted(files):
            p = os.path.join(base, f)
            h.update(os.path.relpath(p, path).replace(os.sep, "/").encode())
            h.update(LC.sha(p).encode())
    return h.hexdigest()


def verify_stage_c():
    """PREREGISTRATION_L's frozen files, plus every stage-C file frozen by Amendment L-2."""
    hashes = LC.verify_frozen()
    for k, p in AMEND.items():
        if not os.path.exists(p):
            raise SystemExit(f"Amendment {k} ({p}) does not exist: no Bogazici score before L-1 and L-2")
    want = {}
    for line in open(AMEND_SHA):
        if line.strip():
            h, name = line.split(maxsplit=1)
            want[name.strip()] = h
    got = stage_c_hashes()
    bad = sorted(k for k in set(want) | set(got) if want.get(k) != got.get(k))
    if bad:
        raise SystemExit("stage C files differ from AMENDMENT_L2.sha256: " + ", ".join(bad))
    return {**hashes, "amendmentL1Sha256": got["artifacts/repr_arch_study/AMENDMENT_L1.md"],
            "amendmentL2Sha256": got["artifacts/repr_arch_study/AMENDMENT_L2.md"]}


# ------------------------------------------------------------------ SapiMouse cohort (base-100) ---
def base100_users():
    hold = set(json.load(open(DEPLOYED["holdout"]))["holdout_users"])
    users = sorted((os.path.basename(d) for d in glob.glob(os.path.join(LC.DATA, "user*"))), key=lambda u: int(u[4:]))
    out = [u for u in users if u not in hold]
    if len(out) != 100:
        raise SystemExit(f"expected the deployed network's 100 training users, found {len(out)}")
    return out


def sapimouse_long(u):
    """A5 windows of a base-100 user's 3-min session (cohort only)."""
    hold = set(json.load(open(DEPLOYED["holdout"]))["holdout_users"])
    if u in hold:
        raise PermissionError(f"{u} is a development user; stage C never reads them")
    from repr_arch_study import raw_steps, windows, _read_events
    cs = sorted(glob.glob(os.path.join(LC.DATA, u, "*.csv")))
    lo = [c for c in cs if "3min" in os.path.basename(c)]
    return windows(raw_steps(_read_events(lo[0])), 1.0, "A5") if lo else np.zeros((0, 50, 2), np.float32)


def load_scaler_c():
    d = json.load(open(DEPLOYED["scaler"]))
    mu, sd = np.asarray(d["mean"], np.float64), np.asarray(d["std"], np.float64)
    sd[sd == 0] = 1.0
    return lambda X: ((np.asarray(X, np.float64) - mu) / sd).astype(np.float32)


def deployed_embedder(scale):
    import tensorflow as tf
    m = tf.keras.models.load_model(DEPLOYED["base"], compile=False)
    return LC.embedder_from(tf.keras.Model(m.input, m.get_layer("embedding").output), scale)


def cohort_c(emb):
    rng = np.random.default_rng(LC.COHORT_SEED)
    Z = []
    for u in base100_users():
        E_ = emb(sapimouse_long(u))
        Z.append(E_[rng.choice(len(E_), min(LC.COHORT_PER_USER, len(E_)), replace=False)])
    Z = np.concatenate(Z)
    mu = Z.mean(0)
    return mu, LC.unit(Z - mu)


# ------------------------------------------------------------------ decisions over sessions ---
def stream_blocks(streams, n):
    return [b for s in streams for b in E.blocks(s, n)]


def user_decisions(u, n):
    """eval_decision_level.user_decisions, with genuine and impostor data as lists of sessions."""
    ref = np.sort(np.asarray(u["ref"], float))
    tau = float(np.percentile(u["ref"], LC.Q_TAU))

    def stats(bl):
        if not bl:
            return {k: np.zeros(0) for k in ("mean", "vote", "pct")}
        B = np.stack(bl)
        return {"mean": B.mean(1), "vote": (B >= tau).mean(1),
                "pct": (np.searchsorted(ref, B, "right") / len(ref)).mean(1)}
    g = stats(stream_blocks(u["genuine"], n))
    i = stats([b for runs in u["runs"].values() for b in stream_blocks(runs, n)])
    return {"g": g, "i": i, "nG": len(g["mean"]), "nI": len(i["mean"])}


def evaluate(units, n):
    dec = {t: user_decisions(u, n) for t, u in units.items()}
    per = {t: {"nG": x["nG"], "nI": x["nI"],
               "aucPct": E.auc_fast(x["g"]["pct"], x["i"]["pct"]) if x["nG"] and x["nI"] else float("nan")}
           for t, x in dec.items()}
    return {"n": n, "perUser": per, "pooled": E.pooled_metrics(dec, list(dec)), "_dec": dec}


# ------------------------------------------------------------------ serialisation ---
def units_to_json(units):
    f = lambda a: [float(x) for x in a]  # noqa: E731
    return {t: {"genuine": [f(s) for s in u["genuine"]],
                "runs": {o: [f(s) for s in r] for o, r in u["runs"].items()},
                "ref": f(u["ref"])} for t, u in units.items()}


def units_from_json(obj):
    a = lambda x: np.asarray(x, float)  # noqa: E731
    return {t: {"genuine": [a(s) for s in u["genuine"]],
                "runs": {o: [a(s) for s in r] for o, r in u["runs"].items()},
                "ref": a(u["ref"])} for t, u in obj.items()}
