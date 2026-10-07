"""Experiment KS: per-user Lu training with four negative sources (PREREGISTRATION_KS.md section 3).

    python run_ks.py --arm REF --threads 8      # then A40, A200, A1000 (or --arm all)

For every KeyRecs target and arm: population_sweep.py's recipe, line for line (temporal 70/30
split with a 5-window gap, validation from the end of the enrol block, negatives = 2 x the positive
windows (at least 60) drawn from the arm's pool, validation negatives split by participant, transfer
from the ws50-gru-v2 base with Conv1D frozen, Adam 3e-4, batch 16, 30 epochs, EarlyStopping patience
6 with the best weights restored). The only difference between arms is the negative pool. The target
is scored on its held-out 30% and on the first 150 windows of each KeyRecs impostor (ids[40:80]).
Seeds: numpy default_rng(1000 + target) as the baseline, and TensorFlow set_random_seed(1000 + target)
with op determinism. One JSON per target and arm under artifacts/phase3/parts/<arm>/; a finished
target is never trained again (a crash leaves no file).
"""
import argparse
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ks_common as KC  # noqa: E402


def negatives_for(arm, K, kpid, keyrecs_neg, pool, smoke):
    """(windows, participant ids, ordered pool, source) for one arm."""
    if arm == "REF":
        return K, kpid, [int(p) for p in keyrecs_neg], "keyrecs"
    size = KC.POOL_SIZES[arm]
    W, P, kept = pool
    ids = kept[:size]
    m = np.isin(P, ids)
    return W[m], P[m], ids, "aalto"


