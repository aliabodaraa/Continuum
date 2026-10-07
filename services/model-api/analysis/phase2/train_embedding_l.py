"""Train one protocol-L embedding (PREREGISTRATION_L.md section 4).

    # selection candidates (base-train only, early stopping, seed 101)
    python train_embedding_l.py --objective arcface --param 0.20 --users base-train --seed 101
    python train_embedding_l.py --objective arcface --param 0.35 --users base-train --seed 101
    python train_embedding_l.py --objective supcon  --param 0.07 --users base-train --seed 101
    python train_embedding_l.py --objective supcon  --param 0.10 --users base-train --seed 101
    # final models (all 80 base users, fixed epochs = the winner's best epoch; see finalize_l.py)

Backbone: B6 FCN up to GAP + Dense(128) + L2 (l_common.build_backbone). ArcFace: scale 30, margin
= --param. Supervised contrastive: temperature = --param. Both use class-balanced batches of 32 users x
8 windows, Adam 1e-3. With early stopping: each user's 3-min session is split at 80% of its STEPS, so
no validation window shares a step with a training window (as train_mouse_fcn.py); patience 8, at most
60 epochs, best weights restored. Without early stopping (--epochs N): the whole 3-min session, N epochs.
TensorFlow runs with op determinism on and the given seed.
"""
import argparse
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402

USERS_PER_BATCH, PER_USER = 32, 8
MAX_EPOCHS, PATIENCE, LR, ARC_S = 60, 8, 1e-3, 30.0


def user_windows(W, users, split):
    """{label: (train, val)}; val empty when split is False."""
    from repr_arch_study import raw_steps, windows, _read_events
    out = {}
    for i, u in enumerate(users):
        LC.guard_users([u], "training")
        lo, _ = W._sessions(u)
        R = raw_steps(_read_events(lo))
        if split:
            cut = int(len(R) * 0.8)
            out[i] = (windows(R, 1.0, "A5", 0, cut), windows(R, 1.0, "A5", cut, None))
        else:
            out[i] = (windows(R, 1.0, "A5"), np.zeros((0, 50, 2), np.float32))
    return out


