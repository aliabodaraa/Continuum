"""
SapiMouse deep-feature-learning + one-class verification.

A faithful reproduction of

  Antal, M., Fejer, N., & Buza, K. (2021). SapiMouse: Mouse dynamics-based user
  authentication using deep feature learning. In 2021 IEEE 15th International
  Symposium on Applied Computational Intelligence and Informatics (SACI)
  (pp. 61-66). IEEE. https://doi.org/10.1109/SACI51354.2021.9465583

taken from the authors' released implementation (github.com/margitantal68/sapimouse):

  util/fcn.py       Conv1D(128, k=8) - BN - ReLU
                    Conv1D(256, k=5) - BN - ReLU
                    Conv1D(128, k=3) - BN - ReLU
                    GlobalAveragePooling1D
                    Dense(n_subjects, softmax)
                    Adam(lr=1e-4), ReduceLROnPlateau(factor=0.5, patience=50)
  util/settings.py  BATCH_SIZE=16  EPOCHS=100  RANDOM_STATE=11235
  util/oneclass.py  OneClassSVM(gamma='scale'); scores z-scored then min-maxed
  main_mouse_blocks.py
                    FCN trains on subjects 1-72; subjects 73-120 are evaluated
                    one-class; ENROL on the 3-min session, TEST on the 1-min
                    session; results reported for 1..5 blocks

The FCN is a feature extractor, not the verifier: after training it to identify
the 72 training subjects, the 128-dimensional GlobalAveragePooling output is
taken as the embedding, and a separate one-class SVM is fitted per evaluation
subject on that subject's enrolment blocks alone. No impostor data is used to
build a user's model, which is what makes this an enrolment scheme rather than
a classifier — a genuine advantage over the binary head the earlier pipelines
used, since a new user needs only their own behaviour.

Score normalisation is monotonic (z-score then min-max), so it cannot change
AUC or EER; it is applied because the paper applies it, and the metrics are
computed on the normalised scores for exactness.

Run inside the model-api container:
    python sapimouse_oneclass_sweep.py --out /app/artifacts/sapimouse-fcn/oneclass.json
"""
import argparse
import json
import os
import sys

import h5py
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from keystroke_user_sweep import auc_of, eer_of, tar_at_far  # noqa: E402

# ---- published parameters --------------------------------------------------
BATCH_SIZE = 16
EPOCHS = 100
RANDOM_STATE = 11235
FCN_SUBJECTS = 72
BLOCK_COUNTS = [1, 2, 3, 4, 5]
ENROL_SESSION, TEST_SESSION = 1, 0      # 1 = 3-min enrol, 0 = 1-min test


def build_fcn(input_shape, nb_classes, num_filters=128):
    """util/fcn.py, layer for layer."""
    from tensorflow.keras import layers, models
    inp = layers.Input(shape=input_shape)
    x = layers.Conv1D(num_filters, 8, padding="same")(inp)
    x = layers.BatchNormalization()(x)
    x = layers.Activation("relu")(x)
    x = layers.Conv1D(2 * num_filters, 5, padding="same")(x)
    x = layers.BatchNormalization()(x)
    x = layers.Activation("relu")(x)
    x = layers.Conv1D(num_filters, 3, padding="same")(x)
    x = layers.BatchNormalization()(x)
    x = layers.Activation("relu")(x)
    gap = layers.GlobalAveragePooling1D(name="embedding")(x)
    out = layers.Dense(nb_classes, activation="softmax")(gap)
    return models.Model(inp, out)


def normalise_scores(s):
    """util/oneclass.py: z-score, clip at +/-2 sd, then min-max to [0, 1]."""
    s = np.asarray(s, dtype=float)
    mu, sd = s.mean(), s.std()
    if sd == 0:
        return np.full_like(s, 0.5)
    lo, hi = mu - 2 * sd, mu + 2 * sd
    return np.clip((s - lo) / (hi - lo), 0.0, 1.0)


def sets_of(scores, k):
    """Mean over k CONSECUTIVE blocks from one person's own stream."""
    s = np.asarray(scores, float)
    if k <= 1:
        return s
    if len(s) < k:
        return np.array([])
    c = np.cumsum(np.insert(s, 0, 0.0))
    return (c[k:] - c[:-k]) / k


