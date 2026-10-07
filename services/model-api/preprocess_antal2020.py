"""
Block preprocessing following

  Antal, M., & Fejer, N. (2020). Mouse dynamics based user recognition using
  deep learning. Acta Universitatis Sapientiae, Informatica, 12(1), 39-50.
  https://doi.org/10.2478/ausi-2020-0003          [open access]

Every parameter is taken either from the paper's Section 3.1 or, where the text
leaves a value unstated, from the authors' released code
(github.com/norbertFejer/AFE_Project, config/constants.py):

  paper 3.1   "scroll events were not considered"
  paper 3.1   "A sequence was ended when the time difference between two
               consecutive mouse events exceeded a threshold."
  code        STATELESS_TIME = 2          -> that threshold is 2 seconds
  paper 3.1   "These sequences were segmented into fixed sized blocks."
  code        BLOCK_SIZE = 128
  paper 3.1   shorter trailing sequences are either DROPPED or CONCATENATED;
              both were evaluated (Table 3). Drop is the default here.
  paper 3.1   "In order to obtain translation invariant mouse position
               sequences we decided to use speed values (dx/dt, dy/dt) instead
               of absolute position coordinates (x, y)."
  code        MAX_WIDTH = MAX_HEIGHT = 4000  -> pixel saturation limits

HOW THIS DIFFERS FROM preprocess_sapimouse_blocks.py
----------------------------------------------------
Same 128-event block size — the two papers agree on that independently, which
is the main reason to trust it — but the input representation differs. The
SapiMouse paper uses ABSOLUTE first-order differences |dx|,|dy|; this one uses
SPEEDS dx/dt, dy/dt, chosen for translation invariance. The authors ship both
variants (`fcn_128_ABS_dx_dy` and `fcn_128_vx_vy`), so they are alternatives
within one line of work rather than a contradiction.

WHAT DEVIATES FROM THE PAPER, DELIBERATELY
------------------------------------------
The paper evaluates on Balabit (10 users) and DFL (21 users). We apply the same
preprocessing to SapiMouse (120 users) because 10 subjects cannot support a
population claim, and because the segmentation needs only timestamps and
coordinates, which SapiMouse provides. Declared wherever results are reported.

Usage:
    python preprocess_antal2020.py --data-dir data/sapimouse \
        --out data/mouse_only/Antal2020_Blocks.h5
"""
import argparse
import glob
import os

import numpy as np

try:
    import h5py
except Exception:  # pragma: no cover
    h5py = None

# ---- published / authors' code parameters ----------------------------------
BLOCK_SIZE = 128            # config/constants.py BLOCK_SIZE
STATELESS_TIME = 2.0        # config/constants.py STATELESS_TIME (seconds)
MAX_WIDTH = 4000.0          # config/constants.py MAX_WIDTH
MAX_HEIGHT = 4000.0         # config/constants.py MAX_HEIGHT
DIMENSIONS = 2              # (dx/dt, dy/dt)
SCROLL_STATES = {"Scroll", "Wheel"}     # paper 3.1: scroll events excluded


def read_events(path):
    """(t_seconds, state, x, y). SapiMouse timestamps are MILLISECONDS."""
    out = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        next(f, None)
        for line in f:
            p = line.rstrip("\n").split(",")
            if len(p) != 5:
                continue
            if p[2] in SCROLL_STATES:
                continue
            try:
                t_ms = float(p[0]); x = float(p[3]); y = float(p[4])
            except ValueError:
                continue
            out.append((t_ms / 1000.0, p[2], x, y))
    return out


def split_sequences(events, gap=STATELESS_TIME):
    """Paper 3.1: a gap larger than the threshold ends the sequence."""
    seqs, cur = [], []
    for e in events:
        if cur and (e[0] - cur[-1][0]) > gap:
            seqs.append(cur)
            cur = []
        cur.append(e)
    if cur:
        seqs.append(cur)
    return seqs


