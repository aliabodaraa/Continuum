"""
Does the per-user keystroke approach work for people we have never seen?

Why this exists
---------------
Every subject-disjoint keystroke number published so far comes from ONE target user (`ali`,
the only enrolled account with enough held-out data). A single user is a case study, not a
population estimate: it cannot say whether 7.1% EER is typical, lucky, or unlucky, and it
gives no sense of the spread a deployment would actually see. The mouse modality already
showed why this matters — its per-user EER is bimodal, so the mean hides users for whom the
system barely works at all.

This script rebuilds the whole enrol-and-verify pipeline for EVERY one of the 99 KeyRecs
participants in turn, using the deployed training recipe, and reports the DISTRIBUTION of
per-user EER rather than a point estimate.

Protocol (the leakage-free version of what production does)
-----------------------------------------------------------
For each target participant t:

  * Positives come only from t. They are split TEMPORALLY, never randomly. Windows overlap
    by 80% (stride 10 of 50), so windows i and j share rows whenever |i-j| < 5; a random
    split would put near-identical copies of the same keystrokes on both sides and the
    result would measure memorisation. A GAP of 5 windows is discarded at every boundary so
    no evaluation window shares a single row with any training window.

        enrol block            gap        held-out block
        [ first 70% ]  -- 5 windows --  [ last 30% ]

  * Training negatives are drawn from NEG_POOL, evaluation impostors from IMP_POOL, and the
    two pools are DISJOINT. Reusing the same people for both would let the model memorise
    the specific impostors it is later scored against, which is the standard way an
    impostor-set is accidentally leaked. t is removed from both pools.

  * The internal validation split used by EarlyStopping is carved out the same way:
    positives contiguous-with-gap, negatives split BY PARTICIPANT.

  * Recipe copied from api.py: transfer from the ws50-gru-v2 base, Conv1D frozen, Adam
    3e-4, 30 epochs, batch 16, EarlyStopping(patience=6, restore_best_weights=True).

One trap worth recording: for keystroke the base has a 2-class head, so api.py reuses the
loaded base object DIRECTLY (`model_instance = base`). Fine-tuning therefore mutates it in
place, and a loop that loads it once would have target 2 start from target 1's fine-tuned
weights — every subsequent user silently inheriting the previous one's identity. The base is
reloaded for every target here.

Usage (inside the model-api container):
    python population_sweep.py --impostors /app/data/keyrecs_impostors.h5 \
        --out /app/artifacts/xai/population_keystroke.json
"""
import argparse
import json
import os
import sys
import time

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

from keystroke_user_sweep import LIVE_THRESHOLD, auc_of, eer_of, tar_at_far

# Windows overlap 80% (stride 10 of a 50-step window), so two windows share rows whenever

# ---- identity scope -------------------------------------------------------
# This experiment is part of the FROZEN baseline. It addresses raw historical user_ids and
# must never resolve principal aliases: user_id=1 is 121 held-out samples, whereas the
# principal that owns it also owns 739935229538144, which would make it 243. The guard below
# raises if anything reaches for canonical resolution.
from identity_scope import ResearchScope, assert_research_scope
SCOPE = assert_research_scope(ResearchScope("baseline-keystroke-v1"), "baseline-keystroke-v1")
# their indices differ by less than 5. Every train/eval boundary discards this many.
OVERLAP_GAP = 5

BASE_MODEL = os.getenv("KS_BASE_MODEL", "/app/artifacts/ws50-gru-v2/final_model")
SCALER = os.getenv("KS_SCALER", "/app/artifacts/ws50-gru-v2/scaler.json")

ENROL_FRAC = 0.70          # of the target's own windows; the rest is held out
VAL_FRAC = 0.15            # of the enrol block, taken from its end
NEG_POOL_SIZE = 40
IMP_POOL_SIZE = 40


def split_with_gap(n, frac):
    """Indices for a temporal split that leaves an overlap gap between the two blocks.

    Returns (head, tail) index arrays. The `OVERLAP_GAP` windows straddling the boundary are
    dropped entirely rather than assigned to either side — they are the only windows that
    could share rows across it."""
    cut = int(n * frac)
    head = np.arange(0, max(cut - OVERLAP_GAP, 0))
    tail = np.arange(min(cut + OVERLAP_GAP, n), n)
    return head, tail


