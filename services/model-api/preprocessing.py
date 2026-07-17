"""
Shared feature preprocessing for the Continuum keystroke model.

The dataset feature order per timestep (verified against Rand_WS*.h5) is:
    [id1, id2, dwell1, dwell2, dd, ud]
- id1/id2: key codes normalized by 254
- dwell1/dwell2: hold times in seconds
- dd: down-down time in seconds (press1 -> press2, always >= 0)
- ud: up-down time in seconds (release1 -> press2, can be negative)

Training and inference must apply the same clipping and z-score
standardization (Lu et al., 2020), so the fitted scaler is stored as JSON
next to the trained model.
"""
import json
import os

import numpy as np

FEATURE_NAMES = ["id1", "id2", "dwell1", "dwell2", "dd", "ud"]

# Clip ranges per feature (seconds for the time features). Long idle pauses
# (e.g. UD of 237s in the raw data) carry no rhythm information and destroy
# the z-score scale, so time features are capped.
CLIP_MIN = np.array([0.0, 0.0, 0.0, 0.0, 0.0, -1.0], dtype=np.float64)
CLIP_MAX = np.array([1.0, 1.0, 2.0, 2.0, 5.0, 5.0], dtype=np.float64)


def clip_features(X):
    # The per-feature clip ranges above are specific to the 6-dim keystroke
    # digraph. Other modalities (e.g. the 7-dim mouse motion vector) arrive
    # already bounded/log-compressed by their own preprocessing, so we skip
    # keystroke clipping for them and let the z-score alone standardize.
    if X.shape[-1] == len(CLIP_MIN):
        return np.clip(X, CLIP_MIN, CLIP_MAX)
    return X


class FeatureScaler:
    def __init__(self, mean, std):
        self.mean = np.asarray(mean, dtype=np.float64)
        self.std = np.asarray(std, dtype=np.float64)
        self.std[self.std == 0] = 1.0

    @classmethod
    def fit(cls, X):
        clipped = clip_features(X)
        flat = clipped.reshape(-1, clipped.shape[-1])
        return cls(flat.mean(axis=0), flat.std(axis=0))

    def transform(self, X):
        return ((clip_features(X) - self.mean) / self.std).astype(np.float32)

    def save(self, path):
        n = len(self.mean)
        clips_apply = n == len(CLIP_MIN)
        with open(path, "w") as f:
            json.dump(
                {
                    "feature_names": FEATURE_NAMES if clips_apply else [f"f{i}" for i in range(n)],
                    "mean": self.mean.tolist(),
                    "std": self.std.tolist(),
                    "clip_min": CLIP_MIN.tolist() if clips_apply else None,
                    "clip_max": CLIP_MAX.tolist() if clips_apply else None,
                },
                f,
                indent=2,
            )

    @classmethod
    def load(cls, path):
        if not os.path.exists(path):
            return None
        with open(path) as f:
            data = json.load(f)
        return cls(data["mean"], data["std"])