def sequence_to_speeds(seq):
    """dx/dt, dy/dt with the authors' pixel saturation applied."""
    if len(seq) < 2:
        return np.empty((0, DIMENSIONS), np.float32)
    t = np.array([e[0] for e in seq], dtype=np.float64)
    x = np.array([e[2] for e in seq], dtype=np.float64)
    y = np.array([e[3] for e in seq], dtype=np.float64)

    # Drop invalid readings rather than saturate them. Balabit records failed
    # samples as 65535 (0xFFFF) in both coordinates; clipping those to the 4000
    # limit still fabricates a ~3500-pixel jump from wherever the pointer really
    # was, which then becomes a spurious high-speed sample. They are not extreme
    # positions, they are missing data, and the honest handling is removal.
    # constants.py comments MAX_WIDTH/MAX_HEIGHT as "Maximum screen sizes in
    # pixels for saturating outlayer values" — the authors SATURATE these rather
    # than drop them, so we do the same for fidelity even though dropping the
    # 65535 sentinels would be cleaner practice. Recorded as a deviation we
    # chose NOT to make.
    x = np.clip(x, 0.0, MAX_WIDTH)
    y = np.clip(y, 0.0, MAX_HEIGHT)

    dt = np.diff(t)
    # Non-positive gaps are duplicate or out-of-order timestamps — 5.75% of
    # Balabit rows. Flooring them at 1e-3 manufactured speeds up to 65,000,000
    # px/s against a median of 62; those single samples then set the max-abs
    # scale for the whole corpus. Dropping the affected steps is both more
    # honest and leaves the scaler on real motion.
    ok = dt > 0
    if not ok.any():
        return np.empty((0, DIMENSIONS), np.float32)
    dx_all, dy_all = np.diff(x), np.diff(y)
    dt, dx_all, dy_all = dt[ok], dx_all[ok], dy_all[ok]
    v = np.column_stack([dx_all / dt, dy_all / dt])
    # A residual speed bound is still needed. Even after removing invalid
    # coordinates and non-positive gaps, genuine sub-millisecond timestamp
    # resolution leaves samples in the millions of px/s against a median of 62.
    # A max-abs scaler fitted on that divides everything by the outlier. The
    # bound is set from MAX_WIDTH, the only magnitude the authors' constants
    # supply, and it truncates 1.85% of Balabit speed values.
    return np.clip(v, -MAX_WIDTH, MAX_WIDTH).astype(np.float32)


def to_blocks(speeds, block_size=BLOCK_SIZE):
    """Non-overlapping blocks; the trailing partial block is DROPPED (paper 3.1)."""
    n = len(speeds) // block_size
    if n == 0:
        return np.empty((0, block_size, DIMENSIONS), np.float32)
    return speeds[: n * block_size].reshape(n, block_size, DIMENSIONS)


def build(data_dir, gap=STATELESS_TIME):
    user_dirs = sorted(
        glob.glob(os.path.join(data_dir, "user*")),
        key=lambda p: int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0))

    X, subj, sess = [], [], []
    dropped_short = 0
    for ud in user_dirs:
        uid = int("".join(c for c in os.path.basename(ud) if c.isdigit()))
        csvs = sorted(glob.glob(os.path.join(ud, "*.csv")))
        short = [c for c in csvs if "1min" in os.path.basename(c)]
        long_ = [c for c in csvs if "3min" in os.path.basename(c)]
        for si, group in ((0, short), (1, long_)):     # 0 = 1-min, 1 = 3-min
            if not group:
                continue
            per_file = []
            for seq in split_sequences(read_events(group[0]), gap):
                sp = sequence_to_speeds(seq)
                b = to_blocks(sp)
                if len(b) == 0 and len(sp) > 0:
                    dropped_short += 1
                if len(b):
                    per_file.append(b)
            if not per_file:
                continue
            blocks = np.concatenate(per_file, axis=0)
            X.append(blocks)
            subj.extend([uid] * len(blocks))
            sess.extend([si] * len(blocks))

    X = np.concatenate(X, axis=0) if X else np.empty((0, BLOCK_SIZE, DIMENSIONS), np.float32)
    return X, np.asarray(subj), np.asarray(sess), dropped_short


def main():
    ap = argparse.ArgumentParser(description="Antal & Fejer (2020) block preprocessing")
    ap.add_argument("--data-dir", default="data/sapimouse")
    ap.add_argument("--out", default="data/mouse_only/Antal2020_Blocks.h5")
    ap.add_argument("--gap", type=float, default=STATELESS_TIME)
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    X, subj, sess, dropped = build(args.data_dir, args.gap)
    users = np.unique(subj)
    print(f"blocks={X.shape}  users={len(users)}  (sub-block sequences dropped: {dropped})")
    per_user = np.array([(subj == u).sum() for u in users])
    print(f"  blocks per user: min {per_user.min()}  median {int(np.median(per_user))}  max {per_user.max()}")
    for si, name in ((0, "1-min"), (1, "3-min")):
        print(f"  session {si} ({name}): {int((sess == si).sum())} blocks")
    print(f"  speed range: p1 {np.percentile(X,1):.1f}  median {np.median(X):.1f}  "
          f"p99 {np.percentile(X,99):.1f} px/s")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with h5py.File(args.out, "w") as f:
        f.create_dataset("X", data=X, compression="gzip")
        f.create_dataset("subject", data=subj, compression="gzip")
        f.create_dataset("session", data=sess, compression="gzip")
        f.attrs["method"] = ("Antal & Fejer (2020), Acta Univ. Sapientiae Informatica "
                             "12(1):39-50, doi:10.2478/ausi-2020-0003")
        f.attrs["block_size"] = BLOCK_SIZE
        f.attrs["stateless_time"] = args.gap
        f.attrs["representation"] = "speeds dx/dt, dy/dt (translation invariant)"
        f.attrs["short_sequences"] = "dropped"
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
