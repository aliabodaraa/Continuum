import json
import os
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
except Exception:
    load_model = None
    EarlyStopping = None

try:
    from model import build_1d_cnn_2rnn
except Exception:
    build_1d_cnn_2rnn = None

try:
    from preprocessing import FeatureScaler
except Exception:
    FeatureScaler = None


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
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
MOUSE_BASE_MODEL_PATH = os.getenv("MOUSE_BASE_MODEL_PATH", os.path.join(ARTIFACTS_DIR, "mouse-ws50-base", "final_model"))
MOUSE_SCALER_PATH = os.getenv("MOUSE_SCALER_PATH", os.path.join(ARTIFACTS_DIR, "mouse-ws50-base", "scaler.json"))
MOUSE_NEG_DATASET_PATH = os.getenv("MOUSE_NEG_DATASET_PATH", os.path.join(DATA_DIR, "mouse_only", "Mouse_WS50.h5"))


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


def get_user_model(path):
    if path not in _user_model_cache:
        _user_model_cache[path] = load_model(path)
        print(f"[cache] Loaded user model: {path}")
    return _user_model_cache[path]


def invalidate_user_model_cache(path):
    if path in _user_model_cache:
        del _user_model_cache[path]
        print(f"[cache] Evicted stale model: {path}")


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


def get_dataset_negatives(window_size, num_features, max_windows=2000, dataset_path=None):
    """
    Real impostor windows sampled from a training dataset — each window belongs
    to a participant who is "not the current user", making far stronger
    negatives than synthetic noise. Defaults to the keystroke NEGATIVE_DATASET_
    PATH; a per-request `dataset_path` lets the mouse modality draw impostors
    from SapiMouse (Mouse_WS*.h5).
    """
    path = dataset_path or NEGATIVE_DATASET_PATH
    if path not in _dataset_negatives_cache:
        try:
            import h5py

            with h5py.File(path, "r") as f:
                key = "train_data" if "train_data" in f else "X"
                data = f[key]
                rng = np.random.default_rng(13)
                idx = np.sort(rng.choice(len(data), size=min(max_windows, len(data)), replace=False))
                _dataset_negatives_cache[path] = np.array(data[idx], dtype=np.float32)
            print(f"Loaded {len(_dataset_negatives_cache[path])} impostor windows from {path}")
        except Exception as exc:
            print(f"Warning: could not load dataset negatives from {path}: {exc}")
            _dataset_negatives_cache[path] = np.empty((0, window_size, num_features), dtype=np.float32)

    neg = _dataset_negatives_cache[path]
    if neg.shape[1:] != (window_size, num_features):
        return np.empty((0, window_size, num_features), dtype=np.float32)
    return neg


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
        if len(negatives) < target_negatives:
            dataset_negatives = get_dataset_negatives(window_size, num_features, dataset_path=neg_dataset_path)
            if len(dataset_negatives) > 0:
                rng = np.random.default_rng(21)
                take = min(target_negatives - len(negatives), len(dataset_negatives))
                picked = dataset_negatives[rng.choice(len(dataset_negatives), size=take, replace=False)]
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
        if len(negatives) and neg_groups is not None and len(neg_groups) != len(negatives):
            # dataset/synthetic negatives were appended after the caller's own,
            # so the supplied ids cover only the first block; pad the remainder
            # with one distinct group each rather than dropping the grouping.
            neg_groups = list(neg_groups) + [f"pad-{i}" for i in range(len(negatives) - len(neg_groups))]

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
        rnn_type = "gru" if "gru" in base_model_path.lower() else "lstm"
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

        eval_loss, eval_acc = model_instance.evaluate(X_val, y_val, verbose=0)
        # Calibrate the decision threshold on held-out validation data only.
        calibration_predictions = model_instance.predict(X_val, verbose=0)
        threshold, balanced_accuracy = choose_user_threshold(
            calibration_predictions[:, 1],
            y_val,
        )
        return {
            "ok": True,
            "userId": payload["userId"],
            "modelPath": path,
            "positiveWindowCount": int(len(positives)),
            "negativeWindowCount": int(len(negatives)),
            "negativeSource": negative_source,
            "trainedFrom": trained_from,
            "inputShape": [int(window_size), int(num_features)],
            "accuracy": float(eval_acc),
            "loss": float(eval_loss),
            "threshold": threshold,
            "thresholdSource": "eer" if balanced_accuracy is not None else "default",
            "splitStrategy": split_strategy,
            "validationWindowCount": int(len(X_val)),
            "validationPositiveCount": int(np.sum(y_val == 1)) if len(y_val) else 0,
            "balancedAccuracy": balanced_accuracy,
            "epochsTrained": len(history.history.get("loss", [])),
            "previousModelPath": prev_path if previous_model_available else None,
        }, 200
    except Exception as exc:
        return {"error": str(exc)}, 500


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

    @app.route("/api/predict", methods=["POST"])
    def predict():
        payload, status = predict_payload(request.get_json())
        return jsonify(payload), status

    @app.route("/api/user/train", methods=["POST"])
    def train_user():
        payload, status = train_user_payload(request.get_json())
        return jsonify(payload), status

    @app.route("/api/user/predict", methods=["POST"])
    def predict_user():
        payload, status = predict_user_payload(request.get_json())
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

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8")
            payload = json.loads(raw_body) if raw_body else {}
            if self.path == "/api/user/train":
                response, status = train_user_payload(payload)
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
    if Flask is not None:
        debug = os.getenv("MODEL_DEBUG", "1") == "1"
        print(f"Starting Flask model API on http://localhost:{PORT} (debug={debug})")
        create_flask_app().run(host=HOST, port=PORT, debug=debug)
    else:
        print(f"Flask is not installed. Starting built-in model API on http://localhost:{PORT}")
        print("Install requirements.txt and add artifacts/final_model to use the TensorFlow model.")
        HTTPServer((HOST, PORT), ContinuumHandler).serve_forever()
