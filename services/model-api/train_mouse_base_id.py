"""
Train the mouse-dynamics base model as USER IDENTIFICATION (N-way softmax).

Why: the previous pooled-binary construction (preprocess_mouse.py build()) is
contradictory — every user's windows appear with label 1 in their own block
and label 0 when sampled as negatives for other users, so the global
window→label mapping is unlearnable and both training runs landed at chance.
Identification over base users is a consistent task and is the standard way
to learn transferable behavioral features (cf. SapiMouse, TypeNet); per-user
verification then fine-tunes from these features exactly as before.

Splits (leakage-safe):
  * 20 users (seeded random) are HELD OUT entirely → enrollment experiments.
  * For the remaining base users: the 3-min session is split temporally
    80/20 into train/val segments (windows built per segment, so no window
    spans the cut); the 1-min session is the TEST set (different session,
    zero window overlap with training).

Export for the existing pipeline: api.py /api/user/train loads the base file
as-is, freezes layers[0] (Conv1D) and fine-tunes the rest with a Dense(2)
head. So after identification training we transplant the Conv1D + both GRU
weights into a fresh num_classes=2 model and save THAT to --output-dir. The
binary head is untrained (it is always trained during per-user fine-tuning);
the transferable value is in the Conv/GRU features.

Outputs in --output-dir: best_model.h5 (binary-head export), final_model/,
scaler.json, results.json (identification metrics + export provenance),
holdout_users.json.
"""
import argparse
import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tensorflow.keras.callbacks import EarlyStopping, ModelCheckpoint, ReduceLROnPlateau  # noqa: E402
from model import build_1d_cnn_2rnn, LEGACY_NETWORK  # noqa: E402
from preprocessing import FeatureScaler  # noqa: E402
from preprocess_mouse import events_to_steps, steps_to_windows, _read_events  # noqa: E402


def session_windows(csv_path, window_size, stride):
    return steps_to_windows(events_to_steps(_read_events(csv_path)), window_size, stride)


def augment_windows(X, y, rng, n_aug, jitter, scale_lo, scale_hi):
    """Behavioral augmentation for mouse windows (applied in SCALED feature space).
    Each copy gets (a) a per-window magnitude scale — simulates the same gesture
    performed a little faster/slower or at a different DPI — and (b) light Gaussian
    jitter. Grows the effective training set so the Conv/GRU features generalize
    (esp. for users the base separates poorly), without changing the architecture."""
    if n_aug <= 0:
        return X, y
    parts_x, parts_y = [X], [y]
    for _ in range(n_aug):
        s = rng.uniform(scale_lo, scale_hi, size=(len(X), 1, 1)).astype(np.float32)
        Xa = X * s + rng.normal(0.0, jitter, size=X.shape).astype(np.float32)
        parts_x.append(Xa.astype(np.float32)); parts_y.append(y)
    return np.concatenate(parts_x, 0), np.concatenate(parts_y, 0)


def split_session_temporal(csv_path, window_size, stride, train_frac=0.8):
    """Split one session's steps temporally, then window each part separately
    so no window crosses the boundary (prevents overlap leakage)."""
    steps = events_to_steps(_read_events(csv_path))
    cut = int(len(steps) * train_frac)
    head = steps_to_windows(steps[:cut], window_size, stride)
    tail = steps_to_windows(steps[cut:], window_size, stride)
    return head, tail


