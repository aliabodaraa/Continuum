"""
Controlled architecture benchmark for the Continuum mouse channel.

THE QUESTION
------------
Which published, reproducible mouse-dynamics approach gives the strongest
foundation for Continuum's actual task: PER-USER VERIFICATION with open
enrolment, where a new user supplies only their own samples and is later
checked against behaviour the system has never seen from anyone.

Closed-set identification accuracy is NOT that task and is not used here as a
decision criterion. (An earlier experiment in this project compared 100-way
top-1 accuracy and drew an architecture conclusion from it; that inference was
invalid and this file exists to replace it.)

WHY A FACTORIAL, NOT THREE ARMS
-------------------------------
The three candidate "architectures" confound two separable factors:

    arm                         extractor        verification head
    Lu et al. (deployed)        CNN + 2xGRU      binary head (needs negatives)
    Antal & Fejer               two-tower CNN    binary head (needs negatives)
    SapiMouse                   FCN              One-Class SVM (positives only)

Comparing SapiMouse against the deployed arm therefore varies BOTH the
representation learner and the decision rule at once. If it wins we could not
say which factor was responsible -- and the head is the factor carrying the
operational consequence (whether enrolment needs other people's data).

So all three extractors are crossed with both heads: 3 x 2 = 6 cells. The three
published combinations are a subset; the remaining three isolate each factor.

WHAT IS HELD CONSTANT ACROSS ALL SIX CELLS
------------------------------------------
  * the same 20 held-out users, taken from the deployed model's
    holdout_users.json so results stay comparable with prior sweeps
  * the same 100 base users for representation learning
  * the same window representation (50 steps x 7 features)
  * ONE scaler, fitted once on base training data
  * the same temporal 80/20 split of each base user's 3-minute session
  * the same enrolment budget: the first 250 windows of the target's 3-minute
    session, in temporal order
  * the same genuine test material: the target's separate 1-minute session
  * the same impostor construction: ONE CONTIGUOUS RUN of 150 windows per
    impostor identity, never pooled and never thinned
  * the same negative pool for the binary-head cells
  * frozen extractor + trained head for every cell (see DEVIATIONS)
  * the same metrics, thresholding rule and bootstrap procedure

INHERENT ASYMMETRY THAT IS NOT CONTROLLED, AND MUST NOT BE
----------------------------------------------------------
The binary head sees the target's 250 positives AND a pool of negatives drawn
from base users. The One-Class SVM sees only the 250 positives -- by design; it
is a one-class method. Equalising this would destroy the method under test.
It is reported as a property of the approach, not corrected away, and it is
precisely the property that matters for open enrolment.

DEVIATIONS FROM PRODUCTION AND FROM THE PUBLISHED METHODS
---------------------------------------------------------
1. Production fine-tunes part of the recurrent stack (api.py freezes only the
   Conv1D layers). Here EVERY extractor is frozen whole and only the head is
   fitted, identically for all six cells. Fair comparison requires it; it means
   the deployed arm's number here is not its production number.
2. Antal & Fejer's two-tower CNN was designed for 128-event blocks of 2 speed
   features. Run on 50 x 7 windows the towers reduce 50 -> 23 -> 21 and
   50 -> 24 -> 23 before pooling, so the receptive-field-to-sequence ratio
   differs from the published setting. The architecture is preserved; its
   operating regime is not. This is a documented risk to validity, and the
   corresponding native-representation result exists separately.
3. SapiMouse's FCN ends in Global Average Pooling, which is length-agnostic,
   so the method transfers to 50 x 7 without structural change. Their published
   input is (dx, dy) over 128 events; ours is 7 derived features over 50 steps.
   The method (FCN embedding -> One-Class SVM) is preserved intact.
4. Embedding dimensionality differs by construction (Flatten vs Dense(60) vs
   GAP-128). Embeddings are standardised on enrolment data before the head, so
   no cell is advantaged purely by scale. Dimensionality itself is reported.

Run inside the model-api container:
    python arch_verification_bench.py --out /app/artifacts/xai/arch_bench.json
"""
import argparse
import glob
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preprocessing import FeatureScaler                                       # noqa: E402
from preprocess_mouse import events_to_steps, steps_to_windows, _read_events   # noqa: E402
from keystroke_user_sweep import auc_of, eer_of, tar_at_far                    # noqa: E402

