import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    from flask import Flask, jsonify, request
except Exception:
    Flask = None
    jsonify = None
    request = None

try:
    import numpy as np
except Exception:
    np = None

try:
    from tensorflow.keras.models import load_model
    from tensorflow.keras.callbacks import EarlyStopping
    from tensorflow.keras.utils import set_random_seed
except Exception:
    load_model = None
    EarlyStopping = None
    set_random_seed = None

try:
    from model import build_1d_cnn_2rnn
except Exception:
    build_1d_cnn_2rnn = None

try:
    from preprocessing import FeatureScaler
except Exception:
    FeatureScaler = None

try:
    import loso
except Exception:
    loso = None


BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ---- SERVICE AUTHENTICATION -------------------------------------------------------
#
# This service had no notion of a caller. Its only protection was topology: compose gives
# it `expose:` rather than `ports:`, so it is not bound to the host. That is not an access
# control, and compose declared no networks at all — every container on the default bridge,
# including the demo app and the acme sample app, could reach it directly.
#
# What that exposed is worse than it sounds. /api/user/predict scores caller-supplied
# windows against a NAMED user's model, so anything on that network was a biometric oracle:
# submit candidate windows for a victim, read back the genuine probability, and hill-climb
# a forgery the real system will accept — no login and no session required. The same reach
# covers /api/user/train (poison a victim's model) and /api/user/rollback (revert it).
# confine_path() below blocks filesystem escape; it does nothing here, because the path is
# DERIVED from the caller's own userId field rather than supplied as one.
#
# The key answers "is this ca-service?" — a service credential, not a user identity. The
# question "may this request act for this person?" is answered one hop earlier, by the
# gateway's RS256 identity assertion that ca-service verifies. Only ca-service holds both a
# verified assertion and this key, so the two checks compose: nothing reaches a model
# without the gateway having vouched for the principal.
#
# Unset = disabled, matching CA_API_KEY and PASSKEY_API_KEY, so a bare `python api.py` still
# works for local model work. Every compose file sets it.
MODEL_API_KEY = os.getenv("MODEL_API_KEY", "")
if not MODEL_API_KEY:
    print(
        "[model-api][SECURITY] MODEL_API_KEY is unset — the scoring and training endpoints "
        "are UNAUTHENTICATED. Set it for any deployment: openssl rand -hex 32"
    )


def api_key_ok(supplied):
    """Constant-time compare so a wrong key leaks nothing through timing."""
    if not MODEL_API_KEY:
        return True  # check inactive
    import hmac
    return hmac.compare_digest(str(supplied or ""), MODEL_API_KEY)


MODEL_PATH = os.getenv("MODEL_PATH", os.path.join(BASE_DIR, "artifacts", "ws50", "final_model"))
SCALER_PATH = os.getenv("SCALER_PATH", os.path.join(os.path.dirname(MODEL_PATH), "scaler.json"))
# Storage roots, declared before anything that derives a default from them.
# DATA_DIR is set by compose (/app/data); deriving the negatives default from
# BASE_DIR instead pointed at /app/services/model-api/data, which does not
# exist, so get_dataset_negatives silently returned nothing and every live
# retrain ran with app-user negatives only — far weaker than intended, and
# occasionally none at all, which falls through to synthetic noise.
ARTIFACTS_DIR = os.getenv("ARTIFACTS_DIR", os.path.join(BASE_DIR, "artifacts"))
DATA_DIR = os.getenv("DATA_DIR", os.path.join(BASE_DIR, "data"))
NEGATIVE_DATASET_PATH = os.getenv(
    "NEGATIVE_DATASET_PATH", os.path.join(DATA_DIR, "Rand_WS50.h5")
)
HOST = os.getenv("MODEL_HOST", "0.0.0.0")
PORT = int(os.getenv("MODEL_PORT", "5000"))

# ---- storage OWNED by this service (microservice isolation) ----
# Callers identify a model by (userId, modality); they never dictate disk paths.
# These two roots are the only places this service reads or writes; any path a
# caller does supply (legacy/dev tooling like the sweep scripts) is CONFINED to
# them, so no request can make this service touch arbitrary files.
# Mouse-modality defaults (this service's own layout, env-overridable).
# These point at mouse-ws50-gru (train_mouse_base_id.py), NOT mouse-ws50-base.
# mouse-ws50-base came from train_mouse_base.py, which splits windows at random.
# Windows are cut size 50 / stride 10, so neighbours share 40 of their 50 motion
# steps: measured by CONTENT, 99.99% of its test windows share raw steps with a
# training window and 90.8% have an immediate neighbour, so its 51.1% top-1 is
# contamination, not generalisation. mouse-ws50-gru is session-disjoint (3-min
# session trains, 1-min session tests) with 20 users held out entirely, and
# reports 40.3% top-1 on 100-way identification against a 1% chance level.
# It is also the artifact every mouse evaluation and docs/MOUSE_MODALITY.md
# describe; both scalers are 7-dimensional, so the wrong one loaded silently.
#
# UPDATE: now mouse-ws50-aligned, retrained after the TRAIN/SERVE SKEW was
# fixed. The browser (sdk/js/mouse-features.js) breaks streams at 0.5 s, drops
# zero-displacement moves and skips near-static windows; the training data was
# built with a 2.0 s break and neither filter, so the deployed model was
# scoring a feature distribution it had never been trained on. That gap was
# measured in production: 52% of every live window was zero-displacement filler
# emitted during scrolling, which pinned scores near 0.28 and caused constant
# false locks. preprocess_mouse.py now applies the browser's rules and this
# base was retrained under them.
#
# On SapiMouse the change is statistically indistinguishable — paired AUC
# difference at 20 windows is +0.0000, 95% CI [-0.0131, +0.0167], better for
# 7 of 20 subjects. That is expected and is NOT the justification: SapiMouse is
# a dense clicking task with no scrolling, so the filters remove only 0.5% of
# its windows and it cannot exercise the defect. The justification is
# correctness — production must score what it was trained on — and the
# measurement above establishes only that the fix costs nothing.
# UPDATE (2026-09-13): mouse-fcn-a5, the configuration the pre-registered study selected
# (artifacts/repr_arch_study/RUN_LOG.md): SapiMouse's FCN on (|dx|, |dy|) windows, trained by
# train_mouse_fcn.py on the 100 base users. Its arch.json tells train_user_payload which layers
# to freeze. Negatives now come from BASE users only: the previous file pooled all 120 users,
# held-out ones included, which is harmless for real users but contaminates held-out evaluation.
MOUSE_BASE_MODEL_PATH = os.getenv("MOUSE_BASE_MODEL_PATH", os.path.join(ARTIFACTS_DIR, "mouse-fcn-a5", "final_model"))
MOUSE_SCALER_PATH = os.getenv("MOUSE_SCALER_PATH", os.path.join(ARTIFACTS_DIR, "mouse-fcn-a5", "scaler.json"))
MOUSE_NEG_DATASET_PATH = os.getenv("MOUSE_NEG_DATASET_PATH", os.path.join(DATA_DIR, "mouse_only", "Mouse_A5_W50_base.h5"))


