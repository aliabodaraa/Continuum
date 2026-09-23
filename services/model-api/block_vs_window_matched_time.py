"""
Antal & Fejer's method IN ITS NATIVE FORM against the deployed window pipeline,
under Continuum's verification protocol, compared at MATCHED OBSERVATION TIME.

WHY THIS EXPERIMENT EXISTS
--------------------------
Every previous comparison of these two was unfair in one direction or the other:

  * the architecture benchmark ported their two-tower CNN onto OUR 50-step
    windows, i.e. ran it outside the 128-event regime it was designed for;
  * the block sweep ran their method natively but under a different protocol
    from the window sweep, so the two numbers were never comparable.

Neither answered the question that actually matters: if Antal & Fejer's method
is used exactly as published -- their segmentation, their speed representation,
their architecture -- does it beat the deployed pipeline on Continuum's task?

THE UNIT PROBLEM, AND HOW IT IS SOLVED
--------------------------------------
A 128-event block observes a median 2.88 s of movement. A 50-step window
observes 1.16 s. One block is therefore worth ~2.5 windows of evidence, and any
per-unit comparison silently hands the block method 2.5x the information.

So nothing here is reported per unit. Both arms are:

  * ENROLLED on the same wall-clock span of the target's 3-minute session
    (ENROL_SECONDS), not on the same number of units;
  * AGGREGATED over k units and reported against the SECONDS those k units
    span, so the two curves are read off the same x-axis.

EVERYTHING ELSE IS HELD CONSTANT
--------------------------------
Same 20 held-out users and same 100 base users (from the deployed model's
holdout_users.json), same temporal 80/20 split for representation learning, the
target's separate 1-minute session as genuine test material, contiguous impostor
runs of matched duration per identity, frozen extractor with a fitted binary head
in both arms, and the same metrics and bootstrap.

    python block_vs_window_matched_time.py --out /app/artifacts/xai/block_vs_window.json
"""
import argparse
import glob
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preprocessing import FeatureScaler                                        # noqa: E402
from preprocess_antal2020 import read_events, split_sequences, sequence_to_speeds, BLOCK_SIZE  # noqa: E402
from preprocess_mouse import events_to_steps, steps_to_windows, _read_events    # noqa: E402
from keystroke_user_sweep import auc_of, eer_of, tar_at_far                     # noqa: E402

WS, STRIDE = 50, 10
ENROL_GRID = [30.0, 60.0, 120.0, 170.0]   # seconds of accumulated enrolment
ENROL_SECONDS = ENROL_GRID[-1]            # material loaded up to the largest budget
IMP_SECONDS = 90.0         # identical contiguous impostor exposure per identity
K_GRID = [1, 2, 3, 4, 5, 6, 8, 10]


# ------------------------------------------------------------- builders ----
def blocks_with_time(csv):
    """Antal & Fejer blocks: (N,128,2) speeds, plus each block's duration."""
    ev = read_events(csv)
    X, dur = [], []
    for seq in split_sequences(ev):
        sp = sequence_to_speeds(seq)
        t = np.asarray([e[0] for e in seq], float)
        # sequence_to_speeds drops the first event and any bad rows, so align on
        # the shorter length rather than assuming a 1:1 correspondence.
        n = min(len(sp), len(t) - 1) // BLOCK_SIZE
        for b in range(n):
            X.append(sp[b * BLOCK_SIZE:(b + 1) * BLOCK_SIZE])
            seg = t[b * BLOCK_SIZE:(b + 1) * BLOCK_SIZE + 1]
            dur.append(float(seg[-1] - seg[0]) if len(seg) > 1 else 0.0)
    if not X:
        return np.empty((0, BLOCK_SIZE, 2), np.float32), np.empty(0)
    # Blocks are non-overlapping, so cumulative movement time is the running sum
    # of their durations; idle gaps between sequences are correctly excluded.
    return np.asarray(X, np.float32), np.cumsum(np.asarray(dur, float))


