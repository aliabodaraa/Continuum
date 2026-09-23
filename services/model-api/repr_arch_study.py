"""
Experiments A (input representation) and B (architecture) for the mouse channel.

The rules -- arms, protocol, endpoints and the decision procedure -- are fixed in
    artifacts/repr_arch_study/PREREGISTRATION.md
which was written and hashed before any result existed. This file only executes it.
Every output records the pre-registration's SHA-256.

One invocation = one (experiment, arm, seed): train the identification base on the
100 base users, personalise a model for each of the 20 held-out users the way
production does (api.py base-feature-extractor mode, generalised to any
architecture), and persist the RAW score streams -- genuine 1-minute session,
enrolment windows, one contiguous 150-window run per impostor identity -- so the
analysis can apply any threshold or rule without retraining.

Every arm sees exactly the same windows. Steps are produced once by Continuum's
filter and windows are selected once from the raw displacement; only the per-step
columns change between representations.

    python repr_arch_study.py --exp A --arm A3 --seed 0 --out-dir /app/artifacts/repr_arch_study/parts
"""
import argparse
import glob
import hashlib
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preprocessing import FeatureScaler                                         # noqa: E402
from preprocess_mouse import (_read_events, events_to_steps, steps_to_windows,   # noqa: E402
                              IDLE_SPLIT_SECONDS, DROP_ZERO_DISPLACEMENT,
                              DT_CLIP_SECONDS, SCREEN_SCALE, MIN_WINDOW_PATH)
from keystroke_user_sweep import auc_of, eer_of, tar_at_far                      # noqa: E402

WS, STRIDE = 50, 10
BUDGET = 250
IMP_RUN_LEN = 150
NEG_USERS, NEG_PER_USER, NEG_PER_TARGET = 30, 40, 500
BASE_SEEDS = [101, 102, 103]
PREREG = "/app/artifacts/repr_arch_study/PREREGISTRATION.md"
AMENDMENT_1 = "/app/artifacts/repr_arch_study/AMENDMENT_1.md"     # governs Experiment B arms
DATA_DIR = "/app/data/sapimouse"
HOLDOUT = "/app/artifacts/mouse-ws50-aligned/holdout_users.json"


# ================================================================ steps ====
def raw_steps(events):
    """Continuum's step filter (preprocess_mouse.events_to_steps), returning the raw
    per-step quantities every representation is computed from.

    Columns: t_ms, x, y, dx, dy, dt_s, dt_ms, v(px/ms), a(|dv|), dtheta, click_or_drag
    """
    rows, prev, prev_v, prev_dir = [], None, 0.0, None
    for (t, button, state, x, y) in events:
        if prev is None:
            prev, prev_dir, prev_v = (t, x, y), None, 0.0
            continue
        dt_ms = t - prev[0]
        dt = dt_ms / 1000.0
        if dt <= 0:
            prev = (t, x, y)
            continue
        if dt > IDLE_SPLIT_SECONDS:
            prev, prev_dir, prev_v = (t, x, y), None, 0.0
            continue
        dx, dy = x - prev[1], y - prev[2]
        dist = float(np.hypot(dx, dy))
        if DROP_ZERO_DISPLACEMENT and dist == 0.0 and state not in ("Pressed", "Released"):
            continue
        v = dist / max(dt_ms, 1.0)
        a = abs(v - prev_v)
        direction = np.arctan2(dy, dx) if dist > 0 else (prev_dir or 0.0)
        dtheta = 0.0
        if prev_dir is not None and dist > 0:
            d = direction - prev_dir
            dtheta = float((d + np.pi) % (2 * np.pi) - np.pi)
        cd = 1.0 if state in ("Pressed", "Released", "Drag") else 0.0
        rows.append((t, x, y, dx, dy, dt, dt_ms, v, a, dtheta, cd))
        prev, prev_v = (t, x, y), v
        if dist > 0:
            prev_dir = direction
    return np.asarray(rows, np.float64).reshape(-1, 11)


