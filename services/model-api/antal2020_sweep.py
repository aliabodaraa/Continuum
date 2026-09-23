"""
Per-user mouse authentication following

  Antal, M., & Fejer, N. (2020). Mouse dynamics based user recognition using
  deep learning. Acta Universitatis Sapientiae, Informatica, 12(1), 39-50.
  https://doi.org/10.2478/ausi-2020-0003          [open access]

Architecture and hyper-parameters come from the authors' released code
(github.com/norbertFejer/AFE_Project), because the paper gives the network only
as a figure. models/cnnModel.py:

    tower 1:  Conv1D(40, k=6, stride 2, relu) -> Conv1D(60, k=3, stride 1, relu)
              -> GlobalMaxPooling1D
    tower 2:  Conv1D(40, k=4, stride 2, relu) -> Conv1D(60, k=2, stride 1, relu)
              -> GlobalMaxPooling1D
    concatenate(120) -> Dropout(0.15) -> Dense(60, relu)   <- embedding
    -> Dense(n) sigmoid for binary, softmax for multiclass
    Adam(lr=0.002, decay=1e-4), batch 32, validation_split 0.15

  config/settings.py  sel_scaling_method = STANDARD_SCALER, sel_scaling_type = ACTION_BASED:
                      each block z-scored on its own statistics (--protocol afe).
                      --protocol legacy keeps the global max-abs of src/dataset.py's
                      session-based option, which the first run used.

TWO DIVERGENCES BETWEEN THE PAPER AND ITS OWN CODE
--------------------------------------------------
  * epochs: the paper's 3.2 says "16 epochs were used"; cnnModel.py says 160.
  * activations: the paper says "We used the sigmoid activation function";
    the code uses relu throughout and sigmoid only on a binary output layer.
We follow the CODE and record the divergence rather than silently choosing.

WHAT WE DO DIFFERENTLY, AND WHY
-------------------------------
The paper evaluates on Balabit (10 users), splitting each user's own sessions
chronologically. We keep Continuum's stricter protocol on SapiMouse (120
users): a set of subjects is held out of representation learning entirely, each
held-out subject enrols on its 3-min session and is tested on its 1-min
session, and its impostors are the OTHER held-out subjects. Ten subjects cannot
support a population claim; 120 can.

REPORTING
---------
Three statistics, because the two source papers use different ones and a reader
may hold up either:
  * mean +/- std of per-user AUC     - Antal & Fejer (2020) Tables 4-5 style
  * median + IQR + bootstrap CI      - robust to the bimodal user population
  * POOLED ROC over all subjects     - SapiMouse (2021) util/oneclass.py style
Pooling mixes score scales between people and normally reads lower, so quoting
a per-user median against a pooled figure would overstate the result.

Run inside the model-api container:
    python antal2020_sweep.py --out /app/artifacts/antal2020/sweep.json
"""
import argparse
import json
import os
import sys

import h5py
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from keystroke_user_sweep import auc_of, eer_of, tar_at_far  # noqa: E402

BLOCK_COUNTS = [1, 2, 3, 4, 5]
BATCH_SIZE = 32              # cnnModel.py
LEARNING_RATE = 0.002        # cnnModel.py
DECAY = 1e-4                 # cnnModel.py
DROPOUT = 0.15               # cnnModel.py / paper 3.2
EMBED_UNITS = 60             # cnnModel.py Dense(60)
PAPER_EPOCHS = 16            # paper 3.2 (code says 160 — divergence recorded)
ENROL_SESSION, TEST_SESSION = 1, 0     # 1 = 3-min enrol, 0 = 1-min test


def build_mcdcnn(input_shape, n_classes):
    """models/cnnModel.py, layer for layer."""
    from tensorflow.keras import layers, models

    inp = layers.Input(shape=input_shape)
    t1 = layers.Conv1D(40, 6, strides=2, activation="relu")(inp)
    t1 = layers.Conv1D(60, 3, strides=1, activation="relu")(t1)
    t1 = layers.GlobalMaxPooling1D()(t1)

    t2 = layers.Conv1D(40, 4, strides=2, activation="relu")(inp)
    t2 = layers.Conv1D(60, 2, strides=1, activation="relu")(t2)
    t2 = layers.GlobalMaxPooling1D()(t2)

    x = layers.Concatenate()([t1, t2])
    x = layers.Dropout(DROPOUT)(x)
    x = layers.Dense(EMBED_UNITS, activation="relu", name="embedding")(x)
    act = "sigmoid" if n_classes == 2 else "softmax"
    out = layers.Dense(n_classes, activation=act)(x)
    return models.Model(inp, out)


