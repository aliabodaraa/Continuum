"""
SapiMouse block preprocessing — a faithful implementation of the method in

  Antal, M., Fejer, N., & Buza, K. (2021). SapiMouse: Mouse dynamics-based user
  authentication using deep feature learning. In 2021 IEEE 15th International
  Symposium on Applied Computational Intelligence and Informatics (SACI)
  (pp. 61-66). IEEE. https://doi.org/10.1109/SACI51354.2021.9465583

Every parameter below is taken from the authors' own published implementation
(github.com/margitantal68/sapimouse), not reconstructed from prose:

    util/settings.py   FEATURES = 128        block length, in events
                       DIMENSIONS = 2        the two channels
                       BATCH_SIZE = 16
                       EPOCHS = 100
                       RANDOM_STATE = 11235
    TRAINED_MODELS/    sapimouse_72__fcn_128_ABS_dx_dy.h5
                       -> 72 training subjects, FCN, 128-event blocks,
                          ABSOLUTE first-order differences of x and y

WHY THIS REPLACES THE EARLIER PIPELINES
---------------------------------------
The first mouse pipeline cut motion into 50-step windows with a stride of 10 —
parameters carried over from the KEYSTROKE method of Lu et al., with no
published basis for a pointer. The second followed Antal & Egyed-Zsigmond
(2019), which is peer-reviewed but predates the 2020 cut-off this work applies
to its method citations. This module follows the SapiMouse paper itself: the
same 2021 peer-reviewed publication that released the dataset we use, so the
method and the data now come from one source.

WHAT THE BLOCKS ARE
-------------------
Consecutive events within one session are differenced, the absolute value is
taken, and the stream is cut into NON-OVERLAPPING blocks of 128. Non-overlapping
matters: the original sliding windows shared 40 of every 50 rows with their
neighbour, which is what made a random split leak. Blocks cannot leak into each
other because they share no events at all.

Usage:
    python preprocess_sapimouse_blocks.py --data-dir data/sapimouse \
        --out data/mouse_only/SapiMouse_Blocks.h5
"""
import argparse
import glob
import os

import numpy as np

try:
    import h5py
except Exception:  # pragma: no cover
    h5py = None

# ---- published parameters (Antal, Fejer & Buza 2021; util/settings.py) ------
BLOCK_LENGTH = 128        # FEATURES
DIMENSIONS = 2            # DIMENSIONS -> (|dx|, |dy|)
RANDOM_STATE = 11235
FCN_SUBJECTS = 72         # subjects 1..72 train the feature extractor
# subjects 73..120 are the one-class evaluation set (48 people)


def read_events(path):
    """(t_seconds, state, x, y) from one SapiMouse CSV.

    `client timestamp` is in MILLISECONDS in the released files.
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
            out.append((t_ms / 1000.0, p[2], x, y))
    return out


def events_to_abs_diffs(events):
    """First-order ABSOLUTE differences, the paper's raw representation."""
    if len(events) < 2:
        return np.empty((0, DIMENSIONS), np.float32)
    x = np.array([e[2] for e in events], dtype=np.float64)
    y = np.array([e[3] for e in events], dtype=np.float64)
    return np.abs(np.column_stack([np.diff(x), np.diff(y)])).astype(np.float32)


def to_blocks(diffs, block_length=BLOCK_LENGTH):
    """Cut into NON-OVERLAPPING blocks; a trailing partial block is dropped."""
    n = len(diffs) // block_length
    if n == 0:
        return np.empty((0, block_length, DIMENSIONS), np.float32)
    return diffs[: n * block_length].reshape(n, block_length, DIMENSIONS)


def zscore_rows(blocks):
    """Row-wise z-score — the paper normalises each sample, not the corpus.

    Normalising per block (rather than with corpus-wide statistics) means no
    information crosses between subjects or between train and test, which is
    what makes the subject-disjoint split below airtight.
    """
    if len(blocks) == 0:
        return blocks
    flat = blocks.reshape(len(blocks), -1)
    mean = flat.mean(axis=1, keepdims=True)
    std = flat.std(axis=1, keepdims=True)
    std[std == 0] = 1.0
    return ((flat - mean) / std).reshape(blocks.shape).astype(np.float32)


def build(data_dir):
    """-> X (n, 128, 2), subject, session  (session 0 = 1-min, 1 = 3-min)."""
    user_dirs = sorted(
        glob.glob(os.path.join(data_dir, "user*")),
        key=lambda p: int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0))

    X, subj, sess = [], [], []
    for ud in user_dirs:
        uid = int("".join(c for c in os.path.basename(ud) if c.isdigit()))
        csvs = sorted(glob.glob(os.path.join(ud, "*.csv")))
        short = [c for c in csvs if "1min" in os.path.basename(c)]
        long_ = [c for c in csvs if "3min" in os.path.basename(c)]
        # session index is explicit, never positional: 0 = 1-min (TEST in the
        # paper), 1 = 3-min (ENROLMENT). Three subjects carry extra recordings,
        # so taking files by position would silently mislabel them.
        for si, group in ((0, short), (1, long_)):
            if not group:
                continue
            blocks = to_blocks(events_to_abs_diffs(read_events(group[0])))
            if len(blocks) == 0:
                continue
            blocks = zscore_rows(blocks)
            X.append(blocks)
            subj.extend([uid] * len(blocks))
            sess.extend([si] * len(blocks))

    X = np.concatenate(X, axis=0) if X else np.empty((0, BLOCK_LENGTH, DIMENSIONS), np.float32)
    return X, np.asarray(subj), np.asarray(sess)


def main():
    ap = argparse.ArgumentParser(description="SapiMouse 128-event block preprocessing")
    ap.add_argument("--data-dir", default="data/sapimouse")
    ap.add_argument("--out", default="data/mouse_only/SapiMouse_Blocks.h5")
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    X, subj, sess = build(args.data_dir)
    users = np.unique(subj)
    print(f"blocks={X.shape}  users={len(users)}")
    per_user = np.array([(subj == u).sum() for u in users])
    print(f"  blocks per user: min {per_user.min()}  median {int(np.median(per_user))}  max {per_user.max()}")
    for si, name in ((0, "1-min (test)"), (1, "3-min (enrol)")):
        print(f"  session {si} {name:15s}: {int((sess == si).sum())} blocks")
    fcn = int((subj <= FCN_SUBJECTS).sum())
    print(f"  FCN subjects 1-{FCN_SUBJECTS}: {fcn} blocks | "
          f"eval subjects {FCN_SUBJECTS+1}-{users.max()}: {len(X)-fcn} blocks")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with h5py.File(args.out, "w") as f:
        f.create_dataset("X", data=X, compression="gzip")
        f.create_dataset("subject", data=subj, compression="gzip")
        f.create_dataset("session", data=sess, compression="gzip")
        f.attrs["method"] = ("Antal, Fejer & Buza (2021), SapiMouse, IEEE SACI, "
                             "doi:10.1109/SACI51354.2021.9465583")
        f.attrs["block_length"] = BLOCK_LENGTH
        f.attrs["dimensions"] = DIMENSIONS
        f.attrs["representation"] = "absolute first-order differences |dx|,|dy|"
        f.attrs["normalization"] = "row-wise z-score"
        f.attrs["fcn_subjects"] = FCN_SUBJECTS
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
