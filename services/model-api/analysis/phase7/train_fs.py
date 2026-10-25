"""Experiment FS, step 1: the base-80 FCN trained with SapiMouse's settings (artifacts/phase7/PREREGISTRATION_FS.md).

    python services/model-api/analysis/phase7/train_fs.py --threads 6
    python services/model-api/analysis/phase7/train_fs.py --smoke --epochs 1     # SMOKE TEST ONLY

The data, split, scaler, architecture and seed are train_mouse_fcn.py's as used for artifacts/mouse-fcn-a5-j80
(--holdout artifacts/protocol_j/exclude_j40.json): the 80 base users, each one's three-minute session split 80/20 by
steps into training and validation windows (A5, 50 steps, stride 10), FeatureScaler fitted on the training windows,
the FCN (arm B6), seed 101. Only the training recipe is SapiMouse's (e_native_blocks.train_base_sapimouse): Adam 1e-4,
batch 16, 100 epochs, ReduceLROnPlateau(val_loss, 0.5, 50, min 1e-6) and the weights with the lowest validation loss.
No negatives file is written (the cohort and heads use the stored base-80 windows in score_fs.py).
"""
import argparse
import glob
import hashlib
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MA = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, MA)
from repr_arch_study import build, raw_steps, windows, _read_events, FeatureScaler, REPRESENTATIONS, WS, STRIDE  # noqa: E402

ROOT = "/app"
OUT = os.path.join(ROOT, "artifacts", "phase7", "fs")
NET = os.path.join(OUT, "fcn_sapimouse_j80")
REF = os.path.join(ROOT, "artifacts", "mouse-fcn-a5-j80")
HOLDOUT = os.path.join(ROOT, "artifacts", "protocol_j", "exclude_j40.json")
DATA_DIR = "/app/data/sapimouse"
ARCH, REP, FREEZE, SEED = "B6", "A5", ["conv1", "bn1"], 101
SM_LR, SM_BATCH, SM_EPOCHS, SM_PLATEAU = 1e-4, 16, 100, 50
FROZEN = ["artifacts/phase7/PREREGISTRATION_FS.md",
          "services/model-api/analysis/phase7/train_fs.py",
          "services/model-api/analysis/phase7/score_fs.py"]
SHA_FILE = os.path.join(ROOT, "artifacts", "phase7", "PREREGISTRATION_FS.sha256")


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def verify_frozen():
    want = json.load(open(SHA_FILE))
    got = {p: sha(os.path.join(ROOT, p)) for p in FROZEN}
    bad = [p for p in FROZEN if want.get(p) != got[p]]
    if bad:
        raise SystemExit(f"frozen files differ from {SHA_FILE}: {bad}")
    return {"preregistrationFsSha256": got[FROZEN[0]]}


def load_data():
    """train_mouse_fcn.py's data block, unchanged."""
    holdout = json.load(open(HOLDOUT))["holdout_users"]
    uids = sorted((os.path.basename(d) for d in glob.glob(os.path.join(DATA_DIR, "user*"))), key=lambda u: int(u[4:]))
    base_users = [u for u in uids if u not in holdout]

    def sessions(u):
        cs = sorted(glob.glob(os.path.join(DATA_DIR, u, "*.csv")))
        lo = [c for c in cs if "3min" in os.path.basename(c)]
        sh = [c for c in cs if "1min" in os.path.basename(c)]
        return (lo[0] if lo else None), (sh[0] if sh else None)

    Xtr, ytr, Xva, yva, Xte, yte = [], [], [], [], [], []
    for ci, u in enumerate(base_users):
        lo, sh = sessions(u)
        if not lo or not sh:
            continue
        R = raw_steps(_read_events(lo))
        cut = int(len(R) * 0.8)
        a, b = windows(R, 1.0, REP, 0, cut), windows(R, 1.0, REP, cut, None)
        Xtr.append(a); ytr += [ci] * len(a); Xva.append(b); yva += [ci] * len(b)
        c = windows(raw_steps(_read_events(sh)), 1.0, REP)
        Xte.append(c); yte += [ci] * len(c)
    Xtr, Xva, Xte = np.concatenate(Xtr), np.concatenate(Xva), np.concatenate(Xte)
    remap = {c: i for i, c in enumerate(sorted(set(ytr)))}
    ytr = np.asarray([remap[c] for c in ytr]); yva = np.asarray([remap[c] for c in yva])
    yte = np.asarray([remap.get(c, -1) for c in yte])
    return base_users, Xtr, ytr, Xva, yva, Xte, yte, remap