def confine_path(p):
    """Resolve a caller-supplied path and reject anything outside our storage roots."""
    if not p:
        return None
    rp = os.path.realpath(p)
    for root in (ARTIFACTS_DIR, DATA_DIR):
        r = os.path.realpath(root)
        if rp == r or rp.startswith(r + os.sep):
            return rp
    raise ValueError(f"path outside model store: {p}")

model = None
model_error = None
_scaler = None
_dataset_negatives = None
_user_model_cache = {}
_user_model_locks = {}
_user_model_locks_guard = threading.Lock()

# Warm cache (TODO 5b). A cold load of a user's model can take longer than ca-service's 5 s
# inference deadline; the caller then gives up, retries, and used to start a second load of the
# same model. Now one load runs per model and later callers wait for it, the server loads the
# models of recently active users in the background at boot, and a model is loaded again as soon
# as training or a rollback replaces it.
_LIVE_MODEL = re.compile(r"(^|[/\\])users[/\\]user-[^/\\]+[/\\](final_model|mouse_model)$")
LAST_USED_FILE = os.path.join(ARTIFACTS_DIR, "users", ".last_used.json")
WARM_DAYS = float(os.getenv("MODEL_WARM_DAYS", "14"))
WARM_MAX = int(os.getenv("MODEL_WARM_MAX", "8"))
_track_use = False            # set by the server only: scripts that import this module record nothing
_last_used = {}
_last_used_saved = 0.0


def _model_lock(path):
    with _user_model_locks_guard:
        return _user_model_locks.setdefault(path, threading.Lock())


def get_user_model(path):
    cached = _user_model_cache.get(path)
    if cached is not None:
        return cached
    with _model_lock(path):
        if path not in _user_model_cache:
            _user_model_cache[path] = load_model(path)
            print(f"[cache] Loaded user model: {path}")
        return _user_model_cache[path]


def invalidate_user_model_cache(path):
    with _model_lock(path):
        if path in _user_model_cache:
            del _user_model_cache[path]
            print(f"[cache] Evicted stale model: {path}")


def warm_user_model_async(path):
    """Load a live user model in the background (server only)."""
    if not _track_use or not _LIVE_MODEL.search(path):
        return

    def run():
        try:
            get_user_model(path)
        except Exception as exc:                     # a failed warm-up must never break serving
            print(f"[cache] Warm-up of {path} failed: {exc}")
    threading.Thread(target=run, daemon=True).start()


def note_model_use(path):
    """Remember when a live user model last served a prediction, so the next boot can warm it.
    Written at once for a model's first use since boot, then at most every 10 minutes."""
    global _last_used_saved
    if not _track_use or not _LIVE_MODEL.search(path):
        return
    now = time.time()
    first = path not in _last_used
    _last_used[path] = now
    if not first and now - _last_used_saved < 600:
        return
    _last_used_saved = now
    try:
        used = {}
        if os.path.exists(LAST_USED_FILE):
            with open(LAST_USED_FILE, encoding="utf-8") as f:
                used = json.load(f)
        used.update({os.path.relpath(p, ARTIFACTS_DIR).replace(os.sep, "/"): t for p, t in _last_used.items()})
        tmp = LAST_USED_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(used, f)
        os.replace(tmp, LAST_USED_FILE)
    except (OSError, ValueError) as exc:
        print(f"[cache] Could not record model use: {exc}")


def warm_recent_user_models():
    """Server boot: record use from now on, and load in the background the live models used or
    trained in the last WARM_DAYS days, newest first, at most WARM_MAX. A model's time is the later
    of its last recorded prediction and its last training (the directory's modification time), so a
    model just rebuilt for a user who has not checked since is warmed too."""
    global _track_use
    _track_use = True
    cutoff = time.time() - WARM_DAYS * 86400
    latest = {}
    try:
        root = os.path.join(ARTIFACTS_DIR, "users")
        for user in os.listdir(root) if os.path.isdir(root) else []:
            for leaf in ("final_model", "mouse_model"):
                p = os.path.join(root, user, leaf)
                if _LIVE_MODEL.search(p) and os.path.isdir(p):
                    latest[p] = os.path.getmtime(p)
        if os.path.exists(LAST_USED_FILE):
            with open(LAST_USED_FILE, encoding="utf-8") as f:
                for rel, t in json.load(f).items():
                    p = os.path.join(ARTIFACTS_DIR, rel)
                    if p in latest:
                        latest[p] = max(latest[p], float(t))
    except (OSError, ValueError) as exc:
        print(f"[cache] Could not list recent models: {exc}")
    paths = [p for p, t in sorted(latest.items(), key=lambda kv: kv[1], reverse=True) if t >= cutoff][:WARM_MAX]

    def run():
        for p in paths:
            try:
                get_user_model(p)
            except Exception as exc:
                print(f"[cache] Warm-up of {p} failed: {exc}")
        print(f"[cache] Warm-up done: {len(paths)} user models")
    print(f"[cache] Warming {len(paths)} recently used user models in the background")
    threading.Thread(target=run, daemon=True).start()


_scaler_cache = {}


def get_scaler(path=None):
    """Load (and cache) a feature scaler. Defaults to the keystroke SCALER_PATH;
    a per-request path lets other modalities (mouse) use their own scaler."""
    path = path or SCALER_PATH
    if path not in _scaler_cache and FeatureScaler is not None:
        _scaler_cache[path] = FeatureScaler.load(path)
        if _scaler_cache[path] is not None:
            print(f"Feature scaler loaded from {path}")
        else:
            print(f"Warning: no feature scaler at {path}; using raw features")
    return _scaler_cache.get(path)


def scale_windows(windows, scaler_path=None):
    scaler = get_scaler(scaler_path)
    if scaler is None:
        return windows.astype(np.float32)
    return scaler.transform(windows)


_dataset_negatives_cache = {}
_dataset_negative_errors = {}


def get_dataset_negatives(window_size, num_features, max_windows=2000, dataset_path=None,
                          with_participants=False):
    """
    Real impostor windows sampled from a training dataset — each window belongs
    to a participant who is "not the current user", making far stronger
    negatives than synthetic noise. Defaults to the keystroke NEGATIVE_DATASET_
    PATH; a per-request `dataset_path` lets the mouse modality draw impostors
    from SapiMouse (Mouse_WS*.h5) and the live keystroke profile from Aalto
    (aalto_neg_A200.h5, T3.3). `max_windows` <= 0 keeps every window.

    with_participants=True returns (windows, participant ids or None); the ids
    exist only in files that store a `participant` dataset (the Aalto file).
    """
    path = dataset_path or NEGATIVE_DATASET_PATH
    if max_windows is None or max_windows <= 0:
        max_windows = 0
    cache_key = (path, max_windows)
    if cache_key not in _dataset_negatives_cache:
        try:
            import h5py

            with h5py.File(path, "r") as f:
                key = "train_data" if "train_data" in f else "X"
                data = f[key]
                if max_windows and max_windows < len(data):
                    rng = np.random.default_rng(13)
                    idx = np.sort(rng.choice(len(data), size=max_windows, replace=False))
                else:
                    idx = np.arange(len(data))
                pids = np.asarray(f["participant"])[idx] if "participant" in f else None
                _dataset_negatives_cache[cache_key] = (np.array(data[idx], dtype=np.float32), pids)
            _dataset_negative_errors.pop(path, None)
            print(f"Loaded {len(_dataset_negatives_cache[cache_key][0])} impostor windows from {path}")
        except Exception as exc:
            # This used to print a warning and hand back an empty array, so a
            # mistyped path degraded every retrain to app-user-only (or synthetic)
            # negatives with nothing visible to the caller. Record the reason so
            # it reaches the training response and the stored profile.
            _dataset_negative_errors[path] = f"{type(exc).__name__}: {exc}"
            print(f"ERROR: dataset negatives unavailable at {path}: {exc}")
            _dataset_negatives_cache[cache_key] = (
                np.empty((0, window_size, num_features), dtype=np.float32), None)

    neg, pids = _dataset_negatives_cache[cache_key]
    if neg.shape[1:] != (window_size, num_features):
        # Previously returned empty with no message at all — the most silent of
        # the two failure modes, and the one a modality mix-up would hit.
        if len(neg):
            _dataset_negative_errors[path] = (
                f"shape mismatch: dataset holds {neg.shape[1:]}, "
                f"model needs {(window_size, num_features)}")
            print(f"ERROR: {_dataset_negative_errors[path]} ({path})")
        neg, pids = np.empty((0, window_size, num_features), dtype=np.float32), None
    return (neg, pids) if with_participants else neg