WS, STRIDE = 50, 10
IMP_RUN_LEN = 150          # contiguous windows per impostor identity
NEG_USERS, NEG_PER_USER = 30, 40
VOTE_K, VOTE_M = 20, 15    # the deployed sustained rule: 15 low of the last 20


# ----------------------------------------------------------------- data ----
def session_csvs(data_dir, uid):
    csvs = sorted(glob.glob(os.path.join(data_dir, uid, "*.csv")))
    long_s = [c for c in csvs if "3min" in os.path.basename(c)]
    short_s = [c for c in csvs if "1min" in os.path.basename(c)]
    return (long_s[0] if long_s else None), (short_s[0] if short_s else None)


def windows_of(csv):
    if csv is None:
        return np.empty((0, WS, 7), np.float32)
    return np.asarray(steps_to_windows(events_to_steps(_read_events(csv)), WS, STRIDE),
                      np.float32)


def split_temporal(csv, frac=0.8):
    steps = events_to_steps(_read_events(csv))
    cut = int(len(steps) * frac)
    return (np.asarray(steps_to_windows(steps[:cut], WS, STRIDE), np.float32),
            np.asarray(steps_to_windows(steps[cut:], WS, STRIDE), np.float32))


# ----------------------------------------------------- extractor factory ----
def make_extractors():
    """(key, builder, embedding-layer-name, description) for each candidate."""
    from tensorflow.keras import layers, models

    def lu(shape, n):
        m = models.Sequential([
            layers.Input(shape=shape),
            layers.Conv1D(32, 2, activation="relu", padding="valid"),
            layers.GRU(32, return_sequences=True),
            layers.Dropout(0.5),
            layers.GRU(32, return_sequences=True),
            layers.Dropout(0.5),
            layers.Flatten(name="embedding"),
            layers.Dense(n, activation="softmax"),
        ])
        return m

    def antal(shape, n):
        from antal2020_sweep import build_mcdcnn
        return build_mcdcnn(shape, n)          # Dense(60, name='embedding')

    def fcn(shape, n, num_filters=128):
        """SapiMouse util/fcn.py build_fcn, layer for layer."""
        inp = layers.Input(shape=shape)
        x = layers.Conv1D(num_filters, 8, padding="same")(inp)
        x = layers.BatchNormalization()(x); x = layers.Activation("relu")(x)
        x = layers.Conv1D(2 * num_filters, 5, padding="same")(x)
        x = layers.BatchNormalization()(x); x = layers.Activation("relu")(x)
        x = layers.Conv1D(num_filters, 3, padding="same")(x)
        x = layers.BatchNormalization()(x); x = layers.Activation("relu")(x)
        x = layers.GlobalAveragePooling1D(name="embedding")(x)
        out = layers.Dense(n, activation="softmax")(x)
        return models.Model(inp, out)

    return [
        ("lu_cnn_gru", lu, "Lu et al. 2020 (keystroke) - Conv1D(32,k2) + 2x GRU(32)"),
        ("antal_twotower", antal, "Antal & Fejer 2020 (mouse) - two-tower 1D CNN"),
        ("sapi_fcn", fcn, "SapiMouse 2021 (mouse) - FCN, GAP-128 embedding"),
    ]


