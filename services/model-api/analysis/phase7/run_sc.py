"""Experiment SC: the personal typing model trained from scratch, as in [1], against the deployed fine-tuned base
(artifacts/phase7/PREREGISTRATION_SC.md).

    python services/model-api/analysis/phase7/run_sc.py --shard 0/10 --threads 4      # ... 9/10
    python services/model-api/analysis/phase7/run_sc.py --smoke --limit 1 --sizes 130 --epochs 2

run_ec.run_target line for line (same owners, splits, negatives, impostors and seeds), with ONE change: the model is the
base's architecture with fresh weights (clone_model, each layer's own initializer, seeded per owner) and every layer
trainable, trained for up to 100 epochs with patience 10. The fine-tuned arm is the stored EC parts at the same sizes.
One JSON per owner and size under artifacts/phase7/sc/parts/<M>/; a finished owner is never trained again.
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
sys.path.insert(0, HERE)
import ks_common as KC  # noqa: E402
import run_ec as R  # noqa: E402

ROOT = KC.ROOT
OUT = os.path.join(ROOT, "artifacts", "phase7", "sc")
SIZES = ("130", "all")
SC_EPOCHS, SC_PATIENCE = 100, 10
FROZEN = ["artifacts/phase7/PREREGISTRATION_SC.md",
          "services/model-api/analysis/phase7/run_sc.py",
          "services/model-api/analysis/phase7/analyze_sc.py"]
SHA_FILE = os.path.join(ROOT, "artifacts", "phase7", "PREREGISTRATION_SC.sha256")


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def verify_frozen():
    want = json.load(open(SHA_FILE))
    got = {p: sha(os.path.join(ROOT, p)) for p in FROZEN}
    bad = [p for p in FROZEN if want.get(p) != got[p]]
    if bad:
        raise SystemExit(f"frozen files differ from {SHA_FILE}: {bad}")
    return {"preregistrationScSha256": got[FROZEN[0]]}


def build_scratch(window_shape):
    """The base's architecture with fresh weights and every layer trainable; optimizer as population_sweep.build_model."""
    from tensorflow.keras.models import clone_model, load_model
    from tensorflow.keras.optimizers import Adam
    sys.path.insert(0, KC.MODEL_API)
    from population_sweep import BASE_MODEL
    base = load_model(BASE_MODEL)
    assert tuple(base.input_shape[1:]) == window_shape, f"base expects {base.input_shape[1:]}"
    m = clone_model(base)                      # new layers, weights drawn from each layer's initializer
    for layer in m.layers:
        layer.trainable = True
    m.compile(optimizer=Adam(learning_rate=3e-4), loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    same = [np.array_equal(a, b) for a, b in zip(base.get_weights(), m.get_weights()) if a.size > 1]
    if any(same):
        raise SystemExit("the scratch model shares weights with the base")
    return m


def run_target(tid, size, K, kpid, NEG, npid, neg_pool, imp_pool, scaler, epochs):
    """run_ec.run_target with the scratch model and its training budget; everything else identical."""
    import tensorflow as tf
    from tensorflow.keras.callbacks import EarlyStopping
    sys.path.insert(0, KC.MODEL_API)
    from population_sweep import ENROL_FRAC, PACKET_RUN_LEN, scale, split_with_gap
    rng = np.random.default_rng(1000 + int(tid))
    tf.keras.utils.set_random_seed(1000 + int(tid))

    own = K[kpid == tid]
    enrol_idx, test_idx = split_with_gap(len(own), ENROL_FRAC)
    if len(enrol_idx) < 40 or len(test_idx) < 20:
        return None
    enrol, held_out = own[enrol_idx], own[test_idx]
    m = len(enrol) if size == "all" else min(int(size), len(enrol))
    sub = enrol[:m]
    tr_idx, va_idx = R.live_split(m)
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

    t0 = time.time()
    model = build_scratch(K.shape[1:])
    hist = model.fit(X_tr, y_tr, validation_data=(X_va, y_va), epochs=epochs, batch_size=16, verbose=0,
                     callbacks=[EarlyStopping(patience=SC_PATIENCE, restore_best_weights=True, monitor="val_loss")])
    train_s = time.time() - t0

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
            "nNegTrain": int(len(neg_tr)), "epochsRun": len(hist.history["loss"]), "trainSeconds": round(train_s, 1),
            "genuine": [float(v) for v in g], "runs": runs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard", default="0/1", help="i/n: this process trains owners i, i+n, i+2n ...")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--sizes", default=",".join(SIZES))
    ap.add_argument("--smoke", action="store_true", help="SMOKE TEST ONLY: skips the freeze check")
    ap.add_argument("--limit", type=int, default=0, help="SMOKE TEST ONLY: first N owners")
    ap.add_argument("--epochs", type=int, default=SC_EPOCHS, help="100 (frozen); smoke tests may lower it")
    a = ap.parse_args()
    sizes = tuple(s.strip() for s in a.sizes.split(","))
    if (a.limit or a.epochs != SC_EPOCHS or sizes != SIZES) and not a.smoke:
        raise SystemExit("--limit, --epochs and --sizes are for smoke tests only")
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
    neg_pool = [int(x) for x in manifest["kept"]][:R.ARM_SIZE]
    sel = np.isin(PP, neg_pool)
    NEG, npid = PW[sel], PP[sel]
    scaler = KC.load_scaler()
    targets = (ids[:a.limit] if a.limit else ids)[i::n]
    folder = os.path.join(OUT, "smoke" if a.smoke else "parts")
    print(f"[SC] shard {i}/{n}: {len(targets)} owners, sizes {sizes}, scratch model, up to {a.epochs} epochs", flush=True)
    t0 = time.time()
    for size in sizes:
        out_dir = os.path.join(folder, size)
        os.makedirs(out_dir, exist_ok=True)
        for tid in targets:
            path = os.path.join(out_dir, f"{int(tid)}.json")
            if os.path.exists(path) and not a.smoke:
                continue
            r = run_target(int(tid), size, K, kpid, NEG, npid, neg_pool, imp_pool, scaler, a.epochs)
            rec = {**hashes, "smokeTest": a.smoke, "arm": "SC", "eligible": r is not None, **(r or {"participant": int(tid), "size": size})}
            KC.write_json(path, rec)
            if r:
                print(f"  M={size:>4} owner {int(tid):>3}: train {r['nTrain']:3d}, {r['epochsRun']} epochs, "
                      f"{r['trainSeconds']:.0f} s, {(time.time() - t0) / 60:.1f} min", flush=True)
    print(f"[SC] shard {i}/{n} done in {(time.time() - t0) / 60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
