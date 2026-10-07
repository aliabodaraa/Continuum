"""
Experiment E (artifacts/repr_arch_study/PREREGISTRATION_E.md): for the SapiMouse-anchored
pipeline -- (|dx|, |dy|) + SapiMouse's FCN -- copy the paper's segmentation and verifier, or
change them?  2 x 2:
    segmentation  K = 128-step non-overlapping blocks (SapiMouse)
                  W = 50-step windows, stride 10, path >= 0.08 (Continuum)
    verifier      OC  = One-Class SVM on the frozen base FCN's embeddings, target data only (SapiMouse)
                  BIN = fine-tuned FCN + binary head, 500 base-user negatives (Continuum)
Enrolment = the target's entire 3-minute session; genuine = entire 1-minute session; impostors =
each other held-out user's entire 1-minute session. Raw score streams are persisted; matched-time
aggregation happens in repr_segm_analyze.py.

    python repr_arch_segm.py --seed 0
"""
import argparse
import gc
import glob
import hashlib
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from repr_arch_study import (build, ARCHS, REPRESENTATIONS, windows, raw_steps, _read_events,  # noqa: E402
                             train_base, personalise, FeatureScaler, NEG_USERS, NEG_PER_USER,
                             NEG_PER_TARGET, BASE_SEEDS, DATA_DIR, HOLDOUT)

ARCH, REP, BLOCK = "B6", "A5", 128
PREREG_E = "/app/artifacts/repr_arch_study/PREREGISTRATION_E.md"


def blocks(R, lo=0, hi=None):
    """SapiMouse segmentation on Continuum's step stream: consecutive non-overlapping 128-step
    chunks of the A5 columns, no path filter."""
    R = R[lo:hi]
    F = REPRESENTATIONS[REP][3](R, 1.0).astype(np.float32) if len(R) else np.zeros((0, 2), np.float32)
    n = len(F) // BLOCK
    return F[:n * BLOCK].reshape(n, BLOCK, F.shape[1]) if n else np.zeros((0, BLOCK, 2), np.float32)