def batches(data, rng, which=0):
    """Class-balanced batches: USERS_PER_BATCH users x PER_USER windows (with replacement inside a user
    only when it has fewer windows than PER_USER). One epoch = ceil(total windows / batch size)."""
    labels = [k for k, v in data.items() if len(v[which])]
    total = sum(len(data[k][which]) for k in labels)
    steps = int(np.ceil(total / (USERS_PER_BATCH * PER_USER)))
    for _ in range(steps):
        us = rng.choice(labels, min(USERS_PER_BATCH, len(labels)), replace=False)
        X, y = [], []
        for u in us:
            pool = data[u][which]
            idx = rng.choice(len(pool), PER_USER, replace=len(pool) < PER_USER)
            X.append(pool[idx]); y += [u] * PER_USER
        yield np.concatenate(X), np.asarray(y, np.int32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--objective", choices=["arcface", "supcon"], required=True)
    ap.add_argument("--param", type=float, required=True, help="ArcFace margin or SupCon temperature")
    ap.add_argument("--users", choices=["base-train", "base-80"], required=True)
    ap.add_argument("--seed", type=int, default=101)
    ap.add_argument("--epochs", type=int, default=0, help="fixed epochs (no early stopping); 0 = early stopping")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--limit-users", type=int, default=0, help="SMOKE TEST ONLY: first N users")
    ap.add_argument("--max-epochs", type=int, default=0, help="SMOKE TEST ONLY (with --limit-users)")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    if a.max_epochs and not a.limit_users:
        raise SystemExit("--max-epochs is for smoke tests only (use it with --limit-users)")

    hashes = LC.verify_frozen()
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    import tensorflow as tf
    if a.threads:
        tf.config.threading.set_intra_op_parallelism_threads(a.threads)
    tf.keras.utils.set_random_seed(a.seed)
    tf.config.experimental.enable_op_determinism()

    j, l = LC.splits()
    users = l["baseTrain"] if a.users == "base-train" else sorted(j["baseTraining"], key=lambda u: int(u[4:]))
    if a.limit_users:
        users = users[:a.limit_users]
    name = f"{a.objective}-{a.param:g}-{a.users}-s{a.seed}" + (f"-e{a.epochs}" if a.epochs else "")
    out = a.out or os.path.join(LC.SMOKE if a.limit_users else LC.OUT, "models", name)
    if os.path.exists(os.path.join(out, "meta.json")) and not a.limit_users:
        raise SystemExit(f"{out} is trained already; each model is trained once (a crashed run leaves no "
                         "meta.json and may simply be started again)")
    os.makedirs(out, exist_ok=True)

    W = LC.Windows("training")
    data = user_windows(W, users, split=not a.epochs)
    scale = LC.load_scaler()
    data = {k: (scale(v[0]) if len(v[0]) else v[0], scale(v[1]) if len(v[1]) else v[1]) for k, v in data.items()}
    n_cls = len(users)
    print(f"[L] {name}: {n_cls} users, train {sum(len(v[0]) for v in data.values())} windows, "
          f"val {sum(len(v[1]) for v in data.values())}", flush=True)

    backbone = LC.build_backbone()
    opt = tf.keras.optimizers.Adam(LR)
    Wc = None
    if a.objective == "arcface":
        Wc = tf.Variable(tf.keras.initializers.GlorotUniform(seed=a.seed)((128, n_cls)), name="arc_w")
        m = float(a.param)
        cos_m, sin_m = np.cos(m), np.sin(m)
        th, mm = np.cos(np.pi - m), np.sin(np.pi - m) * m
        params = backbone.trainable_variables + [Wc]

        def loss_fn(x, y, training):
            e = backbone(x, training=training)
            c = tf.clip_by_value(tf.matmul(e, tf.math.l2_normalize(Wc, axis=0)), -1 + 1e-7, 1 - 1e-7)
            s = tf.sqrt(1.0 - c * c)
            phi = tf.where(c > th, c * cos_m - s * sin_m, c - mm)            # cos(theta + m), safe branch
            oh = tf.one_hot(y, n_cls)
            logits = ARC_S * (oh * phi + (1.0 - oh) * c)
            return tf.reduce_mean(tf.keras.losses.sparse_categorical_crossentropy(y, logits, from_logits=True))
    else:
        tau = float(a.param)
        params = backbone.trainable_variables

        def loss_fn(x, y, training):
            e = backbone(x, training=training)
            sim = tf.matmul(e, e, transpose_b=True) / tau
            n = tf.shape(e)[0]
            eye = tf.eye(n)
            logits = sim - 1e9 * eye                                          # exclude self from the denominator
            log_prob = logits - tf.reduce_logsumexp(logits, axis=1, keepdims=True)
            pos = tf.cast(tf.equal(y[:, None], y[None, :]), tf.float32) * (1.0 - eye)
            per_anchor = tf.reduce_sum(pos * log_prob, 1) / tf.maximum(tf.reduce_sum(pos, 1), 1.0)
            return -tf.reduce_mean(per_anchor)

    @tf.function
    def step(x, y):
        with tf.GradientTape() as tape:
            loss = loss_fn(x, y, True)
        opt.apply_gradients(zip(tape.gradient(loss, params), params))
        return loss

    val_batches = list(batches(data, np.random.default_rng(0), which=1)) if not a.epochs else []

    def val_loss():
        return float(np.mean([float(loss_fn(x, y, False)) for x, y in val_batches]))

    rng = np.random.default_rng(a.seed)
    hist, best, best_ep, best_w, wait = [], np.inf, 0, None, 0
    epochs = a.epochs or a.max_epochs or MAX_EPOCHS
    t0 = time.time()
    for ep in range(1, epochs + 1):
        tr = [float(step(x, y)) for x, y in batches(data, rng, which=0)]
        row = {"epoch": ep, "train": float(np.mean(tr))}
        if not np.isfinite(row["train"]):
            raise SystemExit(f"[L] {name}: non-finite training loss at epoch {ep} (technical failure: "
                             "re-run with identical settings and log it in RUN_LOG.md)")
        if not a.epochs:
            row["val"] = val_loss()
            if not np.isfinite(row["val"]):
                raise SystemExit(f"[L] {name}: non-finite validation loss at epoch {ep}")
            if row["val"] < best - 1e-6:
                best, best_ep, wait = row["val"], ep, 0
                # all backbone weights, including BatchNorm's moving statistics (not trainable)
                best_w = (backbone.get_weights(), None if Wc is None else Wc.numpy())
            else:
                wait += 1
        hist.append(row)
        print(f"[L] {name} epoch {ep}: train {row['train']:.4f}" + (f" val {row['val']:.4f}" if "val" in row else ""), flush=True)
        if not a.epochs and wait >= PATIENCE:
            break
    restored = None
    if best_w is not None:
        backbone.set_weights(best_w[0])
        if Wc is not None:
            Wc.assign(best_w[1])
        restored = val_loss()
        if abs(restored - best) > 1e-5 * max(1.0, abs(best)):
            raise SystemExit(f"[L] {name}: restored weights give val loss {restored:.6f}, not the best {best:.6f}")
    wpath = os.path.join(out, "embedding.weights.h5")
    tmp = os.path.join(out, "embedding.tmp.weights.h5")
    backbone.save_weights(tmp)
    os.replace(tmp, wpath)
    meta = {**hashes, "protocol": "L", "name": name, "objective": a.objective, "param": a.param, "users": a.users,
            "nUsers": n_cls, "userList": list(users), "seed": a.seed, "fixedEpochs": a.epochs or None,
            "bestEpoch": best_ep if not a.epochs else a.epochs,
            "epochsRun": len(hist), "history": hist, "minutes": round((time.time() - t0) / 60, 1),
            "trainWindows": int(sum(len(v[0]) for v in data.values())),
            "valWindows": int(sum(len(v[1]) for v in data.values())),
            "bestValLoss": None if a.epochs else float(best), "restoredValLoss": restored,
            "tensorflow": tf.__version__, "codeSha256": LC.code_hashes(),
            "weightsSha256": LC.sha(wpath), "smokeTest": bool(a.limit_users)}
    LC.write_json(os.path.join(out, "meta.json"), meta, indent=1)
    print(f"[L] wrote {out} (best epoch {meta['bestEpoch']}, {meta['minutes']} min)", flush=True)


if __name__ == "__main__":
    main()
