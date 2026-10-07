"""
Action-based mouse preprocessing — a faithful implementation of the published
segmentation and feature set of:

  M. Antal and E. Egyed-Zsigmond, "Intrusion detection using mouse dynamics",
  IET Biometrics, vol. 8, no. 5, pp. 285-294, 2019.  DOI 10.1049/iet-bmt.2018.5126
  (open preprint: arXiv:1810.04668)

WHY THIS FILE EXISTS
--------------------
The original mouse pipeline (preprocess_mouse.py) cut the event stream into
fixed windows of 50 motion steps with a stride of 10. Those two numbers were
carried over from the KEYSTROKE method of Lu et al. (2020) and have no published
basis for pointer motion: the mouse-dynamics literature segments by ACTION, not
by fixed window, and no paper we could find justifies 50/10 for a mouse.

This module replaces that inherited choice with the field's standard, so every
parameter below traces to a published source rather than to a transplant.

THE PUBLISHED METHOD, EXACTLY
-----------------------------
Segmentation (Antal & Egyed-Zsigmond, Sec. 3):
  1. Cut the raw stream at mouse-RELEASED events. A segment whose release is
     immediately preceded by a press is a POINT-AND-CLICK (PC); otherwise the
     press and release bracket a movement, which is a DRAG-AND-DROP (DD).
  2. Within the remaining material, MOUSE-MOVE (MM) actions are isolated with a
     time threshold: a gap larger than ACTION_GAP_SECONDS between consecutive
     events ends the current action.
  3. Actions with fewer than MIN_EVENTS_PER_ACTION events are discarded (the
     paper's reason: spline interpolation needs at least four points).

Features (39 per action):
  * seven derived time series - vx, vy, v, a, jerk, angular velocity, curvature
    - each summarised by mean, std, min, max                        = 28
  * eleven whole-action descriptors: action type, elapsed time, trajectory
    length, end-to-end distance, direction bin, straightness, number of points,
    sum of angles, largest deviation from the straight line, number of sharp
    angles, and the duration of the initial acceleration phase       = 11

Decision aggregation (paper, Sec. 4.2): the score for a SET of k actions is the
mean of the per-action probabilities, P(A) = (1/k) * sum(p_i). The paper reports
that 10-20 actions are needed, with 20-action sets giving 0.8994 AUC / 0.1880 EER
on its test partition.

WHAT IS NOT THE PAPER'S
-----------------------
The paper evaluates on Balabit (10 users). We apply the same method to SapiMouse
(120 users, Antal et al., SACI 2021) because the segmentation only needs the
button/state field, which SapiMouse provides, and 120 subjects support a
population claim that 10 cannot. That substitution is the one deliberate
deviation and it is declared wherever these numbers are reported.

Usage:
    python preprocess_mouse_actions.py --data-dir data/sapimouse \
        --out data/mouse_only/Mouse_Actions.h5
"""
import argparse
import glob
import os

import numpy as np

try:
    import h5py
except Exception:  # pragma: no cover
    h5py = None

# ---- published parameters (Antal & Egyed-Zsigmond 2019) ---------------------
ACTION_GAP_SECONDS = 10.0     # "10 seconds as the time threshold"
MIN_EVENTS_PER_ACTION = 4     # "actions with fewer than 4 events are discarded"
SHARP_ANGLE_RADIANS = 0.0     # placeholder, set below
# The paper counts "sharp angles"; we take the standard reading of a turn
# sharper than a right angle between consecutive movement directions.
SHARP_ANGLE_THRESHOLD = np.pi / 2

ACTION_MM, ACTION_PC, ACTION_DD = 1, 3, 4   # the paper's action-type codes

FEATURE_NAMES = (
    [f"{s}_{k}" for s in ("vx", "vy", "v", "a", "jerk", "omega", "curv")
     for k in ("mean", "std", "min", "max")]
    + ["action_type", "elapsed_time", "traj_length", "end_to_end_dist",
       "direction_bin", "straightness", "n_points", "sum_of_angles",
       "largest_deviation", "n_sharp_angles", "accel_time_beginning"]
)
assert len(FEATURE_NAMES) == 39, len(FEATURE_NAMES)


def read_events(path):
    """(t_seconds, button, state, x, y) from one SapiMouse CSV.

    SapiMouse stores `client timestamp` in MILLISECONDS. Everything downstream —
    the 10-second segmentation threshold, elapsed time, and every velocity —
    assumes seconds, so the conversion happens here, once.
    """
    out = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        next(f, None)
        for line in f:
            p = line.rstrip("\n").split(",")
            if len(p) != 5:
                continue
            try:
                t_ms = float(p[0]); x = float(p[3]); y = float(p[4])
            except ValueError:
                continue
            out.append((t_ms / 1000.0, p[1], p[2], x, y))
    return out


