"""Experiment E's window arms (W-OC, W-BIN) again, with the window network trained the way SapiMouse trains it.

Why (owner, 22 Oct 2026: the deployed mouse network now uses SapiMouse's training settings; "re-run it, we want to check
and audit the mouse approach"): analysis/phase6/e_native_blocks.py re-ran E's block arms with SapiMouse's recipe, but
kept E's stored window arms, whose network was trained with E's recipe (repr_arch_study.train_base: Adam 1e-3, batch
128, early stopping 12, plateau 5). Paper 4-4's windows-versus-blocks comparison (0.95 against 0.92 with the binary head)
therefore set a window network trained with this work's settings against a block network trained with SapiMouse's.
Here both segmentations are trained with SapiMouse's recipe.

This script repeats E's W part line for line (repr_arch_segm.main with seg == "W") with ONE change: the base FCN is
trained with e_native_blocks.train_base_sapimouse (Adam 1e-4, batch 16, 100 epochs, ReduceLROnPlateau(val_loss, 0.5,
50), the weights with the lowest validation loss). Everything else is E's: the 100 base users and their per-user 80/20
split, the scaler, the seeds (101 to 103), the 20 targets, the enrolment (whole 3-min session), the genuine test (whole
1-min session), the impostor runs, the One-Class SVM and the fine-tuned binary head with 500 base-user negatives.
Every target's windows are checked against E's stored W arms before anything is scored.

Reading rule, fixed before any result exists (22 Oct 2026):
  Primary: W-OC minus K-OC, both networks trained with SapiMouse's recipe, on E's primary endpoint (per-user AUC
  averaged over the five matched lengths, then over seeds), paired bootstrap over the 20 users (repr_arch_analyze.boot).
  Windows better if the difference is > 0 with p < 0.05, blocks better if < 0 with p < 0.05, otherwise a tie.
  Secondary: W-BIN minus K-BIN under the same recipe (the comparison paper 4-4 reports).
  Also reported: the recipe's effect on the windows, W (SapiMouse training) minus W (E), for OC and BIN.
A sensitivity re-run of E under the adopted recipe, reported as such, not a new pre-registered experiment.

    python analysis/phase7/e_native_windows.py --run --seed 0 [--threads 6]   # artifacts/phase7/e_native_w/ENW_s0.json
    python analysis/phase7/e_native_windows.py --analyze                       # artifacts/phase7/e_native_w_result.*
    python analysis/phase7/e_native_windows.py --run --seed 0 --smoke          # 2 targets, 3 epochs -> .../smoke/
"""
import argparse
import gc
import glob
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase6")))
import e_native_blocks as EN  # noqa: E402  (also puts model-api on sys.path)
from repr_arch_study import ARCHS, raw_steps, _read_events, personalise, FeatureScaler  # noqa: E402
from repr_arch_study import NEG_USERS, NEG_PER_USER, NEG_PER_TARGET, BASE_SEEDS, DATA_DIR, HOLDOUT  # noqa: E402
from repr_arch_segm import ARCH, units  # noqa: E402

OUT = "/app/artifacts/phase7"
SEG = "W"