def windows_with_time(csv):
    """Deployed windows: (N,50,7), plus the CUMULATIVE movement time covered.

    Windows overlap at stride 10, so summing their individual durations
    overcounts elapsed time by roughly 5x. What matters for a matched-time
    comparison is the union of the steps the first i+1 windows cover, which is
    steps [0, WS + i*STRIDE). The cumulative dt over that range is the real
    amount of movement the arm has been shown.
    """
    steps = events_to_steps(_read_events(csv))
    W = np.asarray(steps_to_windows(steps, WS, STRIDE), np.float32)
    if not len(W):
        return W, np.empty(0)
    dt = np.asarray([s[5] for s in steps], float)
    cum = np.cumsum(dt)
    idx = np.minimum(WS + np.arange(len(W)) * STRIDE - 1, len(cum) - 1)
    return W, cum[idx]                               # cumulative, not per-unit


def take_seconds(X, cum, budget):
    """Leading units covering `budget` seconds of movement.

    `cum` is already cumulative elapsed time per unit -- computed differently for
    overlapping and non-overlapping units, which is the whole point.
    """
    if not len(X):
        return X
    n = int(np.searchsorted(np.asarray(cum, float), budget) + 1)
    return X[:min(n, len(X))]


# --------------------------------------------------------------- models ----
def build_twotower(shape, n):
    from antal2020_sweep import build_mcdcnn
    return build_mcdcnn(shape, n)


def build_cnn_gru(shape, n):
    from tensorflow.keras import layers, models
    return models.Sequential([
        layers.Input(shape=shape),
        layers.Conv1D(32, 2, activation="relu", padding="valid"),
        layers.GRU(32, return_sequences=True), layers.Dropout(0.5),
        layers.GRU(32, return_sequences=True), layers.Dropout(0.5),
        layers.Flatten(name="embedding"),
        layers.Dense(n, activation="softmax"),
    ])


def train_base(build, Xtr, ytr, Xva, yva, n_cls, epochs, seed):
    import tensorflow as tf
    from tensorflow.keras import Model
    from tensorflow.keras.callbacks import EarlyStopping, ReduceLROnPlateau
    tf.keras.backend.clear_session(); tf.random.set_seed(seed)
    m = build(Xtr.shape[1:], n_cls)
    m.compile(optimizer="adam", loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    m.fit(Xtr, ytr, validation_data=(Xva, yva), epochs=epochs, batch_size=64,
          callbacks=[EarlyStopping(patience=10, monitor="val_loss",
                                   restore_best_weights=True, verbose=0),
                     ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=4,
                                       min_lr=1e-5, verbose=0)], verbose=2)
    name = "embedding" if any(l.name == "embedding" for l in m.layers) else "feature_layer"
    try:
        emb = Model(m.input, m.get_layer(name).output)
    except ValueError:
        emb = Model(m.input, m.layers[-2].output)
    return emb


def head_scores(E_pos, E_neg, E_eval, seed):
    import tensorflow as tf
    from tensorflow.keras import layers, models
    tf.keras.backend.clear_session(); tf.random.set_seed(seed)
    mu, sd = E_pos.mean(0, keepdims=True), E_pos.std(0, keepdims=True) + 1e-8
    z = lambda M: (M - mu) / sd
    X = np.concatenate([z(E_pos), z(E_neg)], 0)
    y = np.concatenate([np.ones(len(E_pos)), np.zeros(len(E_neg))]).astype(int)
    h = models.Sequential([layers.Input(shape=(X.shape[1],)),
                           layers.Dense(2, activation="softmax")])
    h.compile(optimizer="adam", loss="sparse_categorical_crossentropy")
    h.fit(X, y, epochs=15, batch_size=32, verbose=0)
    return {k: h.predict(z(v), batch_size=1024, verbose=0)[:, 1] for k, v in E_eval.items()}


def sets_of(scores, k):
    """Mean over consecutive, NON-overlapping groups of k units."""
    s = np.asarray(scores, float)
    n = len(s) // k
    return s[:n * k].reshape(n, k).mean(1) if n else np.array([])


