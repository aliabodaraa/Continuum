"""
The five leakage checks that must pass BEFORE the ablation results may be interpreted.

Checks 1 and 2 are asked in two parts, because the honest answers differ:

  (a) DIRECT encoding — does the tensor still carry the ablated quantity as a value?
      Answerable definitively: a constant column has zero variance and encodes nothing.

  (b) INDIRECT encoding — can the ablated quantity be inferred from what remains?
      NOT answerable by construction, and the answer is not zero. How long a key is held
      correlates with WHICH key it is, so timing-only input still carries some information
      about typed content, and an identity sequence still implies something about plausible
      timings. This is measured here as mutual information rather than assumed away, because
      claiming "timing-only is private" without measuring it would be false.

Run inside the model-api container:
    python ablation_checks.py
"""
import argparse

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

from ablation_repr import (CONDITIONS, FEATURE_NAMES, IDENTITY_COLS, TIMING_COLS,
                           apply_condition, corpus_constants, kept_columns)
from population_sweep import (ENROL_FRAC, IMP_POOL_SIZE, NEG_POOL_SIZE, split_with_gap)

failures = 0


def check(name, ok, detail=""):
    global failures
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures += 1


def mutual_information(a, b, bins=20):
    """Discretised MI in bits, plus MI normalised by H(a) — 'what fraction of the uncertainty
    about a is removed by knowing b'."""
    a = np.asarray(a).ravel()
    b = np.asarray(b).ravel()
    av = np.unique(a)
    ab = np.digitize(a, np.quantile(a, np.linspace(0, 1, bins + 1)[1:-1])) if len(av) > bins else \
        np.searchsorted(av, a)
    bb = np.digitize(b, np.quantile(b, np.linspace(0, 1, bins + 1)[1:-1]))
    joint = np.histogram2d(ab, bb, bins=[len(np.unique(ab)), len(np.unique(bb))])[0]
    joint = joint / joint.sum()
    pa = joint.sum(axis=1, keepdims=True)
    pb = joint.sum(axis=0, keepdims=True)
    nz = joint > 0
    mi = float((joint[nz] * np.log2(joint[nz] / (pa @ pb)[nz])).sum())
    ha = float(-(pa[pa > 0] * np.log2(pa[pa > 0])).sum())
    return mi, (mi / ha if ha > 0 else 0.0), ha


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--impostors", default="/app/data/keyrecs_impostors.h5")
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    with h5py.File(args.impostors, "r") as f:
        W = np.asarray(f["windows"], dtype=np.float32)
        P = np.asarray(f["participant"])
    K = corpus_constants(W)
    print(f"corpus {W.shape}, constants = "
          + ", ".join(f"{n}={v:.4f}" for n, v in zip(FEATURE_NAMES, K)))

    variants = {c: apply_condition(W[:4000], c, K) for c in CONDITIONS}

    # ---------------------------------------------------------------- check 1a / 2a
    print("\nCHECK 1a — timing-only carries NO key-identity value")
    T = variants["timing_only"]
    for c in IDENTITY_COLS:
        # The criterion is the number of DISTINCT VALUES, not var(). Summing 200k float32s
        # returns ~1e-15 for a genuinely constant column, so a var()==0 test would fail on a
        # rounding artefact. One distinct value encodes zero information by definition.
        u = np.unique(T[:, :, c])
        check(f"{FEATURE_NAMES[c]} has exactly one distinct value",
              u.size == 1, f"{u.size} distinct, value={u[0]:.6f}, var={T[:, :, c].var():.1e}")
    check("timing columns are untouched",
          all(np.array_equal(T[:, :, c], W[:4000, :, c]) for c in TIMING_COLS))

    print("\nCHECK 2a — identity-only carries NO timing value")
    I = variants["identity_only"]
    for c in TIMING_COLS:
        u = np.unique(I[:, :, c])
        check(f"{FEATURE_NAMES[c]} has exactly one distinct value",
              u.size == 1, f"{u.size} distinct, value={u[0]:.6f}, var={I[:, :, c].var():.1e}")
    check("identity columns are untouched",
          all(np.array_equal(I[:, :, c], W[:4000, :, c]) for c in IDENTITY_COLS))

    # ---------------------------------------------------------------- structural leakage
    print("\nSTRUCTURAL — could shape, length or padding carry a signal?")
    check("every window is exactly 50 steps (fixed length, no padding)",
          W.shape[1] == 50 and all(v.shape[1] == 50 for v in variants.values()))
    check("all three conditions have identical tensor shape",
          len({v.shape for v in variants.values()}) == 1,
          str(variants["full"].shape))
    check("no NaN/inf introduced", all(np.isfinite(v).all() for v in variants.values()))
    # a per-window count or ordering difference would be a signal; there is none, because the
    # ablation only rewrites column values in place
    check("window ORDER is preserved identically in every condition",
          all(np.array_equal(v[:, :, kept_columns(c)[0]], W[:4000, :, kept_columns(c)[0]])
              for c, v in variants.items()))

    # ---------------------------------------------------------------- check 1b / 2b
    print("\nCHECK 1b — INDIRECT: how much does timing still reveal about key identity?")
    step = W.reshape(-1, 6)
    for c in TIMING_COLS:
        mi, frac, h = mutual_information(step[:, 0], step[:, c])
        print(f"    MI(id1 ; {FEATURE_NAMES[c]:6}) = {mi:.4f} bits = {100*frac:5.2f}% of "
              f"H(id1)={h:.2f} bits")
    mi_all, frac_all, h1 = mutual_information(
        step[:, 0], step[:, TIMING_COLS].mean(axis=1))
    print(f"    combined (mean of timing cols)   = {mi_all:.4f} bits = {100*frac_all:.2f}%")
    check("timing reveals only a small fraction of key identity (< 10% of H(id1))",
          frac_all < 0.10, f"{100*frac_all:.2f}% — non-zero, so NOT a privacy guarantee")

    print("\nCHECK 2b — INDIRECT: how much does key identity reveal about timing?")
    for c in TIMING_COLS:
        mi, frac, h = mutual_information(step[:, c], step[:, 0])
        print(f"    MI({FEATURE_NAMES[c]:6} ; id1) = {mi:.4f} bits = {100*frac:5.2f}% of "
              f"H({FEATURE_NAMES[c]})={h:.2f} bits")

    # ---------------------------------------------------------------- checks 3, 4
    print("\nCHECK 3/4 — identical evaluation populations and identical data volume")
    ids = np.sort(np.unique(P))
    neg_pool, imp_pool = ids[:NEG_POOL_SIZE], ids[NEG_POOL_SIZE:NEG_POOL_SIZE + IMP_POOL_SIZE]
    check("negative and impostor pools are disjoint", not (set(neg_pool) & set(imp_pool)))
    same_split = True
    same_volume = True
    for tid in ids[:10]:
        own = W[P == tid]
        e0, t0 = split_with_gap(len(own), ENROL_FRAC)
        for c in CONDITIONS:
            ownc = apply_condition(own, c, K)
            e1, t1 = split_with_gap(len(ownc), ENROL_FRAC)
            if not (np.array_equal(e0, e1) and np.array_equal(t0, t1)):
                same_split = False
            if len(ownc) != len(own):
                same_volume = False
    check("split indices identical across all three conditions", same_split)
    check("window counts identical across all three conditions", same_volume)
    check("ablation changes values only, never the number or order of windows",
          all(v.shape[0] == W[:4000].shape[0] for v in variants.values()))

    print(f"\n{'ALL CHECKS PASSED' if failures == 0 else str(failures) + ' CHECK(S) FAILED'}")
    print("\nNote: 1a/2a are proofs (zero variance). 1b/2b are MEASUREMENTS of residual\n"
          "indirect information — they are deliberately not asserted to be zero, because\n"
          "they are not zero, and the write-up must say so.")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