def build_model(window_shape):
    """Load the base fresh and freeze Conv1D, exactly as api.py does for keystroke."""
    from tensorflow.keras.models import load_model
    from tensorflow.keras.optimizers import Adam
    m = load_model(BASE_MODEL)
    assert tuple(m.input_shape[1:]) == window_shape, f"base expects {m.input_shape[1:]}"
    m.layers[0].trainable = False
    m.compile(optimizer=Adam(learning_rate=3e-4),
              loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    return m


def get_scaler():
    from api import get_scaler as _gs
    return _gs(SCALER)


def scale(x, scaler):
    return x.astype(np.float32) if scaler is None else scaler.transform(x.astype(np.float32))


def run_target(tid, windows, pid, neg_pool, imp_pool, scaler, rng, epochs, max_imp):
    """Enrol one participant and score them against unseen impostors."""
    from tensorflow.keras.callbacks import EarlyStopping

    own = windows[pid == tid]
    enrol_idx, test_idx = split_with_gap(len(own), ENROL_FRAC)
    if len(enrol_idx) < 40 or len(test_idx) < 20:
        return None
    enrol, held_out = own[enrol_idx], own[test_idx]

    # validation positives from the END of the enrol block, gap-separated
    tr_idx, va_idx = split_with_gap(len(enrol), 1.0 - VAL_FRAC)
    pos_tr, pos_va = enrol[tr_idx], enrol[va_idx]

    # negatives: split BY PARTICIPANT so no person appears on both sides
    neg_parts = np.array([p for p in neg_pool if p != tid])
    n_va = max(4, len(neg_parts) // 5)
    va_parts, tr_parts = neg_parts[:n_va], neg_parts[n_va:]
    want = max(len(pos_tr) * 2, 60)
    neg_tr_all = windows[np.isin(pid, tr_parts)]
    neg_va_all = windows[np.isin(pid, va_parts)]
    neg_tr = neg_tr_all[rng.choice(len(neg_tr_all), min(want, len(neg_tr_all)), replace=False)]
    neg_va = neg_va_all[rng.choice(len(neg_va_all), min(max(len(pos_va) * 2, 30), len(neg_va_all)),
                                   replace=False)]

    X_tr = scale(np.concatenate([pos_tr, neg_tr]), scaler)
    y_tr = np.concatenate([np.ones(len(pos_tr)), np.zeros(len(neg_tr))]).astype(np.int64)
    X_va = scale(np.concatenate([pos_va, neg_va]), scaler)
    y_va = np.concatenate([np.ones(len(pos_va)), np.zeros(len(neg_va))]).astype(np.int64)
    sh = rng.permutation(len(X_tr))
    X_tr, y_tr = X_tr[sh], y_tr[sh]

    model = build_model(windows.shape[1:])
    model.fit(X_tr, y_tr, validation_data=(X_va, y_va), epochs=epochs, batch_size=16,
              verbose=0, callbacks=[EarlyStopping(patience=6, restore_best_weights=True,
                                                  monitor="val_loss")])

    # evaluate: held-out genuine vs impostors from the disjoint pool
    imp_parts = np.array([p for p in imp_pool if p != tid])
    imp_all = windows[np.isin(pid, imp_parts)]
    imp = imp_all[rng.choice(len(imp_all), min(max_imp, len(imp_all)), replace=False)]

    g = model.predict(scale(held_out, scaler), batch_size=256, verbose=0)[:, 1]
    i = model.predict(scale(imp, scaler), batch_size=256, verbose=0)[:, 1]

    from tensorflow.keras import backend as K
    K.clear_session()

    return {
        # raw scores kept so callers can compute decision-level (packet) rates without
        # refitting; held_out is in temporal order, so packets may slide over it
        "_genuineScores": g.tolist(), "_impostorScores": i.tolist(),
        "participant": int(tid),
        "nEnrol": int(len(pos_tr)), "nHeldOut": int(len(held_out)), "nImpostor": int(len(imp)),
        "auc": float(auc_of(g, i)), "eer": float(eer_of(g, i)[0]),
        "tarAt050": float((g >= LIVE_THRESHOLD).mean()),
        "farAt050": float((i >= LIVE_THRESHOLD).mean()),
        "tarAtFar01": float(tar_at_far(g, i, 0.01)[0]),   # (tar, threshold)
        "tarAtFar05": float(tar_at_far(g, i, 0.05)[0]),
        "genuineMean": float(g.mean()), "impostorMean": float(i.mean()),
    }


def summarise(rows):
    def q(key):
        v = np.array([r[key] for r in rows])
        return {"mean": float(v.mean()), "median": float(np.median(v)),
                "p10": float(np.percentile(v, 10)), "p90": float(np.percentile(v, 90)),
                "min": float(v.min()), "max": float(v.max()), "std": float(v.std())}
    eer = np.array([r["eer"] for r in rows])
    return {
        "nUsers": len(rows),
        "eer": q("eer"), "auc": q("auc"), "farAt050": q("farAt050"), "tarAt050": q("tarAt050"),
        "tarAtFar01": q("tarAtFar01"),
        "usersWorseThan10pctEer": int((eer > 0.10).sum()),
        "usersWorseThan20pctEer": int((eer > 0.20).sum()),
        "usersBetterThan5pctEer": int((eer < 0.05).sum()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--impostors", default="/app/data/keyrecs_impostors.h5")
    ap.add_argument("--out", default=None)
    ap.add_argument("--limit", type=int, default=0, help="run only the first N targets (pilot)")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--max-impostor", type=int, default=1500)
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    with h5py.File(args.impostors, "r") as f:
        windows = np.asarray(f["windows"], dtype=np.float32)
        pid = np.asarray(f["participant"])

    ids = np.sort(np.unique(pid))
    neg_pool = ids[:NEG_POOL_SIZE]
    imp_pool = ids[NEG_POOL_SIZE:NEG_POOL_SIZE + IMP_POOL_SIZE]
    targets = ids if not args.limit else ids[:args.limit]

    print(f"{len(ids)} participants | neg pool {len(neg_pool)} | impostor pool {len(imp_pool)} "
          f"| targets {len(targets)}")
    print("pools are disjoint; the target is removed from both\n")
    print("  target   enrol  held  EER      AUC     FAR@.5  TAR@.5   secs")

    scaler = get_scaler()
    rows, t0 = [], time.time()
    for n, tid in enumerate(targets, 1):
        ts = time.time()
        r = run_target(tid, windows, pid, neg_pool, imp_pool, scaler,
                       np.random.default_rng(1000 + int(tid)), args.epochs, args.max_impostor)
        if r is None:
            print(f"  {tid:<8} skipped (too few windows)")
            continue
        rows.append(r)
        print(f"  {tid:<8} {r['nEnrol']:>5} {r['nHeldOut']:>5}  {r['eer']:6.2%}  {r['auc']:.3f}  "
              f"{r['farAt050']:6.2%}  {r['tarAt050']:6.2%}  {time.time()-ts:5.1f}")
        sys.stdout.flush()
        if args.out and n % 5 == 0:
            with open(args.out, "w") as f:
                json.dump({"perUser": rows, "summary": summarise(rows), "partial": True}, f, indent=2)

    s = summarise(rows)
    print(f"\n  {len(rows)} users in {(time.time()-t0)/60:.1f} min\n")
    print("  PER-USER EER DISTRIBUTION (the number a deployment actually faces)")
    print(f"    median {s['eer']['median']:.2%}   mean {s['eer']['mean']:.2%}   "
          f"sd {s['eer']['std']:.2%}")
    print(f"    p10 {s['eer']['p10']:.2%}  ..  p90 {s['eer']['p90']:.2%}   "
          f"(best {s['eer']['min']:.2%}, worst {s['eer']['max']:.2%})")
    print(f"    users above 10% EER: {s['usersWorseThan10pctEer']}/{s['nUsers']}   "
          f"above 20%: {s['usersWorseThan20pctEer']}   below 5%: {s['usersBetterThan5pctEer']}")
    print(f"\n  AT THE LIVE THRESHOLD 0.50")
    print(f"    FAR median {s['farAt050']['median']:.2%}  (p90 {s['farAt050']['p90']:.2%})")
    print(f"    TAR median {s['tarAt050']['median']:.2%}  (p10 {s['tarAt050']['p10']:.2%})")

    if args.out:
        with open(args.out, "w") as f:
            json.dump({"protocol": {
                "positiveSplit": f"temporal, {ENROL_FRAC:.0%} enrol / rest held out, "
                                 f"{OVERLAP_GAP}-window gap at every boundary",
                "negPool": [int(x) for x in neg_pool], "impPool": [int(x) for x in imp_pool],
                "poolsDisjoint": True, "baseModel": BASE_MODEL,
                "recipe": "transfer from 2-class base, Conv1D frozen, Adam 3e-4, batch 16, "
                          f"{args.epochs} epochs, EarlyStopping(patience=6, restore_best)",
            }, "perUser": rows, "summary": s}, f, indent=2)
        print("\nwrote", args.out)


if __name__ == "__main__":
    main()