# ----------------------------------------------------------------- main ----
def run_arm(name, builder, loader, data_dir, holdout, base_users, epochs, seed, unit_secs):
    """Returns {budget_seconds: [per-user rows]} -- base trained once, reused."""
    print("=" * 88); print(f"ARM: {name}"); print("=" * 88)

    Xtr, ytr, Xva, yva = [], [], [], []
    for ci, uid in enumerate(base_users):
        cs = sorted(glob.glob(os.path.join(data_dir, uid, "*.csv")))
        long_s = [c for c in cs if "3min" in os.path.basename(c)]
        if not long_s:
            continue
        X, _ = loader(long_s[0])
        if len(X) < 5:
            continue
        cut = int(len(X) * 0.8)
        Xtr.extend(X[:cut]); ytr.extend([ci] * cut)
        Xva.extend(X[cut:]); yva.extend([ci] * (len(X) - cut))
    Xtr = np.asarray(Xtr, np.float32); ytr = np.asarray(ytr, np.int64)
    Xva = np.asarray(Xva, np.float32); yva = np.asarray(yva, np.int64)
    remap = {c: i for i, c in enumerate(sorted(set(ytr.tolist())))}
    ytr = np.asarray([remap[c] for c in ytr]); yva = np.asarray([remap.get(c, 0) for c in yva])
    n_cls = len(remap)
    scaler = FeatureScaler.fit(Xtr)
    Xtr, Xva = scaler.transform(Xtr), scaler.transform(Xva)
    print(f"  train {Xtr.shape} val {Xva.shape} classes {n_cls}")

    emb = train_base(builder, Xtr, ytr, Xva, yva, n_cls, epochs, seed)
    EMB = lambda W: emb.predict(scaler.transform(W), batch_size=512, verbose=0)

    rng = np.random.default_rng(21)
    neg_parts = []
    for u in rng.choice(base_users, size=min(30, len(base_users)), replace=False):
        cs = sorted(glob.glob(os.path.join(data_dir, u, "*.csv")))
        long_s = [c for c in cs if "3min" in os.path.basename(c)]
        if long_s:
            X, _ = loader(long_s[0])
            if len(X):
                X = X[rng.choice(len(X), size=min(40, len(X)), replace=False)]
                neg_parts.append(X)
    E_neg_all = EMB(np.concatenate(neg_parts, 0))

    imp = {}
    for u in holdout:
        cs = sorted(glob.glob(os.path.join(data_dir, u, "*.csv")))
        short_s = [c for c in cs if "1min" in os.path.basename(c)]
        if short_s:
            X, d = loader(short_s[0])
            X = take_seconds(X, d, IMP_SECONDS)
            if len(X):
                imp[u] = EMB(X)

    by_budget = {}
    for budget in ENROL_GRID:
        rows = []
        for uid in holdout:
            cs = sorted(glob.glob(os.path.join(data_dir, uid, "*.csv")))
            long_s = [c for c in cs if "3min" in os.path.basename(c)]
            short_s = [c for c in cs if "1min" in os.path.basename(c)]
            if not long_s or not short_s:
                continue
            Xl, dl = loader(long_s[0]); Xs, _ = loader(short_s[0])
            enrol = take_seconds(Xl, dl, budget)
            if len(enrol) < 8 or len(Xs) < 4:
                continue
            E_pos = EMB(enrol)
            negs = E_neg_all[rng.choice(len(E_neg_all),
                                        size=min(2 * len(E_pos), len(E_neg_all)),
                                        replace=False)]
            ev = {"gen": EMB(Xs)}
            for o, E in imp.items():
                if o != uid:
                    ev["imp::" + o] = E
            out = head_scores(E_pos, negs, ev, seed)
            g = np.asarray(out["gen"], float)
            runs = {k.split("::", 1)[1]: np.asarray(v, float)
                    for k, v in out.items() if k.startswith("imp::")}
            if not len(g) or not runs:
                continue
            row = {"participant": uid, "enrolUnits": int(len(enrol)),
                   "enrolSeconds": float(dl[len(enrol) - 1]), "byK": {}}
            for k in K_GRID:
                gs = sets_of(g, k)
                iss = np.concatenate([sets_of(r, k) for r in runs.values()
                                      if len(sets_of(r, k))]) if runs else np.array([])
                if len(gs) < 2 or len(iss) < 2:
                    row["byK"][k] = None
                    continue
                row["byK"][k] = {"seconds": round(k * unit_secs, 2),
                                 "auc": float(auc_of(gs, iss)),
                                 "eer": float(eer_of(gs, iss)[0]),
                                 "tarAtFar01": float(tar_at_far(gs, iss, 0.01)[0])}
            rows.append(row)
        med_units = int(np.median([r["enrolUnits"] for r in rows])) if rows else 0
        a1 = [r["byK"][1]["auc"] for r in rows if r["byK"].get(1)]
        print(f"  budget {budget:>6.0f}s  ->  {len(rows):>2} users, median {med_units:>4} units, "
              f"median AUC@1 {np.median(a1):.3f}" if a1 else f"  budget {budget}s -> no rows")
        by_budget[budget] = rows
    return by_budget


