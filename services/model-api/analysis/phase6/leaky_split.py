"""The personal typing models under a RANDOM split of the owner's overlapping windows, for comparison with the
temporal split of experiment KS (the deployed arm A200).

Why: published free-text results (Lu et al. 2020 among them) come from random splits or cross-validation over
sequences cut by a sliding window, so near-identical windows sit on both sides of the split. KS measured the
deployed recipe with a temporal 70/30 split and a 5-window gap. This script repeats KS's A200 arm line for line
(`phase3/run_ks.py`, `run_target`) with ONE change: the owner's windows are shuffled before the 70/30 split
(and the 15% validation share is drawn at random from the 70%). Everything else is identical: the same base
model, scaler, negatives (200 Aalto typists, 160 for training and 40 for validation, 2 x the positives), the
same impostors (ids[40:80], first 150 windows each), the same seeds and op determinism.

Reported per user: window-level EER and AUC of the held-out 30% against the impostor windows, exactly as
`phase3/analyze_ks.py` computes them (p1lib.eer_of / auc_of). Decision-level rates are not meaningful on a
random held-out set, because its windows are not a time stream, so they are not computed.

    python leaky_split.py --run [--from A --to B] [--threads 8]      # one JSON per target under artifacts/phase6/leaky/
    python leaky_split.py --analyze                                   # artifacts/phase6/leaky_result.json / .txt
    python leaky_split.py --run --smoke --limit 2 --epochs 3          # smoke test, written under artifacts/phase6/smoke/
"""
import argparse
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "phase3"))
import ks_common as KC  # noqa: E402

STUDY = os.path.join(KC.ROOT, "artifacts", "phase6")
ARM = "A200"