def cluster_boot(values, fn=np.median, n=2000, seed=7):
    v = np.asarray([x for x in values if x is not None and np.isfinite(x)], float)
    if len(v) < 2:
        return None
    rng = np.random.default_rng(seed)
    return [float(np.percentile([fn(v[rng.integers(0, len(v), len(v))]) for _ in range(n)], p))
            for p in (2.5, 97.5)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocks", default="/app/data/mouse_only/SapiMouse_Blocks.h5")
    ap.add_argument("--out", default="/app/artifacts/sapimouse-fcn/oneclass.json")
    ap.add_argument("--epochs", type=int, default=EPOCHS)
    args = ap.parse_args()

    from sklearn.svm import OneClassSVM
    from tensorflow.keras.callbacks import ModelCheckpoint, ReduceLROnPlateau
    from tensorflow.keras.optimizers import Adam
    import tensorflow as tf
    tf.random.set_seed(RANDOM_STATE)

    with h5py.File(args.blocks, "r") as f:
        X = np.array(f["X"], dtype=np.float32)
        subj = np.array(f["subject"])
        sess = np.array(f["session"])

    train_mask = subj <= FCN_SUBJECTS
    eval_users = sorted(np.unique(subj[~train_mask]).tolist())
    train_users = sorted(np.unique(subj[train_mask]).tolist())
    remap = {u: i for i, u in enumerate(train_users)}
    ytr = np.array([remap[s] for s in subj[train_mask]])

    print(f"blocks {X.shape} | FCN subjects {len(train_users)} "
          f"({int(train_mask.sum())} blocks) | eval subjects {len(eval_users)}")
    print(f"FCN: Conv(128,8)-Conv(256,5)-Conv(128,3)-GAP-softmax | "
          f"Adam 1e-4 | batch {BATCH_SIZE} | epochs {args.epochs}")

    # ---- 1. deep feature learning on subjects 1-72 -------------------------
    art = os.path.dirname(args.out)
    os.makedirs(art, exist_ok=True)
    model = build_fcn(X.shape[1:], len(train_users))
    model.compile(optimizer=Adam(learning_rate=1e-4),
                  loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    ckpt = os.path.join(art, "fcn_128_ABS_dx_dy.h5")

    # SHUFFLE BEFORE SPLITTING. Keras `validation_split` slices off the LAST
    # fraction without shuffling, and these blocks arrive ordered by subject —
    # so the validation set became subjects 62-72 while training saw 1-61, and
    # the network was scored on 11 identities it had never been shown. It
    # reported below-chance accuracy for that reason alone, and worse,
    # ReduceLROnPlateau spent 100 epochs steering on that meaningless val_loss.
    # Identification needs every subject on both sides of the split.
    Xtr_all, ytr_all = X[train_mask], ytr
    perm = np.random.default_rng(RANDOM_STATE).permutation(len(Xtr_all))
    Xtr_all, ytr_all = Xtr_all[perm], ytr_all[perm]

    hist = model.fit(
        Xtr_all, ytr_all,
        validation_split=0.15, epochs=args.epochs, batch_size=BATCH_SIZE, verbose=2,
        callbacks=[ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=50, min_lr=1e-6),
                   ModelCheckpoint(ckpt, monitor="val_loss", save_best_only=True)])
    val_acc = float(max(hist.history.get("val_accuracy", [0.0])))
    print(f"\nFCN identification val top-1 = {val_acc:.4f} "
          f"(chance {1/len(train_users):.4f})")
    if val_acc <= 2.0 / len(train_users):
        print("  WARNING: at or near chance — the embedding carries no identity, "
              "so any verification result below is not evidence for this method.")
    print()

    from tensorflow.keras import Model
    embedder = Model(model.input, model.get_layer("embedding").output)

    # ---- 2. one-class verification on subjects 73-120 ----------------------
    E = embedder.predict(X, batch_size=256, verbose=0)
    print(f"embedding dimension {E.shape[1]}\n")
    print(f"{'subject':>8} {'enrol':>6} {'gen':>5} {'imp':>6} "
          + " ".join(f"{'EER@'+str(k):>8}" for k in BLOCK_COUNTS))

    rows = []
    for u in eval_users:
        enrol = E[(subj == u) & (sess == ENROL_SESSION)]
        gen = E[(subj == u) & (sess == TEST_SESSION)]
        if len(enrol) < 5 or len(gen) < 1:
            continue

        # The user's model is built from their OWN enrolment blocks only.
        oc = OneClassSVM(gamma="scale").fit(enrol)

        g_raw = oc.decision_function(gen)
        imp_runs = {}
        for other in eval_users:
            if other == u:
                continue
            oi = (subj == other) & (sess == TEST_SESSION)
            if oi.sum():
                imp_runs[int(other)] = oc.decision_function(E[oi])
        if not imp_runs:
            continue

        # Normalise genuine and impostor together, as the paper does.
        allsc = np.concatenate([g_raw] + list(imp_runs.values()))
        norm = normalise_scores(allsc)
        g = norm[:len(g_raw)]
        off = len(g_raw)
        imp_norm = {}
        for k, v in imp_runs.items():
            imp_norm[k] = norm[off:off + len(v)]
            off += len(v)

        row = {"subject": int(u), "enrolBlocks": int(len(enrol)),
               "genuineBlocks": int(len(g)),
               "impostorSubjects": len(imp_norm),
               "impostorBlocks": int(sum(len(v) for v in imp_norm.values())), "blocks": {}}
        for k in BLOCK_COUNTS:
            gs = sets_of(g, k)
            iss = [sets_of(v, k) for v in imp_norm.values()]
            iss = [a for a in iss if len(a)]
            if len(gs) == 0 or not iss:
                row["blocks"][k] = None
                continue
            i_all = np.concatenate(iss)
            eer, _ = eer_of(gs, i_all)
            row["blocks"][k] = {"eer": float(eer), "auc": float(auc_of(gs, i_all)),
                                "tarAtFar01": float(tar_at_far(gs, i_all, 0.01)[0])}
        # Keep the normalised scores so a POOLED ROC can be computed as well.
        # The two source papers report differently and the numbers are not
        # interchangeable: SapiMouse (util/oneclass.py) extends global score
        # lists inside the per-user loop and computes ONE ROC afterwards, while
        # Antal & Fejer (2020) report "the average performance value and in
        # parenthesis the standard deviation" over users. Pooling mixes score
        # scales between people and normally reads lower, so quoting a
        # per-subject median against a pooled figure would overstate the result.
        row["_genuine"] = g.tolist()
        row["_impostorRuns"] = {str(k): v.tolist() for k, v in imp_norm.items()}
        rows.append(row)
        cells = " ".join(f"{row['blocks'][k]['eer']*100:7.2f}%" if row["blocks"][k]
                         else f"{'-':>8}" for k in BLOCK_COUNTS)
        print(f"{u:>8} {len(enrol):>6} {len(g):>5} {row['impostorBlocks']:>6} {cells}")

    summary = {}
    for k in BLOCK_COUNTS:
        e = [r["blocks"][k]["eer"] for r in rows if r["blocks"].get(k)]
        a = [r["blocks"][k]["auc"] for r in rows if r["blocks"].get(k)]
        t = [r["blocks"][k]["tarAtFar01"] for r in rows if r["blocks"].get(k)]
        if not e:
            continue
        summary[k] = {
            "nSubjects": len(e),
            "eer": {"median": float(np.median(e)), "mean": float(np.mean(e)),
                    "iqr": [float(np.percentile(e, 25)), float(np.percentile(e, 75))],
                    "min": float(np.min(e)), "max": float(np.max(e)),
                    "ci95_median": cluster_boot(e)},
            "auc": {"median": float(np.median(a)), "mean": float(np.mean(a)),
                    "ci95_median": cluster_boot(a)},
            "tarAtFar01": {"median": float(np.median(t)), "ci95_median": cluster_boot(t)},
        }

    with open(args.out, "w") as f:
        json.dump({"perSubject": rows, "summary": summary,
                   "fcnValTop1": val_acc, "epochs": args.epochs,
                   "method": ("Antal, Fejer & Buza (2021), SapiMouse, IEEE SACI, "
                              "doi:10.1109/SACI51354.2021.9465583"),
                   "classifier": "OneClassSVM(gamma='scale') on 128-d FCN embedding",
                   "blockCounts": BLOCK_COUNTS}, f, indent=2)

    print("\n" + "=" * 78)
    print(f"SAPIMOUSE ONE-CLASS VERIFICATION  n={len(rows)} evaluation subjects")
    print("method: Antal, Fejer & Buza 2021 (IEEE SACI) | FCN + OneClassSVM")
    print("=" * 78)
    print(f"{'blocks':>7} {'median EER':>12} {'IQR':>17} {'median AUC':>12} {'CI95 AUC':>18}")
    for k in BLOCK_COUNTS:
        if k not in summary:
            continue
        s = summary[k]
        ci = s["auc"]["ci95_median"]
        print(f"{k:>7} {s['eer']['median']*100:>11.2f}% "
              f"{s['eer']['iqr'][0]*100:>7.2f}-{s['eer']['iqr'][1]*100:<8.2f} "
              f"{s['auc']['median']:>12.3f} {ci[0]:>8.3f}-{ci[1]:<8.3f}")
    print(f"\nthe paper reports 0.94 AUC using 15 s of data on these same 48 subjects")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