def train_extractor(build, Xtr, ytr, Xva, yva, n_cls, epochs, batch, seed):
    import tensorflow as tf
    from tensorflow.keras import Model
    from tensorflow.keras.callbacks import EarlyStopping, ReduceLROnPlateau
    tf.keras.backend.clear_session()
    tf.random.set_seed(seed)

    m = build(Xtr.shape[1:], n_cls)
    m.compile(optimizer="adam", loss="sparse_categorical_crossentropy",
              metrics=["accuracy"])
    m.fit(Xtr, ytr, validation_data=(Xva, yva), epochs=epochs, batch_size=batch,
          callbacks=[EarlyStopping(patience=10, monitor="val_loss",
                                   restore_best_weights=True, verbose=0),
                     ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=4,
                                       min_lr=1e-5, verbose=0)],
          verbose=2)
    emb = Model(m.input, m.get_layer("embedding").output)
    return emb


# ------------------------------------------------------------- the heads ----
def head_binary(E_pos, E_neg, E_eval, seed):
    """Continuum's current head: a small supervised classifier over the frozen
    embedding, requiring NEGATIVES from other identities."""
    import tensorflow as tf
    from tensorflow.keras import layers, models
    tf.keras.backend.clear_session()
    tf.random.set_seed(seed)

    X = np.concatenate([E_pos, E_neg], 0)
    y = np.concatenate([np.ones(len(E_pos)), np.zeros(len(E_neg))]).astype(int)
    h = models.Sequential([layers.Input(shape=(X.shape[1],)),
                           layers.Dense(2, activation="softmax")])
    h.compile(optimizer="adam", loss="sparse_categorical_crossentropy")
    h.fit(X, y, epochs=15, batch_size=32, verbose=0)
    return {k: h.predict(v, batch_size=1024, verbose=0)[:, 1] for k, v in E_eval.items()}


def head_ocsvm(E_pos, E_neg, E_eval, seed):
    """SapiMouse's head: One-Class SVM fitted on the TARGET'S OWN embeddings
    only. E_neg is accepted and deliberately ignored -- that is the point."""
    from sklearn.svm import OneClassSVM
    oc = OneClassSVM(gamma="scale").fit(E_pos)
    return {k: oc.decision_function(v) for k, v in E_eval.items()}


HEADS = [("binary", head_binary, "supervised binary head - REQUIRES negatives"),
         ("ocsvm", head_ocsvm, "One-Class SVM - target's own samples only")]


# ------------------------------------------------------------- decisions ----
def fire_vote(seq, tau, k=VOTE_K, m=VOTE_M):
    """Fraction of k-window packets in which >= m windows fall below tau."""
    s = np.asarray(seq, dtype=float)
    if len(s) < k:
        return None
    low = (s < tau).astype(int)
    fires = [1 if low[i:i + k].sum() >= m else 0 for i in range(len(s) - k + 1)]
    return float(np.mean(fires)) if fires else None


def decision_rates(gen, imp_runs, tau):
    """false-lock on the genuine stream; capture across impostor runs."""
    fl = fire_vote(gen, tau)
    caught = [fire_vote(r, tau) for r in imp_runs.values()]
    caught = [c for c in caught if c is not None]
    return fl, (float(np.mean(caught)) if caught else None)


