"""
Architecture head-to-head on the mouse channel: keystroke-derived vs mouse-derived.

WHY THIS EXISTS
---------------
The deployed mouse base model is Conv1D(32, k=2) -> GRU(32) -> GRU(32) ->
Flatten -> softmax. Every part of that is inherited from

    X. Lu, S. Zhang, P. Hui, P. Lio, "Continuous authentication by free-text
    keystroke based on CNN and RNN", Computers & Security 96, 2020,

which is a KEYSTROKE paper. Even the choice of GRU over LSTM was settled on the
Buffalo keystroke corpus (see model.py). Nothing about that architecture was
selected on mouse data.

The alternative is the architecture of

    M. Antal, N. Fejer, "Mouse dynamics based user recognition using deep
    learning", Acta Univ. Sapientiae Informatica 12(1):39-50, 2020,

whose source the paper names as its reproducibility artifact
(github.com/norbertFejer/AFE_Project). Our port is verified layer-for-layer
against that file, a verbatim copy of which is kept in vendor/ for diffing. It
is a two-tower 1D CNN designed for mouse movement, with no recurrent layer.

WHAT IS HELD CONSTANT
---------------------
Everything except the architecture: the same SapiMouse windows, the same
subject holdout, the same temporal 80/20 split of the 3-minute session, the
same 1-minute test session, the same scaler, the same number of classes. Only
`build_*` differs. That is what makes the comparison evidence rather than
anecdote.

A third arm is available for completeness -- Chong, Elovici & Binder (IEEE TIFS
15, 2020) found a 2D-CNN outperformed a CNN-LSTM hybrid on mouse data, which is
the strongest published argument against our recurrent layer. It is not
implemented here because it needs a different input representation (the
sequence rendered as an image), and that is a separate piece of work.

Run inside the model-api container:
    python arch_headtohead.py --out /app/artifacts/xai/arch_headtohead.json
"""
import argparse
import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preprocessing import FeatureScaler                                      # noqa: E402
from preprocess_mouse import events_to_steps, steps_to_windows, _read_events  # noqa: E402
from model import build_1d_cnn_2rnn, LEGACY_NETWORK                          # noqa: E402
from antal2020_sweep import build_mcdcnn                                     # noqa: E402


def session_windows(csv_path, w, s):
    return steps_to_windows(events_to_steps(_read_events(csv_path)), w, s)


def split_session_temporal(csv_path, w, s, train_frac=0.8):
    steps = events_to_steps(_read_events(csv_path))
    cut = int(len(steps) * train_frac)
    return steps_to_windows(steps[:cut], w, s), steps_to_windows(steps[cut:], w, s)


def build_data(args):
    with open(os.path.join(args.art, "holdout_users.json")) as f:
        holdout = json.load(f)["holdout_users"]
    uids = [os.path.basename(d) for d in sorted(
        glob.glob(os.path.join(args.data_dir, "user*")),
        key=lambda p: int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0))]
    base_users = [u for u in uids if u not in holdout]

    Xtr, ytr, Xva, yva, Xte, yte = [], [], [], [], [], []
    for ci, uid in enumerate(base_users):
        csvs = sorted(glob.glob(os.path.join(args.data_dir, uid, "*.csv")))
        long_s = [c for c in csvs if "3min" in os.path.basename(c)]
        short_s = [c for c in csvs if "1min" in os.path.basename(c)]
        if not long_s or not short_s:
            continue
        head, tail = split_session_temporal(long_s[0], args.window_size, args.stride)
        test = session_windows(short_s[0], args.window_size, args.stride)
        Xtr.extend(head); ytr.extend([ci] * len(head))
        Xva.extend(tail); yva.extend([ci] * len(tail))
        Xte.extend(test); yte.extend([ci] * len(test))

    A = lambda v, t: np.asarray(v, t)
    Xtr, ytr = A(Xtr, np.float32), A(ytr, np.int64)
    Xva, yva = A(Xva, np.float32), A(yva, np.int64)
    Xte, yte = A(Xte, np.float32), A(yte, np.int64)

    # One scaler, fitted once on train, shared by BOTH arms -- otherwise the
    # comparison would confound architecture with preprocessing.
    scaler = FeatureScaler.fit(Xtr)
    return (scaler.transform(Xtr), ytr, scaler.transform(Xva), yva,
            scaler.transform(Xte), yte, len(base_users))