def run(seed_idx, threads, smoke):
    import tensorflow as tf
    from tensorflow.keras import Model
    from sklearn.svm import OneClassSVM
    tf.config.threading.set_intra_op_parallelism_threads(threads)
    tf.config.threading.set_inter_op_parallelism_threads(2)
    seed = BASE_SEEDS[seed_idx]
    e_sha = EN.sha_of(EN.PREREG_E)
    ref = json.load(open(os.path.join(EN.E_DIR, "parts", f"E_s{seed_idx}.json")))
    if ref["preregistrationESha256"] != e_sha:
        sys.exit("REFUSING: E's stored results were produced under a different pre-registration")
    refW = {r["participant"]: r for r in ref["perUser"]}
    print(f"[ENW_s{seed_idx}] E's window arms, base trained with SapiMouse's recipe | prereg E {e_sha[:12]}", flush=True)

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
    if smoke:
        targets = targets[:2]
    results = {u: {"participant": u} for u in targets}

    # ---- base FCN (identification on the 100 base users), E's window data, SapiMouse's training ----
    Xtr, ytr, Xva, yva = [], [], [], []
    for ci, u in enumerate(base_users):
        lo, sh = sessions(u)
        if not lo or not sh:
            continue
        R = R_of(lo)
        cut = int(len(R) * 0.8)
        a, b = units(SEG, R, 0, cut), units(SEG, R, cut, None)
        Xtr.append(a); ytr += [ci] * len(a); Xva.append(b); yva += [ci] * len(b)
    Xtr, Xva = np.concatenate(Xtr), np.concatenate(Xva)
    remap = {c: i for i, c in enumerate(sorted(set(ytr)))}
    ytr = np.asarray([remap[c] for c in ytr]); yva = np.asarray([remap[c] for c in yva])
    if len(Xtr) != ref["meta"]["W"]["trainUnits"]:
        sys.exit(f"REFUSING: {len(Xtr)} training windows, E had {ref['meta']['W']['trainUnits']}")
    scaler = FeatureScaler.fit(Xtr)
    t0 = time.time()
    base, hist, best_ep = EN.train_base_sapimouse(scaler.transform(Xtr), ytr, scaler.transform(Xva), yva, len(remap),
                                                  seed, 3 if smoke else EN.SM_EPOCHS)
    val_top1 = float((base.predict(scaler.transform(Xva), batch_size=1024, verbose=0).argmax(1) == yva).mean())
    base_w = {l.name: l.get_weights() for l in base.layers if l.get_weights()}
    emb = Model(base.input, base.get_layer("embedding").output)
    meta = {"trainUnits": int(len(Xtr)), "valUnits": int(len(Xva)), "unitShape": list(Xtr.shape[1:]),
            "classes": len(remap), "epochsRun": len(hist["loss"]), "bestEpoch": best_ep,
            "bestValLoss": float(min(hist["val_loss"])), "valTop1AtBest": val_top1,
            "baseMinutes": round((time.time() - t0) / 60, 2), "history": hist}
    print(f"[W] base: {Xtr.shape} -> best epoch {best_ep} of {meta['epochsRun']}, val top-1 {val_top1:.4f} "
          f"(chance {1 / len(remap):.4f}), {meta['baseMinutes']} min", flush=True)
    out_dir = os.path.join(OUT, "e_native_w", "smoke" if smoke else "")
    os.makedirs(out_dir, exist_ok=True)
    base.save(os.path.join(out_dir, f"base_s{seed_idx}"))

    # ---- material, scaled once, checked against E's stored W arms ----
    test_units = {u: scaler.transform(units(SEG, R_of(sessions(u)[1]))) for u in holdout if sessions(u)[1] is not None}
    test_units = {u: x for u, x in test_units.items() if len(x)}
    enrol_units = {u: scaler.transform(units(SEG, R_of(sessions(u)[0]))) for u in targets}
    for u in targets:
        rw = refW[u]["W-OC"]
        same = (rw["enrolUnits"] == len(enrol_units[u]) and len(rw["_genuineScores"]) == len(test_units[u])
                and {o: len(v) for o, v in rw["_impostorRuns"].items()}
                == {o: len(x) for o, x in test_units.items() if o != u})
        if not same:
            sys.exit(f"REFUSING: {u}'s windows differ from E's")
    E = lambda X: emb.predict(X, batch_size=512, verbose=0)
    test_emb = {u: E(x) for u, x in test_units.items()}

    rng = np.random.default_rng(21)
    neg_parts = []
    for u in rng.choice(base_users, size=NEG_USERS, replace=False):
        w = units(SEG, R_of(sessions(u)[0]))
        if len(w):
            neg_parts.append(w[rng.choice(len(w), size=min(NEG_PER_USER, len(w)), replace=False)])
    neg_pool = scaler.transform(np.concatenate(neg_parts))

    # ---- OC: SapiMouse's verifier (frozen extractor, target data only) ----
    for u in targets:
        oc = OneClassSVM(gamma="scale").fit(E(enrol_units[u]))
        results[u]["W-OC"] = {"_genuineScores": oc.decision_function(test_emb[u]).tolist(),
                              "_impostorRuns": {o: oc.decision_function(x).tolist()
                                                for o, x in test_emb.items() if o != u},
                              "enrolUnits": int(len(enrol_units[u]))}
    del emb
    gc.collect()

    # ---- BIN: Continuum's verifier in E (fine-tuned, binary head, base-user negatives) ----
    nrng = np.random.default_rng(1000 + seed_idx)
    for u in targets:
        negs = neg_pool[nrng.choice(len(neg_pool), size=min(NEG_PER_TARGET, len(neg_pool)), replace=False)]
        m, pe = personalise(ARCH, base_w, Xtr.shape[1:], ARCHS[ARCH][2], enrol_units[u], negs, seed + 7)
        P = lambda X: m.predict(X, batch_size=1024, verbose=0)[:, 1]
        results[u]["W-BIN"] = {"_genuineScores": P(test_units[u]).tolist(),
                               "_impostorRuns": {o: P(x).tolist() for o, x in test_units.items() if o != u},
                               "enrolUnits": int(len(enrol_units[u])), "epochs": pe}
        del m, P
        tf.keras.backend.clear_session()
        gc.collect()
        print(f"  [W] {u:>8}  enrol {len(enrol_units[u]):>4} windows  done", flush=True)

    out = os.path.join(out_dir, f"ENW_s{seed_idx}.json")
    with open(out, "w") as f:
        json.dump({"what": "experiment E window arms, base FCN trained with SapiMouse's recipe",
                   "preregistrationESha256": e_sha, "scriptSha256": EN.sha_of(os.path.abspath(__file__)),
                   "smoke": bool(smoke), "seedIndex": seed_idx, "baseSeed": seed,
                   "recipe": {"optimizer": "Adam", "learningRate": EN.SM_LR, "batch": EN.SM_BATCH, "epochs": EN.SM_EPOCHS,
                              "reduceLrOnPlateau": {"monitor": "val_loss", "factor": 0.5, "patience": EN.SM_PLATEAU},
                              "keep": "lowest val_loss"},
                   "meta": {"W": meta}, "perUser": list(results.values())}, f)
    print(f"wrote {out}", flush=True)


