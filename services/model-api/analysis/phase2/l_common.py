"""Shared code for protocol L (artifacts/repr_arch_study/PREREGISTRATION_L.md).

* verify_frozen(): refuses to run unless PREREGISTRATION_L.md, SPLIT_J.json, SPLIT_L.json,
  eval_decision_level.py and make_split_l.py match PREREGISTRATION_L.sha256. Every result carries the hashes.
* Windows are built with the study's own functions (repr_arch_study: A5, 50 steps, stride 10,
  deployed step filter). guard_users() refuses development users unless SELECTION_L.json exists, and
  refuses lockbox-1 users always (section 8).
* The per-user system is the "F2-style" head of section 3: embedding centred on the cohort mean and
  L2-normalised, logistic regression (C = 1) on the enrolment windows vs 2 x budget cohort windows
  (seed 21), threshold-source scores = leave-one-sample-out over samples of 55 windows, purging the
  4 windows on either side of the held-out sample.

Implementation details fixed here before any L result exists (none changes a rule of the
pre-registration): the scaler is the base-80 scaler (artifacts/mouse-fcn-a5-j80/scaler.json), the one
S0/S1 use in stage D. Both objectives train on class-balanced batches of 32 users x 8 windows. The
cohort for selection scoring on base-val is base-train (the base-val users must not see themselves as
negatives); for stage D it is all 80 base users, as for F2. Smoke tests write only under
artifacts/phase2/L/smoke/, never SELECTION_L.json, and every real step refuses smoke inputs.
"""
import glob
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
MODEL_API = os.path.join(ROOT, "services", "model-api")
STUDY = os.path.join(ROOT, "artifacts", "repr_arch_study")
OUT = os.path.join(ROOT, "artifacts", "phase2", "L")
SMOKE = os.path.join(OUT, "smoke")
DATA = os.path.join(ROOT, "data", "sapimouse")
SCALER = os.path.join(ROOT, "artifacts", "mouse-fcn-a5-j80", "scaler.json")
BASE80 = os.path.join(ROOT, "artifacts", "mouse-fcn-a5-j80", "final_model")
SELECTION = os.path.join(OUT, "SELECTION_L.json")
P3_PARTS = os.path.join(STUDY, "parts", "J_P3")
PREREG_J_SHA = os.path.join(STUDY, "PREREGISTRATION_J.sha256")
sys.path.insert(0, MODEL_API)
sys.path.insert(0, os.path.join(HERE, "..", "phase1"))

BUDGET, SAMPLE, PURGE, IMP_RUN, N_DEC = 440, 55, 4, 150, 33
COHORT_PER_USER, COHORT_SEED, NEG_SEED = 40, 7, 21
Q_TAU, VOTE_N, VOTE_K = 20, 60, 33          # S1's operating point (mouse.js), for the reported replay
SEEDS = (101, 102, 103)

HASHED = {"PREREGISTRATION_L.md": os.path.join(STUDY, "PREREGISTRATION_L.md"),
          "SPLIT_J.json": os.path.join(STUDY, "SPLIT_J.json"),
          "SPLIT_L.json": os.path.join(STUDY, "SPLIT_L.json"),
          "services/model-api/analysis/phase1/eval_decision_level.py":
              os.path.join(MODEL_API, "analysis", "phase1", "eval_decision_level.py"),
          "services/model-api/analysis/phase2/make_split_l.py": os.path.join(HERE, "make_split_l.py")}


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def verify_frozen():
    want = {}
    for line in open(os.path.join(STUDY, "PREREGISTRATION_L.sha256")):
        if line.strip():
            h, name = line.split()
            want[name] = h
    got = {}
    for name, path in HASHED.items():
        got[name] = sha(path)
        if want.get(name) != got[name]:
            raise SystemExit(f"{name} does not match PREREGISTRATION_L.sha256 ({got[name][:8]} vs "
                             f"{want.get(name, '?')[:8]}); refusing to run")
    return {"preregistrationLSha256": got["PREREGISTRATION_L.md"], "splitJSha256": got["SPLIT_J.json"],
            "splitLSha256": got["SPLIT_L.json"],
            "evalDecisionLevelSha256": got["services/model-api/analysis/phase1/eval_decision_level.py"],
            "makeSplitLSha256": got["services/model-api/analysis/phase2/make_split_l.py"]}


