"""SapiMouse's blocks with Lu's fixed 0.50 threshold, fairly: a binary head with as many negatives as positives, as in
Lu et al. (owner, 20 Oct 2026: "fix the threshold at 50% like Lu and keep the blocks").

fixed_threshold.py found that blocks with a binary head at 0.50 rejected 56.5% of genuine decisions. That head saw
about 50 of the user's blocks against 500 negatives (repr_arch_study.NEG_PER_TARGET), which pushes the probability of
"owner" down, while a fixed 0.50 assumes balanced classes. Here the only change is the number of negatives: as many as
the user's enrolment blocks (1:1, Lu). Everything else is unchanged. That covers the block networks stored by
sapimouse_channel.py (trained as SapiMouse trains them, seeds 101-103), E's data, users, enrolment and test sessions,
impostor runs, the negative pool and repr_arch_study.personalise. Decision: at least 3 of 5 blocks below 0.50, or the
mean of 5 blocks below 0.50, on disjoint decisions.

    python analysis/phase6/blocks_lu_threshold.py --run --seed 0     # artifacts/phase6/blocks_lu/BL_s0.json
    python analysis/phase6/blocks_lu_threshold.py --analyze           # artifacts/phase6/blocks_lu_result.json / .txt
"""
import argparse
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "..")))
sys.path.insert(0, HERE)
from repr_arch_study import (ARCHS, raw_steps, _read_events, personalise, FeatureScaler, NEG_USERS, NEG_PER_USER,  # noqa
                             BASE_SEEDS, DATA_DIR, HOLDOUT)
from repr_arch_segm import ARCH, units  # noqa: E402

OUT = "/app/artifacts/phase6"
BASES = os.path.join(OUT, "sapimouse_channel")
DIR = os.path.join(OUT, "blocks_lu")


def run(seed_idx, threads):
    import tensorflow as tf
    tf.config.threading.set_intra_op_parallelism_threads(threads)
    seed = BASE_SEEDS[seed_idx]
    holdout = json.load(open(HOLDOUT))["holdout_users"]
    uids = sorted((os.path.basename(d) for d in glob.glob(os.path.join(DATA_DIR, "user*"))), key=lambda u: int(u[4:]))
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

    base = tf.keras.models.load_model(os.path.join(BASES, f"base_s{seed_idx}", "fcn_blocks.h5"), compile=False)
    scaler = FeatureScaler.load(os.path.join(BASES, f"base_s{seed_idx}", "scaler.json"))
    base_w = {l.name: l.get_weights() for l in base.layers if l.get_weights()}
    targets = [u for u in holdout if all(sessions(u))]
    test_units = {u: scaler.transform(units("K", R_of(sessions(u)[1]))) for u in holdout if sessions(u)[1] is not None}
    test_units = {u: x for u, x in test_units.items() if len(x)}
    enrol_units = {u: scaler.transform(units("K", R_of(sessions(u)[0]))) for u in targets}
    rng = np.random.default_rng(21)                       # E's negative pool, drawn exactly as in repr_arch_segm
    neg_parts = []
    for u in rng.choice(base_users, size=NEG_USERS, replace=False):
        w = units("K", R_of(sessions(u)[0]))
        if len(w):
            neg_parts.append(w[rng.choice(len(w), size=min(NEG_PER_USER, len(w)), replace=False)])
    neg_pool = scaler.transform(np.concatenate(neg_parts))
    shape = next(iter(enrol_units.values())).shape[1:]
    nrng = np.random.default_rng(1000 + seed_idx)
    results = []
    for u in targets:
        n_neg = min(len(enrol_units[u]), len(neg_pool))                       # 1:1, as in Lu et al.
        negs = neg_pool[nrng.choice(len(neg_pool), size=n_neg, replace=False)]
        m, pe = personalise(ARCH, base_w, shape, ARCHS[ARCH][2], enrol_units[u], negs, seed + 7)
        P = lambda X: m.predict(X, batch_size=1024, verbose=0)[:, 1]
        results.append({"participant": u, "K-BIN-1to1": {
            "_genuineScores": P(test_units[u]).tolist(),
            "_impostorRuns": {o: P(x).tolist() for o, x in test_units.items() if o != u},
            "enrolUnits": int(len(enrol_units[u])), "negatives": int(n_neg), "epochs": pe}})
        tf.keras.backend.clear_session()
        print(f"  {u:>8}  {len(enrol_units[u])} blocks vs {n_neg} negatives, {pe} epochs")
    os.makedirs(DIR, exist_ok=True)
    with open(os.path.join(DIR, f"BL_s{seed_idx}.json"), "w") as f:
        json.dump({"seedIndex": seed_idx, "baseSeed": seed, "perUser": results}, f)
    print("wrote", os.path.join(DIR, f"BL_s{seed_idx}.json"))


def analyze():
    from fixed_threshold import evaluate
    from repr_segm_analyze import per_len
    docs = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(DIR, "BL_s*.json")))]
    assert sorted(d["seedIndex"] for d in docs) == [0, 1, 2]
    v = evaluate(docs, "K-BIN-1to1", 0.5, 5, 5, 3)
    auc = {}
    for d in docs:
        for r in d["perUser"]:
            for j in (0, 4):
                auc.setdefault(j, {}).setdefault(r["participant"], []).append(per_len(r["K-BIN-1to1"], "K-BIN", j)[0])
    v["perUserAuc"] = {str(j + 1): float(np.mean([np.mean(x) for x in auc[j].values()])) for j in auc}
    with open(os.path.join(OUT, "blocks_lu_result.json"), "w") as f:
        json.dump(v, f, indent=1)
    txt = (f"blocks, binary head with 1:1 negatives (Lu), fixed 0.50, 20 users x 3 seeds: "
           f"vote 3 of 5 FAR {v['vote']['pooledFAR']*100:.1f}% FRR {v['vote']['pooledFRR']*100:.1f}% | "
           f"mean of 5 FAR {v['mean']['pooledFAR']*100:.1f}% FRR {v['mean']['pooledFRR']*100:.1f}% | "
           f"single block FAR {v['singleUnit']['FAR']*100:.1f}% FRR {v['singleUnit']['FRR']*100:.1f}% | "
           f"per-user AUC 1 block {v['perUserAuc']['1']:.3f}, 5 blocks {v['perUserAuc']['5']:.3f}")
    open(os.path.join(OUT, "blocks_lu_result.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--seed", type=int, choices=[0, 1, 2])
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    run(a.seed, a.threads) if a.run else analyze()
