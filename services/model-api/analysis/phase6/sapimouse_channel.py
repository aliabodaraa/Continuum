"""The mouse channel as SapiMouse publishes it, with the one addition a live system needs: a personal threshold.

Owner's decision (20 Oct 2026, after e_native_blocks.py found windows and blocks equal): the mouse channel adopts
SapiMouse (Antal, Fejer & Buza 2021) unchanged. That means (|dx|, |dy|) steps, 128-event non-overlapping blocks, the
FCN trained for identification with SapiMouse's recipe, a one-class SVM per user fitted on the user's own enrolment
blocks, and scores averaged over five consecutive blocks. The addition, fixed before this run and carried over from
the window channel's rule, is the decision: the personal threshold is the 20th percentile of the user's out-of-sample
enrolment block scores (the 3-minute session cut into eight contiguous parts, each part scored by a one-class SVM
fitted on the other seven), and the passkey is requested when the mean score of five consecutive blocks falls below
it.

Evaluation as in experiment E and e_native_blocks.py: 100 base users train the FCN (seeds 101-103), the 20 held-out
users are the targets, enrolment is the whole 3-minute session, genuine is the whole 1-minute session, impostors are
the other held-out users' 1-minute sessions, and decisions are disjoint groups of five blocks. The base networks are
stored, and the per-user training and one check are timed (computation only, inside one process, after loading).

    python analysis/phase6/sapimouse_channel.py --run --seed 0 [--threads 4]   # artifacts/phase6/sapimouse_channel/
    python analysis/phase6/sapimouse_channel.py --analyze                       # artifacts/phase6/sapimouse_channel_result.*
"""
import argparse
import glob
import hashlib
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MA = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, MA)
sys.path.insert(0, HERE)
from repr_arch_study import raw_steps, _read_events, FeatureScaler, BASE_SEEDS, DATA_DIR, HOLDOUT  # noqa: E402
from repr_arch_segm import units  # noqa: E402
from e_native_blocks import train_base_sapimouse, sha_of, E_DIR, PREREG_E, SM_EPOCHS  # noqa: E402

OUT = "/app/artifacts/phase6"
DIR = os.path.join(OUT, "sapimouse_channel")
PARTS, Q, K = 8, 20, 5            # enrolment parts for the out-of-sample scores, threshold percentile, blocks per decision
SEC_PER_STEP = 0.0269             # session time per step (block_vs_window_native.json timeBasis)