def compile_model(m, n_classes):
    from tensorflow.keras.optimizers import Adam
    try:
        opt = Adam(learning_rate=LEARNING_RATE, decay=DECAY)
    except (TypeError, ValueError):
        # Keras 2.11+ removed `decay` from the new optimizer and raises
        # ValueError. The legacy optimizer still honours it, which keeps us on
        # the authors' setting instead of silently dropping their schedule.
        try:
            from tensorflow.keras.optimizers.legacy import Adam as LegacyAdam
            opt = LegacyAdam(learning_rate=LEARNING_RATE, decay=DECAY)
        except Exception:
            opt = Adam(learning_rate=LEARNING_RATE)
    m.compile(optimizer=opt, loss="sparse_categorical_crossentropy",
              metrics=["accuracy"])
    return m


# ---------------------------------------------------------------------------
# Per-user training exactly as AFE_Project trains it (the repository named by
# Antal & Fejer 2020 as its reproducibility artefact). Sources, verbatim:
#
#   models/cnnModel.py  build_model   nb_classes == 2 -> Dense(2, sigmoid),
#                                     loss='binary_crossentropy' on one-hot labels
#                       train_model   nb_epochs, mini_batch_size = 160, 32
#                                     fit(..., validation_split=0.15, shuffle=False)
#   models/baseModel.py AUTHENTICATION + CLASSIFIER_MCDCNN callbacks:
#                       ReduceLROnPlateau(monitor='val_loss', factor=0.5,
#                                         patience=15, min_lr=0.0001)
#                       ModelCheckpoint(monitor='loss', save_best_only=True)
#                       EarlyStopping(monitor='loss', min_delta=0.01,
#                                     patience=45, restore_best_weights=False)
#   src/evaluateModel.py evaluates 'best_' + model_name, i.e. the CHECKPOINT
#                        with the lowest TRAINING loss, not the last epoch.
#
# Two consequences of their code, reproduced on purpose and recorded here:
#   * Their training array is concatenate(positives, negatives) and nothing
#     shuffles it before fit(validation_split=0.15, shuffle=False). Keras takes
#     the validation split from the END of the array, so their validation set
#     is NEGATIVES ONLY, and ReduceLROnPlateau watches a loss with no genuine
#     samples in it.
#   * shuffle=False means every epoch sees class-ordered batches: all positive
#     batches, then all negative ones.
# Callers must therefore pass X as concatenate(positives, negatives).
#
# The checkpoint is held in memory rather than written to disk and reloaded;
# the weights evaluated are identical.
# ---------------------------------------------------------------------------
AFE_EPOCHS = 160            # cnnModel.train_model (the paper's text says 16)
AFE_VAL_SPLIT = 0.15        # cnnModel.train_model


def zscore_per_block(X):
    """settings.py STANDARD_SCALER + ACTION_BASED: each block standardised on its
    OWN per-feature mean and std over its timesteps (dataset.__standard_scaler
    applied block by block in __action_based_scaling). Their zero-std guard is
    0.0001, ours 1.0; the numerator is 0 whenever the std is 0, so the output
    is identical."""
    mu = X.mean(axis=1, keepdims=True)
    sd = X.std(axis=1, keepdims=True)
    sd[sd == 0] = 1.0
    return ((X - mu) / sd).astype(np.float32)