# The code that produces protocol-L results. Its hashes go into every model, selection_scores.json and
# SELECTION_L.json; score_l.py and analyze_l.py refuse to run on code that differs from SELECTION_L.json
# unless an amendment is named (--amended).
CODE = ["services/model-api/analysis/phase2/" + f for f in
        ("l_common.py", "train_embedding_l.py", "select_l.py", "finalize_l.py", "score_l.py", "analyze_l.py")] + \
       ["services/model-api/analysis/phase1/p1lib.py"]


def code_hashes():
    import importlib.util
    out = {rel: sha(os.path.join(ROOT, rel)) for rel in CODE}
    for mod in ("repr_arch_study", "preprocess_mouse"):
        out[f"module:{mod}"] = sha(importlib.util.find_spec(mod).origin)
    return out


def check_code(sel, amended=None):
    """Stage D runs the code frozen in SELECTION_L.json, or names the amendment that changed it."""
    now, then = code_hashes(), sel.get("codeSha256", {})
    changed = sorted(k for k in set(now) | set(then) if now.get(k) != then.get(k))
    if not changed:
        return {"codeMatchesSelection": True}
    if not amended:
        raise SystemExit("code differs from SELECTION_L.json: " + ", ".join(changed) +
                         ". Write an amendment first, then pass --amended <its path>.")
    if not os.path.exists(amended):
        raise SystemExit(f"amendment {amended} not found")
    return {"codeMatchesSelection": False, "changedFiles": changed,
            "amendment": os.path.relpath(os.path.abspath(amended), ROOT).replace(os.sep, "/"),
            "amendmentSha256": sha(amended)}