def run(seed_idx, threads, epochs=None, limit=0):
    import tensorflow as tf
    from tensorflow.keras import Model
    from sklearn.svm import OneClassSVM
    tf.config.threading.set_intra_op_parallelism_threads(threads)
    tf.config.threading.set_inter_op_parallelism_threads(2)
    seed = BASE_SEEDS[seed_idx]
    ref = json.load(open(os.path.join(E_DIR, "parts", f"E_s{seed_idx}.json")))
    refK = {r["participant"]: r for r in ref["perUser"]}
    print(f"[SC_s{seed_idx}] SapiMouse channel with a personal threshold | prereg E {sha_of(PREREG_E)[:12]}")

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

    targets = [u for u in holdout if all(sessions(u))]
    if limit:
        targets = targets[:limit]
    Xtr, ytr, Xva, yva = [], [], [], []
    for ci, u in enumerate(base_users):
        lo, sh = sessions(u)
        if not lo or not sh:
            continue
        R = R_of(lo)
        cut = int(len(R) * 0.8)
        a, b = units("K", R, 0, cut), units("K", R, cut, None)
        Xtr.append(a); ytr += [ci] * len(a); Xva.append(b); yva += [ci] * len(b)
    Xtr, Xva = np.concatenate(Xtr), np.concatenate(Xva)
    remap = {c: i for i, c in enumerate(sorted(set(ytr)))}
    ytr = np.asarray([remap[c] for c in ytr]); yva = np.asarray([remap[c] for c in yva])
    if len(Xtr) != ref["meta"]["K"]["trainUnits"]:
        sys.exit("REFUSING: training blocks differ from E's")
    scaler = FeatureScaler.fit(Xtr)
    t0 = time.time()
    base, hist, best_ep = train_base_sapimouse(scaler.transform(Xtr), ytr, scaler.transform(Xva), yva, len(remap),
                                               seed, epochs or SM_EPOCHS)
    val_top1 = float((base.predict(scaler.transform(Xva), batch_size=1024, verbose=0).argmax(1) == yva).mean())
    d_out = os.path.join(OUT, "smoke", "sapimouse_channel") if limit else DIR
    out_dir = os.path.join(d_out, f"base_s{seed_idx}")
    os.makedirs(out_dir, exist_ok=True)
    base.save(os.path.join(out_dir, "fcn_blocks.h5"))
    scaler.save(os.path.join(out_dir, "scaler.json"))
    emb = Model(base.input, base.get_layer("embedding").output)
    print(f"[K] base: best epoch {best_ep}, val top-1 {val_top1:.4f}, {round((time.time() - t0) / 60, 2)} min")

    test_units = {u: scaler.transform(units("K", R_of(sessions(u)[1]))) for u in holdout if sessions(u)[1] is not None}
    test_units = {u: x for u, x in test_units.items() if len(x)}
    E = lambda X: emb.predict(X, batch_size=512, verbose=0)
    test_emb = {u: E(x) for u, x in test_units.items()}
    E(test_units[targets[0]][:1])                          # warm-up before timing

    results, train_s, check_ms = [], [], []
    for u in targets:
        raw_enrol = units("K", R_of(sessions(u)[0]))
        if refK[u]["K-OC"]["enrolUnits"] != len(raw_enrol):
            sys.exit(f"REFUSING: {u}'s enrolment blocks differ from E's")
        t1 = time.perf_counter()
        Ee = E(scaler.transform(raw_enrol))
        loo = np.empty(len(Ee))
        for p in np.array_split(np.arange(len(Ee)), PARTS):
            rest = np.setdiff1d(np.arange(len(Ee)), p)
            loo[p] = OneClassSVM(gamma="scale").fit(Ee[rest]).decision_function(Ee[p])
        oc = OneClassSVM(gamma="scale").fit(Ee)
        train_s.append(time.perf_counter() - t1)
        for i in range(10):                                # one check = embed one new block + score it
            blk = test_units[u][i % len(test_units[u])][None]
            t2 = time.perf_counter()
            oc.decision_function(E(blk))
            check_ms.append(1000 * (time.perf_counter() - t2))
        results.append({"participant": u, "enrolUnits": int(len(Ee)), "_looScores": loo.tolist(),
                        "_genuineScores": oc.decision_function(test_emb[u]).tolist(),
                        "_impostorRuns": {o: oc.decision_function(x).tolist() for o, x in test_emb.items() if o != u}})
        print(f"  {u:>8}  enrol {len(Ee):>3} blocks  train {train_s[-1]:.2f} s")

    os.makedirs(d_out, exist_ok=True)
    out = os.path.join(d_out, f"SC_s{seed_idx}.json")
    with open(out, "w") as f:
        json.dump({"what": "SapiMouse channel (blocks, FCN trained as SapiMouse, one-class SVM) + personal threshold",
                   "preregistrationESha256": sha_of(PREREG_E), "scriptSha256": sha_of(os.path.abspath(__file__)),
                   "seedIndex": seed_idx, "baseSeed": seed, "parts": PARTS,
                   "base": {"bestEpoch": best_ep, "epochsRun": len(hist["loss"]), "valTop1AtBest": val_top1},
                   "timing": {"trainSeconds": train_s, "checkMs": check_ms,
                              "note": "computation only, in one process, after the network was loaded"},
                   "perUser": results}, f)
    print(f"wrote {out}")


def groups(seq, k):
    s = np.asarray(seq, float)
    return np.array([s[i:i + k].mean() for i in range(0, len(s) - k + 1, k)])