def run_arm(name, build, Xtr, ytr, Xva, yva, Xte, yte, n_cls, epochs, batch, seed):
    import tensorflow as tf
    from tensorflow.keras.callbacks import EarlyStopping, ReduceLROnPlateau
    tf.keras.backend.clear_session()
    tf.random.set_seed(seed)

    m = build(Xtr.shape[1:], n_cls)
    m.compile(optimizer="adam", loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    n_params = int(sum(np.prod(w.shape) for w in m.trainable_weights))

    h = m.fit(Xtr, ytr, validation_data=(Xva, yva), epochs=epochs, batch_size=batch,
              callbacks=[EarlyStopping(patience=12, monitor="val_loss",
                                       restore_best_weights=True, verbose=0),
                         ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=5,
                                           min_lr=1e-5, verbose=0)],
              verbose=2)

    p = m.predict(Xte, batch_size=512, verbose=0)
    top1 = float((p.argmax(1) == yte).mean())
    top5 = float(np.mean([y in row.argsort()[-5:] for row, y in zip(p, yte)]))
    print(f"\n  {name}: top1={top1:.4f}  top5={top5:.4f}  params={n_params:,}  "
          f"epochs_run={len(h.history['loss'])}\n")
    return {"arm": name, "top1": top1, "top5": top5, "trainableParams": n_params,
            "epochsRun": len(h.history["loss"]),
            "bestValLoss": float(min(h.history["val_loss"]))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="/app/data/sapimouse")
    ap.add_argument("--art", default="/app/artifacts/mouse-ws50-aligned")
    ap.add_argument("--out", default="/app/artifacts/xai/arch_headtohead.json")
    ap.add_argument("--window-size", type=int, default=50)
    ap.add_argument("--stride", type=int, default=10)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch-size", type=int, default=64)
    ap.add_argument("--seeds", type=int, default=3,
                    help="repeats per arm; training is non-deterministic, so a "
                         "single run per arm cannot separate the arms")
    args = ap.parse_args()

    Xtr, ytr, Xva, yva, Xte, yte, n_cls = build_data(args)
    print(f"train {Xtr.shape}  val {Xva.shape}  test {Xte.shape}  classes {n_cls}")
    print(f"chance = {1.0 / n_cls:.4f}\n")

    ARMS = [
        ("lu_cnn_2gru", lambda shp, n: build_1d_cnn_2rnn(shp, num_classes=n, units=32,
                                                         rnn_type="gru", **LEGACY_NETWORK),
         "Lu et al. 2020 (keystroke) -- Conv1D(32,k2) + 2x GRU(32)"),
        ("antal_two_tower", lambda shp, n: build_mcdcnn(shp, n),
         "Antal & Fejer 2020 (mouse) -- two-tower 1D CNN, verified vs AFE_Project"),
    ]

    rows = []
    for key, build, desc in ARMS:
        print("=" * 74); print(desc); print("=" * 74)
        for s in range(args.seeds):
            r = run_arm(key, build, Xtr, ytr, Xva, yva, Xte, yte, n_cls,
                        args.epochs, args.batch_size, seed=17 + s)
            r["seed"] = 17 + s; r["description"] = desc
            rows.append(r)

    summary = {}
    for key, _, desc in ARMS:
        v = [r["top1"] for r in rows if r["arm"] == key]
        summary[key] = {"description": desc, "n": len(v),
                        "top1Mean": float(np.mean(v)), "top1Std": float(np.std(v)),
                        "top1Runs": v}

    out = {"question": "Does the mouse-derived architecture beat the keystroke-derived one "
                       "on mouse data, everything else held constant?",
           "heldConstant": ["windows", "subject holdout", "temporal split", "scaler",
                            "class count", "optimiser", "callbacks"],
           "runs": rows, "summary": summary, "chance": 1.0 / n_cls}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)

    print("=" * 74)
    print(f"{'arm':<18}{'top-1 mean':>12}{'sd':>9}   description")
    for k, v in summary.items():
        print(f"{k:<18}{v['top1Mean']:>12.4f}{v['top1Std']:>9.4f}   {v['description'][:44]}")
    a, b = [summary[k]["top1Mean"] for k, _, _ in ARMS]
    sd = max(summary[k]["top1Std"] for k, _, _ in ARMS)
    print(f"\ndifference (mouse - keystroke) = {b - a:+.4f}"
          f"   ({(b - a) / sd:+.1f} sd of run noise)" if sd > 0 else "")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
