"""
Evaluate the trained mouse base model on the leak-free held-out test split and
write the results.json that the interrupted training run never produced.

Reconstructs the exact same group-aware split as train_mouse_base.py
(make_train_val_test defaults, random_state=42) and applies the scaler saved
at training time — no refitting, matching what inference uses.
"""
import argparse
import json
import os
import sys

import numpy as np
import h5py

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tensorflow.keras.models import load_model  # noqa: E402
from data_loader import make_train_val_test  # noqa: E402
from preprocessing import FeatureScaler  # noqa: E402
from train import calculate_metrics  # noqa: E402


def main(args):
    print("[1/4] Loading mouse windows...")
    with h5py.File(args.data, "r") as f:
        X = np.array(f["train_data"], dtype=np.float32)
        y = np.array(f["train_labels"]).reshape(-1).astype(np.int64)
        groups = (
            np.array(f["groups"]).reshape(-1).astype(np.int64) if "groups" in f else None
        )
    print(f"  X={X.shape} labels={np.bincount(y).tolist()} groups={len(np.unique(groups)) if groups is not None else 'none'}")

    print("[2/4] Reproducing group-aware split (defaults, random_state=42)...")
    X_train, X_val, X_test, y_train, y_val, y_test = make_train_val_test(X, y, groups=groups)
    print(f"  train={X_train.shape} val={X_val.shape} test={X_test.shape}")

    print("[3/4] Loading saved scaler + model...")
    scaler = FeatureScaler.load(os.path.join(args.model_dir, "scaler.json"))
    X_test = scaler.transform(X_test)
    model = load_model(os.path.join(args.model_dir, "best_model.h5"))

    print("[4/4] Evaluating on held-out test set...")
    test_loss, test_acc = model.evaluate(X_test, y_test, verbose=0)
    metrics = calculate_metrics(y_test, model.predict(X_test, verbose=0))
    results = {
        "model": "mouse 1D CNN + 2GRU",
        "dataset": "SapiMouse (Antal et al., 2021)",
        "window_size": int(X_test.shape[1]),
        "num_features": int(X_test.shape[2]),
        "test_loss": float(test_loss),
        "test_accuracy": float(test_acc),
        "test_metrics": metrics,
        "note": "evaluation-only run of saved best_model.h5; split reproduced with make_train_val_test defaults (random_state=42)",
        "dataset_size": int(len(X)),
        "train_size": int(len(X_train)),
        "val_size": int(len(X_val)),
        "test_size": int(len(X_test)),
    }
    out = os.path.join(args.model_dir, "results.json")
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    print("=" * 50)
    print(f"MOUSE BASE  EER={metrics['eer']:.4f}  acc={metrics['accuracy']:.4f}  "
          f"f1={metrics['f1']:.4f}  auc={metrics.get('roc_auc')}")
    print(f"Saved: {out}")
    print("=" * 50)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Evaluate the saved SapiMouse base model")
    p.add_argument("--data", default="data/mouse_only/Mouse_WS50.h5")
    p.add_argument("--model-dir", default="artifacts/mouse-ws50-gru")
    main(p.parse_args())
