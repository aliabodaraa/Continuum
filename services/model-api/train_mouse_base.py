"""
Train the GLOBAL mouse-dynamics base model from the SapiMouse dataset — as a
USER-IDENTIFICATION feature extractor.

Why not genuine/impostor: preprocess_mouse.py pools all 120 users into a single
anchor-free genuine-vs-impostor set, where the same motion carries both labels
depending on which user's block it lands in. That is unlearnable by a plain
window classifier (measured EER ~0.51, AUC ~0.48). "Genuine vs impostor" only
means something relative to a specific reference identity.

The correct pre-training task is closed-set IDENTIFICATION: given a window,
predict WHICH of the N users produced it. This is genuinely learnable (mouse
dynamics identify people), and it forces the Conv1D + GRU stack to learn general,
discriminative mouse-motion features. Per-user enrollment then transfers that
frozen feature extractor and trains a fresh binary (genuine/impostor) head
(see api.py). Output: artifacts/mouse-ws50-base/{final_model, scaler.json,
results.json}.

We take only the GENUINE windows from Mouse_WS50.h5 (label == 1); their `groups`
value is the producing user's index, which becomes the identification label.
Split is per-window stratified (every user must appear in train AND test for a
closed-set task) — NOT group-aware.
"""
import argparse
import os
import json

import numpy as np
import h5py
from sklearn.model_selection import train_test_split
from tensorflow.keras.callbacks import ModelCheckpoint, EarlyStopping, ReduceLROnPlateau

from model import build_1d_cnn_2rnn, LEGACY_NETWORK
from preprocessing import FeatureScaler


def main(args):
    print("[1/5] Loading SapiMouse windows...")
    with h5py.File(args.data, "r") as f:
        X = np.array(f["train_data"], dtype=np.float32)
        y = np.array(f["train_labels"]).reshape(-1).astype(np.int64)
        groups = np.array(f["groups"]).reshape(-1).astype(np.int64)

    # Keep only genuine windows (each user's own motion); their group id is the
    # producing user's index → the identification label. Remap to contiguous 0..K-1.
    mask = y == 1
    X = X[mask]
    raw_labels = groups[mask]
    uniq = np.unique(raw_labels)
    remap = {u: i for i, u in enumerate(uniq)}
    labels = np.array([remap[u] for u in raw_labels], dtype=np.int64)
    num_users = len(uniq)
    print(f"  genuine windows X={X.shape}  users={num_users}  (chance top-1 = {1.0/num_users:.4f})")

    print("[2/5] Per-window stratified split (every user in train+val+test)...")
    X_tmp, X_test, y_tmp, y_test = train_test_split(
        X, labels, test_size=0.15, random_state=13, stratify=labels
    )
    X_train, X_val, y_train, y_val = train_test_split(
        X_tmp, y_tmp, test_size=0.1765, random_state=13, stratify=y_tmp
    )  # 0.1765*0.85 ≈ 0.15 val
    print(f"  train={X_train.shape} val={X_val.shape} test={X_test.shape}")

    print("[3/5] Fit scaler (z-score; mouse features are pre-bounded, no clip)...")
    os.makedirs(args.output_dir, exist_ok=True)
    scaler = FeatureScaler.fit(X_train)
    X_train = scaler.transform(X_train)
    X_val = scaler.transform(X_val)
    X_test = scaler.transform(X_test)
    scaler.save(os.path.join(args.output_dir, "scaler.json"))

    print(f"[4/5] Build + train 1D CNN + 2GRU identifier ({num_users} users, units={args.units})...")
    model = build_1d_cnn_2rnn(X_train.shape[1:], num_classes=num_users, units=args.units, rnn_type="gru", **LEGACY_NETWORK)
    model.compile(optimizer="adam", loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    model.summary()
    ckpt = os.path.join(args.output_dir, "best_model.h5")
    callbacks = [
        ModelCheckpoint(ckpt, save_best_only=True, monitor="val_accuracy", mode="max", verbose=1),
        EarlyStopping(patience=10, monitor="val_accuracy", mode="max", restore_best_weights=True, verbose=1),
        ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=4, min_lr=1e-5, verbose=1),
    ]
    history = model.fit(
        X_train, y_train,
        validation_data=(X_val, y_val),
        epochs=args.epochs,
        batch_size=args.batch_size,
        callbacks=callbacks,
        verbose=2,
    )

    print("[5/5] Evaluate identification on held-out windows...")
    test_loss, test_acc = model.evaluate(X_test, y_test, verbose=0)
    # top-5 accuracy
    probs = model.predict(X_test, verbose=0)
    top5 = np.mean([y_test[i] in np.argsort(probs[i])[-5:] for i in range(len(y_test))])
    chance = 1.0 / num_users
    results = {
        "model": "mouse 1D CNN + 2GRU — user identifier (transfer feature extractor)",
        "dataset": "SapiMouse (Antal et al., 2021)",
        "task": "closed-set user identification",
        "num_users": int(num_users),
        "window_size": int(X_train.shape[1]),
        "num_features": int(X_train.shape[2]),
        "test_loss": float(test_loss),
        "test_top1_accuracy": float(test_acc),
        "test_top5_accuracy": float(top5),
        "chance_top1": float(chance),
        "lift_over_chance": float(test_acc / chance),
        "training_epochs": len(history.history["loss"]),
        "genuine_windows": int(len(X)),
        "train_size": int(len(X_train)),
    }
    with open(os.path.join(args.output_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=2)

    final = os.path.join(args.output_dir, "final_model")
    model.save(final)
    print("\n" + "=" * 56)
    print(f"MOUSE BASE (user-ID)  top1={test_acc:.4f}  top5={top5:.4f}  "
          f"chance={chance:.4f}  lift={test_acc/chance:.1f}x")
    print("  (top1 >> chance => the Conv1D+GRU learned transferable features)")
    print(f"Saved: {final}")
    print("=" * 56)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Train the SapiMouse user-identification base")
    p.add_argument("--data", default="data/mouse_only/Mouse_WS50.h5")
    p.add_argument("--output-dir", default="artifacts/mouse-ws50-base")
    p.add_argument("--epochs", type=int, default=40)
    p.add_argument("--batch-size", type=int, default=128)
    p.add_argument("--units", type=int, default=32)
    main(p.parse_args())
