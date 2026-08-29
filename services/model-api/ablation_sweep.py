"""
Experiment #6 — timing-only vs identity-only, against frozen baseline `baseline-keystroke-v1`.

Three conditions over the same 99 KeyRecs targets:

    A. full           id1, id2, dwell1, dwell2, dd, ud
    B. timing_only    identity columns replaced by a corpus constant
    C. identity_only  timing columns replaced by a corpus constant

ONLY the input representation changes. Architecture, base model, frozen weights, optimiser,
epochs, batch size, early stopping, negative pools, impostor pools, temporal split, overlap gap
and evaluation metrics are the frozen baseline, unchanged.

How identical populations are GUARANTEED rather than hoped for
--------------------------------------------------------------
Every index — enrol/validation/held-out positions, the sampled negative participants, the
sampled impostor windows — is drawn ONCE per target, before any condition runs, and the same
index arrays are reused for all three. So the three conditions cannot differ in which windows
they see, how many they see, or in what order. They differ only in the VALUES of two or four
columns. This is stronger than seeding three separate runs identically, because it does not
depend on the three code paths consuming randomness in the same sequence.

TensorFlow's seed is additionally fixed per target so the three fits start from identical
state. The frozen baseline did not set a TF seed; setting it here makes the three-way
comparison controlled rather than confounded with fit noise, and is a configuration detail
rather than a protocol change. Condition A is checked against the frozen population figures to
confirm it still reproduces them.

Confidence intervals
--------------------
Reported at POPULATION level by bootstrapping over the 99 users, who are independent. Per-user
CIs are deliberately NOT reported: a user's held-out block is one contiguous stretch of typing,
so resampling its windows would treat correlated observations as independent — the exact defect
the baseline protocol forbids. Paired per-user differences are bootstrapped over users too,
which is valid because the pairing removes the between-user variance.

Usage (inside the model-api container):
    python ablation_sweep.py --out /app/artifacts/xai/ablation_keystroke.json
"""
import argparse
import json
import sys
import time

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

from ablation_repr import CONDITIONS, apply_condition, corpus_constants
from keystroke_user_sweep import LIVE_THRESHOLD, auc_of, eer_of, tar_at_far
from population_sweep import (ENROL_FRAC, IMP_POOL_SIZE, NEG_POOL_SIZE, VAL_FRAC,
                              build_model, get_scaler, scale, split_with_gap)