def train_sapimouse(Xtr, ytr, Xva, yva, n_cls, epochs):
    """e_native_blocks.train_base_sapimouse, on the windows: SapiMouse's recipe, the same build and seed call as
    repr_arch_study.train_base, so both networks start from the same initial weights."""
    import tensorflow as tf
    from tensorflow.keras.callbacks import Callback, ReduceLROnPlateau
    from tensorflow.keras.optimizers import Adam
    tf.keras.utils.set_random_seed(SEED)
    m = build(ARCH, Xtr.shape[1:], n_cls)
    m.compile(optimizer=Adam(learning_rate=SM_LR), loss="sparse_categorical_crossentropy", metrics=["accuracy"])

    class KeepBest(Callback):
        def __init__(self):
            super().__init__()
            self.best, self.epoch, self.weights = np.inf, -1, None

        def on_epoch_end(self, epoch, logs=None):
            v = (logs or {}).get("val_loss", np.inf)
            if v < self.best:
                self.best, self.epoch, self.weights = v, epoch, self.model.get_weights()

    keep = KeepBest()
    h = m.fit(Xtr, ytr, validation_data=(Xva, yva), epochs=epochs, batch_size=SM_BATCH, verbose=2,
              callbacks=[ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=SM_PLATEAU, min_lr=1e-6), keep])
    m.set_weights(keep.weights)
    return m, {k: [float(x) for x in v] for k, v in h.history.items()}, keep.epoch + 1, float(keep.best)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=6)
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--epochs", type=int, default=SM_EPOCHS)
    a = ap.parse_args()
    if a.epochs != SM_EPOCHS and not a.smoke:
        raise SystemExit("--epochs is for smoke tests only")
    hashes = {} if a.smoke else verify_frozen()
    import tensorflow as tf
    tf.config.threading.set_intra_op_parallelism_threads(a.threads)
    net = os.path.join(OUT, "smoke_net") if a.smoke else NET
    if os.path.exists(os.path.join(net, "results.json")) and not a.smoke:
        raise SystemExit(f"{net} exists already; FS trains once")
    os.makedirs(net, exist_ok=True)

    base_users, Xtr, ytr, Xva, yva, Xte, yte, remap = load_data()
    scaler = FeatureScaler.fit(Xtr)
    scaler.save(os.path.join(net, "scaler.json"))
    mine, ref = json.load(open(os.path.join(net, "scaler.json"))), json.load(open(os.path.join(REF, "scaler.json")))
    same = all(np.allclose(np.asarray(mine[k], float), np.asarray(ref[k], float), rtol=0, atol=1e-9) for k in ("mean", "std"))
    if not same:
        raise SystemExit("the scaler differs from the reference base-80 scaler: not the same training windows")
    print(f"base users {len(base_users)} | train {Xtr.shape} val {Xva.shape} test {Xte.shape} | scaler = reference", flush=True)

    t0 = time.time()
    model, hist, best_epoch, best_val = train_sapimouse(scaler.transform(Xtr), ytr, scaler.transform(Xva), yva, len(remap), a.epochs)
    ok = yte >= 0
    top1 = float((model.predict(scaler.transform(Xte[ok]), batch_size=1024, verbose=0).argmax(1) == yte[ok]).mean())
    model.save(os.path.join(net, "final_model"))
    json.dump({"arch": "fcn", "study_arm": ARCH, "representation": REP, "representation_desc": REPRESENTATIONS[REP][0],
               "window": WS, "stride": STRIDE, "freeze": FREEZE, "embedding_layer": "embedding"},
              open(os.path.join(net, "arch.json"), "w"), indent=1)
    json.dump({**hashes, "smokeTest": a.smoke, "identificationTop1": top1, "classes": len(remap), "seed": SEED,
               "epochsRun": len(hist.get("loss", [])), "bestEpoch": best_epoch, "bestValLoss": best_val,
               "trainWindows": int(len(Xtr)), "valWindows": int(len(Xva)), "minutes": (time.time() - t0) / 60,
               "recipe": {"optimizer": "Adam", "learningRate": SM_LR, "batch": SM_BATCH, "epochs": a.epochs,
                          "plateau": SM_PLATEAU, "weights": "lowest validation loss"},
               "history": hist}, open(os.path.join(net, "results.json"), "w"), indent=1)
    print(f"trained {len(hist.get('loss', []))} epochs (best {best_epoch}) in {(time.time() - t0) / 60:.1f} min | "
          f"identification top-1 {top1:.4f} (reference base-80: {json.load(open(os.path.join(REF, 'results.json')))['identificationTop1']:.4f})", flush=True)


if __name__ == "__main__":
    main()