def analyze():
    import repr_arch_analyze as RA
    from repr_segm_analyze import per_len, KB, KW
    e_sha = EN.sha_of(EN.PREREG_E)
    E = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(EN.E_DIR, "parts", "E_s*.json")))]
    K = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(EN.OUT, "e_native", "EN_s*.json")))]
    W = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(OUT, "e_native_w", "ENW_s*.json")))]
    if len(E) != 3 or len(K) != 3 or len(W) != 3:
        sys.exit(f"REFUSING: need 3 seeds of each, found E {len(E)}, K native {len(K)}, W native {len(W)}")
    if any(d["preregistrationESha256"] != e_sha for d in E + K + W) or any(d["smoke"] for d in K + W):
        sys.exit("REFUSING: a result file does not belong to this check")

    def collect(docs, arm):
        per = {}
        for d in docs:
            for r in d["perUser"]:
                res = [per_len(r[arm], arm, j) for j in range(5)]
                e = per.setdefault(r["participant"], {"prim": [], "auc": [], "eer5": []})
                aucs = [a for a, _ in res]
                e["prim"].append(float(np.nanmean(aucs))); e["auc"].append(aucs); e["eer5"].append(res[4][1])
        return per

    arms = {"K-OC (SapiMouse training)": collect(K, "K-OC"), "W-OC (SapiMouse training)": collect(W, "W-OC"),
            "K-BIN (SapiMouse training)": collect(K, "K-BIN"), "W-BIN (SapiMouse training)": collect(W, "W-BIN"),
            "W-OC (E's training)": collect(E, "W-OC"), "W-BIN (E's training)": collect(E, "W-BIN")}
    users = sorted(set.intersection(*[set(v) for v in arms.values()]))
    prim = {a: [float(np.mean(arms[a][u]["prim"])) for u in users] for a in arms}
    byk = {a: [float(x) for x in np.nanmean([np.nanmean(arms[a][u]["auc"], axis=0) for u in users], axis=0)] for a in arms}
    eer5 = {a: float(np.nanmean([np.nanmean(arms[a][u]["eer5"]) for u in users])) for a in arms}
    primary = RA.boot(prim["K-OC (SapiMouse training)"], prim["W-OC (SapiMouse training)"])
    verdict = ("windows better" if primary["meanDiff"] > 0 and primary["p"] < 0.05 else
               "blocks better" if primary["meanDiff"] < 0 and primary["p"] < 0.05 else "tie")
    secondary = RA.boot(prim["K-BIN (SapiMouse training)"], prim["W-BIN (SapiMouse training)"])
    recipe_oc = RA.boot(prim["W-OC (E's training)"], prim["W-OC (SapiMouse training)"])
    recipe_bin = RA.boot(prim["W-BIN (E's training)"], prim["W-BIN (SapiMouse training)"])
    base = [{"seedIndex": d["seedIndex"], "bestEpoch": d["meta"]["W"]["bestEpoch"], "epochsRun": d["meta"]["W"]["epochsRun"],
             "valTop1AtBest": d["meta"]["W"]["valTop1AtBest"], "baseMinutes": d["meta"]["W"]["baseMinutes"]}
            for d in sorted(W, key=lambda d: d["seedIndex"])]
    res = {"what": "E's windows vs blocks with both networks trained with SapiMouse's recipe", "preregistrationESha256": e_sha,
           "scriptSha256": EN.sha_of(os.path.abspath(__file__)), "users": users, "lengthsBlocks": KB, "lengthsWindows": KW,
           "primaryAuc": {a: float(np.mean(v)) for a, v in prim.items()}, "aucByLength": byk, "eerAt5Blocks": eer5,
           "primary": {"comparison": "W-OC minus K-OC (both SapiMouse training)", **primary, "verdict": verdict},
           "secondary": {"comparison": "W-BIN minus K-BIN (both SapiMouse training)", **secondary},
           "recipeEffectWindowsOC": {"comparison": "W-OC SapiMouse training minus W-OC E", **recipe_oc},
           "recipeEffectWindowsBIN": {"comparison": "W-BIN SapiMouse training minus W-BIN E", **recipe_bin},
           "windowBase": base}
    with open(os.path.join(OUT, "e_native_w_result.json"), "w") as f:
        json.dump(res, f, indent=1)
    fmt = lambda r: (f"{r['meanDiff']:+.4f} [{r['ci95'][0]:+.4f}, {r['ci95'][1]:+.4f}] p {r['p']:.4f}, "
                     f"second higher for {r['bBetter']}/{r['n']}")
    L = [f"E windows vs blocks, both networks trained as SapiMouse trains them (prereg E {e_sha[:12]}), {len(users)} users, 3 seeds",
         "window base, validation top-1 at the kept weights: " + ", ".join(
             f"{b['valTop1AtBest']:.3f} (epoch {b['bestEpoch']} of {b['epochsRun']})" for b in base),
         "", f"{'arm':<30}{'primary':>9}" + "".join(f"{f'{b}b/{w}w':>10}" for b, w in zip(KB, KW)) + f"{'EER@5b':>9}"]
    for a in arms:
        L.append(f"{a:<30}{np.mean(prim[a]):>9.3f}" + "".join(f"{x:>10.3f}" for x in byk[a]) + f"{eer5[a] * 100:>8.1f}%")
    L += ["", f"PRIMARY   W-OC minus K-OC (both SapiMouse training): {fmt(primary)} -> {verdict}",
          f"SECONDARY W-BIN minus K-BIN (both SapiMouse training): {fmt(secondary)}",
          f"recipe effect on windows, OC: {fmt(recipe_oc)}", f"recipe effect on windows, BIN: {fmt(recipe_bin)}"]
    txt = "\n".join(L)
    open(os.path.join(OUT, "e_native_w_result.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--seed", type=int, choices=[0, 1, 2])
    ap.add_argument("--threads", type=int, default=6)
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()
    if args.run:
        if args.seed is None:
            sys.exit("--run needs --seed")
        run(args.seed, args.threads, args.smoke)
    elif args.analyze:
        analyze()
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
