"""
SapiMouse -> windowed HDF5, matching the keystroke pipeline's conventions.

Raw SapiMouse CSV columns:  client timestamp (ms), button, state, x, y

We convert each user's event stream into a sequence of per-point MOTION vectors
(the mouse analogue of the keystroke digraph), then cut fixed-length windows and
build a pooled binary genuine/impostor set — exactly the (N, WS, F) + binary y
format that data_loader.py / train.py / api.py already consume.

Per-point feature vector  F = 11 (enriched trajectory dynamics — the 7-feature
kinematic set under-expressed identity vs keystroke timings; curvature/jerk/angular
velocity and split click/drag channels are the standard discriminative mouse features
in the literature, cf. SapiMouse / Chao Shen):
    [dx, dy, v, a, jerk, dtheta, ang_vel, curvature, dt, is_click, is_drag]
      dx, dy    : normalized displacement since previous point  (screen-scaled -> ~[-1,1])
      v         : speed (pixels/ms), log-compressed
      a         : |speed change| (tangential accel magnitude), log-compressed
      jerk      : |accel change| (motion smoothness), log-compressed
      dtheta    : turning angle between consecutive moves (radians, [-pi,pi] -> [-1,1])
      ang_vel   : dtheta/dt (rad/s) — time-normalized turn rate, clipped to +/-1
      curvature : dtheta/dist (rad/px) — speed-independent path curvature, clipped to +/-1
      dt        : time gap since previous point (s), clipped
      is_click  : 1 if this point is a Pressed/Released button event else 0
      is_drag   : 1 if this point is a Drag (moving with button held) else 0

Design choices mirroring the keystroke model:
  * long idle gaps (dt > IDLE) split the stream (like composition-pause drops) —
    we never build a motion vector across a "away from mouse" gap.
  * identity-agnostic base: subject ids are used only to build genuine/impostor
    labels, then dropped.

Usage:
    python preprocess_mouse.py --window-size 50 --stride 10 \
        --data-dir data/sapimouse --out data/Mouse_WS50.h5
"""
import argparse
import glob
import os

import numpy as np

try:
    import h5py
except Exception:  # pragma: no cover
    h5py = None

# Feature-set version. The DEPLOYED mouse base and the SDK/extension JS extractors
# (sdk/js/mouse-features.js, extension/src/features-mouse.js) emit the ORIGINAL 7-feature
# vector, so v1 stays the default — regenerating data as v2 would silently stop matching
# the shipped extractor. v2 is the enriched 11-feature set from the accuracy experiments
# (jerk / angular velocity / curvature / split click-drag); opt in with MOUSE_FEATURES=11.
# Measured on SapiMouse with the same sweep protocol: v2 gives EER 22.3% vs v1's 23.8% —
# a real but marginal gain, which is why it is offered rather than switched on.
MOUSE_FEATURE_SET = 11 if os.getenv("MOUSE_FEATURES") == "11" else 7
MOUSE_FEATURE_NAMES_V1 = ["dx", "dy", "v", "a", "dtheta", "dt", "is_click"]
MOUSE_FEATURE_NAMES_V2 = ["dx", "dy", "v", "a", "jerk", "dtheta", "ang_vel", "curvature", "dt", "is_click", "is_drag"]
MOUSE_FEATURE_NAMES = MOUSE_FEATURE_NAMES_V2 if MOUSE_FEATURE_SET == 11 else MOUSE_FEATURE_NAMES_V1

# Screen scale for normalizing displacement into roughly [-1, 1]. SapiMouse was
# collected at 1920x1080; we scale by a common diagonal-ish constant so dx/dy
# are device-comparable (per-user fine-tuning absorbs residual DPI differences).
SCREEN_SCALE = 1920.0
IDLE_SPLIT_SECONDS = 2.0   # gap above this splits the motion stream
DT_CLIP_SECONDS = 1.0      # per-point time gap is clipped to this
# Clip scales for the enriched turn features so a single tiny-dt / tiny-dist sample
# can't produce an outlier that dominates the z-score scaler. Both map to +/-1.
ANG_VEL_SCALE = 30.0       # rad/s: human direction-change rate rarely exceeds this
CURV_SCALE = 0.2           # rad/px: 1/R for R~5px is already a very sharp corner


def _read_events(path):
    """Return list of (t_ms, button, state, x, y) parsed from one CSV."""
    out = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        next(f, None)  # header
        for line in f:
            p = line.rstrip("\n").split(",")
            if len(p) != 5:
                continue
            try:
                t = float(p[0]); x = float(p[3]); y = float(p[4])
            except ValueError:
                continue
            out.append((t, p[1], p[2], x, y))
    return out