def session_scale(events):
    """Chong's per-screen normalisation proxy: the session's largest coordinate."""
    if not events:
        return 1.0
    return float(max(max(e[3] for e in events), max(e[4] for e in events), 1.0))


# ======================================================= representations ====
def _dt_floor(R):
    return np.maximum(R[:, 6], 1.0) / 1000.0            # seconds, 1 ms floor


REPRESENTATIONS = {
    # key: (description, source, n_features, fn(raw, s) -> (n, F))
    "A1": ("dx/1920, dy/1920, log(1+v), log(1+|dv|), turn/pi, dt, click-or-drag",
           "Continuum (deployed)", 7,
           lambda R, s: np.stack([np.clip(R[:, 3] / SCREEN_SCALE, -1, 1),
                                  np.clip(R[:, 4] / SCREEN_SCALE, -1, 1),
                                  np.log1p(R[:, 7]), np.log1p(R[:, 8]),
                                  R[:, 9] / np.pi, np.minimum(R[:, 5], DT_CLIP_SECONDS),
                                  R[:, 10]], 1)),
    "A2": ("dx, dy, vx, vy", "RUMBA-Mouse [35]", 4,
           lambda R, s: np.stack([R[:, 3], R[:, 4], R[:, 3] / _dt_floor(R),
                                  R[:, 4] / _dt_floor(R)], 1)),
    "A3": ("dx/dt, dy/dt", "Antal & Fejer [37]", 2,
           lambda R, s: np.stack([R[:, 3] / _dt_floor(R), R[:, 4] / _dt_floor(R)], 1)),
    "A4": ("dx, dy", "SapiMouse [2] baseline", 2,
           lambda R, s: np.stack([R[:, 3], R[:, 4]], 1)),
    "A5": ("|dx|, |dy|", "SapiMouse [2] best variant", 2,
           lambda R, s: np.stack([np.abs(R[:, 3]), np.abs(R[:, 4])], 1)),
    "A6": ("x/s, y/s (absolute position)", "Chong et al. [16]", 2,
           lambda R, s: np.stack([R[:, 1] / s, R[:, 2] / s], 1)),
    "A7": ("(dx/s)/dt, (dy/s)/dt", "Chong et al. [16] speed", 2,
           lambda R, s: np.stack([R[:, 3] / s / _dt_floor(R), R[:, 4] / s / _dt_floor(R)], 1)),
    "A8": ("dx/s, dy/s", "Chong et al. [16] position differences", 2,
           lambda R, s: np.stack([R[:, 3] / s, R[:, 4] / s], 1)),
    # Experiment D control (PREREGISTRATION_D.md): A5 divided by a per-session scalar, so a
    # constant per-device gain (mouse DPI, pointer acceleration) cannot separate people. Run it
    # with --scale medstep, which makes `s` the session's median step magnitude.
    "D2": ("|dx|/m, |dy|/m, m = session median step magnitude",
           "Experiment D device-scale control", 2,
           lambda R, s: np.stack([np.abs(R[:, 3]) / s, np.abs(R[:, 4]) / s], 1)),
}


def median_step_magnitude(R):
    """Per-session scale used by Experiment D: median |step| in pixels, floored at 1 px."""
    if not len(R):
        return 1.0
    return float(max(1.0, np.median(np.hypot(R[:, 3], R[:, 4]))))


def window_starts(R):
    """Window selection from the raw displacement, identical for every arm
    (the same MIN_WINDOW_PATH rule as preprocess_mouse.steps_to_windows)."""
    n = len(R)
    if n < WS:
        return []
    ndx = np.clip(R[:, 3] / SCREEN_SCALE, -1, 1)
    ndy = np.clip(R[:, 4] / SCREEN_SCALE, -1, 1)
    step_path = np.hypot(ndx, ndy)
    c = np.concatenate([[0.0], np.cumsum(step_path)])
    return [s for s in range(0, n - WS + 1, STRIDE) if c[s + WS] - c[s] >= MIN_WINDOW_PATH]


