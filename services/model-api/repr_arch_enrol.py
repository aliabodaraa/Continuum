"""
Experiment C: enrolment amount x where personalisation runs, for the adopted pipeline.

Rules: artifacts/repr_arch_study/PREREGISTRATION_C.md (hash recorded in every output).
One invocation = one base seed: the base is trained once, then for each of the 19 targets and
each enrolment budget two personal models are built from the SAME enrolment windows and the
SAME 500 negatives:
    M1 server     repr_arch_study.personalise (api.py base-feature-extractor mode)
    M2 on-device  replica of extension/src/trainer.js: frozen extractor up to 'embedding',
                  Dense(2) head, Adam 0.002, 25 epochs, batch 32, genuine oversampled with
                  +-0.006 raw jitter, first pass pristine; no truncation of genuine windows.
Raw score streams are persisted, as in Experiments A/B.

    python repr_arch_enrol.py --arch B8 --seed 0
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
from repr_arch_study import (build, ARCHS, REPRESENTATIONS, windows, raw_steps, session_scale,  # noqa: E402
                             _read_events, train_base, personalise, dedupe, FeatureScaler,
                             IMP_RUN_LEN, NEG_USERS, NEG_PER_USER, NEG_PER_TARGET, BASE_SEEDS,
                             DATA_DIR, HOLDOUT)
from keystroke_user_sweep import auc_of                                                         # noqa: E402

REP = "A5"
BUDGETS = [55, 110, 220, 330, 440]
PREREG_C = "/app/artifacts/repr_arch_study/PREREGISTRATION_C.md"
JITTER = 0.006


def augment(gen_raw, target, rng):
    """trainer.js augment(): cycle through the genuine windows until `target` copies exist;
    copies after the first pass get uniform +-JITTER on every continuous column (A5 has no
    flag column, so both columns). Unlike the shipped code, never truncate: if there are more
    genuine windows than `target`, all of them are kept."""
    n = max(target, len(gen_raw))
    out = []
    for i in range(n):
        w = gen_raw[i % len(gen_raw)].copy()
        if i >= len(gen_raw):
            w = w + rng.uniform(-JITTER, JITTER, size=w.shape)
        out.append(w)
    return np.asarray(out, np.float32)


def on_device(base, scaler, enrol_raw, neg_raw, seed):
    """trainer.js train(): features from the frozen extractor, then a Dense(2) softmax head."""
    import tensorflow as tf
    from tensorflow.keras import Model, layers, models
    from tensorflow.keras.optimizers import Adam
    tf.keras.utils.set_random_seed(seed)
    extractor = Model(base.input, base.get_layer("embedding").output)
    gen = augment(enrol_raw, len(neg_raw), np.random.default_rng(seed))
    X = np.concatenate([scaler.transform(gen), scaler.transform(neg_raw)])
    Y = np.r_[np.ones(len(gen)), np.zeros(len(neg_raw))].astype(int)
    F = extractor.predict(X, batch_size=512, verbose=0).reshape(len(X), -1)
    head = models.Sequential([layers.Input(shape=(F.shape[1],)), layers.Dense(2, activation="softmax")])
    head.compile(optimizer=Adam(learning_rate=0.002), loss="sparse_categorical_crossentropy")
    head.fit(F, Y, epochs=25, batch_size=32, shuffle=True, verbose=0)
    return lambda Xs: head.predict(extractor.predict(Xs, batch_size=1024, verbose=0)
                                   .reshape(len(Xs), -1), batch_size=1024, verbose=0)[:, 1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", required=True, help="the architecture Experiment B adopted")
    ap.add_argument("--seed", type=int, required=True, choices=[0, 1, 2])
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0, help="smoke test only")
    ap.add_argument("--base-epochs", type=int, default=40, help="smoke test only; 40 is the protocol")
    ap.add_argument("--out-dir", default="/app/artifacts/repr_arch_study/parts")
    args = ap.parse_args()

    import tensorflow as tf
    tf.config.threading.set_intra_op_parallelism_threads(args.threads)
    tf.config.threading.set_inter_op_parallelism_threads(2)
    sha = hashlib.sha256(open(PREREG_C, "rb").read()).hexdigest()
    arch, seed = args.arch, BASE_SEEDS[args.seed]
    assert arch in ARCHS
    tag = f"C_{arch}_s{args.seed}"
    print(f"[{tag}] representation {REP} | architecture {arch} = {ARCHS[arch][0]} | prereg C {sha[:12]}")

    holdout = json.load(open(HOLDOUT))["holdout_users"]
    uids = sorted((os.path.basename(d) for d in glob.glob(os.path.join(DATA_DIR, "user*"))),
                  key=lambda u: int(u[4:]))
    base_users = [u for u in uids if u not in holdout]

    def sessions(u):
        cs = sorted(glob.glob(os.path.join(DATA_DIR, u, "*.csv")))
        lo = [c for c in cs if "3min" in os.path.basename(c)]
        sh = [c for c in cs if "1min" in os.path.basename(c)]
        return (lo[0] if lo else None), (sh[0] if sh else None)

    def win(csv):
        ev = _read_events(csv)
        return raw_steps(ev), session_scale(ev)

    # ---- base: identical construction to Experiments A/B ----
    Xtr, ytr, Xva, yva = [], [], [], []
    for ci, u in enumerate(base_users):
        lo, sh = sessions(u)
        if not lo or not sh:
            continue
        R, s = win(lo)
        cut = int(len(R) * 0.8)
        a, b = windows(R, s, REP, 0, cut), windows(R, s, REP, cut, None)
        Xtr.append(a); ytr += [ci] * len(a); Xva.append(b); yva += [ci] * len(b)
    Xtr, Xva = np.concatenate(Xtr), np.concatenate(Xva)
    remap = {c: i for i, c in enumerate(sorted(set(ytr)))}
    ytr = np.asarray([remap[c] for c in ytr]); yva = np.asarray([remap[c] for c in yva])
    scaler = FeatureScaler.fit(Xtr)
    t0 = time.time()
    base, base_epochs = train_base(arch, scaler.transform(Xtr), ytr, scaler.transform(Xva), yva,
                                   len(remap), seed, args.base_epochs)
    base_w = {l.name: l.get_weights() for l in base.layers if l.get_weights()}
    print(f"base trained {base_epochs} epochs in {(time.time()-t0)/60:.1f} min")

    rng = np.random.default_rng(21)
    neg_parts = []
    for u in rng.choice(base_users, size=NEG_USERS, replace=False):
        lo, _ = sessions(u)
        R, s = win(lo)
        w = windows(R, s, REP)
        if len(w):
            neg_parts.append(w[rng.choice(len(w), size=min(NEG_PER_USER, len(w)), replace=False)])
    neg_pool_raw = np.concatenate(neg_parts)

    # Targets in the Experiment A/B order and eligibility (>= 250 enrolment windows), so the
    # per-target negative draw below consumes the RNG exactly as A/B did and every target gets
    # the SAME 500 negatives it had there. Only targets with >= 440 windows are processed.
    imp, targets = {}, []
    for u in holdout:
        lo, sh = sessions(u)
        g = None
        if sh:
            R, s = win(sh)
            w = windows(R, s, REP)
            if len(w):
                imp[u] = scaler.transform(w[:IMP_RUN_LEN])
                g = scaler.transform(w)
        if lo and g is not None:
            R, s = win(lo)
            e = windows(R, s, REP)
            if len(e) >= 250:                                   # repr_arch_study.BUDGET
                targets.append((u, e[:max(BUDGETS)] if len(e) >= max(BUDGETS) else None, g))
    nrng = np.random.default_rng(1000 + args.seed)
    drawn = [(u, e, g, neg_pool_raw[nrng.choice(len(neg_pool_raw), size=NEG_PER_TARGET, replace=False)])
             for u, e, g in targets]
    run = [t for t in drawn if t[1] is not None]
    if args.limit:
        run = run[:args.limit]
    print(f"targets {len(run)} of {len(targets)} (need >= {max(BUDGETS)} enrolment windows)")

    freeze = ARCHS[arch][2]
    rows = []
    for u, enrol_raw_all, gen, neg_raw in run:
        row = {"participant": u, "M1": {}, "M2": {}}
        for b in BUDGETS:
            enrol_raw = enrol_raw_all[:b]
            enrol = scaler.transform(enrol_raw)
            # M1 server
            m, ep = personalise(arch, base_w, Xtr.shape[1:], freeze, enrol,
                                scaler.transform(neg_raw), seed + 7)
            P = lambda X: m.predict(X, batch_size=1024, verbose=0)[:, 1]
            runs = {o: P(X).tolist() for o, X in imp.items() if o != u}
            row["M1"][str(b)] = {"_genuineScores": P(gen).tolist(), "_enrolScores": P(enrol).tolist(),
                                 "_impostorRuns": runs, "epochs": ep}
            # M2 on-device (the base network, not the personalised one, is the frozen extractor)
            Q = on_device(base, scaler, enrol_raw, neg_raw, seed + 11)
            runs2 = {o: Q(X).tolist() for o, X in imp.items() if o != u}
            row["M2"][str(b)] = {"_genuineScores": Q(gen).tolist(), "_enrolScores": Q(enrol).tolist(),
                                 "_impostorRuns": runs2}
            # Release both personal models before the next budget: each one adds a graph to the
            # Keras session, and over 95 (user, budget) pairs that grew to several GB per job.
            del m, P, Q
            import gc
            tf.keras.backend.clear_session()
            gc.collect()
            i1 = np.concatenate([np.asarray(v) for v in runs.values()])
            i2 = np.concatenate([np.asarray(v) for v in runs2.values()])
            print(f"  {u:>8} b={b:>3}  M1 AUC {auc_of(np.asarray(row['M1'][str(b)]['_genuineScores']), i1):.3f}"
                  f"  M2 AUC {auc_of(np.asarray(row['M2'][str(b)]['_genuineScores']), i2):.3f}")
        rows.append(row)

    os.makedirs(args.out_dir, exist_ok=True)
    out = os.path.join(args.out_dir, f"{tag}.json")
    with open(out, "w") as f:
        json.dump({"preregistrationCSha256": sha, "exp": "C", "arch": arch, "representation": REP,
                   "seedIndex": args.seed, "baseSeed": seed, "baseEpochs": base_epochs,
                   "budgets": BUDGETS, "nTargets": len(rows), "perUser": rows}, f)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
