"""Training time of the two personal typing models of experiment SC, measured on the same machine (owner, 23 Oct 2026:
"yes" to measuring seconds rather than inferring them from epochs).

Ten owners spread over the 99 (every tenth), both enrolment sizes. For each owner the two models are trained one after
the other in the same process, so load on the machine affects both alike:
  FT  the deployed recipe: the Buffalo base loaded, convolution frozen, up to 30 epochs, patience 6 (run_ec / EC);
  SC  the base's architecture with fresh weights, every layer trainable, up to 100 epochs, patience 10 (run_sc / SC).
Timed: building the model plus fitting it, the part a training job adds; data preparation and scoring are the same
for both and are not timed. Validity: with determinism on, each run's epochs must equal the stored EC and SC parts.

    python services/model-api/analysis/phase7/time_sc.py --threads 4     # artifacts/phase7/sc_timing.json / .txt
"""
import argparse
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
import run_sc as RS  # noqa: E402


def prepare(tid, size, K, kpid, NEG, npid, neg_pool):
    """The data of run_ec.run_target / run_sc.run_target, drawn with the same seeds."""
    import tensorflow as tf
    sys.path.insert(0, KC.MODEL_API)
    from population_sweep import ENROL_FRAC, scale, split_with_gap
    rng = np.random.default_rng(1000 + int(tid))
    tf.keras.utils.set_random_seed(1000 + int(tid))
    own = K[kpid == tid]
    enrol_idx, test_idx = split_with_gap(len(own), ENROL_FRAC)
    if len(enrol_idx) < 40 or len(test_idx) < 20:
        return None
    enrol = own[enrol_idx]
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
    scaler = KC.load_scaler()
    X_tr = scale(np.concatenate([pos_tr, neg_tr]), scaler)
    y_tr = np.concatenate([np.ones(len(pos_tr)), np.zeros(len(neg_tr))]).astype(np.int64)
    X_va = scale(np.concatenate([pos_va, neg_va]), scaler)
    y_va = np.concatenate([np.ones(len(pos_va)), np.zeros(len(neg_va))]).astype(np.int64)
    sh = rng.permutation(len(X_tr))
    return X_tr[sh], y_tr[sh], X_va, y_va


def timed_fit(kind, tid, size, data, shape):
    import tensorflow as tf
    from tensorflow.keras.callbacks import EarlyStopping
    sys.path.insert(0, KC.MODEL_API)
    from population_sweep import build_model
    X_tr, y_tr, X_va, y_va = data
    t0 = time.perf_counter()
    if kind == "FT":
        model, epochs, patience = build_model(shape), KC.EPOCHS, 6
    else:
        model, epochs, patience = RS.build_scratch(shape), RS.SC_EPOCHS, RS.SC_PATIENCE
    t_build = time.perf_counter() - t0
    hist = model.fit(X_tr, y_tr, validation_data=(X_va, y_va), epochs=epochs, batch_size=16, verbose=0,
                     callbacks=[EarlyStopping(patience=patience, restore_best_weights=True, monitor="val_loss")])
    total = time.perf_counter() - t0
    tf.keras.backend.clear_session()
    n = len(hist.history["loss"])
    return {"epochs": n, "buildSeconds": t_build, "totalSeconds": total, "secondsPerEpoch": (total - t_build) / n}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    import tensorflow as tf
    tf.config.threading.set_intra_op_parallelism_threads(a.threads)
    tf.config.experimental.enable_op_determinism()
    K, kpid = KC.load_h5(KC.KEYRECS)
    ids, _neg, _imp = KC.keyrecs_pools(kpid)
    manifest = json.load(open(os.path.join(KC.STUDY, "aalto_pool_ks.json")))
    PW, PP = KC.load_h5(os.path.join(R.ROOT, manifest["poolH5"]))
    neg_pool = [int(x) for x in manifest["kept"]][:R.ARM_SIZE]
    sel = np.isin(PP, neg_pool)
    NEG, npid = PW[sel], PP[sel]
    owners = [int(t) for t in ids[::10]]
    rows, mismatch = [], []
    for size in RS.SIZES:
        for tid in owners:
            data = prepare(tid, size, K, kpid, NEG, npid, neg_pool)
            if data is None:
                continue
            for kind in ("FT", "SC"):
                r = timed_fit(kind, tid, size, data, K.shape[1:])
                stored = os.path.join(R.ROOT, "artifacts", "phase7", "ec" if kind == "FT" else "sc", "parts", size, f"{tid}.json")
                want = json.load(open(stored))["epochsRun"]
                if want != r["epochs"]:
                    mismatch.append((kind, size, tid, want, r["epochs"]))
                rows.append({"kind": kind, "size": size, "owner": tid, **r, "storedEpochs": want})
                print(f"  {kind} M={size:>4} owner {tid:>3}: {r['epochs']:3d} epochs (stored {want}), "
                      f"{r['totalSeconds']:5.1f} s ({r['secondsPerEpoch']:.2f} s/epoch, build {r['buildSeconds']:.1f} s)", flush=True)
    summary = {}
    for size in RS.SIZES:
        for kind in ("FT", "SC"):
            rs = [x for x in rows if x["size"] == size and x["kind"] == kind]
            summary[f"{kind}_{size}"] = {k: float(np.mean([x[k] for x in rs])) for k in ("epochs", "totalSeconds", "secondsPerEpoch", "buildSeconds")}
        ft, sc = summary[f"FT_{size}"], summary[f"SC_{size}"]
        summary[f"ratio_{size}"] = sc["totalSeconds"] / ft["totalSeconds"]
    res = {"owners": owners, "threads": a.threads, "rows": rows, "summary": summary, "epochMismatches": mismatch}
    json.dump(res, open(os.path.join(R.ROOT, "artifacts", "phase7", "sc_timing.json"), "w"), indent=1)
    L = [f"SC TIMING: {len(owners)} owners (every tenth), same process, {a.threads} threads; epoch mismatches vs stored runs: {len(mismatch)}"]
    for size in RS.SIZES:
        ft, sc = summary[f"FT_{size}"], summary[f"SC_{size}"]
        L.append(f"M={size:>4}: FT {ft['totalSeconds']:.1f} s ({ft['epochs']:.1f} epochs, {ft['secondsPerEpoch']:.2f} s/epoch) | "
                 f"SC {sc['totalSeconds']:.1f} s ({sc['epochs']:.1f} epochs, {sc['secondsPerEpoch']:.2f} s/epoch) | "
                 f"SC takes {summary[f'ratio_{size}']:.2f}x as long")
    txt = "\n".join(L)
    open(os.path.join(R.ROOT, "artifacts", "phase7", "sc_timing.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