def windows(R, s, rep, lo=0, hi=None):
    """Windows over steps [lo, hi) -- selection is done inside the slice, exactly as
    steps_to_windows does on a temporal split."""
    R = R[lo:hi]
    F = REPRESENTATIONS[rep][3](R, s).astype(np.float32) if len(R) else np.zeros((0, 1), np.float32)
    starts = window_starts(R)
    if not starts:
        return np.zeros((0, WS, REPRESENTATIONS[rep][2]), np.float32)
    return np.stack([F[i:i + WS] for i in starts]).astype(np.float32)


def self_check(data_dir, users):
    """A1 must reproduce the deployed preprocessing byte for byte."""
    for u in users:
        for csv in sorted(glob.glob(os.path.join(data_dir, u, "*.csv"))):
            ev = _read_events(csv)
            ref = np.asarray(steps_to_windows(events_to_steps(ev), WS, STRIDE), np.float32)
            got = windows(raw_steps(ev), session_scale(ev), "A1")
            assert ref.shape == got.shape, (csv, ref.shape, got.shape)
            assert np.allclose(ref, got, atol=1e-5), csv
    return True


# ========================================================= architectures ====
def build(arch, shape, n):
    """Every weighted layer is named, so base -> personal weight copy is by name."""
    import tensorflow as tf
    from tensorflow.keras import layers, models
    inp = layers.Input(shape=shape)
    if arch in ("B1", "B2"):
        rnn = layers.GRU if arch == "B1" else layers.LSTM
        x = layers.Conv1D(32, 2, activation="relu", padding="valid", name="conv")(inp)
        x = rnn(32, return_sequences=True, name="rnn1")(x)
        x = layers.Dropout(0.5)(x)
        x = rnn(32, return_sequences=True, name="rnn2")(x)
        x = layers.Dropout(0.5)(x)
        x = layers.Flatten(name="embedding")(x)
    elif arch == "B3":
        x = layers.GRU(32, return_sequences=True, name="rnn1")(inp)
        x = layers.Dropout(0.5)(x)
        x = layers.GRU(32, return_sequences=True, name="rnn2")(x)
        x = layers.Dropout(0.5)(x)
        x = layers.Flatten(name="embedding")(x)
    elif arch == "B4":
        # Chong et al. Sec. IV-C, Fig. 3: two LSTM layers, hidden size 10, dropout 0.3 between,
        # fully connected layer on the last hidden state (Amendment 1).
        x = layers.LSTM(10, return_sequences=True, name="lstm1")(inp)
        x = layers.Dropout(0.3)(x)
        x = layers.LSTM(10, name="embedding")(x)
    elif arch == "B5":
        x = layers.Conv1D(32, 8, activation="relu", name="conv1")(inp)
        x = layers.Conv1D(48, 6, activation="relu", name="conv2")(x)
        x = layers.Conv1D(64, 4, activation="relu", name="conv3")(x)
        x = layers.Bidirectional(layers.LSTM(32, return_sequences=True), name="bilstm1")(x)
        x = layers.Bidirectional(layers.LSTM(32, return_sequences=True), name="bilstm2")(x)
        x = layers.Lambda(lambda z: tf.reduce_sum(z, axis=1), name="embedding")(x)
    elif arch == "B6":
        x = inp
        for i, (f, k) in enumerate([(128, 8), (256, 5), (128, 3)], 1):
            x = layers.Conv1D(f, k, padding="same", name=f"conv{i}")(x)
            x = layers.BatchNormalization(name=f"bn{i}")(x)
            x = layers.Activation("relu")(x)
        x = layers.GlobalAveragePooling1D(name="embedding")(x)
    elif arch == "B7":
        t1 = layers.Conv1D(40, 6, strides=2, activation="relu", name="t1c1")(inp)
        t1 = layers.Conv1D(60, 3, strides=1, activation="relu", name="t1c2")(t1)
        t1 = layers.GlobalMaxPooling1D()(t1)
        t2 = layers.Conv1D(40, 4, strides=2, activation="relu", name="t2c1")(inp)
        t2 = layers.Conv1D(60, 2, strides=1, activation="relu", name="t2c2")(t2)
        t2 = layers.GlobalMaxPooling1D()(t2)
        x = layers.Concatenate()([t1, t2])
        x = layers.Dropout(0.15)(x)
        x = layers.Dense(60, activation="relu", name="embedding")(x)
    elif arch == "B8":
        # Chong et al. Sec. IV-A, Fig. 1: two first-layer convolutions, ONE second-layer
        # convolution with shared weights, global max-pooling, dropout 0.3 (Amendment 1).
        shared = layers.Conv1D(60, 10, strides=2, activation="elu", name="shared_c2")
        t1 = layers.Conv1D(20, 10, strides=3, activation="elu", name="t1c1")(inp)
        t2 = layers.Conv1D(20, 15, strides=3, activation="elu", name="t2c1")(inp)
        t1 = layers.GlobalMaxPooling1D()(shared(t1))
        t2 = layers.GlobalMaxPooling1D()(shared(t2))
        x = layers.Concatenate()([t1, t2])
        x = layers.Dropout(0.3, name="embedding")(x)
    elif arch == "B9":
        # Chong et al. Sec. IV-D, Fig. 4, CNN-LSTM variant 1: two first-layer convolutions,
        # ONE 3-layer stacked LSTM60 (dropout 0.2) with shared weights, last hidden states
        # concatenated, dropout 0.2 (Amendment 1).
        l1 = layers.LSTM(60, return_sequences=True, dropout=0.2, name="shared_lstm1")
        l2 = layers.LSTM(60, return_sequences=True, dropout=0.2, name="shared_lstm2")
        l3 = layers.LSTM(60, dropout=0.2, name="shared_lstm3")
        t1 = layers.Conv1D(20, 10, strides=3, activation="elu", name="t1c1")(inp)
        t2 = layers.Conv1D(20, 15, strides=3, activation="elu", name="t2c1")(inp)
        h1 = l3(l2(l1(t1)))
        h2 = l3(l2(l1(t2)))
        x = layers.Concatenate()([h1, h2])
        x = layers.Dropout(0.2, name="embedding")(x)
    else:
        raise ValueError(arch)
    out = layers.Dense(n, activation="softmax", name="head")(x)
    return models.Model(inp, out)