def analyze():
    from repr_segm_analyze import per_len
    docs = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(DIR, "SC_s*.json")))]
    if sorted(d["seedIndex"] for d in docs) != [0, 1, 2]:
        sys.exit("REFUSING: need seeds 0, 1, 2")

    def rates(q):
        g_low = g_n = i_high = i_n = 0
        per_user = {}
        for d in docs:
            for r in d["perUser"]:
                thr = np.percentile(r["_looScores"], q)
                g = groups(r["_genuineScores"], K)
                imp = np.concatenate([groups(v, K) for v in r["_impostorRuns"].values() if len(v) >= K])
                g_low += int((g < thr).sum()); g_n += len(g); i_high += int((imp >= thr).sum()); i_n += len(imp)
                e = per_user.setdefault(r["participant"], {"frr": [], "far": []})
                e["frr"].append(float((g < thr).mean())); e["far"].append(float((imp >= thr).mean()))
        return {"q": q, "pooledFRR": g_low / g_n, "pooledFAR": i_high / i_n, "genuineDecisions": g_n,
                "impostorDecisions": i_n,
                "meanFRR": float(np.mean([np.mean(v["frr"]) for v in per_user.values()])),
                "meanFAR": float(np.mean([np.mean(v["far"]) for v in per_user.values()]))}

    adopted = rates(Q)
    sweep = [rates(q) for q in (5, 10, 20, 30, 40, 50)]
    acc = {}
    for d in docs:
        for r in d["perUser"]:
            unit = {"_genuineScores": r["_genuineScores"], "_impostorRuns": r["_impostorRuns"]}
            for j in range(5):
                a, e = per_len(unit, "K-OC", j)
                acc.setdefault(j, {}).setdefault(r["participant"], []).append((a, e))
    by_blocks = {j + 1: {"aucMean": float(np.mean([np.mean([x[0] for x in v]) for v in acc[j].values()])),
                         "eerMean": float(np.mean([np.mean([x[1] for x in v]) for v in acc[j].values()]))}
                 for j in acc}
    tr = np.concatenate([d["timing"]["trainSeconds"] for d in docs])
    ck = np.concatenate([d["timing"]["checkMs"] for d in docs])
    res = {"what": docs[0]["what"], "users": len(docs[0]["perUser"]), "seeds": 3,
           "rule": f"threshold = {Q}th percentile of out-of-sample enrolment block scores ({PARTS} parts); "
                   f"passkey when the mean of {K} consecutive blocks is below it",
           "secondsPerDecision": round(128 * K * SEC_PER_STEP, 1), "adopted": adopted, "sweep": sweep,
           "byBlocks": by_blocks, "base": [d["base"] for d in docs],
           "timing": {"trainSecondsMean": float(tr.mean()), "trainSecondsRange": [float(tr.min()), float(tr.max())],
                      "checkMsMean": float(ck.mean()), "checkMsP95": float(np.percentile(ck, 95)),
                      "note": docs[0]["timing"]["note"]},
           "enrolBlocksMean": float(np.mean([r["enrolUnits"] for r in docs[0]["perUser"]]))}
    with open(os.path.join(OUT, "sapimouse_channel_result.json"), "w") as f:
        json.dump(res, f, indent=1)
    L = [f"SapiMouse channel + personal threshold, {res['users']} users x 3 seeds, decision = {K} blocks "
         f"(about {res['secondsPerDecision']} s), enrolment {res['enrolBlocksMean']:.1f} blocks on average",
         f"ADOPTED (q = {Q}, fixed before the run): pooled FAR {adopted['pooledFAR']*100:.1f}%  FRR "
         f"{adopted['pooledFRR']*100:.1f}%  | mean over users FAR {adopted['meanFAR']*100:.1f}%  FRR "
         f"{adopted['meanFRR']*100:.1f}%  ({adopted['genuineDecisions']} genuine, {adopted['impostorDecisions']} "
         "impostor decisions)", "sweep (diagnostic only): " + "; ".join(
             f"q{s['q']} FAR {s['pooledFAR']*100:.1f}% FRR {s['pooledFRR']*100:.1f}%" for s in sweep),
         "per-user AUC / EER by blocks: " + "; ".join(
             f"{b}: {v['aucMean']:.3f} / {v['eerMean']*100:.1f}%" for b, v in by_blocks.items()),
         f"timing: training {res['timing']['trainSecondsMean']:.2f} s ({res['timing']['trainSecondsRange'][0]:.2f}-"
         f"{res['timing']['trainSecondsRange'][1]:.2f}), one check {res['timing']['checkMsMean']:.1f} ms "
         f"(p95 {res['timing']['checkMsP95']:.1f}) [{res['timing']['note']}]",
         "base: " + ", ".join(f"val top-1 {b['valTop1AtBest']:.3f} at epoch {b['bestEpoch']}" for b in res["base"])]
    txt = "\n".join(L)
    open(os.path.join(OUT, "sapimouse_channel_result.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--seed", type=int, choices=[0, 1, 2])
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--smoke", action="store_true", help="2 targets, 2 epochs, under artifacts/phase6/smoke/")
    args = ap.parse_args()
    if args.run:
        run(args.seed, args.threads, 2 if args.smoke else None, 2 if args.smoke else 0)
    elif args.analyze:
        analyze()
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