def run_target(tid, K, kpid, NEG, npid, neg_pool, source, imp_pool, scaler, epochs):
    """population_sweep.run_target with the negatives taken from (NEG, npid, neg_pool)."""
    import tensorflow as tf
    from tensorflow.keras.callbacks import EarlyStopping
    from population_sweep import ENROL_FRAC, PACKET_RUN_LEN, VAL_FRAC, build_model, scale, split_with_gap
    rng = np.random.default_rng(1000 + int(tid))
    tf.keras.utils.set_random_seed(1000 + int(tid))

    own = K[kpid == tid]
    enrol_idx, test_idx = split_with_gap(len(own), ENROL_FRAC)
    if len(enrol_idx) < 40 or len(test_idx) < 20:
        return None
    enrol, held_out = own[enrol_idx], own[test_idx]
    tr_idx, va_idx = split_with_gap(len(enrol), 1.0 - VAL_FRAC)
    pos_tr, pos_va = enrol[tr_idx], enrol[va_idx]

    # the target is removed from its own pool only when the pool is KeyRecs (Aalto ids are another namespace)
    neg_parts = np.array([p for p in neg_pool if not (source == "keyrecs" and p == tid)])
    n_va = max(4, len(neg_parts) // 5)
    va_parts, tr_parts = neg_parts[:n_va], neg_parts[n_va:]
    want = max(len(pos_tr) * 2, 60)
    neg_tr_all = NEG[np.isin(npid, tr_parts)]
    neg_va_all = NEG[np.isin(npid, va_parts)]
    neg_tr = neg_tr_all[rng.choice(len(neg_tr_all), min(want, len(neg_tr_all)), replace=False)]
    neg_va = neg_va_all[rng.choice(len(neg_va_all), min(max(len(pos_va) * 2, 30), len(neg_va_all)), replace=False)]

    X_tr = scale(np.concatenate([pos_tr, neg_tr]), scaler)
    y_tr = np.concatenate([np.ones(len(pos_tr)), np.zeros(len(neg_tr))]).astype(np.int64)
    X_va = scale(np.concatenate([pos_va, neg_va]), scaler)
    y_va = np.concatenate([np.ones(len(pos_va)), np.zeros(len(neg_va))]).astype(np.int64)
    sh = rng.permutation(len(X_tr))
    X_tr, y_tr = X_tr[sh], y_tr[sh]

    model = build_model(K.shape[1:])
    hist = model.fit(X_tr, y_tr, validation_data=(X_va, y_va), epochs=epochs, batch_size=16, verbose=0,
                     callbacks=[EarlyStopping(patience=6, restore_best_weights=True, monitor="val_loss")])

    g = model.predict(scale(held_out, scaler), batch_size=256, verbose=0)[:, 1]
    runs = {}
    for part in imp_pool:
        if part == tid:
            continue
        block = K[kpid == part][:PACKET_RUN_LEN]
        if len(block) >= 8:
            runs[str(int(part))] = [float(v) for v in model.predict(scale(block, scaler), batch_size=256, verbose=0)[:, 1]]
    tf.keras.backend.clear_session()
    if not (np.isfinite(g).all() and all(np.isfinite(v).all() for v in runs.values())):
        raise SystemExit(f"target {tid}: non-finite scores (technical failure: re-run, log it)")
    return {"participant": int(tid), "nEnrol": int(len(pos_tr)), "nHeldOut": int(len(held_out)),
            "nNegTrain": int(len(neg_tr)), "negPeopleTrain": int(len(tr_parts)), "negPeopleVal": int(len(va_parts)),
            "epochsRun": len(hist.history["loss"]), "genuine": [float(v) for v in g], "runs": runs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", choices=list(KC.ARMS) + ["all"], required=True)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--smoke", action="store_true", help="SMOKE TEST ONLY: skips the freeze check")
    ap.add_argument("--keyrecs", default=KC.KEYRECS)
    ap.add_argument("--limit", type=int, default=0, help="SMOKE TEST ONLY: first N targets")
    ap.add_argument("--epochs", type=int, default=KC.EPOCHS, help="30 (frozen); smoke tests may lower it")
    a = ap.parse_args()
    if (a.limit or a.epochs != KC.EPOCHS or a.keyrecs != KC.KEYRECS) and not a.smoke:
        raise SystemExit("--limit, --epochs and --keyrecs are for smoke tests only")
    hashes = {} if a.smoke else KC.verify_frozen()

    import tensorflow as tf
    if a.threads:
        tf.config.threading.set_intra_op_parallelism_threads(a.threads)
    tf.config.experimental.enable_op_determinism()

    K, kpid = KC.load_h5(a.keyrecs)
    ids, keyrecs_neg, imp_pool = KC.keyrecs_pools(kpid)
    folder = KC.SMOKE if a.smoke else KC.STUDY
    manifest = KC.json.load(open(os.path.join(folder, "aalto_pool_ks.json")))
    if bool(manifest.get("smokeTest")) != a.smoke:
        raise SystemExit("the Aalto pool's smokeTest flag does not fit this run")
    pool_h5 = os.path.join(KC.ROOT, manifest["poolH5"])
    if KC.sha(pool_h5) != manifest["poolH5Sha256"]:
        raise SystemExit(f"{pool_h5} differs from its manifest")
    PW, PP = KC.load_h5(pool_h5)
    pool = (PW, PP, [int(x) for x in manifest["kept"]])
    scaler = KC.load_scaler()
    targets = ids[:a.limit] if a.limit else ids
    arms = KC.ARMS if a.arm == "all" else (a.arm,)
    for arm in arms:
        NEG, npid, neg_pool, source = negatives_for(arm, K, kpid, keyrecs_neg, pool, a.smoke)
        out_dir = os.path.join(folder, "parts", arm)
        os.makedirs(out_dir, exist_ok=True)
        print(f"[KS] arm {arm}: {len(neg_pool)} negative people ({source}), {len(targets)} targets", flush=True)
        t0 = time.time()
        for tid in targets:
            path = os.path.join(out_dir, f"{int(tid)}.json")
            if os.path.exists(path) and not a.smoke:
                continue
            r = run_target(int(tid), K, kpid, NEG, npid, neg_pool, source, imp_pool, scaler, a.epochs)
            rec = {**hashes, "smokeTest": a.smoke, "arm": arm, "negSource": source, "negPoolSize": len(neg_pool),
                   "eligible": r is not None, **(r or {"participant": int(tid)})}
            KC.write_json(path, rec)
            if r:
                print(f"  {arm} {int(tid):>4}: enrol {r['nEnrol']:4d} held {r['nHeldOut']:4d} "
                      f"neg {r['nNegTrain']:4d} from {r['negPeopleTrain']} people, {r['epochsRun']} epochs", flush=True)
        print(f"[KS] arm {arm} done in {(time.time() - t0) / 60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