def dataset_negative_status(path=None):
    """Why dataset negatives are unavailable, or None when they loaded."""
    return _dataset_negative_errors.get(path or NEGATIVE_DATASET_PATH)


def preflight_negatives():
    """Check the configured negatives dataset at STARTUP, so a misconfigured path
    is caught at boot rather than silently degrading the next retrain."""
    path = NEGATIVE_DATASET_PATH
    if not os.path.exists(path):
        print(f"PREFLIGHT FAIL: negatives dataset missing: {path}")
        _dataset_negative_errors[path] = f"file does not exist: {path}"
        return False
    print(f"PREFLIGHT OK: negatives dataset present: {path}")
    return True


def init_model():
    global model, model_error
    if load_model is None:
        model_error = "TensorFlow is not installed"
        print(f"TensorFlow model unavailable: {model_error}")
        return

    if not os.path.exists(MODEL_PATH):
        model_error = f"model path does not exist: {MODEL_PATH}"
        print(f"TensorFlow model unavailable: {model_error}")
        return

    try:
        model = load_model(MODEL_PATH)
        model_error = None
        print(f"Model loaded from {MODEL_PATH}")
    except Exception as exc:
        model_error = str(exc)
        print(f"Warning: Could not load model from {MODEL_PATH}: {exc}")


def predict_payload(payload):
    if not payload or "input" not in payload:
        return {"error": "No input provided"}, 400

    if model is not None and np is not None:
        input_array = np.array(payload["input"], dtype=np.float32)
        if input_array.ndim == 1:
            input_array = np.expand_dims(input_array, axis=(0, 2))
        elif input_array.ndim == 2:
            input_array = np.expand_dims(input_array, axis=0)

        if input_array.shape[-1] == 6:
            input_array = scale_windows(input_array)
        predictions = model.predict(input_array)
        return {
            "prediction": predictions.tolist(),
            "class": int(np.argmax(predictions[0])),
            "model_loaded": True,
            "mode": "tensorflow",
        }, 200

    return {
        "error": "TensorFlow model is not loaded",
        "model_loaded": False,
        "mode": "unavailable",
        "model_error": model_error,
    }, 503


def user_model_path(user_id, modality="keystroke"):
    """THE per-user model location — derived from (userId, modality), owned here."""
    safe_user_id = str(user_id).replace("/", "").replace("\\", "")
    leaf = "mouse_model" if modality == "mouse" else "final_model"
    return os.path.join(ARTIFACTS_DIR, "users", f"user-{safe_user_id}", leaf)


# ---- ACTION-BASED mouse path (Antal & Egyed-Zsigmond, IET Biometrics 2019) --
# The window path above segments motion into fixed 50-step windows, a parameter
# carried over from the KEYSTROKE method of Lu et al. that has no published
# basis for a pointer. This path segments into mouse ACTIONS and scores each
# with a Random Forest over the paper's 39 features, which is the field's
# standard and what the deployed mouse channel now uses.
#
# The Random Forest is chosen over the CNN+GRU arm on a measured operating
# point, not on preference: at a 1% false-accept budget it reaches TAR 35.11%
# against the network's 7.14% on the same 20 held-out subjects, even though the
# two have identical AUC (0.947). TAR@FAR=1% is what decides whether the channel
# is usable as a step-up trigger.
MOUSE_ACTION_DATASET_PATH = os.getenv(
    "MOUSE_ACTION_DATASET_PATH", os.path.join(DATA_DIR, "mouse_only", "Mouse_Actions.h5"))
MOUSE_ACTION_FEATURES = 39
MOUSE_ACTION_TREES = 100        # the paper's Random Forest size
MOUSE_ACTION_SET_SIZE = 20      # the paper: 10-20 actions are needed per decision
_action_negatives_cache = {}


def user_action_model_path(user_id):
    safe = str(user_id).replace("/", "").replace("\\", "")
    return os.path.join(ARTIFACTS_DIR, "users", f"user-{safe}", "mouse_action_model.joblib")


def to_action_array(value):
    arr = np.array(value, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)
    if arr.ndim != 2 or arr.shape[1] != MOUSE_ACTION_FEATURES:
        raise ValueError(
            f"actions must be (n, {MOUSE_ACTION_FEATURES}); got {arr.shape}")
    arr[~np.isfinite(arr)] = 0.0
    return arr


def get_action_negatives(max_actions=4000, dataset_path=None):
    """Real actions from other people, for the per-user Random Forest."""
    path = dataset_path or MOUSE_ACTION_DATASET_PATH
    if path not in _action_negatives_cache:
        import h5py
        with h5py.File(path, "r") as f:
            X = np.array(f["X"], dtype=np.float64)
        rng = np.random.default_rng(13)
        if len(X) > max_actions:
            X = X[rng.choice(len(X), size=max_actions, replace=False)]
        X[~np.isfinite(X)] = 0.0
        _action_negatives_cache[path] = X
        print(f"Loaded {len(X)} impostor actions from {path}")
    return _action_negatives_cache[path]