ARCHS = {
    "B1": ("Conv1D(32,k2) + GRU32 + GRU32", "Lu et al. [1] (deployed)", ["conv"]),
    "B2": ("Conv1D(32,k2) + LSTM32 + LSTM32", "Lu et al. [1] LSTM variant", ["conv"]),
    "B3": ("GRU32 + GRU32 (no CNN)", "ablation of B1", ["rnn1"]),
    "B4": ("2 x LSTM10, dropout 0.3", "Chong et al. [16] (Amendment 1)", ["lstm1"]),
    "B5": ("3 x Conv1D (32k8, 48k6, 64k4) + 2 x BiLSTM32 + sum", "RUMBA-Mouse [35]", ["conv1"]),
    "B6": ("FCN 128/256/128 + GAP", "SapiMouse [2]", ["conv1", "bn1"]),
    "B7": ("two-tower CNN (MCDCNN)", "Antal & Fejer [37]", ["t1c1", "t2c1"]),
    "B8": ("1D-CNN: 2 first convs + shared conv + GMP, ELU", "Chong et al. [16] (Amendment 1)",
           ["t1c1", "t2c1"]),
    "B9": ("CNN-LSTM v1: 2 convs + shared 3 x LSTM60", "Chong et al. [16] (Amendment 1)",
           ["t1c1", "t2c1"]),
}