def units(seg, R, lo=0, hi=None):
    return blocks(R, lo, hi) if seg == "K" else windows(R, 1.0, REP, lo, hi)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, required=True, choices=[0, 1, 2])
    ap.add_argument("--threads", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0, help="smoke test only")
    ap.add_argument("--base-epochs", type=int, default=40, help="smoke test only; 40 is the protocol")
    ap.add_argument("--out-dir", default="/app/artifacts/repr_arch_study/parts")
    args = ap.parse_args()

    import tensorflow as tf
    from tensorflow.keras import Model
    from sklearn.svm import OneClassSVM
    tf.config.threading.set_intra_op_parallelism_threads(args.threads)
    tf.config.threading.set_inter_op_parallelism_threads(2)
    sha = hashlib.sha256(open(PREREG_E, "rb").read()).hexdigest()
    seed = BASE_SEEDS[args.seed]
    print(f"[E_s{args.seed}] A5 + FCN, 2x2 segmentation x verifier | prereg E {sha[:12]}")

    holdout = json.load(open(HOLDOUT))["holdout_users"]
    uids = sorted((os.path.basename(d) for d in glob.glob(os.path.join(DATA_DIR, "user*"))),
                  key=lambda u: int(u[4:]))
    base_users = [u for u in uids if u not in holdout]

    def sessions(u):
        cs = sorted(glob.glob(os.path.join(DATA_DIR, u, "*.csv")))
        lo = [c for c in cs if "3min" in os.path.basename(c)]
        sh = [c for c in cs if "1min" in os.path.basename(c)]
        return (lo[0] if lo else None), (sh[0] if sh else None)

    steps = {}

    def R_of(csv):
        if csv not in steps:
            steps[csv] = raw_steps(_read_events(csv))
        return steps[csv]

    targets = [u for u in holdout if all(sessions(u))]
    if args.limit:
        targets = targets[:args.limit]
    results = {u: {"participant": u} for u in targets}
    meta = {}

    for seg in ("K", "W"):
        # ---- base FCN for this segmentation (identification on the 100 base users) ----
        Xtr, ytr, Xva, yva = [], [], [], []
        for ci, u in enumerate(base_users):
            lo, sh = sessions(u)
            if not lo or not sh:
                continue
            R = R_of(lo)
            cut = int(len(R) * 0.8)
            a, b = units(seg, R, 0, cut), units(seg, R, cut, None)
            Xtr.append(a); ytr += [ci] * len(a); Xva.append(b); yva += [ci] * len(b)
        Xtr, Xva = np.concatenate(Xtr), np.concatenate(Xva)
        remap = {c: i for i, c in enumerate(sorted(set(ytr)))}
        ytr = np.asarray([remap[c] for c in ytr]); yva = np.asarray([remap[c] for c in yva])
        scaler = FeatureScaler.fit(Xtr)
        t0 = time.time()
        base, ep = train_base(ARCH, scaler.transform(Xtr), ytr, scaler.transform(Xva), yva,
                              len(remap), seed, args.base_epochs)
        base_w = {l.name: l.get_weights() for l in base.layers if l.get_weights()}
        emb = Model(base.input, base.get_layer("embedding").output)
        meta[seg] = {"trainUnits": int(len(Xtr)), "unitShape": list(Xtr.shape[1:]),
                     "baseEpochs": ep, "baseMinutes": round((time.time() - t0) / 60, 2)}
        print(f"[{seg}] base: {Xtr.shape} -> {ep} epochs in {meta[seg]['baseMinutes']} min")

        # ---- material, scaled once ----
        test_units = {u: scaler.transform(units(seg, R_of(sessions(u)[1]))) for u in holdout
                      if sessions(u)[1] is not None}
        test_units = {u: x for u, x in test_units.items() if len(x)}
        enrol_units = {u: scaler.transform(units(seg, R_of(sessions(u)[0]))) for u in targets}
        E = lambda X: emb.predict(X, batch_size=512, verbose=0)
        test_emb = {u: E(x) for u, x in test_units.items()}

        rng = np.random.default_rng(21)
        neg_parts = []
        for u in rng.choice(base_users, size=NEG_USERS, replace=False):
            w = units(seg, R_of(sessions(u)[0]))
            if len(w):
                neg_parts.append(w[rng.choice(len(w), size=min(NEG_PER_USER, len(w)), replace=False)])
        neg_pool = scaler.transform(np.concatenate(neg_parts))

        # ---- OC: SapiMouse's verifier (frozen extractor, target data only) ----
        for u in targets:
            oc = OneClassSVM(gamma="scale").fit(E(enrol_units[u]))
            results[u][f"{seg}-OC"] = {
                "_genuineScores": oc.decision_function(test_emb[u]).tolist(),
                "_impostorRuns": {o: oc.decision_function(x).tolist()
                                  for o, x in test_emb.items() if o != u},
                "enrolUnits": int(len(enrol_units[u]))}
        del emb, base
        gc.collect()

        # ---- BIN: Continuum's verifier (fine-tuned, binary head, base-user negatives) ----
        nrng = np.random.default_rng(1000 + args.seed)
        for u in targets:
            negs = neg_pool[nrng.choice(len(neg_pool), size=min(NEG_PER_TARGET, len(neg_pool)),
                                        replace=False)]
            m, pe = personalise(ARCH, base_w, Xtr.shape[1:], ARCHS[ARCH][2], enrol_units[u], negs, seed + 7)
            P = lambda X: m.predict(X, batch_size=1024, verbose=0)[:, 1]
            results[u][f"{seg}-BIN"] = {
                "_genuineScores": P(test_units[u]).tolist(),
                "_impostorRuns": {o: P(x).tolist() for o, x in test_units.items() if o != u},
                "enrolUnits": int(len(enrol_units[u])), "epochs": pe}
            del m, P
            tf.keras.backend.clear_session()
            gc.collect()
            print(f"  [{seg}] {u:>8}  enrol {len(enrol_units[u]):>4} units  done")

    os.makedirs(args.out_dir, exist_ok=True)
    out = os.path.join(args.out_dir, f"E_s{args.seed}.json")
    with open(out, "w") as f:
        json.dump({"preregistrationESha256": sha, "exp": "E", "arch": ARCH, "representation": REP,
                   "seedIndex": args.seed, "baseSeed": seed, "meta": meta,
                   "perUser": list(results.values())}, f)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
