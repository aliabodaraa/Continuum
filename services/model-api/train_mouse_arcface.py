"""
Train the mouse-dynamics base as a METRIC-LEARNING embedding (ArcFace) instead of
a plain softmax-identification model with a swapped Dense(2) head.

Why: Stage-1 showed feature enrichment (F=7 -> F=11) barely moved per-user EER
(23.8% -> 22.3%). The bottleneck is not the inputs but the VERIFICATION construction:
a softmax-ID base + frozen-Conv + Dense(2) head-swap learns a decision boundary
against generic pooled negatives and generalises poorly to unseen impostors,
especially for users whose motion is only weakly distinctive (user8/16, EER ~0.45).

ArcFace (additive angular margin softmax, Deng et al. 2019) instead trains the
120-d embedding so that same-identity windows form tight angular clusters with an
explicit margin between identities. Verification is then prototype-based: enrol =
mean L2-normalised embedding of the genuine windows; score = cosine similarity of a
test window's embedding to that prototype. No per-user head, no negative selection —
the separation is baked into the embedding geometry.

Backbone is IDENTICAL to the keystroke-grade net (Conv1D + 2xGRU) so the only
variable vs Stage-1 is the training objective + prototype scoring.

Splits, holdout seed, augmentation and scaler all mirror train_mouse_base_id.py so
the ArcFace base's holdout_users.json matches and the eval sweep stays comparable.

Outputs in --output-dir:
  embed_model/           SavedModel: windows -> L2-normalised embedding (inference)
  embed_model.h5         same weights (h5)
  scaler.json            feature scaler (fit on train)
  holdout_users.json     same 20 held-out users (seed 13) as the Stage-1 base
  results.json           closed-set retrieval sanity metrics + provenance
"""
import argparse
import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tensorflow as tf  # noqa: E402
from tensorflow.keras import layers, models, regularizers  # noqa: E402
from tensorflow.keras.callbacks import EarlyStopping, ModelCheckpoint, ReduceLROnPlateau  # noqa: E402
from preprocessing import FeatureScaler  # noqa: E402
from preprocess_mouse import events_to_steps, steps_to_windows, _read_events  # noqa: E402
from train_mouse_base_id import augment_windows, split_session_temporal, session_windows  # noqa: E402


class ArcFace(layers.Layer):
    """Additive angular margin softmax. Inputs: (embeddings, one-hot labels).
    Output: softmax over margin-penalised, scaled cosine logits. Only used at
    TRAIN time; inference uses the bare (L2-normalised) embedding."""

    def __init__(self, n_classes, s=30.0, m=0.50, **kwargs):
        super().__init__(**kwargs)
        self.n_classes = int(n_classes)
        self.s = float(s)
        self.m = float(m)

    def build(self, input_shape):
        emb_dim = input_shape[0][-1]
        self.W = self.add_weight(
            name="arc_W", shape=(emb_dim, self.n_classes),
            initializer="glorot_uniform", trainable=True,
            regularizer=regularizers.l2(1e-4))

    def call(self, inputs):
        embeddings, labels = inputs
        x = tf.nn.l2_normalize(embeddings, axis=1)
        W = tf.nn.l2_normalize(self.W, axis=0)
        cos = tf.clip_by_value(tf.matmul(x, W), -1.0 + 1e-7, 1.0 - 1e-7)
        theta = tf.acos(cos)
        target = tf.cos(theta + self.m)                 # penalise the true-class angle
        logits = cos * (1.0 - labels) + target * labels
        return tf.nn.softmax(logits * self.s)

    def get_config(self):
        c = super().get_config()
        c.update({"n_classes": self.n_classes, "s": self.s, "m": self.m})
        return c