# =============================================================== training ====
def train_base(arch, Xtr, ytr, Xva, yva, n_cls, seed, epochs=40):
    """train_mouse_base_id.py recipe: Adam, 40 epochs, batch 128, ES 12, plateau 5."""
    import tensorflow as tf
    from tensorflow.keras.callbacks import EarlyStopping, ReduceLROnPlateau
    tf.keras.utils.set_random_seed(seed)
    m = build(arch, Xtr.shape[1:], n_cls)
    m.compile(optimizer="adam", loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    h = m.fit(Xtr, ytr, validation_data=(Xva, yva), epochs=epochs, batch_size=128, verbose=2,
              callbacks=[EarlyStopping(patience=12, monitor="val_loss", restore_best_weights=True),
                         ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=5, min_lr=1e-5)])
    return m, len(h.history["loss"])


def dedupe(X):
    seen, keep = set(), []
    for i, w in enumerate(X):
        k = hashlib.sha1(np.ascontiguousarray(w).tobytes()).hexdigest()
        if k not in seen:
            seen.add(k); keep.append(i)
    return X[keep]


def contiguous_split(n, frac=0.2, gap=5):
    """api.py _contiguous_split: validation from the tail, gap windows dropped."""
    n_val = int(round(n * frac))
    if n < 2 or n_val < 1:
        return np.arange(n), np.arange(0)
    cut = n - n_val
    tr = np.arange(0, max(cut - gap, 0)) if cut - gap > 0 else np.arange(0, cut)
    return tr, np.arange(cut, n)


def personalise(arch, base_w, shape, freeze, pos, neg, seed):
    """api.py base-feature-extractor mode, generalised: copy everything but the head,
    freeze the first learned layer of each branch, Adam 3e-4, 15 epochs, batch 32,
    early stopping 6 on a contiguous 20% tail with a 5-window gap."""
    import tensorflow as tf
    from tensorflow.keras.callbacks import EarlyStopping
    from tensorflow.keras.optimizers import Adam
    tf.keras.backend.clear_session()
    tf.keras.utils.set_random_seed(seed)
    m = build(arch, shape, 2)
    for l in m.layers:
        if l.name in base_w and l.name != "head":
            l.set_weights(base_w[l.name])
    for name in freeze:
        m.get_layer(name).trainable = False
    pos, neg = dedupe(pos), dedupe(neg)
    ptr, pva = contiguous_split(len(pos))
    ntr, nva = contiguous_split(len(neg))
    Xtr = np.concatenate([pos[ptr], neg[ntr]]); ytr = np.r_[np.ones(len(ptr)), np.zeros(len(ntr))].astype(int)
    Xva = np.concatenate([pos[pva], neg[nva]]); yva = np.r_[np.ones(len(pva)), np.zeros(len(nva))].astype(int)
    order = np.random.default_rng(7).permutation(len(Xtr))
    Xtr, ytr = Xtr[order], ytr[order]
    m.compile(optimizer=Adam(learning_rate=3e-4), loss="sparse_categorical_crossentropy")
    h = m.fit(Xtr, ytr, validation_data=(Xva, yva), epochs=15, batch_size=32, verbose=0,
              callbacks=[EarlyStopping(patience=6, restore_best_weights=True, monitor="val_loss")])
    return m, len(h.history["loss"])