def train_user_actions_payload(payload):
    """Per-user Random Forest over 39 action features."""
    try:
        from joblib import dump
        from sklearn.ensemble import RandomForestClassifier
    except Exception as exc:
        return {"error": f"scikit-learn/joblib unavailable: {exc}"}, 503
    try:
        pos = to_action_array(payload.get("actions") or [])
    except ValueError as exc:
        return {"error": str(exc)}, 400

    min_actions = int(payload.get("minActions", 40))
    if len(pos) < min_actions:
        return {"error": f"not enough actions: {len(pos)} collected, {min_actions} required",
                "actionCount": int(len(pos)),
                "requiredActions": min_actions}, 400

    raw_neg = payload.get("negativeActions")
    if raw_neg:
        neg = to_action_array(raw_neg)
        neg_source = "app-users"
    else:
        pool = get_action_negatives()
        rng = np.random.default_rng(21)
        take = min(len(pos), len(pool))
        neg = pool[rng.choice(len(pool), size=take, replace=False)]
        neg_source = "dataset"

    X = np.vstack([pos, neg])
    y = np.concatenate([np.ones(len(pos)), np.zeros(len(neg))])

    clf = RandomForestClassifier(n_estimators=MOUSE_ACTION_TREES,
                                 random_state=13, n_jobs=-1)
    clf.fit(X, y)

    path = user_action_model_path(payload["userId"])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    dump(clf, path)
    _user_action_models.pop(path, None)

    # Out-of-bag-style sanity: resubstitution accuracy on the genuine half only,
    # reported so a caller can see the fit did something, never as a metric.
    train_acc = float(clf.score(X, y))
    return {
        "ok": True, "userId": payload["userId"], "modelPath": path,
        "actionCount": int(len(pos)), "negativeActionCount": int(len(neg)),
        "negativeSource": neg_source, "trees": MOUSE_ACTION_TREES,
        "setSize": MOUSE_ACTION_SET_SIZE, "trainAccuracy": train_acc,
        "method": "Antal & Egyed-Zsigmond, IET Biometrics 8(5):285-294, 2019",
    }, 200


_user_action_models = {}


def predict_user_actions_payload(payload):
    """Score actions and aggregate by the paper's mean-of-k rule."""
    try:
        from joblib import load
    except Exception as exc:
        return {"error": f"joblib unavailable: {exc}"}, 503
    try:
        acts = to_action_array(payload.get("actions") or [])
    except ValueError as exc:
        return {"error": str(exc)}, 400

    path = confine_path(payload.get("modelPath")) or user_action_model_path(payload["userId"])
    if not os.path.exists(path):
        return {"error": "no action model for this user", "modelPath": path}, 404
    if path not in _user_action_models:
        _user_action_models[path] = load(path)
    clf = _user_action_models[path]

    scores = clf.predict_proba(acts)[:, 1].astype(float)
    k = int(payload.get("setSize", MOUSE_ACTION_SET_SIZE))
    threshold = float(payload.get("threshold", 0.5))

    # P(A) = (1/k) * sum(p_i) over the most recent k actions (the paper's rule).
    warmup = len(scores) < k
    set_score = float(np.mean(scores[-k:])) if len(scores) else 0.0
    return {
        "ok": True, "userId": payload["userId"],
        "scores": scores.tolist(),
        "setScore": set_score, "setSize": k, "threshold": threshold,
        "warmup": warmup,
        "isSuspicious": bool((not warmup) and set_score < threshold),
    }, 200


def to_window_array(value):
    if np is None:
        raise RuntimeError("NumPy is not installed")
    arr = np.array(value, dtype=np.float32)
    if arr.ndim == 2:
        arr = np.expand_dims(arr, axis=0)
    if arr.ndim != 3:
        raise ValueError("windows must have shape (samples, window_size, features)")
    return arr


def make_synthetic_negatives(positive_windows):
    """Fallback negatives when no real impostor windows are available:
    shuffle the temporal order and rescale the timing features."""
    negatives = positive_windows.copy()
    if len(negatives) == 0:
        return negatives

    rng = np.random.default_rng(42)
    for idx in range(len(negatives)):
        rng.shuffle(negatives[idx], axis=0)
        # Rescale only timing columns (dwell1, dwell2, dd, ud), keep key ids.
        scale = rng.uniform(0.55, 1.75, size=(1, negatives.shape[2] - 2))
        negatives[idx, :, 2:] = negatives[idx, :, 2:] * scale
    return negatives


# ---- leakage-free train/validation splitting -------------------------------
# Windows are built with a sliding stride, so consecutive windows SHARE most of
# their rows: at window 50 / stride 10 any two windows closer than 5 apart
# overlap. A random shuffle therefore puts near-identical copies of the same
# keystrokes on both sides of the split, and everything measured on the
# validation side — val_loss (which drives early stopping) and the calibrated
# per-user threshold — is measured against data the model effectively trained
# on. Both are then optimistic, and the threshold is calibrated too low.
#
# Two strategies, best first:
#   * BY GROUP: callers send one group id per window (the source sample /
#     session). Whole groups go to one side, so no window can have its overlapping
#     neighbour on the other side. This is the correct fix.
#   * CONTIGUOUS + GAP: no groups supplied — take the validation set from the END
#     of the sequence and discard `gap` windows at the boundary, the only place
#     where overlap can cross. Weaker than grouping (a single long session still
#     spans both sides) but strictly better than shuffling.
DEFAULT_OVERLAP_GAP = 5          # ceil(WINDOW_SIZE / WINDOW_STRIDE) for 50/10
DEFAULT_VAL_FRACTION = 0.2
MAX_VAL_SHARE = 0.5              # never let group assignment swallow the training set


def _contiguous_split(n, val_fraction, gap):
    """Validation from the tail, with `gap` windows dropped at the boundary."""
    n_val = int(round(n * val_fraction))
    if n < 2 or n_val < 1:
        return list(range(n)), []
    cut = n - n_val
    train = list(range(0, max(cut - gap, 0)))
    if not train:                                  # too few windows to afford a gap
        train = list(range(0, cut))
    return train, list(range(cut, n))


def _group_split(groups, val_fraction, seed):
    """Assign whole groups to validation. Returns None if it cannot be done."""
    uniq = list(dict.fromkeys(groups))
    if len(uniq) < 2:
        return None
    counts = {g: 0 for g in uniq}
    for g in groups:
        counts[g] += 1
    order = list(uniq)
    np.random.default_rng(seed).shuffle(order)
    target = max(1, int(round(len(groups) * val_fraction)))
    cap = int(len(groups) * MAX_VAL_SHARE)
    val_groups, taken = set(), 0
    for g in order:
        if taken >= target:
            break
        if val_groups and taken + counts[g] > cap:
            continue                               # would leave too little to train on
        val_groups.add(g)
        taken += counts[g]
    train = [i for i, g in enumerate(groups) if g not in val_groups]
    val = [i for i, g in enumerate(groups) if g in val_groups]
    return (train, val) if train and val else None


def dedupe_windows(X, groups=None):
    """Drop exact-duplicate windows, keeping the first occurrence.

    Grouping by source sample stops windows from one sample straddling the split, but it cannot
    help when the SAME content is filed under two different sample ids — a session submitted
    twice. Those produce byte-identical windows in two different groups, so a group split
    happily puts one copy on each side and the validation set again contains its own training
    data. Observed live: 23 of user 1's 165 validation windows were exact copies of training
    windows, from a duplicate sample pair.

    Deduplicating is preferable to merging the groups: a session recorded twice is not twice the
    evidence, and keeping both would over-weight that content in the fit.

    Returns (kept_indices, n_dropped)."""
    seen = {}
    keep = []
    for i, w in enumerate(X):
        h = np.asarray(w, dtype=np.float32).tobytes()
        if h in seen:
            continue
        seen[h] = i
        keep.append(i)
    return keep, len(X) - len(keep)


def split_no_overlap(n, groups=None, val_fraction=DEFAULT_VAL_FRACTION,
                     gap=DEFAULT_OVERLAP_GAP, seed=7):
    """Train/validation indices that never place overlapping windows on both sides.

    Returns (train_idx, val_idx, strategy)."""
    if groups is not None and len(groups) == n:
        got = _group_split(list(groups), val_fraction, seed)
        if got:
            return got[0], got[1], "group"
    train, val = _contiguous_split(n, val_fraction, gap)
    return train, val, "contiguous+gap"