def paired_bootstrap(a, b, n=4000, seed=17):
    """Percentile CI on the median paired difference (b - a), resampling USERS."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    a, b = a[ok], b[ok]
    if len(a) < 3:
        return None
    d = b - a
    rng = np.random.default_rng(seed)
    stat = [np.median(d[rng.integers(0, len(d), len(d))]) for _ in range(n)]
    lo, hi = np.percentile(stat, 2.5), np.percentile(stat, 97.5)
    # two-sided bootstrap p for "median difference is zero"
    p = 2 * min((np.asarray(stat) <= 0).mean(), (np.asarray(stat) >= 0).mean())
    return {"medianDiff": float(np.median(d)), "ci95": [float(lo), float(hi)],
            "pBoot": float(min(1.0, p)), "nUsers": int(len(d)),
            "favoursB": int((d > 0).sum()), "favoursA": int((d < 0).sum())}


def holm(pvals):
    """Holm-Bonferroni adjusted p-values, order preserved."""
    idx = np.argsort(pvals); adj = np.empty(len(pvals)); run = 0.0
    for rank, i in enumerate(idx):
        run = max(run, (len(pvals) - rank) * pvals[i])
        adj[i] = min(1.0, run)
    return adj.tolist()


# ------------------------------------------------------------------ main ----
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="/app/data/sapimouse")
    ap.add_argument("--art", default="/app/artifacts/mouse-ws50-aligned")
    ap.add_argument("--out", default="/app/artifacts/xai/arch_bench.json")
    ap.add_argument("--budget", type=int, default=250)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch-size", type=int, default=64)
    ap.add_argument("--seeds", type=int, default=2)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    with open(os.path.join(args.art, "holdout_users.json")) as f:
        holdout = json.load(f)["holdout_users"]
    uids = [os.path.basename(d) for d in sorted(
        glob.glob(os.path.join(args.data_dir, "user*")),
        key=lambda p: int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0))]
    base_users = [u for u in uids if u not in holdout]

    # ---- representation-learning material (base users only) ----
    Xtr, ytr, Xva, yva = [], [], [], []
    for ci, uid in enumerate(base_users):
        long_s, short_s = session_csvs(args.data_dir, uid)
        if not long_s or not short_s:
            continue
        head, tail = split_temporal(long_s)
        Xtr.extend(head); ytr.extend([ci] * len(head))
        Xva.extend(tail); yva.extend([ci] * len(tail))
    Xtr = np.asarray(Xtr, np.float32); ytr = np.asarray(ytr, np.int64)
    Xva = np.asarray(Xva, np.float32); yva = np.asarray(yva, np.int64)
    n_cls = len(set(ytr.tolist()))

    scaler = FeatureScaler.fit(Xtr)                    # ONE scaler for everything
    Xtr, Xva = scaler.transform(Xtr), scaler.transform(Xva)
    print(f"base users {len(base_users)} | classes {n_cls} | train {Xtr.shape} val {Xva.shape}")

    # ---- negative pool for the binary-head cells (base users only) ----
    rng = np.random.default_rng(21)
    neg_parts = []
    for u in rng.choice(base_users, size=min(NEG_USERS, len(base_users)), replace=False):
        w = windows_of(session_csvs(args.data_dir, u)[0])
        if len(w):
            neg_parts.append(w[rng.choice(len(w), size=min(NEG_PER_USER, len(w)),
                                          replace=False)])
    neg_pool = scaler.transform(np.concatenate(neg_parts, 0))
    print(f"negative pool {neg_pool.shape} (binary head only; OCSVM never sees it)")

    # ---- evaluation material, built ONCE and shared by every cell ----
    targets, imp_pool = [], {}
    for u in holdout:
        long_s, short_s = session_csvs(args.data_dir, u)
        sw = windows_of(short_s)
        if len(sw):
            imp_pool[u] = scaler.transform(sw[:IMP_RUN_LEN])
        lw = windows_of(long_s)
        if len(lw) >= args.budget and len(sw):
            targets.append({"uid": u,
                            "enrol": scaler.transform(lw[:args.budget]),
                            "genuine": scaler.transform(sw)})
    if args.limit:
        targets = targets[:args.limit]
    print(f"targets {len(targets)} | impostor identities {len(imp_pool)}")
    print(f"budget {args.budget} windows | impostor run {IMP_RUN_LEN} | vote {VOTE_M}-of-{VOTE_K}\n")

    cells = {}
    for seed in range(args.seeds):
        for ekey, build, edesc in make_extractors():
            print("=" * 78); print(f"[seed {seed}] {edesc}"); print("=" * 78)
            emb = train_extractor(build, Xtr, ytr, Xva, yva, n_cls,
                                  args.epochs, args.batch_size, 101 + seed)
            EMB = lambda W: emb.predict(W, batch_size=512, verbose=0)
            E_neg_all = EMB(neg_pool)
            E_imp_all = {k: EMB(v) for k, v in imp_pool.items()}
            dim = int(E_neg_all.shape[1])
            print(f"  embedding dim = {dim}")

            for hkey, head_fn, hdesc in HEADS:
                key = f"{ekey}+{hkey}"
                rows = []
                for t in targets:
                    t0 = time.time()
                    E_pos = EMB(t["enrol"])
                    # standardise on ENROLMENT statistics only -- no test leakage
                    mu, sd = E_pos.mean(0, keepdims=True), E_pos.std(0, keepdims=True) + 1e-8
                    z = lambda M: (M - mu) / sd
                    negs = E_neg_all[rng.choice(len(E_neg_all),
                                                size=min(2 * args.budget, len(E_neg_all)),
                                                replace=False)]
                    ev = {"gen": z(EMB(t["genuine"])), "enrol": z(E_pos)}
                    for oid, Ei in E_imp_all.items():
                        if oid != t["uid"]:
                            ev[f"imp::{oid}"] = z(Ei)
                    out = head_fn(z(E_pos), z(negs), ev, seed=101 + seed)

                    g = np.asarray(out["gen"], float)
                    imp_runs = {k.split("::", 1)[1]: np.asarray(v, float)
                                for k, v in out.items() if k.startswith("imp::")}
                    i = np.concatenate(list(imp_runs.values())) if imp_runs else np.array([])
                    if not len(g) or not len(i):
                        continue

                    # Operating threshold from ENROLMENT ONLY. Never from test
                    # material, and identical in FORM for every cell, so no arm is
                    # advantaged by where its scores happen to sit on the number
                    # line: tau is the 10th percentile of the head's scores on the
                    # target's own enrolment windows. A deployed system can compute
                    # exactly this at enrolment time.
                    tau = float(np.percentile(np.asarray(out["enrol"], float), 10))
                    fl, caught = decision_rates(g, imp_runs, tau)

                    eer, _ = eer_of(g, i)
                    rows.append({
                        "participant": t["uid"], "eer": float(eer), "auc": float(auc_of(g, i)),
                        "tarAtFar01": float(tar_at_far(g, i, 0.01)[0]),
                        "tarAtFar05": float(tar_at_far(g, i, 0.05)[0]),
                        "farAtTau": float((i >= tau).mean()), "tarAtTau": float((g >= tau).mean()),
                        "decisionFalseLock": fl, "decisionCaught": caught,
                        "embeddingDim": dim, "secs": round(time.time() - t0, 1),
                        # RAW STREAMS. Persisted so any decision rule can be
                        # re-evaluated without retraining. The deployed 15-of-20
                        # rule was tuned on the incumbent architecture's own score
                        # distribution, so using it alone to compare architectures
                        # would favour the incumbent. Keeping the streams lets the
                        # whole rule family be swept per architecture instead.
                        "_tau": tau,
                        "_genuineScores": g.tolist(),
                        "_impostorRuns": {k: v.tolist() for k, v in imp_runs.items()},
                        "_enrolScores": np.asarray(out["enrol"], float).tolist(),
                    })
                    print(f"   {key:<26} {t['uid']:>8}  AUC {rows[-1]['auc']:.3f} "
                          f"EER {rows[-1]['eer']*100:5.1f}%  FL {('--' if fl is None else f'{fl*100:5.1f}%')} "
                          f"CAP {('--' if caught is None else f'{caught*100:5.1f}%')}")
                cells.setdefault(key, {"extractor": ekey, "head": hkey,
                                       "description": f"{edesc} | {hdesc}",
                                       "bySeed": {}})["bySeed"][str(seed)] = rows
                print()

    out = {"task": "per-user verification on held-out users (open enrolment)",
           "design": "3 extractors x 2 verification heads, everything else held constant",
           "heldConstant": ["holdout users", "base users", "representation (50x7)",
                            "single shared scaler", "enrolment budget", "genuine test session",
                            "contiguous impostor runs", "negative pool", "frozen extractor",
                            "metrics", "threshold rule", "bootstrap"],
           "inherentAsymmetry": "binary head sees negatives; OCSVM sees only the target's "
                                "own samples -- inherent to a one-class method, reported not corrected",
           "voteRule": f"{VOTE_M}-of-{VOTE_K}", "cells": cells}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