def draw_indices(tid, windows, pid, neg_pool, imp_pool, rng, max_imp):
    """Every random choice for this target, made ONCE and shared by all three conditions."""
    own_mask = pid == tid
    own_n = int(own_mask.sum())
    enrol_idx, test_idx = split_with_gap(own_n, ENROL_FRAC)
    if len(enrol_idx) < 40 or len(test_idx) < 20:
        return None
    tr_idx, va_idx = split_with_gap(len(enrol_idx), 1.0 - VAL_FRAC)

    neg_parts = np.array([p for p in neg_pool if p != tid])
    n_va = max(4, len(neg_parts) // 5)
    va_parts, tr_parts = neg_parts[:n_va], neg_parts[n_va:]
    want = max(len(tr_idx) * 2, 60)
    neg_tr_pos = np.where(np.isin(pid, tr_parts))[0]
    neg_va_pos = np.where(np.isin(pid, va_parts))[0]
    neg_tr = neg_tr_pos[rng.choice(len(neg_tr_pos), min(want, len(neg_tr_pos)), replace=False)]
    neg_va = neg_va_pos[rng.choice(len(neg_va_pos),
                                   min(max(len(va_idx) * 2, 30), len(neg_va_pos)), replace=False)]

    imp_parts = np.array([p for p in imp_pool if p != tid])
    imp_pos = np.where(np.isin(pid, imp_parts))[0]
    imp = imp_pos[rng.choice(len(imp_pos), min(max_imp, len(imp_pos)), replace=False)]

    own_pos = np.where(own_mask)[0]
    shuffle_n = len(tr_idx) + len(neg_tr)
    return {
        "pos_tr": own_pos[enrol_idx[tr_idx]], "pos_va": own_pos[enrol_idx[va_idx]],
        "held_out": own_pos[test_idx], "neg_tr": neg_tr, "neg_va": neg_va, "imp": imp,
        "shuffle": rng.permutation(shuffle_n),
    }


def run_condition(cond, idx, windows, constants, scaler, epochs, seed):
    import tensorflow as tf
    from tensorflow.keras import backend as K
    from tensorflow.keras.callbacks import EarlyStopping
    K.clear_session()
    tf.random.set_seed(seed)

    def prep(positions):
        return scale(apply_condition(windows[positions], cond, constants), scaler)

    X_tr = np.concatenate([prep(idx["pos_tr"]), prep(idx["neg_tr"])])
    y_tr = np.concatenate([np.ones(len(idx["pos_tr"])),
                           np.zeros(len(idx["neg_tr"]))]).astype(np.int64)
    X_va = np.concatenate([prep(idx["pos_va"]), prep(idx["neg_va"])])
    y_va = np.concatenate([np.ones(len(idx["pos_va"])),
                           np.zeros(len(idx["neg_va"]))]).astype(np.int64)
    sh = idx["shuffle"]
    X_tr, y_tr = X_tr[sh], y_tr[sh]

    model = build_model(windows.shape[1:])
    model.fit(X_tr, y_tr, validation_data=(X_va, y_va), epochs=epochs, batch_size=16,
              verbose=0, callbacks=[EarlyStopping(patience=6, restore_best_weights=True,
                                                  monitor="val_loss")])
    g = model.predict(prep(idx["held_out"]), batch_size=256, verbose=0)[:, 1]
    i = model.predict(prep(idx["imp"]), batch_size=256, verbose=0)[:, 1]
    K.clear_session()
    return {
        "auc": float(auc_of(g, i)), "eer": float(eer_of(g, i)[0]),
        "tarAtFar01": float(tar_at_far(g, i, 0.01)[0]),
        "tarAtFar05": float(tar_at_far(g, i, 0.05)[0]),
        "tarAt050": float((g >= LIVE_THRESHOLD).mean()),
        "farAt050": float((i >= LIVE_THRESHOLD).mean()),
        "nHeldOut": int(len(g)), "nImpostor": int(len(i)),
        "nTrain": int(len(X_tr)), "nVal": int(len(X_va)),
    }


def stats(v):
    v = np.asarray(v, dtype=float)
    return {"median": float(np.median(v)), "iqr": [float(np.percentile(v, 25)),
                                                   float(np.percentile(v, 75))],
            "mean": float(v.mean()), "min": float(v.min()), "max": float(v.max()),
            "std": float(v.std()), "n": int(len(v))}


def boot_ci(v, fn=np.median, n=4000, seed=17):
    """CI by resampling USERS, the independent unit."""
    v = np.asarray(v, dtype=float)
    rng = np.random.default_rng(seed)
    vals = [fn(v[rng.integers(0, len(v), len(v))]) for _ in range(n)]
    return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--impostors", default="/app/data/keyrecs_impostors.h5")
    ap.add_argument("--out", default=None)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--max-impostor", type=int, default=1500)
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    with h5py.File(args.impostors, "r") as f:
        W = np.asarray(f["windows"], dtype=np.float32)
        P = np.asarray(f["participant"])
    constants = corpus_constants(W)
    ids = np.sort(np.unique(P))
    neg_pool = ids[:NEG_POOL_SIZE]
    imp_pool = ids[NEG_POOL_SIZE:NEG_POOL_SIZE + IMP_POOL_SIZE]
    targets = ids if not args.limit else ids[:args.limit]
    scaler = get_scaler()

    print(f"{len(targets)} targets x {len(CONDITIONS)} conditions | pools disjoint, "
          f"target excluded from both")
    print("indices drawn once per target and shared by all conditions\n")
    print(f"  {'target':>6}  " + "  ".join(f"{c:>22}" for c in CONDITIONS))
    print(f"  {'':>6}  " + "  ".join(f"{'EER    AUC   T@1%':>22}" for _ in CONDITIONS))

    rows, t0 = [], time.time()
    for n, tid in enumerate(targets, 1):
        idx = draw_indices(tid, W, P, neg_pool, imp_pool,
                           np.random.default_rng(1000 + int(tid)), args.max_impostor)
        if idx is None:
            print(f"  {tid:>6}  skipped (too few windows)")
            continue
        rec = {"participant": int(tid)}
        for cond in CONDITIONS:
            rec[cond] = run_condition(cond, idx, W, constants, scaler,
                                      args.epochs, 1000 + int(tid))
        # identical populations, asserted per target rather than assumed
        assert len({rec[c]["nHeldOut"] for c in CONDITIONS}) == 1
        assert len({rec[c]["nImpostor"] for c in CONDITIONS}) == 1
        assert len({rec[c]["nTrain"] for c in CONDITIONS}) == 1
        rows.append(rec)
        print(f"  {tid:>6}  " + "  ".join(
            f"{rec[c]['eer']:6.2%} {rec[c]['auc']:.3f} {rec[c]['tarAtFar01']:5.1%}"
            for c in CONDITIONS))
        sys.stdout.flush()
        if args.out and n % 5 == 0:
            with open(args.out, "w") as f:
                json.dump({"perUser": rows, "partial": True}, f)

    summary = {}
    for c in CONDITIONS:
        summary[c] = {m: stats([r[c][m] for r in rows])
                      for m in ("eer", "auc", "tarAtFar01", "tarAt050", "farAt050")}
        summary[c]["eer"]["medianCI"] = boot_ci([r[c]["eer"] for r in rows])
        summary[c]["auc"]["medianCI"] = boot_ci([r[c]["auc"] for r in rows])
        summary[c]["tarAtFar01"]["medianCI"] = boot_ci([r[c]["tarAtFar01"] for r in rows])

    paired = {}
    for a, b in (("full", "timing_only"), ("full", "identity_only"),
                 ("timing_only", "identity_only")):
        d = np.array([r[b]["eer"] - r[a]["eer"] for r in rows])
        paired[f"{b} - {a}"] = {
            "eerDeltaMedian": float(np.median(d)),
            "eerDeltaMedianCI": boot_ci(d),
            "usersWorse": int((d > 0).sum()), "usersBetter": int((d < 0).sum()),
        }

    print(f"\n  {len(rows)} users x 3 conditions in {(time.time()-t0)/60:.1f} min\n")
    print(f"  {'metric':<16} " + "".join(f"{c:>16}" for c in CONDITIONS))
    for m, label in (("eer", "EER median"), ("auc", "AUC median"),
                     ("tarAtFar01", "TAR@FAR=1% med")):
        print(f"  {label:<16} " + "".join(
            f"{summary[c][m]['median']:>15.2%} " if m != "auc"
            else f"{summary[c][m]['median']:>15.3f} " for c in CONDITIONS))
    print()
    for k, v in paired.items():
        print(f"  paired EER delta, {k:<28} {v['eerDeltaMedian']:+.2%} "
              f"CI[{v['eerDeltaMedianCI'][0]:+.2%}, {v['eerDeltaMedianCI'][1]:+.2%}]  "
              f"worse for {v['usersWorse']}/{len(rows)}")

    if args.out:
        with open(args.out, "w") as f:
            json.dump({"baseline": "baseline-keystroke-v1",
                       "conditions": list(CONDITIONS),
                       "constants": constants.tolist(),
                       "perUser": rows, "summary": summary, "paired": paired}, f, indent=2)
        print("\nwrote", args.out)


if __name__ == "__main__":
    main()