MIN_EER_VALIDATION_WINDOWS = 3   # minimum positive windows needed for EER to be statistically meaningful
DEFAULT_THRESHOLD = 0.65          # used when validation data is too small to compute reliable EER
# NOTE: the live continuous-auth decision uses a FIXED 0.50 window boundary
# (Lu et al. 2020), set in keystrokeSecurity.js. The per-user EER computed here
# is retained only as a reported research metric — it is no longer the live
# cutoff, so it is reported RAW (unclamped) to reflect the true per-user EER.

def choose_user_threshold(genuine_scores, labels):
    positives = labels == 1
    negatives = labels == 0
    n_positive_val = int(np.sum(positives))

    # EER requires enough validation windows to be statistically meaningful.
    # With 2-3 genuine windows the crossing point is noise, not signal.
    # Return the safe default and flag it so callers know EER was not computed.
    if n_positive_val < MIN_EER_VALIDATION_WINDOWS:
        return DEFAULT_THRESHOLD, None  # None signals "not enough data for EER"

    thresholds = np.linspace(0.0, 1.0, 1001)
    best_threshold = DEFAULT_THRESHOLD
    best_diff = float("inf")

    for threshold in thresholds:
        far = float(np.mean(genuine_scores[negatives] >= threshold)) if np.any(negatives) else 0.0
        frr = float(np.mean(genuine_scores[positives] < threshold)) if np.any(positives) else 0.0
        diff = abs(far - frr)
        if diff < best_diff:
            best_diff = diff
            best_threshold = float(threshold)

    predicted = (genuine_scores >= best_threshold).astype(np.int64)
    tar = float(np.mean(predicted[positives] == 1)) if np.any(positives) else 0.0
    trr = float(np.mean(predicted[negatives] == 0)) if np.any(negatives) else 0.0
    return best_threshold, (tar + trr) / 2.0