def main(args):
    rng = np.random.default_rng(args.seed)
    user_dirs = sorted(
        glob.glob(os.path.join(args.data_dir, "user*")),
        key=lambda p: int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0),
    )
    uids = [os.path.basename(d) for d in user_dirs]
    holdout = sorted(rng.choice(uids, size=args.holdout_users, replace=False).tolist(),
                     key=lambda u: int("".join(c for c in u if c.isdigit())))
    base_users = [u for u in uids if u not in holdout]
    print(f"users={len(uids)}  base={len(base_users)}  holdout={len(holdout)}")

    os.makedirs(args.output_dir, exist_ok=True)
    with open(os.path.join(args.output_dir, "holdout_users.json"), "w") as f:
        json.dump({"seed": args.seed, "holdout_users": holdout}, f, indent=2)

    Xtr, ytr, Xva, yva, Xte, yte = [], [], [], [], [], []
    for ci, uid in enumerate(base_users):
        udir = os.path.join(args.data_dir, uid)
        csvs = sorted(glob.glob(os.path.join(udir, "*.csv")))
        long_s = [c for c in csvs if "3min" in os.path.basename(c)]
        short_s = [c for c in csvs if "1min" in os.path.basename(c)]
        if not long_s or not short_s:
            print(f"  skip {uid}: sessions found {os.path.basename(' '.join(csvs))}")
            continue
        head, tail = split_session_temporal(long_s[0], args.window_size, args.stride)
        test = session_windows(short_s[0], args.window_size, args.stride)
        Xtr.extend(head); ytr.extend([ci] * len(head))
        Xva.extend(tail); yva.extend([ci] * len(tail))
        Xte.extend(test); yte.extend([ci] * len(test))

    num_classes = len(base_users)
    Xtr = np.asarray(Xtr, np.float32); ytr = np.asarray(ytr, np.int64)
    Xva = np.asarray(Xva, np.float32); yva = np.asarray(yva, np.int64)
    Xte = np.asarray(Xte, np.float32); yte = np.asarray(yte, np.int64)
    print(f"train={Xtr.shape} val={Xva.shape} test={Xte.shape} classes={num_classes}")

    scaler = FeatureScaler.fit(Xtr)
    Xtr = scaler.transform(Xtr); Xva = scaler.transform(Xva); Xte = scaler.transform(Xte)
    scaler.save(os.path.join(args.output_dir, "scaler.json"))

    # Augment TRAIN only (val/test stay clean) to strengthen the feature extractor.
    if args.augment > 0:
        rng_aug = np.random.default_rng(args.seed + 1)
        before = len(Xtr)
        Xtr, ytr = augment_windows(Xtr, ytr, rng_aug, args.augment, args.jitter, args.scale_lo, args.scale_hi)
        # reshuffle so augmented copies aren't grouped
        perm = rng_aug.permutation(len(Xtr)); Xtr = Xtr[perm]; ytr = ytr[perm]
        print(f"augment x{args.augment}: train {before} -> {len(Xtr)} windows (jitter={args.jitter}, scale=[{args.scale_lo},{args.scale_hi}])")

    model = build_1d_cnn_2rnn(Xtr.shape[1:], num_classes=num_classes, units=args.units, rnn_type="gru", **LEGACY_NETWORK)
    model.compile(optimizer="adam", loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    model.summary()
    id_ckpt = os.path.join(args.output_dir, "id_model.h5")
    history = model.fit(
        Xtr, ytr,
        validation_data=(Xva, yva),
        epochs=args.epochs,
        batch_size=args.batch_size,
        callbacks=[
            ModelCheckpoint(id_ckpt, save_best_only=True, monitor="val_loss", verbose=1),
            EarlyStopping(patience=12, monitor="val_loss", restore_best_weights=True, verbose=1),
            ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=5, min_lr=1e-5, verbose=1),
        ],
        verbose=2,
    )

    probs = model.predict(Xte, verbose=0)
    top1 = float((probs.argmax(1) == yte).mean())
    top5 = float(np.mean([y in row.argsort()[-5:] for row, y in zip(probs, yte)]))
    print(f"IDENTIFICATION  top1={top1:.4f}  top5={top5:.4f}  (chance={1/num_classes:.4f})")

    # Binary-head export for the per-user fine-tuning pipeline.
    export = build_1d_cnn_2rnn(Xtr.shape[1:], num_classes=2, units=args.units, rnn_type="gru", **LEGACY_NETWORK)
    for i, layer in enumerate(export.layers[:-1]):  # all but the Dense head
        w = model.layers[i].get_weights()
        if w and [a.shape for a in w] == [a.shape for a in layer.get_weights()]:
            layer.set_weights(w)
    export.compile(optimizer="adam", loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    export.save(os.path.join(args.output_dir, "best_model.h5"))
    export.save(os.path.join(args.output_dir, "final_model"))

    results = {
        "model": "mouse 1D CNN + 2GRU (identification base, binary-head export)",
        "dataset": "SapiMouse (Antal et al., 2021)",
        "task": f"{num_classes}-way user identification; 20 held-out users for enrollment experiments",
        "window_size": int(Xtr.shape[1]),
        "num_features": int(Xtr.shape[2]),
        "split": "train/val = 3-min session (temporal 80/20, no cross-boundary windows); test = 1-min session",
        "test_top1_accuracy": top1,
        "test_top5_accuracy": top5,
        "chance_level": 1.0 / num_classes,
        "training_epochs": len(history.history["loss"]),
        "train_size": int(len(Xtr)),
        "val_size": int(len(Xva)),
        "test_size": int(len(Xte)),
        "export_note": "best_model.h5/final_model carry Conv1D+GRU features with a fresh Dense(2) head; the head is trained during per-user fine-tuning (api.py freezes only Conv1D).",
        "previous_pooled_binary_attempt": "unlearnable by construction (same windows labeled 1 and 0); test acc was ~0.47 = chance",
    }
    with open(os.path.join(args.output_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=2)
    print(f"Saved export + results to {args.output_dir}")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Train SapiMouse identification base model")
    p.add_argument("--data-dir", default="data/sapimouse")
    p.add_argument("--output-dir", default="artifacts/mouse-ws50-gru")
    p.add_argument("--window-size", type=int, default=50)
    p.add_argument("--stride", type=int, default=10)
    p.add_argument("--holdout-users", type=int, default=20)
    p.add_argument("--epochs", type=int, default=40)
    p.add_argument("--batch-size", type=int, default=128)
    p.add_argument("--units", type=int, default=32)
    p.add_argument("--seed", type=int, default=13)
    # Behavioral augmentation (train only): number of extra copies + strength.
    p.add_argument("--augment", type=int, default=0)
    p.add_argument("--jitter", type=float, default=0.05)
    p.add_argument("--scale-lo", type=float, default=0.9)
    p.add_argument("--scale-hi", type=float, default=1.1)
    main(p.parse_args())