def afe_train(m, X, y, epochs=AFE_EPOCHS):
    """Compile and fit a 2-class MCDCNN the way AFE_Project does; leaves the
    model holding the lowest-training-loss weights, which is what their
    evaluation loads."""
    from tensorflow.keras.callbacks import Callback, EarlyStopping, ReduceLROnPlateau
    from tensorflow.keras.utils import to_categorical
    from tensorflow.keras.optimizers import Adam
    try:
        opt = Adam(learning_rate=LEARNING_RATE, decay=DECAY)
    except (TypeError, ValueError):
        try:
            from tensorflow.keras.optimizers.legacy import Adam as LegacyAdam
            opt = LegacyAdam(learning_rate=LEARNING_RATE, decay=DECAY)
        except Exception:
            opt = Adam(learning_rate=LEARNING_RATE)
    m.compile(loss="binary_crossentropy", optimizer=opt, metrics=["binary_accuracy"])

    class _BestTrainLoss(Callback):
        """ModelCheckpoint(monitor='loss', save_best_only=True), in memory."""
        def on_train_begin(self, logs=None):
            self.best, self.w = np.inf, None

        def on_epoch_end(self, epoch, logs=None):
            loss = (logs or {}).get("loss")
            if loss is not None and loss < self.best:
                self.best, self.w = loss, self.model.get_weights()

    best = _BestTrainLoss()
    h = m.fit(X, to_categorical(y, 2), batch_size=BATCH_SIZE,
              validation_split=AFE_VAL_SPLIT, epochs=epochs, shuffle=False, verbose=0,
              callbacks=[ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=15,
                                           min_lr=0.0001),
                         best,
                         EarlyStopping(monitor="loss", min_delta=0.01, patience=45,
                                       restore_best_weights=False)])
    if best.w is not None:
        m.set_weights(best.w)
    return h


def maxabs_fit(X):
    """src/dataset.py default scaler: divide by per-feature max |value|."""
    m = np.max(np.abs(X.reshape(-1, X.shape[-1])), axis=0)
    m[m == 0] = 1.0
    return m


def sets_of(scores, k):
    s = np.asarray(scores, float)
    if k <= 1:
        return s
    if len(s) < k:
        return np.array([])
    c = np.cumsum(np.insert(s, 0, 0.0))
    return (c[k:] - c[:-k]) / k