def train_user_payload(payload):
    if load_model is None or build_1d_cnn_2rnn is None or np is None:
        return {"error": "TensorFlow training stack is not available"}, 503

    if not payload or "userId" not in payload or "positiveWindows" not in payload:
        return {"error": "userId and positiveWindows are required"}, 400

    try:
        # Weight init, dropout, and model.fit's batch shuffling were the one
        # unseeded source of randomness left in this pipeline: negative sampling
        # and the train/val split already use fixed np.random.default_rng seeds
        # (see below), but retraining on IDENTICAL data still produced genuine-user
        # confidence swinging from a mean of 0.92 down to 0.74 run to run, because
        # nothing pinned TF/Keras's own RNG. Seeding it makes "retrain on the same
        # data" actually reproducible; it does not by itself make any one fit better.
        if set_random_seed is not None:
            set_random_seed(int(payload.get("trainSeed", 7)))

        positives = to_window_array(payload["positiveWindows"])

        # Modality-aware storage, OWNED here: callers send `modality`
        # ("keystroke" default | "mouse") and this service derives every path.
        # Explicit path params remain for dev tooling (sweeps) but are confined
        # to our storage roots.
        modality = payload.get("modality") or "keystroke"
        is_mouse = modality == "mouse"
        scaler_path = confine_path(payload.get("scalerPath")) or (MOUSE_SCALER_PATH if is_mouse else SCALER_PATH)
        save_path = confine_path(payload.get("modelPath")) or user_model_path(payload["userId"], modality)
        neg_dataset_path = confine_path(payload.get("negativeDatasetPath")) or (MOUSE_NEG_DATASET_PATH if is_mouse else None)
        try:
            base_model_path = confine_path(payload.get("baseModelPath")) or (MOUSE_BASE_MODEL_PATH if is_mouse else MODEL_PATH)
        except ValueError:
            base_model_path = ""  # unusable base sentinel (dev "__none__") → train from scratch

        min_positive = int(payload.get("minPositiveWindows", 12))
        if len(positives) < min_positive:
            return {
                "error": f"not enough positive windows: {len(positives)} collected, {min_positive} required",
                "positive_window_count": int(len(positives)),
                "required_positive_windows": min_positive,
            }, 400

        window_size, num_features = positives.shape[1], positives.shape[2]

        # Negatives, strongest first: real windows from other app users,
        # then real impostor windows from the Buffalo/Continuum dataset,
        # synthetic noise only as a last resort.
        raw_negatives = payload.get("negativeWindows") or []
        negatives = (
            to_window_array(raw_negatives)
            if len(raw_negatives) > 0
            else np.empty((0, window_size, num_features), dtype=np.float32)
        )
        negative_source = "app-users" if len(negatives) > 0 else None

        target_negatives = max(len(positives) * 2, 60)
        dataset_groups = None
        if len(negatives) < target_negatives:
            # negativeDatasetMaxWindows: how many of the file's windows are eligible (default 2000,
            # <= 0 = all). The live keystroke profile sends 0 so all of KS's A200 windows count.
            dataset_negatives, dataset_pids = get_dataset_negatives(
                window_size, num_features, dataset_path=neg_dataset_path,
                max_windows=int(payload.get("negativeDatasetMaxWindows", 2000)), with_participants=True)
            if len(dataset_negatives) > 0:
                rng = np.random.default_rng(21)
                take = min(target_negatives - len(negatives), len(dataset_negatives))
                pick = rng.choice(len(dataset_negatives), size=take, replace=False)
                picked = dataset_negatives[pick]
                if dataset_pids is not None:
                    # Validation negatives come from typists absent from training, as in KS.
                    dataset_groups = [f"ds-{int(p)}" for p in dataset_pids[pick]]
                negatives = np.concatenate([negatives, picked], axis=0) if len(negatives) else picked
                negative_source = (negative_source + "+dataset") if negative_source else "dataset"

        if len(negatives) == 0:
            negatives = make_synthetic_negatives(positives)
            negative_source = "synthetic"

        # Split BEFORE combining, and split each class on its own, so validation
        # always contains both classes (a random split can leave it with none of
        # one) and so each class is grouped by its own source samples.
        gap = int(payload.get("overlapGap", DEFAULT_OVERLAP_GAP))
        val_fraction = float(payload.get("valFraction", DEFAULT_VAL_FRACTION))
        pos_groups = payload.get("positiveGroups")
        neg_groups = payload.get("negativeGroups")
        if dataset_groups is not None:
            n_own = len(negatives) - len(dataset_groups)
            own = list(neg_groups)[:n_own] if neg_groups is not None else []
            neg_groups = own + [f"pad-{i}" for i in range(n_own - len(own))] + dataset_groups
        if len(negatives) and neg_groups is not None and len(neg_groups) != len(negatives):
            # dataset/synthetic negatives were appended after the caller's own,
            # so the supplied ids cover only the first block; pad the remainder
            # with one distinct group each rather than dropping the grouping.
            neg_groups = list(neg_groups) + [f"pad-{i}" for i in range(len(negatives) - len(neg_groups))]

        # Remove exact duplicates BEFORE splitting: identical content filed under two
        # sample ids defeats grouping and puts copies on both sides.
        p_keep, p_dropped = dedupe_windows(positives)
        n_keep, n_dropped = dedupe_windows(negatives) if len(negatives) else ([], 0)
        if p_dropped or n_dropped:
            print(f"dedupe: dropped {p_dropped} duplicate positive, {n_dropped} duplicate "
                  f"negative windows before splitting")
        positives = positives[p_keep]
        if len(negatives):
            negatives = negatives[n_keep]
        if pos_groups is not None and len(pos_groups) >= len(p_keep):
            pos_groups = [pos_groups[i] for i in p_keep]
        if neg_groups is not None and len(neg_groups) >= len(n_keep):
            neg_groups = [neg_groups[i] for i in n_keep]

        # Evaluation-only option (protocol J, PREREGISTRATION_J.md): the caller names which positive
        # windows train and which validate, by index into positiveWindows; windows in neither list
        # (held-out or purged at a boundary) are not used for fitting. Absent in production calls.
        explicit = payload.get("explicitSplit")
        if explicit is not None:
            pos_map = {orig: new for new, orig in enumerate(p_keep)}
            p_tr = [pos_map[i] for i in explicit.get("train", []) if i in pos_map]
            p_va = [pos_map[i] for i in explicit.get("val", []) if i in pos_map]
            p_how = "explicit"
        else:
            p_tr, p_va, p_how = split_no_overlap(len(positives), pos_groups, val_fraction, gap)
        n_tr, n_va, n_how = split_no_overlap(len(negatives), neg_groups, val_fraction, gap)
        split_strategy = f"positives={p_how}, negatives={n_how}"

        pos_s = scale_windows(positives.astype(np.float32), scaler_path)
        neg_s = (scale_windows(negatives.astype(np.float32), scaler_path)
                 if len(negatives) else negatives.astype(np.float32))

        def _stack(pi, ni):
            xs = [pos_s[pi]] if len(pi) else []
            ys = [np.ones(len(pi), dtype=np.int64)] if len(pi) else []
            if len(ni):
                xs.append(neg_s[ni])
                ys.append(np.zeros(len(ni), dtype=np.int64))
            if not xs:
                return (np.empty((0, window_size, num_features), dtype=np.float32),
                        np.empty((0,), dtype=np.int64))
            return np.concatenate(xs, axis=0), np.concatenate(ys)

        X_train, y_train = _stack(p_tr, n_tr)
        X_val, y_val = _stack(p_va, n_va)

        # Shuffling the TRAINING order is harmless (it only affects batch
        # composition); shuffling across the split boundary is what leaked.
        rng = np.random.default_rng(7)
        order = rng.permutation(len(X_train))
        X_train, y_train = X_train[order], y_train[order]

        # Fine-tune the pre-trained base model (transfer learning) when its
        # input shape matches; otherwise train from scratch.
        model_instance = None
        trained_from = "scratch"
        freeze_names = []
        rnn_type = "gru" if "gru" in base_model_path.lower() else "lstm"
        # A base exported with an arch.json sidecar (train_mouse_fcn.py) declares its own
        # feature layer and the layers to freeze; such bases are personalised generically
        # below instead of being rebuilt as a CNN+GRU. Bases without it keep the original path.
        arch_meta = {}
        arch_json = os.path.join(os.path.dirname(os.path.normpath(base_model_path)), "arch.json")
        if base_model_path and os.path.exists(arch_json):
            try:
                with open(arch_json) as fh:
                    arch_meta = json.load(fh)
            except Exception as exc:
                print(f"Warning: unreadable {arch_json}: {exc}")
        model_units = int(os.getenv("MODEL_UNITS", "16"))
        if os.path.exists(base_model_path):
            try:
                base = load_model(base_model_path)
                if tuple(base.input_shape[1:]) == (window_size, num_features):
                    base_out = int(base.output_shape[-1])
                    if base_out == 2:
                        # Same-task 2-class base (keystroke): reuse it directly and
                        # freeze only Conv1D below.
                        model_instance = base
                        trained_from = "base-model-fine-tune"
                    elif arch_meta:
                        # Generic feature-extractor transfer (e.g. SapiMouse's FCN): keep every
                        # base layer up to the declared embedding, add a fresh binary head, and
                        # freeze the declared layers -- the same procedure the pre-registered
                        # study evaluated (repr_arch_study.personalise).
                        from tensorflow.keras import Model as _Model
                        from tensorflow.keras.layers import Dense as _Dense
                        emb = base.get_layer(arch_meta.get("embedding_layer", "embedding")).output
                        model_instance = _Model(base.input, _Dense(2, activation="softmax", name="head")(emb))
                        freeze_names = list(arch_meta.get("freeze", []))
                        trained_from = "base-feature-extractor"
                        print(f"  transfer: {arch_meta.get('arch')} base, embedding "
                              f"{int(emb.shape[-1])}-d, freezing {freeze_names}")
                    else:
                        # FEATURE-EXTRACTOR base (e.g. the mouse USER-ID model, which
                        # has an N-user head). Copy every layer EXCEPT the head into a
                        # fresh binary model, so the per-user model inherits the general
                        # Conv1D+GRU mouse-motion features and only learns a new
                        # genuine/impostor head. Match the base's RNN width so shapes line up.
                        base_units = model_units
                        for lyr in base.layers:
                            cfg = lyr.get_config()
                            if "units" in cfg:
                                base_units = int(cfg["units"]); break
                        # Infer the RNN family from the BASE's own layers, not the
                        # path string (e.g. "mouse-ws50-base" has no "gru" in it, so
                        # a path-based guess wrongly builds an LSTM and the GRU
                        # weights won't load).
                        base_rnn = "gru" if any(l.__class__.__name__ == "GRU" for l in base.layers) else "lstm"
                        fresh = build_1d_cnn_2rnn(
                            (window_size, num_features), num_classes=2, units=base_units, rnn_type=base_rnn
                        )
                        copied = 0
                        for i in range(len(fresh.layers) - 1):  # all but the final Dense head
                            w = base.layers[i].get_weights()
                            if w:
                                fresh.layers[i].set_weights(w)
                            copied += 1
                        model_instance = fresh
                        trained_from = "base-feature-extractor"
                        print(f"  transfer: copied {copied} feature layers from {base_out}-class base (units={base_units})")
            except Exception as exc:
                print(f"Warning: could not load base model for fine-tuning: {exc}")

        if model_instance is None:
            model_instance = build_1d_cnn_2rnn((window_size, num_features), num_classes=2, units=model_units, rnn_type=rnn_type)

        from tensorflow.keras.optimizers import Adam

        # Freeze the Conv1D layer for both transfer modes so the general low-level
        # motion/rhythm features survive small-sample fine-tuning; the GRU + new
        # Dense head adapt to the individual user. From scratch: everything trains.
        if trained_from in ("base-model-fine-tune", "base-feature-extractor"):
            if freeze_names:
                for name in freeze_names:
                    model_instance.get_layer(name).trainable = False
            else:
                model_instance.layers[0].trainable = False

        learning_rate = 3e-4 if trained_from in ("base-model-fine-tune", "base-feature-extractor") else 1e-3
        model_instance.compile(
            optimizer=Adam(learning_rate=learning_rate),
            loss="sparse_categorical_crossentropy",
            metrics=["accuracy"],
        )

        epochs = int(payload.get("epochs", 30))
        batch_size = int(payload.get("batchSize", 16))
        callbacks = []
        if EarlyStopping is not None and len(X_val) > 0:
            callbacks.append(EarlyStopping(patience=6, restore_best_weights=True, monitor="val_loss"))

        history = model_instance.fit(
            X_train,
            y_train,
            validation_data=(X_val, y_val) if len(X_val) > 0 else None,
            epochs=epochs,
            batch_size=batch_size,
            verbose=0,
            callbacks=callbacks,
        )

        path = save_path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Snapshot the current live model before overwriting so the caller can
        # run a held-out validation gate and ROLL BACK if the new (stochastic)
        # fit is worse than what it replaces.
        prev_path = path + "_prev"
        previous_model_available = False
        if os.path.exists(path):
            import shutil
            if os.path.exists(prev_path):
                shutil.rmtree(prev_path)
            shutil.copytree(path, prev_path)
            invalidate_user_model_cache(prev_path)
            previous_model_available = True
        model_instance.save(path)
        invalidate_user_model_cache(path)
        warm_user_model_async(path)

        eval_loss, eval_acc = model_instance.evaluate(X_val, y_val, verbose=0)
        # Calibrate the decision threshold on held-out validation data only.
        calibration_predictions = model_instance.predict(X_val, verbose=0)
        threshold, balanced_accuracy = choose_user_threshold(
            calibration_predictions[:, 1],
            y_val,
        )
        # Scores of the user's own enrolment windows under the new model, as percentiles. The
        # mouse channel's per-user threshold is the q-th percentile of these (the operating
        # point the pre-registered study selects), so the caller can store it with the profile.
        enrol_scores = model_instance.predict(pos_s, batch_size=1024, verbose=0)[:, 1]
        enrol_percentiles = {str(q): float(np.percentile(enrol_scores, q))
                             for q in (1, 2, 5, 10, 15, 20, 30, 40, 50)}
        # The same percentiles over the genuine windows held out from training (validation). They
        # are out-of-sample, unlike the enrolment scores above (artifacts/repr_arch_study,
        # PREREGISTRATION_H.md compares the two sources, and a third, for the threshold).
        val_genuine = calibration_predictions[:, 1][y_val == 1] if len(y_val) else np.empty(0)
        val_percentiles = ({str(q): float(np.percentile(val_genuine, q))
                            for q in (1, 2, 5, 10, 15, 20, 30, 40, 50)} if len(val_genuine) else None)
        return {
            "ok": True,
            "userId": payload["userId"],
            "modelPath": path,
            "enrolScorePercentiles": enrol_percentiles,
            "validationScorePercentiles": val_percentiles,
            "validationGenuineScores": [float(v) for v in val_genuine],
            "positiveWindowCount": int(len(positives)),
            "negativeWindowCount": int(len(negatives)),
            "negativeSource": negative_source,
            "datasetNegativeError": dataset_negative_status(neg_dataset_path),
            "trainedFrom": trained_from,
            "inputShape": [int(window_size), int(num_features)],
            "accuracy": float(eval_acc),
            "loss": float(eval_loss),
            "threshold": threshold,
            "thresholdSource": "eer" if balanced_accuracy is not None else "default",
            "splitStrategy": split_strategy,
            "validationWindowCount": int(len(X_val)),
            "duplicateWindowsDropped": int(p_dropped + n_dropped),
            "validationPositiveCount": int(np.sum(y_val == 1)) if len(y_val) else 0,
            "balancedAccuracy": balanced_accuracy,
            "epochsTrained": len(history.history.get("loss", [])),
            "previousModelPath": prev_path if previous_model_available else None,
        }, 200
    except Exception as exc:
        return {"error": str(exc)}, 500