def events_to_steps(events):
    """Convert one CSV's events into a list of 7-dim motion vectors, splitting
    on long idle gaps so no vector spans an away-from-mouse pause."""
    steps = []
    prev = None       # (t, x, y)
    prev_v = 0.0
    prev_a = 0.0
    prev_dir = None   # previous movement angle
    for (t, button, state, x, y) in events:
        if prev is None:
            prev = (t, x, y); prev_dir = None; prev_v = 0.0; prev_a = 0.0
            continue
        dt_ms = t - prev[0]
        dt = dt_ms / 1000.0
        if dt <= 0:
            # duplicate / out-of-order timestamp -> skip (measurement artifact)
            prev = (t, x, y)
            continue
        if dt > IDLE_SPLIT_SECONDS:
            # long idle -> break the stream; start fresh after the pause
            prev = (t, x, y); prev_dir = None; prev_v = 0.0; prev_a = 0.0
            continue

        dx_px = x - prev[1]
        dy_px = y - prev[2]
        dist = float(np.hypot(dx_px, dy_px))
        v = dist / max(dt_ms, 1.0)                 # px per ms
        a = abs(v - prev_v)                        # tangential accel magnitude
        jerk = abs(a - prev_a)                     # rate of accel change (smoothness)
        direction = np.arctan2(dy_px, dx_px) if dist > 0 else (prev_dir or 0.0)
        dtheta = 0.0
        if prev_dir is not None and dist > 0:
            d = direction - prev_dir
            dtheta = float((d + np.pi) % (2 * np.pi) - np.pi)  # wrap to [-pi, pi]
        ang_vel = dtheta / max(dt, 1e-3)           # rad/s (time-normalized turn rate)
        curvature = dtheta / max(dist, 1.0)        # rad/px (speed-independent turn)
        is_click = 1.0 if state in ("Pressed", "Released") else 0.0
        is_drag = 1.0 if state == "Drag" else 0.0

        if MOUSE_FEATURE_SET == 11:
            steps.append([
                np.clip(dx_px / SCREEN_SCALE, -1.0, 1.0),
                np.clip(dy_px / SCREEN_SCALE, -1.0, 1.0),
                float(np.log1p(v)),                    # log-compress heavy tail
                float(np.log1p(a)),
                float(np.log1p(jerk)),
                dtheta / np.pi,                        # -> [-1, 1]
                float(np.clip(ang_vel / ANG_VEL_SCALE, -1.0, 1.0)),
                float(np.clip(curvature / CURV_SCALE, -1.0, 1.0)),
                min(dt, DT_CLIP_SECONDS),
                is_click,
                is_drag,
            ])
        else:
            # v1 (deployed): click and drag share one flag, no jerk/ang_vel/curvature.
            steps.append([
                np.clip(dx_px / SCREEN_SCALE, -1.0, 1.0),
                np.clip(dy_px / SCREEN_SCALE, -1.0, 1.0),
                float(np.log1p(v)),                    # log-compress heavy tail
                float(np.log1p(a)),
                dtheta / np.pi,                        # -> [-1, 1]
                min(dt, DT_CLIP_SECONDS),
                1.0 if (is_click or is_drag) else 0.0,
            ])
        prev = (t, x, y); prev_v = v; prev_a = a
        if dist > 0:
            prev_dir = direction
    return steps


def steps_to_windows(steps, window_size, stride):
    if len(steps) < window_size:
        return []
    arr = np.asarray(steps, dtype=np.float32)
    windows = []
    for start in range(0, len(arr) - window_size + 1, stride):
        windows.append(arr[start:start + window_size])
    return windows


def build(data_dir, window_size, stride, negatives_per_user, seed):
    rng = np.random.default_rng(seed)
    user_dirs = sorted(
        glob.glob(os.path.join(data_dir, "user*")),
        key=lambda p: int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0),
    )
    # 1) windows per user
    user_windows = {}
    for ud in user_dirs:
        uid = os.path.basename(ud)
        wins = []
        for csv in sorted(glob.glob(os.path.join(ud, "*.csv"))):
            wins.extend(steps_to_windows(events_to_steps(_read_events(csv)), window_size, stride))
        if wins:
            user_windows[uid] = np.asarray(wins, dtype=np.float32)
    uids = list(user_windows.keys())
    print(f"users with data: {len(uids)}")

    # 2) genuine + sampled-impostor pooled binary set (subject ids then dropped).
    #    We also emit an explicit GROUP id per window so the leak-free splitter
    #    keeps each user's windows in a single split (a user is never in both
    #    train and test). group = user_index for genuine, a separate id per
    #    (target-user) impostor block. Subject identity is NOT kept in X/y.
    X_parts, y_parts, g_parts = [], [], []
    for gi, uid in enumerate(uids):
        gen = user_windows[uid]
        X_parts.append(gen)
        y_parts.append(np.ones(len(gen), dtype=np.int64))
        g_parts.append(np.full(len(gen), gi, dtype=np.int64))  # genuine group = user index
        others = [u for u in uids if u != uid]
        pool = np.concatenate([user_windows[u] for u in others], axis=0)
        k = min(len(gen), len(pool)) if negatives_per_user <= 0 else min(negatives_per_user, len(pool))
        idx = rng.choice(len(pool), size=k, replace=False)
        X_parts.append(pool[idx])
        y_parts.append(np.zeros(k, dtype=np.int64))
        g_parts.append(np.full(k, len(uids) + gi, dtype=np.int64))  # impostor group id

    X = np.concatenate(X_parts, axis=0).astype(np.float32)
    y = np.concatenate(y_parts, axis=0).reshape(-1, 1).astype(np.float64)
    groups = np.concatenate(g_parts, axis=0).astype(np.int64)
    # NOTE: do NOT shuffle — the splitter groups by `groups`, and unshuffled
    # contiguous order keeps each group's rows together for clean allocation.
    return X, y, groups


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="data/sapimouse")
    ap.add_argument("--window-size", type=int, default=50)
    ap.add_argument("--stride", type=int, default=10)
    ap.add_argument("--negatives-per-user", type=int, default=0, help="0 = balance to genuine count")
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--out", default="data/Mouse_WS50.h5")
    args = ap.parse_args()

    if h5py is None:
        raise SystemExit("h5py is required")

    X, y, groups = build(args.data_dir, args.window_size, args.stride, args.negatives_per_user, args.seed)
    genuine = int((y == 1).sum()); impostor = int((y == 0).sum())
    print(f"X={X.shape}  y={y.shape}  groups={len(np.unique(groups))}  genuine={genuine}  impostor={impostor}")
    with h5py.File(args.out, "w") as f:
        f.create_dataset("train_data", data=X, compression="gzip")
        f.create_dataset("train_labels", data=y, compression="gzip")
        f.create_dataset("groups", data=groups, compression="gzip")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
