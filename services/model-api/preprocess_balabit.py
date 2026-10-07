"""
Balabit preprocessing for the Antal & Fejer (2020) reproduction.

  Antal, M., & Fejer, N. (2020). Mouse dynamics based user recognition using
  deep learning. Acta Universitatis Sapientiae, Informatica, 12(1), 39-50.
  https://doi.org/10.2478/ausi-2020-0003

Emits the SAME h5 schema as preprocess_antal2020.py (X, subject, session) using
exactly the same segmentation rules, so the only thing that differs between the
two runs is the dataset. That is the point: reproducing the paper's number on
the paper's own data is what tells us whether our implementation is faithful,
and it is only evidence if the code path is otherwise identical.

FORMAT DIFFERENCES FROM SAPIMOUSE, HANDLED HERE
-----------------------------------------------
  * six columns: record timestamp, client timestamp, button, state, x, y
    (SapiMouse has five and no record timestamp)
  * `client timestamp` is in SECONDS already (0.016, 0.032, ...), whereas
    SapiMouse stores MILLISECONDS. Getting this wrong silently rescales every
    velocity by 1000 and destroys the 2-second sequence threshold.
  * one directory per user containing many session files; the paper treats a
    session as the unit, so each session is given its own session index.

Usage:
    python preprocess_balabit.py --data-dir data/balabit/training_files \
        --out data/mouse_only/Balabit_Blocks.h5
"""
import argparse
import glob
import os

import numpy as np

try:
    import h5py
except Exception:  # pragma: no cover
    h5py = None

from preprocess_antal2020 import (  # noqa: E402
    BLOCK_SIZE, STATELESS_TIME, DIMENSIONS, SCROLL_STATES,
    split_sequences, sequence_to_speeds, to_blocks,
)

# Balabit identifies the scroll wheel in the BUTTON column, not the state column.
SCROLL_BUTTONS = {"Scroll", "Wheel"}


def read_balabit_session(path):
    """(t_seconds, state, x, y) from one Balabit session file."""
    out = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        header = next(f, "")
        cols = [c.strip() for c in header.rstrip("\n").split(",")]
        try:
            i_t = cols.index("client timestamp")
            i_state = cols.index("state")
            i_btn = cols.index("button")
            i_x, i_y = cols.index("x"), cols.index("y")
        except ValueError:
            return out
        for line in f:
            p = line.rstrip("\n").split(",")
            if len(p) < len(cols):
                continue
            # Paper 3.1: "All mouse events contain the x and y coordinates of
            # the mouse pointer with the exception of the mouse scroll event.
            # Therefore, scroll events were not considered."
            #
            # Balabit marks a scroll in the BUTTON column as 'Scroll', with
            # state Down/Up — NOT in the state column. Filtering on state alone
            # keeps every one of them (4.8% of rows), and since a scroll does
            # not move the pointer they enter as zero-displacement samples:
            # the same defect that flooded the browser window pipeline.
            if p[i_btn] in SCROLL_BUTTONS or p[i_state] in SCROLL_STATES:
                continue
            try:
                t = float(p[i_t]); x = float(p[i_x]); y = float(p[i_y])
            except ValueError:
                continue
            out.append((t, p[i_state], x, y))     # already seconds
    return out


def build(data_dir, gap=STATELESS_TIME):
    user_dirs = sorted(
        glob.glob(os.path.join(data_dir, "user*")),
        key=lambda p: int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0))

    X, subj, sess = [], [], []
    for ud in user_dirs:
        uid = int("".join(c for c in os.path.basename(ud) if c.isdigit()))
        for si, path in enumerate(sorted(glob.glob(os.path.join(ud, "session_*")))):
            per_session = []
            for seq in split_sequences(read_balabit_session(path), gap):
                b = to_blocks(sequence_to_speeds(seq))
                if len(b):
                    per_session.append(b)
            if not per_session:
                continue
            blocks = np.concatenate(per_session, axis=0)
            X.append(blocks)
            subj.extend([uid] * len(blocks))
            sess.extend([si] * len(blocks))

    X = np.concatenate(X, axis=0) if X else np.empty((0, BLOCK_SIZE, DIMENSIONS), np.float32)
    return X, np.asarray(subj), np.asarray(sess)


def main():
    ap = argparse.ArgumentParser(description="Balabit block preprocessing (Antal & Fejer 2020)")
    ap.add_argument("--data-dir", default="data/balabit/training_files")
    ap.add_argument("--out", default="data/mouse_only/Balabit_Blocks.h5")
    ap.add_argument("--gap", type=float, default=STATELESS_TIME)
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    X, subj, sess = build(args.data_dir, args.gap)
    users = np.unique(subj)
    print(f"blocks={X.shape}  users={len(users)}")
    print(f"{'user':>8} {'blocks':>8} {'sessions':>9}")
    per_user = {}
    for u in users:
        n = int((subj == u).sum())
        per_user[int(u)] = n
        print(f"{'user'+str(u):>8} {n:>8} {len(np.unique(sess[subj==u])):>9}")

    # The paper's Table 1 lists blocks per user for the DROP setting. Printing
    # ours beside it is the first check that the segmentation matches before
    # any model is trained.
    paper_drop = {7: 2457, 9: 2408, 12: 459, 15: 385, 16: 871,
                  20: 1269, 21: 449, 23: 345, 29: 324, 35: 217}
    print(f"\n{'user':>8} {'ours':>8} {'paper':>8} {'ratio':>7}   (paper Table 1, drop setting)")
    for u in sorted(paper_drop):
        if u in per_user:
            r = per_user[u] / paper_drop[u]
            print(f"{'user'+str(u):>8} {per_user[u]:>8} {paper_drop[u]:>8} {r:>6.2f}x")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with h5py.File(args.out, "w") as f:
        f.create_dataset("X", data=X, compression="gzip")
        f.create_dataset("subject", data=subj, compression="gzip")
        f.create_dataset("session", data=sess, compression="gzip")
        f.attrs["dataset"] = "Balabit Mouse Dynamics Challenge (training_files)"
        f.attrs["method"] = ("Antal & Fejer (2020), Acta Univ. Sapientiae Informatica "
                             "12(1):39-50, doi:10.2478/ausi-2020-0003")
        f.attrs["block_size"] = BLOCK_SIZE
        f.attrs["stateless_time"] = args.gap
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