# =================================================================== main ====
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--exp", choices=["A", "B"], required=True)
    ap.add_argument("--arm", required=True, help="A1..A8 for exp A, B1..B9 for exp B")
    ap.add_argument("--rep", default=None, help="exp B: the representation Experiment A adopted")
    ap.add_argument("--seed", type=int, required=True, choices=[0, 1, 2])
    ap.add_argument("--threads", type=int, default=5)
    ap.add_argument("--limit", type=int, default=0, help="smoke test: first N targets only")
    ap.add_argument("--base-epochs", type=int, default=40, help="smoke test only; 40 is the protocol")
    ap.add_argument("--out-dir", default="/app/artifacts/repr_arch_study/parts")
    ap.add_argument("--self-check", action="store_true")
    ap.add_argument("--scale", choices=["maxcoord", "medstep"], default="maxcoord",
                    help="what the per-session scalar `s` means: the session's largest coordinate "
                         "(Chong's proxy, used by A6-A8) or its median step magnitude "
                         "(Experiment D control)")
    args = ap.parse_args()

    import tensorflow as tf
    tf.config.threading.set_intra_op_parallelism_threads(args.threads)
    tf.config.threading.set_inter_op_parallelism_threads(2)

    prereg_sha = hashlib.sha256(open(PREREG, "rb").read()).hexdigest()
    amend_sha = (hashlib.sha256(open(AMENDMENT_1, "rb").read()).hexdigest()
                 if args.exp == "B" else None)
    rep = args.arm if args.exp == "A" else args.rep
    arch = "B1" if args.exp == "A" else args.arm
    assert rep in REPRESENTATIONS and arch in ARCHS, (rep, arch)
    seed = BASE_SEEDS[args.seed]
    tag = f"{args.exp}_{args.arm}_s{args.seed}" + (f"_{rep}" if args.exp == "B" else "")
    print(f"[{tag}] representation {rep} = {REPRESENTATIONS[rep][0]} | architecture {arch} = "
          f"{ARCHS[arch][0]} | prereg {prereg_sha[:12]}")

    holdout = json.load(open(HOLDOUT))["holdout_users"]
    uids = sorted((os.path.basename(d) for d in glob.glob(os.path.join(DATA_DIR, "user*"))),
                  key=lambda u: int(u[4:]))
    base_users = [u for u in uids if u not in holdout]
    if args.self_check:
        self_check(DATA_DIR, holdout[:3] + base_users[:3])
        print("self-check: A1 reproduces the deployed windows exactly")

    def sessions(u):
        cs = sorted(glob.glob(os.path.join(DATA_DIR, u, "*.csv")))
        lo = [c for c in cs if "3min" in os.path.basename(c)]
        sh = [c for c in cs if "1min" in os.path.basename(c)]
        return (lo[0] if lo else None), (sh[0] if sh else None)

    def load(csv):
        ev = _read_events(csv)
        R = raw_steps(ev)
        return R, (median_step_magnitude(R) if args.scale == "medstep" else session_scale(ev))

    # ---- base material ----
    Xtr, ytr, Xva, yva, Xte, yte = [], [], [], [], [], []
    for ci, u in enumerate(base_users):
        lo, sh = sessions(u)
        if not lo or not sh:
            continue
        R, s = load(lo)
        cut = int(len(R) * 0.8)
        a, b = windows(R, s, rep, 0, cut), windows(R, s, rep, cut, None)
        Xtr.append(a); ytr += [ci] * len(a); Xva.append(b); yva += [ci] * len(b)
        Rs, ss = load(sh)
        c = windows(Rs, ss, rep)
        Xte.append(c); yte += [ci] * len(c)
    Xtr, Xva, Xte = np.concatenate(Xtr), np.concatenate(Xva), np.concatenate(Xte)
    ytr, yva, yte = np.asarray(ytr), np.asarray(yva), np.asarray(yte)
    remap = {c: i for i, c in enumerate(sorted(set(ytr.tolist())))}
    ytr = np.asarray([remap[c] for c in ytr]); yva = np.asarray([remap[c] for c in yva])
    yte = np.asarray([remap.get(c, -1) for c in yte])
    scaler = FeatureScaler.fit(Xtr)
    Xtr, Xva, Xte = scaler.transform(Xtr), scaler.transform(Xva), scaler.transform(Xte)
    print(f"base: train {Xtr.shape} val {Xva.shape} test {Xte.shape} classes {len(remap)}")

    t0 = time.time()
    base, base_epochs = train_base(arch, Xtr, ytr, Xva, yva, len(remap), seed, args.base_epochs)
    ok = yte >= 0
    top1 = float((base.predict(Xte[ok], batch_size=1024, verbose=0).argmax(1) == yte[ok]).mean())
    base_w = {l.name: l.get_weights() for l in base.layers if l.get_weights()}
    base_secs = time.time() - t0
    print(f"base trained {base_epochs} epochs in {base_secs/60:.1f} min | identification top-1 "
          f"on the base users' 1-min session {top1:.4f} (chance {1/len(remap):.4f})")

    # ---- negatives (base users only) ----
    rng = np.random.default_rng(21)
    neg_parts = []
    for u in rng.choice(base_users, size=NEG_USERS, replace=False):
        lo, _ = sessions(u)
        R, s = load(lo)
        w = windows(R, s, rep)
        if len(w):
            neg_parts.append(w[rng.choice(len(w), size=min(NEG_PER_USER, len(w)), replace=False)])
    neg_pool = scaler.transform(np.concatenate(neg_parts))

    # ---- evaluation material ----
    targets, imp = [], {}
    for u in holdout:
        lo, sh = sessions(u)
        gen = None
        if sh:
            R, s = load(sh)
            w = windows(R, s, rep)
            if len(w):
                imp[u] = scaler.transform(w[:IMP_RUN_LEN])
                gen = scaler.transform(w)
        if lo and sh and gen is not None:
            R, s = load(lo)
            w = windows(R, s, rep)
            if len(w) >= BUDGET:
                targets.append((u, scaler.transform(w[:BUDGET]), gen))
    if args.limit:
        targets = targets[:args.limit]

    rows = []
    nrng = np.random.default_rng(1000 + args.seed)
    freeze = ARCHS[arch][2]
    params = None
    for u, enrol, gen in targets:
        t1 = time.time()
        negs = neg_pool[nrng.choice(len(neg_pool), size=NEG_PER_TARGET, replace=False)]
        m, ep = personalise(arch, base_w, Xtr.shape[1:], freeze, enrol, negs, seed + 7)
        params = int(m.count_params())
        P = lambda X: m.predict(X, batch_size=1024, verbose=0)[:, 1]
        g, e = P(gen), P(enrol)
        runs = {o: P(X) for o, X in imp.items() if o != u}
        i = np.concatenate(list(runs.values()))
        rows.append({"participant": u, "epochs": ep, "auc": float(auc_of(g, i)),
                     "eer": float(eer_of(g, i)[0]), "tarAtFar01": float(tar_at_far(g, i, 0.01)[0]),
                     "_genuineScores": g.tolist(), "_enrolScores": e.tolist(),
                     "_impostorRuns": {o: r.tolist() for o, r in runs.items()},
                     "secs": round(time.time() - t1, 1)})
        print(f"  {u:>8}  AUC {rows[-1]['auc']:.3f}  EER {rows[-1]['eer']*100:5.1f}%  "
              f"epochs {ep:>2}  {rows[-1]['secs']:.0f}s")

    os.makedirs(args.out_dir, exist_ok=True)
    out = os.path.join(args.out_dir, f"{tag}.json")
    with open(out, "w") as f:
        json.dump({"preregistrationSha256": prereg_sha, "amendment1Sha256": amend_sha,
                   "exp": args.exp, "arm": args.arm,
                   "representation": rep, "representationDesc": REPRESENTATIONS[rep][0],
                   "representationSource": REPRESENTATIONS[rep][1],
                   "nFeatures": REPRESENTATIONS[rep][2], "architecture": arch,
                   "architectureDesc": ARCHS[arch][0], "architectureSource": ARCHS[arch][1],
                   "frozen": freeze, "sessionScale": args.scale,
                   "seedIndex": args.seed, "baseSeed": seed,
                   "baseEpochs": base_epochs, "baseMinutes": round(base_secs / 60, 2),
                   "baseTop1": top1, "perUserModelParams": params, "nTargets": len(rows),
                   "perUser": rows}, f)
    print(f"wrote {out}  (median AUC {np.median([r['auc'] for r in rows]):.3f})")


if __name__ == "__main__":
    main()
