"""
Feature ablation for the mouse channel, by permutation importance.

WHAT THIS MEASURES
------------------
The deployed mouse representation is a 100-way identification network trained on
SapiMouse 3-minute sessions and evaluated on the held-out 1-minute sessions
(artifacts/mouse-ws50-aligned). Every per-user verifier is a head fine-tuned on
top of that frozen representation, so whatever the representation relies on is
what the whole channel relies on.

Permutation importance asks one question per input feature: if this feature's
values are shuffled across windows -- keeping the feature's own distribution and
its within-window shape intact, but destroying its link to identity -- how much
identification accuracy is lost?

  importance(j) = top1(clean) - top1(feature j permuted)

A large drop means the representation genuinely depends on that feature. A drop
near zero means the feature carries little identity information beyond what the
other six already provide, which is the honest reading: permutation importance
measures marginal contribution in the presence of the rest, not standalone power.

The permutation is applied AFTER scaling and along the window axis only, so the
temporal structure inside each window survives and only the association with the
label is broken. Each feature is permuted REPEATS times with different draws and
the mean and spread are reported, because a single shuffle is itself a random
draw.

Run inside the model-api container:
    python mouse_feature_ablation.py --out /app/artifacts/xai/mouse_ablation.json
"""
import argparse
import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preprocessing import FeatureScaler                      # noqa: E402
from preprocess_mouse import events_to_steps, steps_to_windows, _read_events  # noqa: E402

# The seven step features, in the order sdk/js/mouse-features.js emits them.
FEATURES = [
    ("dx",      "normalised horizontal displacement, clipped to [-1, 1]"),
    ("dy",      "normalised vertical displacement, clipped to [-1, 1]"),
    ("log_v",   "log(1 + speed) -- how fast the pointer is travelling"),
    ("log_a",   "log(1 + |change in speed|) -- acceleration"),
    ("dtheta",  "turning angle between consecutive steps, divided by pi"),
    ("dt",      "time since the previous event, clipped"),
    ("isClick", "1 while a button is Pressed/Released/Drag, else 0"),
]


def session_windows(csv_path, window_size, stride):
    return steps_to_windows(events_to_steps(_read_events(csv_path)), window_size, stride)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="/app/data/sapimouse")
    ap.add_argument("--art", default="/app/artifacts/mouse-ws50-aligned")
    ap.add_argument("--out", default="/app/artifacts/xai/mouse_ablation.json")
    ap.add_argument("--window-size", type=int, default=50)
    ap.add_argument("--stride", type=int, default=10)
    ap.add_argument("--repeats", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    import tensorflow as tf

    with open(os.path.join(args.art, "holdout_users.json")) as f:
        holdout = json.load(f)["holdout_users"]
    uids = [os.path.basename(d) for d in sorted(
        glob.glob(os.path.join(args.data_dir, "user*")),
        key=lambda p: int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0))]
    base_users = [u for u in uids if u not in holdout]

    # Rebuild the SAME test set the base model was scored on: the 1-minute
    # session of every base user, labelled by that user's class index.
    X, y = [], []
    for ci, uid in enumerate(base_users):
        csvs = sorted(glob.glob(os.path.join(args.data_dir, uid, "*.csv")))
        short_s = [c for c in csvs if "1min" in os.path.basename(c)]
        if not short_s:
            continue
        w = session_windows(short_s[0], args.window_size, args.stride)
        X.extend(w); y.extend([ci] * len(w))
    X = np.asarray(X, np.float32); y = np.asarray(y, np.int64)

    scaler = FeatureScaler.load(os.path.join(args.art, "scaler.json"))
    Xs = scaler.transform(X)
    print(f"test windows {Xs.shape} | classes {len(base_users)}")

    model = tf.keras.models.load_model(os.path.join(args.art, "id_model.h5"), compile=False)

    def top1(Z):
        p = model.predict(Z, batch_size=512, verbose=0)
        return float((p.argmax(1) == y).mean())

    base = top1(Xs)
    print(f"clean top-1 = {base:.4f}  (chance = {1.0/len(base_users):.4f})\n")

    rows = []
    for j, (name, desc) in enumerate(FEATURES):
        drops = []
        for r in range(args.repeats):
            rng = np.random.default_rng(args.seed + 1000 * j + r)
            Z = Xs.copy()
            Z[:, :, j] = Z[rng.permutation(len(Z)), :, j]
            drops.append(base - top1(Z))
        d = np.array(drops)
        rows.append({"feature": name, "description": desc,
                     "dropMean": float(d.mean()), "dropStd": float(d.std()),
                     "relativeDropPct": float(100.0 * d.mean() / base)})
        print(f"  {name:<8} drop {d.mean():.4f} +/- {d.std():.4f}   "
              f"({100.0 * d.mean() / base:5.1f}% of clean accuracy)")

    rows.sort(key=lambda r: -r["dropMean"])
    out = {"method": "permutation importance on the 100-way identification base",
           "artifact": args.art, "nTestWindows": int(len(Xs)),
           "nClasses": len(base_users), "chance": 1.0 / len(base_users),
           "cleanTop1": base, "repeats": args.repeats, "features": rows}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)

    print("\nranked by importance")
    for r in rows:
        print(f"  {r['feature']:<8} {r['dropMean']:.4f}")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