def cluster_boot(v, fn=np.median, n=2000, seed=7):
    v = np.asarray([x for x in v if x is not None and np.isfinite(x)], float)
    if len(v) < 2:
        return None
    rng = np.random.default_rng(seed)
    st = [fn(v[rng.integers(0, len(v), len(v))]) for _ in range(n)]
    return [float(np.percentile(st, 2.5)), float(np.percentile(st, 97.5))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocks", default="/app/data/mouse_only/Antal2020_Blocks.h5")
    ap.add_argument("--holdout", default="/app/artifacts/mouse-ws50-gru/holdout_users.json")
    ap.add_argument("--out", default="/app/artifacts/antal2020/sweep.json")
    ap.add_argument("--pretrain-epochs", type=int, default=60)
    ap.add_argument("--user-epochs", type=int, default=PAPER_EPOCHS)
    ap.add_argument("--seed", type=int, default=42)      # constants.py RANDOM_STATE
    ap.add_argument("--protocol", choices=["afe", "legacy"], default="afe",
                    help="afe = per-user training and scaling exactly as AFE_Project; "
                         "legacy = the earlier run (16 epochs, no callbacks, global max-abs)")
    ap.add_argument("--scaling", choices=["auto", "zscore_block", "maxabs"], default="auto",
                    help="auto = whatever --protocol implies; the other two override it, "
                         "to separate the effect of scaling from that of training")
    args = ap.parse_args()

    from tensorflow.keras.callbacks import EarlyStopping
    from tensorflow.keras import Model
    import tensorflow as tf
    tf.random.set_seed(args.seed)

    with h5py.File(args.blocks, "r") as f:
        X = np.array(f["X"], dtype=np.float32)
        subj = np.array(f["subject"])
        sess = np.array(f["session"])

    holdout = [int("".join(c for c in str(u) if c.isdigit()))
               for u in json.load(open(args.holdout))["holdout_users"]]
    all_users = sorted(np.unique(subj).tolist())
    base_users = [u for u in all_users if u not in holdout]
    base_mask = np.isin(subj, base_users)

    # Scaler is fitted on BASE blocks only — held-out subjects contribute
    # nothing to it, so no statistic crosses the subject boundary.
    scaling = args.scaling if args.scaling != "auto" else (
        "zscore_block" if args.protocol == "afe" else "maxabs")
    if scaling == "zscore_block":
        # settings.py: STANDARD_SCALER + ACTION_BASED -- per-block z-score. Each
        # block uses only its own statistics, so nothing crosses a subject boundary.
        Xs = zscore_per_block(X)
    else:
        scale = maxabs_fit(X[base_mask])
        Xs = (X / scale).astype(np.float32)

    print(f"blocks {X.shape} | base subjects {len(base_users)} | holdout {len(holdout)}")
    print(f"MCDCNN towers (40,k6,s2)+(60,k3) / (40,k4,s2)+(60,k2) -> Dense({EMBED_UNITS})")
    print(f"Adam lr={LEARNING_RATE} decay={DECAY} batch={BATCH_SIZE} "
          f"| pretrain {args.pretrain_epochs}ep | per-user "
          + (f"{AFE_EPOCHS}ep max, AFE callbacks + best-loss checkpoint" if args.protocol == "afe" else f"{args.user_epochs}ep"))
    print("scaling: per-block z-score (settings.py STANDARD_SCALER + ACTION_BASED)" if scaling == "zscore_block"
          else f"max-abs scale fitted on base subjects: {scale}")
    print()

    # ---- representation learning on base subjects (TRANSFER2 pre-training) --
    remap = {u: i for i, u in enumerate(base_users)}
    yb = np.array([remap[s] for s in subj[base_mask]])
    Xb = Xs[base_mask]
    perm = np.random.default_rng(args.seed).permutation(len(Xb))   # never split by subject order
    Xb, yb = Xb[perm], yb[perm]

    pre = compile_model(build_mcdcnn(Xs.shape[1:], len(base_users)), len(base_users))
    hist = pre.fit(Xb, yb, validation_split=0.15, epochs=args.pretrain_epochs,
                   batch_size=BATCH_SIZE, verbose=2,
                   callbacks=[EarlyStopping(patience=15, monitor="val_loss",
                                            restore_best_weights=True)])
    pre_acc = float(max(hist.history.get("val_accuracy", [0.0])))
    print(f"\nrepresentation learning: identification val top-1 = {pre_acc:.4f} "
          f"(chance {1/len(base_users):.4f})")
    if pre_acc <= 2.0 / len(base_users):
        print("  WARNING: at chance — embeddings carry no identity.")
    print()

    # ---- per-user binary authentication (paper 4.3) ------------------------
    print(f"{'subject':>8} {'enrol':>6} {'gen':>5} {'imp':>6} "
          + " ".join(f"{'AUC@'+str(k):>8}" for k in BLOCK_COUNTS))
    rows = []
    neg_pool_idx = np.where(base_mask)[0]
    rng = np.random.default_rng(args.seed)

    for u in holdout:
        enrol = Xs[(subj == u) & (sess == ENROL_SESSION)]
        gen = Xs[(subj == u) & (sess == TEST_SESSION)]
        if len(enrol) < 10 or len(gen) < 2:
            continue
        # "the same number of positive and negative data" (paper 4.3)
        negs = Xs[rng.choice(neg_pool_idx, size=min(len(enrol), len(neg_pool_idx)),
                             replace=False)]
        Xtr = np.concatenate([enrol, negs], 0)
        ytr = np.concatenate([np.ones(len(enrol)), np.zeros(len(negs))]).astype(int)

        # TRANSFER2: start from the pre-trained representation, then update.
        m = build_mcdcnn(Xs.shape[1:], 2)
        for i in range(len(m.layers) - 1):
            w = pre.layers[i].get_weights()
            if w and [a.shape for a in w] == [a.shape for a in m.layers[i].get_weights()]:
                m.layers[i].set_weights(w)
        if args.protocol == "afe":
            afe_train(m, Xtr, ytr)      # Xtr is concatenate(positives, negatives)
        else:
            compile_model(m, 2)
            m.fit(Xtr, ytr, epochs=args.user_epochs, batch_size=BATCH_SIZE, verbose=0)

        g = m.predict(gen, verbose=0)[:, 1]
        imp_runs = {}
        for other in holdout:
            if other == u:
                continue
            oi = (subj == other) & (sess == TEST_SESSION)
            if oi.sum():
                imp_runs[int(other)] = m.predict(Xs[oi], verbose=0)[:, 1]
        if not imp_runs:
            continue

        row = {"subject": int(u), "enrolBlocks": int(len(enrol)),
               "genuineBlocks": int(len(g)), "impostorSubjects": len(imp_runs),
               "impostorBlocks": int(sum(len(v) for v in imp_runs.values())),
               "blocks": {}, "_genuine": g.tolist(),
               "_impostorRuns": {str(k): v.tolist() for k, v in imp_runs.items()}}
        for k in BLOCK_COUNTS:
            gs = sets_of(g, k)
            iss = [sets_of(v, k) for v in imp_runs.values()]
            iss = [a for a in iss if len(a)]
            if len(gs) == 0 or not iss:
                row["blocks"][k] = None
                continue
            ia = np.concatenate(iss)
            row["blocks"][k] = {"auc": float(auc_of(gs, ia)),
                                "eer": float(eer_of(gs, ia)[0]),
                                "tarAtFar01": float(tar_at_far(gs, ia, 0.01)[0])}
        rows.append(row)
        cells = " ".join(f"{row['blocks'][k]['auc']:8.3f}" if row["blocks"][k]
                         else f"{'-':>8}" for k in BLOCK_COUNTS)
        print(f"{u:>8} {len(enrol):>6} {len(g):>5} {row['impostorBlocks']:>6} {cells}")

    # ---- three reporting styles -------------------------------------------
    summary = {}
    for k in BLOCK_COUNTS:
        a = [r["blocks"][k]["auc"] for r in rows if r["blocks"].get(k)]
        e = [r["blocks"][k]["eer"] for r in rows if r["blocks"].get(k)]
        if not a:
            continue
        pg, pi = [], []
        for r in rows:
            gs = sets_of(r["_genuine"], k)
            iss = [sets_of(v, k) for v in r["_impostorRuns"].values()]
            iss = [x for x in iss if len(x)]
            if len(gs) and iss:
                pg.extend(gs.tolist()); pi.extend(np.concatenate(iss).tolist())
        pooled_auc = float(auc_of(np.array(pg), np.array(pi))) if pg and pi else None
        pooled_eer = float(eer_of(np.array(pg), np.array(pi))[0]) if pg and pi else None
        summary[k] = {
            "nSubjects": len(a),
            "aucMean": float(np.mean(a)), "aucStd": float(np.std(a)),
            "aucMedian": float(np.median(a)),
            "aucIQR": [float(np.percentile(a, 25)), float(np.percentile(a, 75))],
            "aucCI95Median": cluster_boot(a),
            "aucPooled": pooled_auc,
            "eerMedian": float(np.median(e)), "eerPooled": pooled_eer,
        }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump({"perSubject": rows, "summary": summary,
                   "pretrainValTop1": pre_acc,
                   "method": ("Antal & Fejer (2020), Acta Univ. Sapientiae Informatica "
                              "12(1):39-50, doi:10.2478/ausi-2020-0003"),
                   "architectureSource": "github.com/norbertFejer/AFE_Project models/cnnModel.py",
                   "paperCodeDivergence": {"epochs": {"paper": 16, "code": 160,
                                                      "used": AFE_EPOCHS if args.protocol == "afe" else args.user_epochs}},
                   "protocol": args.protocol,
                   "scaling": scaling,
                   "blockCounts": BLOCK_COUNTS}, f, indent=2)

    print("\n" + "=" * 86)
    print(f"ANTAL & FEJER (2020) METHOD ON SAPIMOUSE  n={len(rows)} held-out subjects")
    print("=" * 86)
    print(f"{'blocks':>7} {'mean+/-std':>16} {'median':>9} {'IQR':>15} {'POOLED':>9} {'med EER':>9}")
    for k in BLOCK_COUNTS:
        if k not in summary:
            continue
        s = summary[k]
        print(f"{k:>7} {s['aucMean']:>9.3f}+/-{s['aucStd']:<5.3f} {s['aucMedian']:>9.3f} "
              f"{s['aucIQR'][0]:>6.3f}-{s['aucIQR'][1]:<7.3f} {s['aucPooled']:>9.3f} "
              f"{s['eerMedian']*100:>8.2f}%")
    print("\nthe paper reports mean+/-std of per-user AUC; its best on Balabit is 0.98 (0.02).")
    print("the POOLED column is the SapiMouse (2021) reporting style, shown so the two")
    print("are never confused; pooling mixes score scales and normally reads lower.")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