LOSO_PERCENTILES = (1, 2, 5, 10, 15, 20, 30, 40, 50)


def train_user_loso_payload(payload):
    """Mouse enrolment with a leave-one-sample-out threshold source (S1, AMENDMENT_J1.md §2).

    positiveWindows are the user's enrolment in time order, a whole number of loso.SAMPLE-window
    samples. Each fold model trains on the other samples and scores the one it never saw; then the
    deployed model trains on all of them and is saved where train_user_payload always saves it.
    Every model goes through train_user_payload with an explicit split, exactly as
    protocol_j_p1.fit_and_score drove it for the lockbox evaluation (same negatives, seeds and
    settings), so the only difference from that recipe is where the fold models live: a scratch
    directory beside the user's model, removed before this returns. The folds run first, so a
    retrain replaces the live model only at the end.

    Returns the final model's training response plus the pooled out-of-sample scores
    (losoScores) and their percentiles (losoScorePercentiles); the caller picks its threshold
    from those.
    """
    import shutil

    if load_model is None or build_1d_cnn_2rnn is None or np is None or loso is None:
        return {"error": "TensorFlow training stack is not available"}, 503
    if not payload or "userId" not in payload or "positiveWindows" not in payload:
        return {"error": "userId and positiveWindows are required"}, 400
    if int(payload.get("sampleWindows", loso.SAMPLE)) != loso.SAMPLE:
        return {"error": f"sampleWindows must be {loso.SAMPLE}, the evaluated sample size"}, 400
    try:
        positives = to_window_array(payload["positiveWindows"])
        modality = payload.get("modality") or "keystroke"
        final_path = confine_path(payload.get("modelPath")) or user_model_path(payload["userId"], modality)
    except ValueError as exc:
        return {"error": str(exc)}, 400
    n = len(positives)
    samples = n // loso.SAMPLE
    if n % loso.SAMPLE or samples < 2:
        return {"error": f"need a whole number (>= 2) of {loso.SAMPLE}-window samples, got {n} windows"}, 400

    # Settings forwarded unchanged to every model; the internal calls fix the rest.
    common = {k: payload[k] for k in ("modality", "scalerPath", "baseModelPath", "negativeDatasetPath",
                                      "overlapGap", "epochs", "batchSize", "trainSeed") if k in payload}
    order = list(range(samples))
    fold_root = final_path + "_loso"

    def fit(model_path, ordered, train, val):
        pos = {t: p for p, t in enumerate(ordered)}
        return train_user_payload({
            **common, "userId": payload["userId"], "modelPath": model_path,
            "positiveWindows": positives[ordered],
            "explicitSplit": {"train": [pos[t] for t in train], "val": [pos[t] for t in val]},
            "minPositiveWindows": 1})

    oof = np.full(n, np.nan)
    shutil.rmtree(fold_root, ignore_errors=True)   # debris from an interrupted run
    try:
        for s in order:
            ordered, train, val, held = loso.plan_folds(order, [s])
            fold_path = os.path.join(fold_root, f"fold{s}")
            res, code = fit(fold_path, ordered, train, val)
            if code != 200:
                return {"error": f"fold {s}: {res.get('error')}", "fold": s}, code
            pred, code = predict_user_payload({
                "userId": payload["userId"], "modality": modality, "modelPath": fold_path,
                "windows": positives[held], **({"scalerPath": payload["scalerPath"]} if "scalerPath" in payload else {})})
            invalidate_user_model_cache(fold_path)
            shutil.rmtree(fold_path, ignore_errors=True)
            if code != 200:
                return {"error": f"fold {s} scoring: {pred.get('error')}", "fold": s}, code
            oof[held] = [float(p[1]) for p in pred["prediction"]]
    finally:
        shutil.rmtree(fold_root, ignore_errors=True)

    ordered, train, val, _ = loso.plan_folds(order, [])
    res, code = fit(final_path, ordered, train, val)
    if code != 200:
        return res, code
    res.update({
        "thresholdScheme": "leave-one-sample-out",
        "losoSamples": samples,
        "losoSampleWindows": loso.SAMPLE,
        "losoScores": [round(float(v), 6) for v in oof],
        "losoScorePercentiles": {str(q): float(np.percentile(oof, q)) for q in LOSO_PERCENTILES},
    })
    return res, 200


