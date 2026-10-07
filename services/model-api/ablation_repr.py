"""
Input representations for the timing-vs-identity ablation. ONE thing changes: which feature
columns carry information. Everything else — shape, architecture, base model, splits, seeds,
negative pools, evaluation — is the frozen baseline.

Why constants rather than dropping columns
------------------------------------------
Slicing identity out would make the input 50x4, which no longer matches the frozen base model's
50x6 input, forcing a different architecture and a from-scratch fit. That would change the model
as well as the representation, and the comparison would confound the two. Replacing a column
with a CONSTANT keeps the tensor shape, the base model, the frozen weights and the training
procedure byte-identical while removing all information the column carried: a constant has zero
variance, so it can encode nothing.

The constant is the column mean over the ENTIRE corpus — a fixed dataset-level scalar, identical
for genuine and impostor windows and for every user and split. Using a per-split or per-class
mean would itself be a signal; a global constant cannot be.

Column order (preprocessing.FEATURE_NAMES): id1, id2, dwell1, dwell2, dd, ud
"""
import numpy as np

IDENTITY_COLS = (0, 1)              # id1, id2 — which keys
TIMING_COLS = (2, 3, 4, 5)          # dwell1, dwell2, dd, ud — how they were pressed
FEATURE_NAMES = ["id1", "id2", "dwell1", "dwell2", "dd", "ud"]

CONDITIONS = ("full", "timing_only", "identity_only")


def corpus_constants(X):
    """Per-column mean over the whole corpus — the fill value for ablated columns."""
    return np.asarray(X, dtype=np.float32).reshape(-1, X.shape[-1]).mean(axis=0)


def apply_condition(X, condition, constants):
    """Return a copy of X with the ablated columns replaced by their corpus constant."""
    if condition == "full":
        return np.asarray(X, dtype=np.float32).copy()
    if condition == "timing_only":
        drop = IDENTITY_COLS
    elif condition == "identity_only":
        drop = TIMING_COLS
    else:
        raise ValueError(f"unknown condition: {condition}")
    Y = np.asarray(X, dtype=np.float32).copy()
    for c in drop:
        Y[:, :, c] = constants[c]
    return Y


def ablated_columns(condition):
    return {"full": (), "timing_only": IDENTITY_COLS, "identity_only": TIMING_COLS}[condition]


def kept_columns(condition):
    return tuple(c for c in range(6) if c not in ablated_columns(condition))