def write_json(path, obj, **kw):
    """Write-then-rename, so a crash never leaves a truncated result under its final name."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, **kw)
    os.replace(tmp, path)


def check_hashes(obj, hashes, what):
    """A result file must carry the current frozen hashes (section 'Status')."""
    for k, v in hashes.items():
        if obj.get(k) != v:
            raise SystemExit(f"{what}: produced under another {k} ({str(obj.get(k))[:8]} vs {v[:8]}); refusing it")


def splits():
    j = json.load(open(HASHED["SPLIT_J.json"]))
    l = json.load(open(HASHED["SPLIT_L.json"]))
    return j, l


_SELECTION_OK = []


def guard_users(users, purpose):
    """Section 8: development users only after a valid SELECTION_L.json exists; lockbox 1 never."""
    j, _ = splits()
    lock1, dev = set(j["lockbox"]), set(j["development"])
    bad = [u for u in users if u in lock1]
    if bad:
        raise PermissionError(f"{purpose}: lockbox-1 users are never read by protocol L ({bad[:3]})")
    if any(u in dev for u in users):
        if not os.path.exists(SELECTION):
            raise PermissionError(f"{purpose}: development users before SELECTION_L.json exists")
        if not _SELECTION_OK:
            load_selection()                       # hashes, smoke flag, model files
            _SELECTION_OK.append(True)


def base80_users():
    """The 80 base users in SPLIT_J order (the order frozen_check.py drew its cohort in)."""
    j, _ = splits()
    return list(j["baseTraining"])


# ------------------------------------------------------------------ windows --
class Windows:
    """A5 windows per user and session, built with repr_arch_study, cached per process.
    (A5 = |dx|, |dy| ignores the session scale, so these equal protocol J's Reader windows.)"""

    def __init__(self, purpose):
        self.purpose, self._c = purpose, {}

    def _sessions(self, u):
        cs = sorted(glob.glob(os.path.join(DATA, u, "*.csv")))
        lo = [c for c in cs if "3min" in os.path.basename(c)]
        sh = [c for c in cs if "1min" in os.path.basename(c)]
        return (lo[0] if lo else None), (sh[0] if sh else None)

    def get(self, u, which):
        guard_users([u], self.purpose)
        key = (u, which)
        if key not in self._c:
            from repr_arch_study import raw_steps, windows, _read_events
            lo, sh = self._sessions(u)
            path = lo if which == "long" else sh
            self._c[key] = (windows(raw_steps(_read_events(path)), 1.0, "A5") if path
                            else np.zeros((0, 50, 2), np.float32))
        return self._c[key]


def load_scaler():
    d = json.load(open(SCALER))
    mu, sd = np.asarray(d["mean"], np.float64), np.asarray(d["std"], np.float64)
    sd[sd == 0] = 1.0
    return lambda X: ((np.asarray(X, np.float64) - mu) / sd).astype(np.float32)


# ------------------------------------------------------------------ models ---
def build_backbone(emb_dim=128):
    """B6 FCN (SapiMouse; train_mouse_fcn / repr_arch_study 'fcn') up to GAP, + Dense(emb_dim), L2."""
    import tensorflow as tf
    L = tf.keras.layers
    x_in = L.Input((50, 2), name="window")
    x = x_in
    for i, (f, k) in enumerate(((128, 8), (256, 5), (128, 3)), start=1):
        x = L.Conv1D(f, k, padding="same", name=f"conv{i}")(x)
        x = L.BatchNormalization(name=f"bn{i}")(x)
        x = L.Activation("relu")(x)
    x = L.GlobalAveragePooling1D(name="gap")(x)
    x = L.Dense(emb_dim, name="proj")(x)
    x = L.UnitNormalization(name="l2")(x)
    return tf.keras.Model(x_in, x, name="embedding_l")


def unit(Z):
    return Z / np.maximum(np.linalg.norm(Z, axis=1, keepdims=True), 1e-12)


def embedder_from(model, scale):
    dim = int(model.output_shape[-1])
    return lambda X: (model.predict(scale(X), batch_size=1024, verbose=0) if len(X)
                      else np.zeros((0, dim), np.float32))


def base80_embedder(scale):
    """The frozen base-80 network's GAP output (F2's embedding)."""
    import tensorflow as tf
    m = tf.keras.models.load_model(BASE80, compile=False)
    sub = tf.keras.Model(m.input, m.get_layer("embedding").output)
    return embedder_from(sub, scale)


def load_model_dir(model_dir, allow_smoke=False):
    """A protocol-L embedding: weights verified against their meta.json hash."""
    meta = json.load(open(os.path.join(model_dir, "meta.json")))
    w = os.path.join(model_dir, "embedding.weights.h5")
    if sha(w) != meta["weightsSha256"]:
        raise SystemExit(f"{model_dir}: weights do not match meta.json")
    if meta.get("smokeTest") and not allow_smoke:
        raise SystemExit(f"{model_dir} is a smoke-test model")
    m = build_backbone()
    m.load_weights(w)
    return m, meta


# ------------------------------------------------------------------ selection record ---
def load_selection(path=SELECTION, allow_smoke=False):
    """SELECTION_L.json, checked against the frozen hashes and the model files it names."""
    if not os.path.exists(path):
        raise SystemExit(f"{path} does not exist: run select_l.py and finalize_l.py first")
    s = json.load(open(path))
    check_hashes(s, verify_frozen(), os.path.basename(path))
    if s.get("smokeTest") and not allow_smoke:
        raise SystemExit(f"{path} is a smoke-test selection")
    for m in s["models"]:
        d = os.path.join(ROOT, m["dir"])
        if sha(os.path.join(d, "embedding.weights.h5")) != m["weightsSha256"]:
            raise SystemExit(f"{d}: weights differ from {os.path.basename(path)}")
    return s


# ------------------------------------------------------------------ per-user head (F2 style) ---
def cohort(emb, W, users):
    rng = np.random.default_rng(COHORT_SEED)
    Z = []
    for u in users:
        X = W.get(u, "long")
        E = emb(X)
        Z.append(E[rng.choice(len(E), min(COHORT_PER_USER, len(E)), replace=False)])
    Z = np.concatenate(Z)
    mu = Z.mean(0)
    return mu, unit(Z - mu)


def loso_folds(n=BUDGET, k=SAMPLE):
    folds = []
    for s in range(n // k):
        lo, hi = s * k, (s + 1) * k
        keep = np.array([i for i in range(n) if i < lo - PURGE or i >= hi + PURGE])
        folds.append((keep, np.arange(lo, hi)))
    return folds


def head_scores(E_enrol, C, tests):
    """Logistic head on centred+normalised embeddings. Returns scores for each test array and the
    leave-one-sample-out reference scores."""
    from sklearn.linear_model import LogisticRegression
    neg = C[np.random.default_rng(NEG_SEED).choice(len(C), 2 * len(E_enrol), replace=False)]

    def fit(P):
        X = np.concatenate([P, neg])
        y = np.r_[np.ones(len(P)), np.zeros(len(neg))]
        return LogisticRegression(C=1.0, solver="lbfgs", max_iter=5000).fit(X, y)
    full = fit(E_enrol)
    out = {k: full.predict_proba(v)[:, 1] if len(v) else np.zeros(0) for k, v in tests.items()}
    ref = np.zeros(len(E_enrol))
    for keep, held in loso_folds(len(E_enrol)):
        ref[held] = fit(E_enrol[keep]).predict_proba(E_enrol[held])[:, 1]
    return out, ref


def centroid_scores(E_enrol, tests):
    """'L with centroid cosine' (section 3, reference only): cosine to the enrolment centroid, with
    the same leave-one-sample-out threshold source."""
    c = unit(E_enrol.mean(0)[None])[0]
    out = {k: (v @ c) if len(v) else np.zeros(0) for k, v in tests.items()}
    ref = np.zeros(len(E_enrol))
    for keep, held in loso_folds(len(E_enrol)):
        ref[held] = E_enrol[held] @ unit(E_enrol[keep].mean(0)[None])[0]
    return out, ref


def _unit_of(s, ref):
    return {"genuine": s["genuine"], "runs": {o: s[o] for o in s if o != "genuine"},
            "ref": ref, "tau": float(np.percentile(ref, Q_TAU))}


def score_targets(emb, W, targets, impostor_pool, cohort_users, centroid=False):
    """Per target: {genuine, runs, ref, tau} for eval_decision_level (the F2-style system).
    genuine = the whole 1-min session; impostor runs = the first IMP_RUN windows of every other
    pool user's 1-min session (users without one are skipped, as protocol J did). With centroid=True
    also returns the centroid-cosine units."""
    mu, C = cohort(emb, W, cohort_users)
    Z = {u: unit(emb(W.get(u, "short")) - mu) for u in sorted(set(targets) | set(impostor_pool))}
    units, cent = {}, {}
    for u in targets:
        X = W.get(u, "long")[:BUDGET]
        if len(X) != BUDGET:
            raise SystemExit(f"{u}: {len(X)} enrolment windows, not {BUDGET}")
        E_enrol = unit(emb(X) - mu)
        tests = {"genuine": Z[u], **{o: Z[o][:IMP_RUN] for o in impostor_pool if o != u and len(Z[o])}}
        s, ref = head_scores(E_enrol, C, tests)
        units[u] = _unit_of(s, ref)
        if centroid:
            s, ref = centroid_scores(E_enrol, tests)
            cent[u] = _unit_of(s, ref)
    return (units, cent) if centroid else units


def per_user_auc(units, n=N_DEC):
    import eval_decision_level as E
    ev = E.evaluate(units, n)
    return {u: ev["perUser"][u]["aucPct"] for u in units}, ev


# ------------------------------------------------------------------ serialisation ---
def check_finite(units, what):
    for u, d in units.items():
        arrs = [d["genuine"], d["ref"], *d["runs"].values()]
        if not all(np.isfinite(np.asarray(a, float)).all() for a in arrs):
            raise SystemExit(f"{what} {u}: non-finite scores")


def units_to_json(units, digits=None):
    """Scores at full float precision (digits=None), so no probability saturates into a tie."""
    r = (lambda a: [float(x) for x in a]) if digits is None else (lambda a: [round(float(x), digits) for x in a])  # noqa: E731
    return {u: {"genuine": r(d["genuine"]), "runs": {o: r(v) for o, v in d["runs"].items()},
                "ref": r(d["ref"]), "tau": float(d["tau"])} for u, d in units.items()}


def units_from_json(obj):
    a = lambda x: np.asarray(x, float)  # noqa: E731
    return {u: {"genuine": a(d["genuine"]), "runs": {o: a(v) for o, v in d["runs"].items()},
                "ref": a(d["ref"]), "tau": float(d["tau"])} for u, d in obj.items()}
