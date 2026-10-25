"""Experiment EC: the typing enrolment learning curve (artifacts/phase7/PREREGISTRATION_EC.md).

    python services/model-api/analysis/phase7/run_ec.py --shard 0/3 --threads 4      # and 1/3, 2/3
    python services/model-api/analysis/phase7/run_ec.py --smoke --limit 1 --sizes 12,130 --epochs 2

For every KeyRecs target and enrolment size M: run_ks.run_target for arm A200, line for line, except that the model
learns from the first M windows of the owner's enrolment block and the positives are split for validation by the live
service's rule (api._contiguous_split: the last 20%, five windows dropped before them). Held-out windows, impostors,
negatives, recipe and seeds are KS's. One JSON per target and size under artifacts/phase7/ec/parts/<M>/; a finished
target is never trained again (a crash leaves no file).
"""
import argparse
import hashlib
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase3")))
import ks_common as KC  # noqa: E402

ROOT = KC.ROOT
OUT = os.path.join(ROOT, "artifacts", "phase7", "ec")
SIZES = ("12", "26", "52", "78", "130", "208", "all")
FROZEN = ["artifacts/phase7/PREREGISTRATION_EC.md",
          "services/model-api/analysis/phase7/run_ec.py",
          "services/model-api/analysis/phase7/analyze_ec.py"]
SHA_FILE = os.path.join(ROOT, "artifacts", "phase7", "PREREGISTRATION_EC.sha256")
VAL_FRACTION, GAP = 0.2, 5          # api.DEFAULT_VAL_FRACTION, api.DEFAULT_OVERLAP_GAP
ARM_SIZE = 200                      # KS arm A200


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def current_hashes():
    return {p: sha(os.path.join(ROOT, p)) for p in FROZEN}


def verify_frozen():
    want = json.load(open(SHA_FILE))
    got = current_hashes()
    bad = [p for p in FROZEN if want.get(p) != got[p]]
    if bad:
        raise SystemExit(f"frozen files differ from {SHA_FILE}: {bad}")
    return {"preregistrationEcSha256": got[FROZEN[0]]}


def live_split(n):
    """api._contiguous_split(n, 0.2, 5), copied: validation from the tail, `GAP` windows dropped before it."""
    n_val = int(round(n * VAL_FRACTION))
    if n < 2 or n_val < 1:
        return list(range(n)), []
    cut = n - n_val
    train = list(range(0, max(cut - GAP, 0)))
    if not train:
        train = list(range(0, cut))
    return train, list(range(cut, n))


def run_target(tid, size, K, kpid, NEG, npid, neg_pool, imp_pool, scaler, epochs):
    """run_ks.run_target (arm A200) with the enrolment cut to its first M windows and the live validation split."""
    import tensorflow as tf
    from tensorflow.keras.callbacks import EarlyStopping
    sys.path.insert(0, KC.MODEL_API)
    from population_sweep import ENROL_FRAC, PACKET_RUN_LEN, build_model, scale, split_with_gap
    rng = np.random.default_rng(1000 + int(tid))
    tf.keras.utils.set_random_seed(1000 + int(tid))

    own = K[kpid == tid]
    enrol_idx, test_idx = split_with_gap(len(own), ENROL_FRAC)
    if len(enrol_idx) < 40 or len(test_idx) < 20:
        return None
    enrol, held_out = own[enrol_idx], own[test_idx]
    m = len(enrol) if size == "all" else min(int(size), len(enrol))
    sub = enrol[:m]
    tr_idx, va_idx = live_split(m)
    pos_tr, pos_va = sub[tr_idx], sub[va_idx]

    neg_parts = np.array([int(p) for p in neg_pool])
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
        raise SystemExit(f"target {tid} size {size}: non-finite scores (technical failure: re-run, log it)")
    return {"participant": int(tid), "size": size, "nEnrolBlock": int(len(enrol)), "nUsed": int(m),
            "truncatedToBlock": bool(size != "all" and int(size) > len(enrol)),
            "nTrain": int(len(pos_tr)), "nVal": int(len(pos_va)), "nHeldOut": int(len(held_out)),
            "nNegTrain": int(len(neg_tr)), "epochsRun": len(hist.history["loss"]),
            "genuine": [float(v) for v in g], "runs": runs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", default="0/1", help="i/n: this process trains targets i, i+n, i+2n ...")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--sizes", default=",".join(SIZES))
    ap.add_argument("--smoke", action="store_true", help="SMOKE TEST ONLY: skips the freeze check")
    ap.add_argument("--limit", type=int, default=0, help="SMOKE TEST ONLY: first N targets")
    ap.add_argument("--epochs", type=int, default=KC.EPOCHS, help="30 (frozen); smoke tests may lower it")
    a = ap.parse_args()
    sizes = tuple(s.strip() for s in a.sizes.split(","))
    if (a.limit or a.epochs != KC.EPOCHS or sizes != SIZES) and not a.smoke:
        raise SystemExit("--limit, --epochs and --sizes are for smoke tests only")
    if set(sizes) - set(SIZES):
        raise SystemExit(f"unknown sizes {sorted(set(sizes) - set(SIZES))}")
    hashes = {} if a.smoke else verify_frozen()
    i, n = (int(x) for x in a.shard.split("/"))

    import tensorflow as tf
    if a.threads:
        tf.config.threading.set_intra_op_parallelism_threads(a.threads)
    tf.config.experimental.enable_op_determinism()

    K, kpid = KC.load_h5(KC.KEYRECS)
    ids, _keyrecs_neg, imp_pool = KC.keyrecs_pools(kpid)
    manifest = json.load(open(os.path.join(KC.STUDY, "aalto_pool_ks.json")))
    pool_h5 = os.path.join(ROOT, manifest["poolH5"])
    if sha(pool_h5) != manifest["poolH5Sha256"]:
        raise SystemExit(f"{pool_h5} differs from its manifest")
    PW, PP = KC.load_h5(pool_h5)
    neg_pool = [int(x) for x in manifest["kept"]][:ARM_SIZE]
    m = np.isin(PP, neg_pool)
    NEG, npid = PW[m], PP[m]
    scaler = KC.load_scaler()
    targets = (ids[:a.limit] if a.limit else ids)[i::n]
    folder = os.path.join(OUT, "smoke" if a.smoke else "parts")
    print(f"[EC] shard {i}/{n}: {len(targets)} targets, sizes {sizes}, {len(neg_pool)} Aalto negative people", flush=True)
    t0 = time.time()
    for size in sizes:
        out_dir = os.path.join(folder, size)
        os.makedirs(out_dir, exist_ok=True)
        for tid in targets:
            path = os.path.join(out_dir, f"{int(tid)}.json")
            if os.path.exists(path) and not a.smoke:
                continue
            r = run_target(int(tid), size, K, kpid, NEG, npid, neg_pool, imp_pool, scaler, a.epochs)
            rec = {**hashes, "smokeTest": a.smoke, "arm": "A200", "eligible": r is not None, **(r or {"participant": int(tid), "size": size})}
            KC.write_json(path, rec)
            if r:
                print(f"  M={size:>4} target {int(tid):>3}: used {r['nUsed']:3d} (train {r['nTrain']:3d}, val {r['nVal']:2d}) "
                      f"neg {r['nNegTrain']:3d}, {r['epochsRun']} epochs, {(time.time() - t0) / 60:.1f} min", flush=True)
    print(f"[EC] shard {i}/{n} done in {(time.time() - t0) / 60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
