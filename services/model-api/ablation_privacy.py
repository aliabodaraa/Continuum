"""
Does the timing-only representation still leak typed CONTENT?

"We removed the key codes" is a statement about the input tensor, not about privacy. Timing
correlates with content: a word boundary is a distinctive pause, common letters are typed faster
than rare ones, and a digram's speed depends on which two keys it spans. So the question is not
whether identity was removed — check 1a proves it was — but how much of it can be RECOVERED from
what remains.

Three probes, each an attacker trying to reconstruct content from timing alone:

  1. word boundaries — is this digraph a space? The most privacy-relevant single bit: recover
     spaces and you recover word lengths, which is most of the way to fingerprinting a phrase.
  2. key identity — which key was pressed, as a multi-class problem over the frequent keys.
  3. sequence structure — does the ORDER of timings within a window carry more than the
     unordered multiset? If shuffling timings within a window destroys predictive power, the
     sequence itself is carrying content.

Each probe is scored against the correct baseline (predicting the majority class), because a
94%-accurate space detector is worthless if 94% of digraphs are not spaces.

Run inside the model-api container:
    python ablation_privacy.py
"""
import argparse

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

from ablation_repr import TIMING_COLS

KEYCODE_SCALE = 255.0
SPACE = 32


def auc(y, s):
    y = np.asarray(y).astype(int)
    s = np.asarray(s, dtype=float)
    order = s.argsort()
    ranks = np.empty(len(s), float)
    ranks[order] = np.arange(1, len(s) + 1)
    _, inv, cnt = np.unique(s, return_inverse=True, return_counts=True)
    sums = np.zeros(len(cnt))
    np.add.at(sums, inv, ranks)
    ranks = (sums / cnt)[inv]
    npos, nneg = int(y.sum()), int((1 - y).sum())
    if not npos or not nneg:
        return float("nan")
    return float((ranks[y == 1].sum() - npos * (npos + 1) / 2) / (npos * nneg))


def fit_logreg(X, y, iters=300, lr=0.5):
    """Small logistic regression, standardised inputs, no external dependency."""
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = np.hstack([(X - mu) / sd, np.ones((len(X), 1))])
    w = np.zeros(Z.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Z @ w))
        w -= lr * (Z.T @ (p - y)) / len(y)
    return lambda A: 1 / (1 + np.exp(-np.hstack([(A - mu) / sd, np.ones((len(A), 1))]) @ w))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--impostors", default="/app/data/keyrecs_impostors.h5")
    ap.add_argument("--n", type=int, default=400000)
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    with h5py.File(args.impostors, "r") as f:
        W = np.asarray(f["windows"], dtype=np.float32)
    steps = W.reshape(-1, 6)
    if len(steps) > args.n:
        steps = steps[np.random.default_rng(5).choice(len(steps), args.n, replace=False)]
    key1 = np.rint(steps[:, 0] * KEYCODE_SCALE).astype(int)
    timing = steps[:, list(TIMING_COLS)]
    print(f"{len(steps)} digraph steps; {len(np.unique(key1))} distinct key1 codes")

    cut = int(0.7 * len(steps))
    Xtr, Xte = timing[:cut], timing[cut:]

    # ---------------------------------------------------------------- probe 1: spaces
    print("\nPROBE 1 — can timing alone identify word boundaries (space)?")
    y = (key1 == SPACE).astype(int)
    base = max(y.mean(), 1 - y.mean())
    ytr, yte = y[:cut], y[cut:]
    if ytr.sum() > 50:
        pred = fit_logreg(Xtr, ytr)(Xte)
        a = auc(yte, pred)
        acc = float(((pred >= 0.5).astype(int) == yte).mean())
        print(f"    spaces are {100*y.mean():.1f}% of digraphs; majority baseline "
              f"{100*base:.1f}%")
        print(f"    timing-only detector: accuracy {100*acc:.1f}%   AUC {a:.3f}")
        print(f"    -> {'LEAKS word boundaries' if a > 0.6 else 'weak signal' if a > 0.55 else 'near chance'}"
              f" (AUC 0.5 = no information)")
    else:
        print("    too few space digraphs to probe")

    # ---------------------------------------------------------------- probe 2: key identity
    print("\nPROBE 2 — can timing alone identify WHICH key, among the frequent ones?")
    vals, counts = np.unique(key1, return_counts=True)
    top = vals[np.argsort(-counts)[:5]]
    print(f"    5 most frequent key codes: {top.tolist()} "
          f"({100*counts[np.argsort(-counts)[:5]].sum()/len(key1):.0f}% of all digraphs)")
    aucs = []
    for k in top:
        yk = (key1 == k).astype(int)
        if yk[:cut].sum() < 50:
            continue
        a = auc(yk[cut:], fit_logreg(Xtr, yk[:cut])(Xte))
        aucs.append(a)
        print(f"      key {k:>3}: one-vs-rest AUC {a:.3f}")
    if aucs:
        print(f"    mean AUC {np.mean(aucs):.3f} — "
              f"{'substantial content leakage' if np.mean(aucs) > 0.65 else 'weak but non-zero' if np.mean(aucs) > 0.55 else 'near chance'}")

    # ---------------------------------------------------------------- probe 3: ordering
    print("\nPROBE 3 — does the ORDER of timings inside a window carry content?")
    sub = W[:6000]
    real = sub[:, :, list(TIMING_COLS)]
    rng = np.random.default_rng(7)
    shuf = real.copy()
    for i in range(len(shuf)):                       # permute steps within each window
        shuf[i] = shuf[i][rng.permutation(shuf.shape[1])]
    # a window's space COUNT is content; can it be read from ordered vs shuffled timings?
    space_count = (np.rint(sub[:, :, 0] * KEYCODE_SCALE).astype(int) == SPACE).sum(axis=1)
    y = (space_count > np.median(space_count)).astype(int)
    c = int(0.7 * len(sub))
    # Features MUST be order-sensitive or this probe is vacuous: mean/std/min/max are
    # permutation-invariant, so shuffling would trivially change nothing. Use the flattened
    # sequence, which preserves position.
    for name, D in (("ordered", real), ("shuffled", shuf)):
        F = D.reshape(len(D), -1)                    # 50 steps x 4 timings, in order
        a = auc(y[c:], fit_logreg(F[:c], y[:c], iters=400)(F[c:]))
        # deviation in EITHER direction is information; 0.5 is the no-information point
        print(f"    {name:9} timings -> predict above-median space count: AUC {a:.3f} "
              f"(|AUC-0.5| = {abs(a-0.5):.3f})")
    print("    (if ordered carries more than shuffled, sequence ORDER itself leaks content)")

    print("\nInterpretation: any AUC above 0.5 is recoverable content. Removing the key-code\n"
          "columns removes DIRECT identity, not the possibility of inferring what was typed.")


if __name__ == "__main__":
    main()
