"""
Explainability for a per-user keystroke model: WHICH features drive the verdict.

Motivation
----------
The system can say "suspicious 0.27" but not why, which makes the verdict unauditable and
leaves an obvious question unanswered: is the model recognising HOW someone types (timing)
or WHAT they typed (key identity)? Those have very different implications. Timing is a
behavioural biometric. Key identity is closer to content, would not transfer across texts,
and would mean the "biometric" is partly a language model.

Method — permutation importance (Breiman 2001), model-agnostic
--------------------------------------------------------------
Baseline: the genuine/impostor separation (AUC) of the real windows. Then for each feature
column in turn, shuffle that column's values ACROSS windows, destroying the information it
carries while leaving every other feature and the model untouched, and re-measure AUC. The
drop is that feature's contribution. Shuffling (rather than deleting) keeps the input in
the same numeric range, so the network is not being fed an impossible value.

Reported alongside is an occlusion variant that replaces the column with its dataset mean —
a different perturbation that should agree in ranking. Agreement between the two is the
check that the ranking reflects the model and not one particular perturbation.

Both are computed over a genuine/impostor mix, because importance is only meaningful with
respect to a discrimination task; permuting a feature on genuine data alone would measure
sensitivity, not usefulness.

Usage (inside the model-api container):
    python explain.py --user-id 1 --impostors /tmp/keyrecs_partial.h5 \
        --out /app/artifacts/xai/explain_user1.json
"""
import argparse
import json

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

from keystroke_user_sweep import (auc_of, genuine_windows, model_path_for, score)

# Order must match preprocessing.FEATURE_NAMES / buildSteps().
FEATURE_NAMES = ["id1", "id2", "dwell1", "dwell2", "dd", "ud"]
TIMING = {"dwell1", "dwell2", "dd", "ud"}
IDENTITY = {"id1", "id2"}


def permute_column(X, col, rng):
    """Shuffle one feature across ALL windows and positions, destroying only that feature's
    information. Copy so the caller's array is untouched."""
    Y = X.copy()
    flat = Y[:, :, col].ravel()
    rng.shuffle(flat)
    Y[:, :, col] = flat.reshape(Y.shape[0], Y.shape[1])
    return Y


def occlude_column(X, col):
    """Replace one feature with its mean — a perturbation of a different shape than
    shuffling, used as a cross-check on the ranking."""
    Y = X.copy()
    Y[:, :, col] = Y[:, :, col].mean()
    return Y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user-id", type=int, required=True)
    ap.add_argument("--impostors", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--max-genuine", type=int, default=200)
    ap.add_argument("--max-impostor", type=int, default=600)
    ap.add_argument("--repeats", type=int, default=3,
                    help="permutation repeats; importance is averaged over them")
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    model_path, profile = model_path_for(args.user_id)
    gen = np.asarray(genuine_windows(args.user_id, 0)[:args.max_genuine], dtype=np.float32)
    with h5py.File(args.impostors, "r") as f:
        imp = np.asarray(f["windows"])
    rng = np.random.default_rng(3)
    if len(imp) > args.max_impostor:
        imp = imp[rng.choice(len(imp), args.max_impostor, replace=False)]

    n_gen = len(gen)
    X = np.concatenate([gen, imp], axis=0)
    print(f"user {args.user_id}: genuine={n_gen} impostor={len(imp)} windows")

    def sep(Xall):
        s = score(list(Xall), args.user_id, model_path)
        return auc_of(s[:n_gen], s[n_gen:])

    base = sep(X)
    print(f"baseline AUC = {base:.4f}\n")

    rows = []
    for c, name in enumerate(FEATURE_NAMES):
        drops = []
        for r in range(args.repeats):
            drops.append(base - sep(permute_column(X, c, np.random.default_rng(100 + r))))
        perm = float(np.mean(drops))
        occ = float(base - sep(occlude_column(X, c)))
        rows.append({"feature": name, "permutationDrop": perm, "permutationStd": float(np.std(drops)),
                     "occlusionDrop": occ,
                     "kind": "timing" if name in TIMING else "identity"})
        print(f"  {name:<7} permutation ΔAUC {perm:+.4f} (sd {np.std(drops):.4f})   "
              f"occlusion ΔAUC {occ:+.4f}")

    tim = sum(r["permutationDrop"] for r in rows if r["kind"] == "timing")
    ide = sum(r["permutationDrop"] for r in rows if r["kind"] == "identity")
    total = tim + ide
    print(f"\n  timing total  {tim:+.4f}"
          f"   ({100*tim/total:.0f}% of attributed importance)" if total else "")
    print(f"  identity total {ide:+.4f}"
          f"   ({100*ide/total:.0f}% of attributed importance)" if total else "")
    verdict = ("timing-driven — behaves as a behavioural biometric"
               if tim > ide else
               "IDENTITY-DRIVEN — the model leans on WHICH keys were pressed, i.e. partly "
               "content rather than typing rhythm; report this as a limitation")
    print(f"  -> {verdict}")

    res = {"userId": args.user_id, "baselineAuc": base,
           "nGenuine": n_gen, "nImpostor": int(len(imp)),
           "method": "permutation importance (shuffle across windows), "
                     "cross-checked with mean-occlusion",
           "features": rows,
           "timingShare": (tim / total) if total else None,
           "identityShare": (ide / total) if total else None,
           "interpretation": verdict}
    if args.out:
        with open(args.out, "w") as f:
            json.dump(res, f, indent=2)
        print("\nwrote", args.out)


if __name__ == "__main__":
    main()