def summarise(rows, k):
    v = [r["byK"][k] for r in rows if r["byK"].get(k)]
    if len(v) < 3:
        return None
    def q(key):
        a = np.array([x[key] for x in v], float)
        rng = np.random.default_rng(7)
        st = [np.median(a[rng.integers(0, len(a), len(a))]) for _ in range(3000)]
        return {"median": float(np.median(a)),
                "ci95": [float(np.percentile(st, 2.5)), float(np.percentile(st, 97.5))]}
    return {"n": len(v), "seconds": v[0]["seconds"],
            "auc": q("auc"), "eer": q("eer"), "tarAtFar01": q("tarAtFar01")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="/app/data/sapimouse")
    ap.add_argument("--art", default="/app/artifacts/mouse-ws50-aligned")
    ap.add_argument("--out", default="/app/artifacts/xai/block_vs_window.json")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--seed", type=int, default=101)
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    with open(os.path.join(args.art, "holdout_users.json")) as f:
        holdout = json.load(f)["holdout_users"]
    uids = [os.path.basename(d) for d in sorted(
        glob.glob(os.path.join(args.data_dir, "user*")),
        key=lambda p: int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0))]
    base_users = [u for u in uids if u not in holdout]
    print(f"base {len(base_users)} | holdout {len(holdout)} | enrol budget {ENROL_SECONDS}s "
          f"| impostor exposure {IMP_SECONDS}s per identity\n")

    arms = {
        "antal_blocks_native": run_arm(
            "Antal & Fejer (2020) NATIVE: 128-event blocks, speeds, two-tower CNN",
            build_twotower, blocks_with_time, args.data_dir, holdout, base_users,
            args.epochs, args.seed, unit_secs=2.88),
        "deployed_windows": run_arm(
            "Deployed: 50-step windows, 7 features, CNN + 2x GRU",
            build_cnn_gru, windows_with_time, args.data_dir, holdout, base_users,
            args.epochs, args.seed, unit_secs=1.16),
    }

    out = {"question": "Antal & Fejer as published vs the deployed pipeline, at matched "
                       "observation time, swept over accumulated enrolment",
           "unitSeconds": {"block": 2.88, "window": 1.16},
           "enrolGrid": ENROL_GRID, "impostorSeconds": IMP_SECONDS,
           "note": "Continuum retrains on all accumulated enrolment sessions, so a single "
                   "budget would have been the wrong premise; this sweeps it.",
           "arms": {a: {str(b): {"perUser": rows,
                                 "summary": {str(kk): summarise(rows, kk) for kk in K_GRID}}
                        for b, rows in by_b.items()}
                    for a, by_b in arms.items()}}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump(out, open(args.out, "w"), indent=2)

    print("\n" + "=" * 92)
    print("AUC vs SECONDS OBSERVED, at each accumulated-enrolment budget (median over users)")
    print("=" * 92)
    for budget in ENROL_GRID:
        print(f"\n--- enrolment {budget:.0f}s " + "-" * 62)
        print(f"{'arm':<22}{'units':>7}{'k':>4}{'sec':>7}{'AUC':>8}{'95% CI':>18}{'EER%':>7}{'T@F1%':>7}")
        for name, by_b in arms.items():
            rows = by_b.get(budget, [])
            if not rows:
                continue
            u = int(np.median([r["enrolUnits"] for r in rows]))
            for k in (1, 3, 5, 8):
                sm = summarise(rows, k)
                if not sm:
                    continue
                ci = sm["auc"]["ci95"]
                print(f"{name:<22}{u:>7}{k:>4}{sm['seconds']:>7.1f}{sm['auc']['median']:>8.3f}"
                      f"{f'[{ci[0]:.3f},{ci[1]:.3f}]':>18}"
                      f"{sm['eer']['median']*100:>7.1f}{sm['tarAtFar01']['median']*100:>7.1f}")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