def run_target(tid, K, kpid, NEG, npid, neg_pool, imp_pool, scaler, epochs):
    """run_ks.run_target with the owner's windows shuffled before the split (the only change)."""
    import tensorflow as tf
    from tensorflow.keras.callbacks import EarlyStopping
    from population_sweep import ENROL_FRAC, PACKET_RUN_LEN, VAL_FRAC, build_model, scale
    rng = np.random.default_rng(1000 + int(tid))
    tf.keras.utils.set_random_seed(1000 + int(tid))

    own = K[kpid == tid]
    perm = rng.permutation(len(own))                      # <-- the one change: a random split, no gap
    cut = int(len(own) * ENROL_FRAC)
    enrol_idx, test_idx = perm[:cut], perm[cut:]
    if len(enrol_idx) < 40 or len(test_idx) < 20:
        return None
    enrol, held_out = own[enrol_idx], own[test_idx]
    vcut = int(len(enrol) * (1.0 - VAL_FRAC))
    pos_tr, pos_va = enrol[:vcut], enrol[vcut:]           # random already, so a plain cut is a random validation share

    neg_parts = np.array(list(neg_pool))
    n_va = max(4, len(neg_parts) // 5)
    va_parts, tr_parts = neg_parts[:n_va], neg_parts[n_va:]
    want = max(len(pos_tr) * 2, 60)
    neg_tr_all = NEG[np.isin(npid, tr_parts)]
    neg_va_all = NEG[np.isin(npid, va_parts)]
    neg_tr = neg_tr_all[rng.choice(len(neg_tr_all), min(want, len(neg_tr_all)), replace=False)]
    neg_va = neg_va_all[rng.choice(len(neg_va_all), min(max(len(pos_va) * 2, 30), len(neg_va_all)), replace=False)]

    X_tr = scale(np.concatenate([pos_tr, neg_tr]), scaler)
    y_tr = np.concatenate([np.ones(len(pos_tr)), np.zeros(len(neg_tr))]).astype(np.int64)
    X_va = scale(np.concatenate([pos_va, neg_va]), scaler)
    y_va = np.concatenate([np.ones(len(pos_va)), np.zeros(len(neg_va))]).astype(np.int64)
    sh = rng.permutation(len(X_tr))
    X_tr, y_tr = X_tr[sh], y_tr[sh]

    model = build_model(K.shape[1:])
    hist = model.fit(X_tr, y_tr, validation_data=(X_va, y_va), epochs=epochs, batch_size=16, verbose=0,
                     callbacks=[EarlyStopping(patience=6, restore_best_weights=True, monitor="val_loss")])

    g = model.predict(scale(held_out, scaler), batch_size=256, verbose=0)[:, 1]
    runs = {}
    for part in imp_pool:
        if part == tid:
            continue
        block = K[kpid == part][:PACKET_RUN_LEN]
        if len(block) >= 8:
            runs[str(int(part))] = [float(v) for v in model.predict(scale(block, scaler), batch_size=256, verbose=0)[:, 1]]
    tf.keras.backend.clear_session()
    if not (np.isfinite(g).all() and all(np.isfinite(v).all() for v in runs.values())):
        raise SystemExit(f"target {tid}: non-finite scores (technical failure: re-run, log it)")
    return {"participant": int(tid), "nEnrol": int(len(pos_tr)), "nHeldOut": int(len(held_out)),
            "nNegTrain": int(len(neg_tr)), "negPeopleTrain": int(len(tr_parts)), "negPeopleVal": int(len(va_parts)),
            "epochsRun": len(hist.history["loss"]), "genuine": [float(v) for v in g], "runs": runs}


def run(a):
    import tensorflow as tf
    if a.threads:
        tf.config.threading.set_intra_op_parallelism_threads(a.threads)
    tf.config.experimental.enable_op_determinism()
    K, kpid = KC.load_h5(KC.KEYRECS)
    ids, _, imp_pool = KC.keyrecs_pools(kpid)
    manifest = json.load(open(os.path.join(KC.STUDY, "aalto_pool_ks.json")))
    pool_h5 = os.path.join(KC.ROOT, manifest["poolH5"])
    if KC.sha(pool_h5) != manifest["poolH5Sha256"]:
        raise SystemExit(f"{pool_h5} differs from its manifest")
    PW, PP = KC.load_h5(pool_h5)
    kept = [int(x) for x in manifest["kept"]][:KC.POOL_SIZES[ARM]]
    m = np.isin(PP, kept)
    NEG, npid, neg_pool = PW[m], PP[m], kept
    scaler = KC.load_scaler()
    targets = list(ids)[a.frm:a.to] if a.to else list(ids)[a.frm:]
    if a.limit:
        targets = targets[:a.limit]
    out_dir = os.path.join(STUDY, "smoke" if a.smoke else "leaky")
    os.makedirs(out_dir, exist_ok=True)
    print(f"[leaky] arm {ARM}, random 70/30 split, {len(targets)} targets -> {out_dir}", flush=True)
    t0 = time.time()
    for tid in targets:
        path = os.path.join(out_dir, f"{int(tid)}.json")
        if os.path.exists(path) and not a.smoke:
            continue
        r = run_target(int(tid), K, kpid, NEG, npid, neg_pool, imp_pool, scaler, a.epochs)
        KC.write_json(path, {"smokeTest": a.smoke, "arm": ARM, "split": "random 70/30, no gap",
                             "eligible": r is not None, **(r or {"participant": int(tid)})})
        if r:
            print(f"  {int(tid):>4}: enrol {r['nEnrol']:4d} held {r['nHeldOut']:4d} neg {r['nNegTrain']:4d}, {r['epochsRun']} epochs", flush=True)
    print(f"[leaky] done in {(time.time() - t0) / 60:.1f} min", flush=True)


def analyze(a):
    sys.path.insert(0, os.path.join(HERE, "..", "phase1"))
    import p1lib as P
    folder = os.path.join(STUDY, "smoke" if a.smoke else "leaky")
    rows = []
    for f in sorted(os.listdir(folder)):
        if f.endswith(".json"):
            r = json.load(open(os.path.join(folder, f)))
            if r.get("eligible"):
                g = np.asarray(r["genuine"], float)
                imp = np.concatenate([np.asarray(v, float) for v in r["runs"].values()])
                rows.append({"participant": r["participant"], "winEer": float(P.eer_of(g, imp)[0]), "winAuc": float(P.auc_of(g, imp)),
                             "nHeldOut": r["nHeldOut"], "epochsRun": r["epochsRun"]})
    # the temporal counterpart: KS arm A200, same metric code
    ks = []
    for f in sorted(os.listdir(os.path.join(KC.PARTS, ARM))):
        if f.endswith(".json"):
            r = json.load(open(os.path.join(KC.PARTS, ARM, f)))
            if r.get("eligible"):
                g = np.asarray(r["genuine"], float)
                imp = np.concatenate([np.asarray(v, float) for v in r["runs"].values()])
                ks.append({"participant": r["participant"], "winEer": float(P.eer_of(g, imp)[0]), "winAuc": float(P.auc_of(g, imp))})
    common = sorted(set(x["participant"] for x in rows) & set(x["participant"] for x in ks))
    L = {x["participant"]: x for x in rows}
    T = {x["participant"]: x for x in ks}
    eer_l = np.array([L[p]["winEer"] for p in common]); eer_t = np.array([T[p]["winEer"] for p in common])
    auc_l = np.array([L[p]["winAuc"] for p in common]); auc_t = np.array([T[p]["winAuc"] for p in common])
    rng = np.random.default_rng(17)
    d = eer_l - eer_t
    bs = np.array([d[rng.integers(0, len(d), len(d))].mean() for _ in range(10000)])
    res = {"arm": ARM, "nTargets": len(common),
           "randomSplit": {"windowEerMean": float(eer_l.mean()), "windowAucMean": float(auc_l.mean())},
           "temporalSplitKS": {"windowEerMean": float(eer_t.mean()), "windowAucMean": float(auc_t.mean())},
           "eerDiffRandomMinusTemporal": {"mean": float(d.mean()), "ci95": [float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))],
                                          "lowerFor": int((d < 0).sum())},
           "perUser": {str(p): {"random": L[p], "temporal": T[p]} for p in common}}
    KC.write_json(os.path.join(STUDY, "leaky_result.json"), res, indent=1)
    txt = (f"Random 70/30 split of the owner's overlapping windows (arm {ARM}, {len(common)} targets): window EER mean "
           f"{100*eer_l.mean():.1f}%, window AUC mean {auc_l.mean():.3f}\n"
           f"Temporal split with a gap (experiment KS, the same targets): window EER mean {100*eer_t.mean():.1f}%, "
           f"window AUC mean {auc_t.mean():.3f}\n"
           f"EER random - temporal: {100*d.mean():+.1f} points [{100*np.percentile(bs,2.5):+.1f}, {100*np.percentile(bs,97.5):+.1f}], "
           f"lower under the random split for {(d < 0).sum()}/{len(d)} users\n")
    open(os.path.join(STUDY, "leaky_result.txt"), "w").write(txt)
    print(txt)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--epochs", type=int, default=KC.EPOCHS)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--from", dest="frm", type=int, default=0)
    ap.add_argument("--to", type=int, default=0)
    a = ap.parse_args()
    if (a.limit or a.epochs != KC.EPOCHS) and not a.smoke:
        raise SystemExit("--limit and --epochs are for smoke tests only")
    if a.run:
        run(a)
    if a.analyze:
        analyze(a)