def dispatch_train(body):
    """/api/user/train: the action-based path, the leave-one-sample-out enrolment, or the
    original single-model path, chosen by the payload."""
    if body and body.get("actions") is not None:
        return train_user_actions_payload(body)
    if body and body.get("thresholdScheme") == "leave-one-sample-out":
        return train_user_loso_payload(body)
    return train_user_payload(body)


def rollback_user_payload(payload):
    """Restore the pre-retrain model snapshot (validation-gate rollback)."""
    if not payload or "userId" not in payload:
        return {"error": "userId is required"}, 400
    import shutil

    path = user_model_path(payload["userId"], payload.get("modality") or "keystroke")
    prev_path = path + "_prev"
    if not os.path.exists(prev_path):
        return {"error": "no previous model snapshot to roll back to"}, 404
    if os.path.exists(path):
        shutil.rmtree(path)
    shutil.copytree(prev_path, path)
    invalidate_user_model_cache(path)
    warm_user_model_async(path)
    return {"ok": True, "userId": payload["userId"], "modelPath": path, "rolledBack": True}, 200


def predict_user_payload(payload):
    if load_model is None or np is None:
        return {"error": "TensorFlow prediction stack is not available"}, 503

    if not payload or "userId" not in payload or "windows" not in payload:
        return {"error": "userId and windows are required"}, 400

    modality = payload.get("modality") or "keystroke"
    try:
        path = confine_path(payload.get("modelPath")) or user_model_path(payload["userId"], modality)
        req_scaler = confine_path(payload.get("scalerPath")) or (MOUSE_SCALER_PATH if modality == "mouse" else None)
    except ValueError as exc:
        return {"error": str(exc)}, 400
    if not os.path.exists(path):
        # Personal model not yet created — use global model as fallback
        if model is None:
            return {"error": "no user model and global model unavailable", "model_loaded": False}, 503
        user_model = model
    else:
        user_model = None  # loaded below

    try:
        if user_model is None:
            user_model = get_user_model(path)
            note_model_use(path)
        windows = scale_windows(to_window_array(payload["windows"]), req_scaler)
        predictions = user_model.predict(windows, verbose=0)
        genuine_scores = predictions[:, 1]
        threshold = float(payload.get("threshold", 0.65))
        mean_score = float(np.mean(genuine_scores))
        return {
            "ok": True,
            "model_loaded": True,
            "prediction": predictions.tolist(),
            "genuineScore": mean_score,
            "threshold": threshold,
            "isSuspicious": bool(mean_score < threshold),
            "windowCount": int(len(windows)),
        }, 200
    except Exception as exc:
        return {"error": str(exc)}, 500


def health_payload():
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "mode": "tensorflow" if model is not None else "unavailable",
        "model_path": MODEL_PATH,
        "model_error": model_error,
    }


def create_flask_app():
    app = Flask(__name__)

    @app.before_request
    def _require_service_key():
        # /health stays open: it is how the orchestrator decides whether this container is
        # ready, it reveals nothing beyond "TensorFlow loaded", and gating it would mean
        # handing the healthcheck a credential.
        if request.path == "/health":
            return None
        if not api_key_ok(request.headers.get("X-Api-Key")):
            print(f"[model-api][SECURITY] rejected {request.method} {request.path} — bad or missing X-Api-Key")
            return jsonify({"error": "invalid_or_missing_api_key"}), 401
        return None

    @app.route("/api/predict", methods=["POST"])
    def predict():
        payload, status = predict_payload(request.get_json())
        return jsonify(payload), status

    @app.route("/api/user/train", methods=["POST"])
    def train_user():
        # An `actions` field selects the action-based mouse path; `windows`
        # keeps the original window path. Dispatching on the payload rather
        # than on a mode flag means an old client cannot accidentally land in
        # the new pipeline or the reverse. `thresholdScheme` selects the
        # leave-one-sample-out enrolment (S1) on the window path.
        payload, status = dispatch_train(request.get_json())
        return jsonify(payload), status

    @app.route("/api/user/predict", methods=["POST"])
    def predict_user():
        body = request.get_json()
        if body and body.get("actions") is not None:
            payload, status = predict_user_actions_payload(body)
        else:
            payload, status = predict_user_payload(body)
        return jsonify(payload), status

    @app.route("/api/user/rollback", methods=["POST"])
    def rollback_user():
        payload, status = rollback_user_payload(request.get_json())
        return jsonify(payload), status

    @app.route("/health", methods=["GET"])
    def health():
        return jsonify(health_payload())

    return app


class ContinuumHandler(BaseHTTPRequestHandler):
    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(health_payload())
            return
        self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        if self.path not in ("/api/predict", "/api/user/train", "/api/user/predict", "/api/user/rollback"):
            self._send_json({"error": "Not found"}, 404)
            return

        # The stdlib fallback server enforces the same credential as the Flask app. Leaving
        # it open would mean the protection quietly disappeared on any host where Flask
        # failed to import — exactly the situation where nobody is looking.
        if not api_key_ok(self.headers.get("X-Api-Key")):
            print(f"[model-api][SECURITY] rejected POST {self.path} — bad or missing X-Api-Key")
            self._send_json({"error": "invalid_or_missing_api_key"}, 401)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8")
            payload = json.loads(raw_body) if raw_body else {}
            if self.path == "/api/user/train":
                response, status = dispatch_train(payload)
            elif self.path == "/api/user/predict":
                response, status = predict_user_payload(payload)
            elif self.path == "/api/user/rollback":
                response, status = rollback_user_payload(payload)
            else:
                response, status = predict_payload(payload)
            self._send_json(response, status)
        except Exception as exc:
            self._send_json({"error": str(exc)}, 500)

    def log_message(self, format, *args):
        print(f"{self.address_string()} - {format % args}")


if __name__ == "__main__":
    init_model()
    preflight_negatives()
    warm_recent_user_models()
    if Flask is not None:
        debug = os.getenv("MODEL_DEBUG", "1") == "1"
        print(f"Starting Flask model API on http://localhost:{PORT} (debug={debug})")
        create_flask_app().run(host=HOST, port=PORT, debug=debug)
    else:
        print(f"Flask is not installed. Starting built-in model API on http://localhost:{PORT}")
        print("Install requirements.txt and add artifacts/final_model to use the TensorFlow model.")
        HTTPServer((HOST, PORT), ContinuumHandler).serve_forever()