def segment_actions(events):
    """Antal & Egyed-Zsigmond two-step segmentation.

    Returns a list of (action_type, [events]).
    """
    actions = []
    current = []

    for ev in events:
        t, button, state, x, y = ev

        # Step 2 — a gap longer than the threshold ends whatever movement is in
        # progress. This is what isolates MM actions from one another.
        if current and (t - current[-1][0]) > ACTION_GAP_SECONDS:
            actions.append((ACTION_MM, current))
            current = []

        current.append(ev)

        if state == "Released":
            # Step 1 — the stream is cut at every release, and the WHOLE segment
            # is the action: a point-and-click is the travel to the target plus
            # the click, not the press-release pair on its own. (Reading the pair
            # alone as the action leaves it 2 events long, below the 4-event
            # minimum, which silently deletes every click from the dataset.)
            #
            # The segment is a PC when the release is immediately preceded by the
            # press — the button went down and straight back up. If the pointer
            # moved while the button was held, the segment is a DD instead;
            # SapiMouse marks held-button motion with an explicit "Drag" state.
            prev_state = current[-2][2] if len(current) >= 2 else None
            if prev_state == "Pressed":
                actions.append((ACTION_PC, current))
            elif any(e[2] == "Drag" for e in current):
                actions.append((ACTION_DD, current))
            else:
                actions.append((ACTION_PC, current))
            current = []

    if current:
        actions.append((ACTION_MM, current))

    return [(a, evs) for a, evs in actions if len(evs) >= MIN_EVENTS_PER_ACTION]


def _stats(series):
    """mean, std, min, max — the paper's four summaries per time series."""
    if len(series) == 0:
        return [0.0, 0.0, 0.0, 0.0]
    a = np.asarray(series, dtype=np.float64)
    a = a[np.isfinite(a)]
    if len(a) == 0:
        return [0.0, 0.0, 0.0, 0.0]
    return [float(a.mean()), float(a.std()), float(a.min()), float(a.max())]


def action_features(action_type, events):
    """The 39 published features for one action."""
    t = np.array([e[0] for e in events], dtype=np.float64)
    x = np.array([e[3] for e in events], dtype=np.float64)
    y = np.array([e[4] for e in events], dtype=np.float64)

    dt = np.diff(t)
    dt[dt <= 0] = 1e-3                      # guard against duplicate stamps
    dx, dy = np.diff(x), np.diff(y)
    dist = np.hypot(dx, dy)

    vx, vy = dx / dt, dy / dt
    v = dist / dt
    a = np.diff(v) / dt[1:] if len(v) > 1 else np.array([])
    jerk = np.diff(a) / dt[2:] if len(a) > 1 else np.array([])

    theta = np.arctan2(dy, dx)
    dtheta = np.diff(theta)
    dtheta = (dtheta + np.pi) % (2 * np.pi) - np.pi     # wrap to [-pi, pi]
    omega = dtheta / dt[1:] if len(dtheta) else np.array([])
    with np.errstate(divide="ignore", invalid="ignore"):
        curv = np.where(dist[1:] > 0, dtheta / dist[1:], 0.0) if len(dtheta) else np.array([])

    feats = []
    for s in (vx, vy, v, a, jerk, omega, curv):
        feats.extend(_stats(s))

    traj_length = float(dist.sum())
    end_to_end = float(np.hypot(x[-1] - x[0], y[-1] - y[0]))
    elapsed = float(t[-1] - t[0])
    direction = np.arctan2(y[-1] - y[0], x[-1] - x[0])
    direction_bin = int(((direction + np.pi) / (2 * np.pi) * 8) % 8)   # 8-point compass
    straightness = float(end_to_end / traj_length) if traj_length > 0 else 0.0
    sum_angles = float(np.abs(dtheta).sum()) if len(dtheta) else 0.0
    n_sharp = int((np.abs(dtheta) > SHARP_ANGLE_THRESHOLD).sum()) if len(dtheta) else 0

    # largest perpendicular deviation from the straight start->end line
    if end_to_end > 0:
        ux, uy = (x[-1] - x[0]) / end_to_end, (y[-1] - y[0]) / end_to_end
        px, py = x - x[0], y - y[0]
        largest_dev = float(np.abs(px * uy - py * ux).max())
    else:
        largest_dev = 0.0

    # duration of the initial acceleration phase: time until peak velocity
    accel_time = float(t[int(np.argmax(v)) + 1] - t[0]) if len(v) else 0.0

    feats.extend([
        float(action_type), elapsed, traj_length, end_to_end, float(direction_bin),
        straightness, float(len(events)), sum_angles, largest_dev,
        float(n_sharp), accel_time,
    ])
    return feats