def build_embedding_backbone(input_shape, units, embed_dim):
    """Conv1D + 2xGRU backbone (keystroke-grade) -> Dense embedding. No final
    activation; the embedding is L2-normalised by the Lambda so cosine == dot."""
    inp = layers.Input(shape=input_shape, name="win")
    x = layers.Conv1D(32, 2, activation="relu", padding="valid")(inp)
    x = layers.GRU(units, return_sequences=True)(x)
    x = layers.Dropout(0.5)(x)
    x = layers.GRU(units, return_sequences=True)(x)
    x = layers.Dropout(0.5)(x)
    x = layers.Flatten()(x)
    x = layers.Dense(embed_dim, name="embed_dense")(x)
    x = layers.BatchNormalization(name="embed_bn")(x)
    emb = layers.Lambda(lambda t: tf.nn.l2_normalize(t, axis=1), name="embed")(x)
    return inp, emb


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

    if args.augment > 0:
        rng_aug = np.random.default_rng(args.seed + 1)
        before = len(Xtr)
        Xtr, ytr = augment_windows(Xtr, ytr, rng_aug, args.augment, args.jitter, args.scale_lo, args.scale_hi)
        perm = rng_aug.permutation(len(Xtr)); Xtr = Xtr[perm]; ytr = ytr[perm]
        print(f"augment x{args.augment}: train {before} -> {len(Xtr)} windows")

    ytr_oh = tf.one_hot(ytr, num_classes).numpy().astype(np.float32)
    yva_oh = tf.one_hot(yva, num_classes).numpy().astype(np.float32)

    # Training model: (windows, labels) -> arcface softmax.  Inference model shares
    # the backbone weights and outputs the bare embedding.
    inp, emb = build_embedding_backbone(Xtr.shape[1:], args.units, args.embed_dim)
    label_in = layers.Input(shape=(num_classes,), name="label")
    out = ArcFace(num_classes, s=args.scale, m=args.margin)([emb, label_in])
    train_model = models.Model([inp, label_in], out)
    embed_model = models.Model(inp, emb)

    # WARMUP: seed the shared backbone (Conv1D + both GRUs) from a trained softmax-ID
    # base so ArcFace fine-tunes from a discriminative point instead of cold-starting
    # (cold ArcFace with a hard margin collapses the embedding to a constant).
    if args.init_from:
        src = tf.keras.models.load_model(args.init_from, compile=False)
        src_by_type = {}
        for L in src.layers:
            if L.get_weights():
                src_by_type.setdefault(type(L).__name__, []).append(L)
        copied = []
        for L in embed_model.layers:
            w = L.get_weights()
            if not w:
                continue
            pool = src_by_type.get(type(L).__name__, [])
            for cand in pool:
                cw = cand.get_weights()
                if [a.shape for a in cw] == [a.shape for a in w]:
                    L.set_weights(cw); pool.remove(cand); copied.append(L.name); break
        print(f"warmup init from {args.init_from}: copied layers {copied}")
    train_model.compile(optimizer=tf.keras.optimizers.Adam(args.lr),
                        loss="categorical_crossentropy", metrics=["accuracy"])
    train_model.summary()

    ckpt = os.path.join(args.output_dir, "_train_ckpt.h5")
    history = train_model.fit(
        [Xtr, ytr_oh], ytr_oh,
        validation_data=([Xva, yva_oh], yva_oh),
        epochs=args.epochs, batch_size=args.batch_size,
        callbacks=[
            ModelCheckpoint(ckpt, save_best_only=True, monitor="val_loss",
                            save_weights_only=True, verbose=1),
            EarlyStopping(patience=12, monitor="val_loss", restore_best_weights=True, verbose=1),
            ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=5, min_lr=1e-5, verbose=1),
        ],
        verbose=2,
    )

    # --- closed-set retrieval sanity: embed test windows, nearest-prototype top-1.
    # (This is a proxy for embedding quality; the real metric is the enrol sweep EER.)
    emb_te = embed_model.predict(Xte, batch_size=256, verbose=0)
    protos = {}
    for c in range(num_classes):
        m = emb_te[yte == c]
        if len(m):
            p = m.mean(0); protos[c] = p / (np.linalg.norm(p) + 1e-9)
    pc = np.array(sorted(protos.keys()))
    P = np.stack([protos[c] for c in pc])           # (C, d)
    sims = emb_te @ P.T                              # (N, C) cosine (both normalised)
    pred = pc[sims.argmax(1)]
    top1 = float((pred == yte).mean())
    print(f"CLOSED-SET nearest-prototype top1={top1:.4f} (chance={1/num_classes:.4f})")

    embed_model.save(os.path.join(args.output_dir, "embed_model"))
    embed_model.save(os.path.join(args.output_dir, "embed_model.h5"))

    results = {
        "model": f"mouse 1D CNN + 2GRU ArcFace embedding (d={args.embed_dim}, s={args.scale}, m={args.margin})",
        "dataset": "SapiMouse (Antal et al., 2021)",
        "task": f"{num_classes}-way ArcFace metric learning; 20 held-out users for enrollment experiments",
        "window_size": int(Xtr.shape[1]),
        "num_features": int(Xtr.shape[2]),
        "embed_dim": int(args.embed_dim),
        "closed_set_nearest_proto_top1": top1,
        "chance_level": 1.0 / num_classes,
        "training_epochs": len(history.history["loss"]),
        "train_size": int(len(Xtr)),
        "verification": "prototype cosine (enrol = mean L2-normalised embedding); no per-user head",
    }
    with open(os.path.join(args.output_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=2)
    print(f"Saved ArcFace embedding + results to {args.output_dir}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--data-dir", default="data/sapimouse")
    p.add_argument("--output-dir", default="artifacts/mouse-ws50-arcface")
    p.add_argument("--window-size", type=int, default=50)
    p.add_argument("--stride", type=int, default=10)
    p.add_argument("--holdout-users", type=int, default=20)
    p.add_argument("--epochs", type=int, default=60)
    p.add_argument("--batch-size", type=int, default=128)
    p.add_argument("--units", type=int, default=32)
    p.add_argument("--embed-dim", type=int, default=128)
    p.add_argument("--scale", type=float, default=30.0)
    p.add_argument("--margin", type=float, default=0.50)
    p.add_argument("--init-from", default="", help="id_model.h5 to warmup the backbone from")
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--seed", type=int, default=13)
    p.add_argument("--augment", type=int, default=2)
    p.add_argument("--jitter", type=float, default=0.05)
    p.add_argument("--scale-lo", type=float, default=0.9)
    p.add_argument("--scale-hi", type=float, default=1.1)
    main(p.parse_args())