# ---- sequence representation, for the CNN-RNN arm --------------------------
# Chong et al. (TIFS 2020) and Fu et al. (RUMBA-Mouse, IEEE CNS 2020) feed RAW
# mouse movement SEQUENCES to convolutional/recurrent networks rather than
# handcrafted summaries. To use an action as such a sequence it must be a fixed
# length, so each action's per-point feature series is RESAMPLED (not truncated)
# to SEQ_LEN steps: truncation would discard the tail of every long action,
# whereas resampling keeps the whole shape of every action at the cost of
# time resolution. Duration survives as the dt channel and, for the 39-feature
# arm, as elapsed_time.
SEQ_LEN = 32
SEQ_FEATURES = ["dx", "dy", "v", "a", "dtheta", "dt", "is_click"]


def action_sequence(events, seq_len=SEQ_LEN):
    """(seq_len, 7) resampled per-point kinematics for one action."""
    t = np.array([e[0] for e in events], dtype=np.float64)
    x = np.array([e[3] for e in events], dtype=np.float64)
    y = np.array([e[4] for e in events], dtype=np.float64)
    clicks = np.array([1.0 if e[2] in ("Pressed", "Released") else 0.0 for e in events])

    dt = np.diff(t); dt[dt <= 0] = 1e-3
    dx, dy = np.diff(x), np.diff(y)
    dist = np.hypot(dx, dy)
    v = dist / dt
    a = np.concatenate([[0.0], np.diff(v) / dt[1:]]) if len(v) > 1 else np.zeros(len(v))
    theta = np.arctan2(dy, dx)
    dth = np.concatenate([[0.0], (np.diff(theta) + np.pi) % (2 * np.pi) - np.pi]) \
        if len(theta) > 1 else np.zeros(len(theta))

    series = np.column_stack([
        dx / SCREEN_SCALE, dy / SCREEN_SCALE,
        np.log1p(v), np.log1p(np.abs(a)), dth / np.pi,
        np.minimum(dt, 1.0), clicks[1:],
    ])
    if len(series) == 0:
        return np.zeros((seq_len, len(SEQ_FEATURES)), np.float32)

    # linear resample each channel from its native length onto seq_len points
    src = np.linspace(0.0, 1.0, len(series))
    dst = np.linspace(0.0, 1.0, seq_len)
    out = np.column_stack([np.interp(dst, src, series[:, c]) for c in range(series.shape[1])])
    return out.astype(np.float32)


SCREEN_SCALE = 1920.0   # same normalisation constant as the window pipeline


def build(data_dir):
    """-> X (n, 39), subject ids, session ids, action types."""
    user_dirs = sorted(
        glob.glob(os.path.join(data_dir, "user*")),
        key=lambda p: int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0))

    X, S, subj, sess, types = [], [], [], [], []
    for ud in user_dirs:
        uid = int("".join(c for c in os.path.basename(ud) if c.isdigit()))
        for si, csv in enumerate(sorted(glob.glob(os.path.join(ud, "*.csv")))):
            for atype, evs in segment_actions(read_events(csv)):
                X.append(action_features(atype, evs))
                S.append(action_sequence(evs))
                subj.append(uid); sess.append(si); types.append(atype)

    X = np.asarray(X, dtype=np.float64)
    X[~np.isfinite(X)] = 0.0
    S = np.asarray(S, dtype=np.float32)
    S[~np.isfinite(S)] = 0.0
    return X, S, np.asarray(subj), np.asarray(sess), np.asarray(types)


def main():
    ap = argparse.ArgumentParser(description="Antal-style action segmentation for SapiMouse")
    ap.add_argument("--data-dir", default="data/sapimouse")
    ap.add_argument("--out", default="data/mouse_only/Mouse_Actions.h5")
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    X, S, subj, sess, types = build(args.data_dir)
    n_users = len(np.unique(subj))
    print(f"actions={len(X)}  features={X.shape[1]}  sequences={S.shape}  users={n_users}")
    for code, name in ((ACTION_MM, "MM"), (ACTION_PC, "PC"), (ACTION_DD, "DD")):
        n = int((types == code).sum())
        print(f"  {name}: {n:6d}  ({n/max(len(types),1):.1%})")
    per_user = np.bincount(subj)[np.unique(subj)]
    print(f"  actions per user: min {per_user.min()}  median {int(np.median(per_user))}  max {per_user.max()}")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with h5py.File(args.out, "w") as f:
        f.create_dataset("X", data=X, compression="gzip")
        f.create_dataset("seq", data=S, compression="gzip")
        f.create_dataset("subject", data=subj, compression="gzip")
        f.create_dataset("session", data=sess, compression="gzip")
        f.create_dataset("action_type", data=types, compression="gzip")
        f.attrs["feature_names"] = ",".join(FEATURE_NAMES)
        f.attrs["method"] = "Antal & Egyed-Zsigmond, IET Biometrics 8(5):285-294, 2019"
        f.attrs["gap_seconds"] = ACTION_GAP_SECONDS
        f.attrs["min_events"] = MIN_EVENTS_PER_ACTION
        f.attrs["seq_len"] = SEQ_LEN
        f.attrs["seq_features"] = ",".join(SEQ_FEATURES)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
