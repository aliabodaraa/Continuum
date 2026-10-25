"""Experiment E's block arms (K-OC, K-BIN) again, with the block network trained the way SapiMouse's released code
trains it.

Why: in experiment E (artifacts/repr_arch_study/PREREGISTRATION_E.md, f410e4b0) both segmentations trained their base
FCN with the windows recipe (repr_arch_study.train_base: Adam 1e-3, batch 128, early stopping after 12 epochs without
a lower validation loss, best weights restored). On the 4,351 training blocks the validation loss was lowest after the
FIRST epoch in all three seeds (identification accuracy 2.6-3.9%, chance 1%), so training stopped at epoch 13 and the
block arms used an almost untrained network, while the window network trained for 28-39 epochs. E-2's windows-minus-
blocks difference (+0.103 per-user AUC) is therefore confounded with a training failure.

This script repeats E's K part line for line (repr_arch_segm.main with seg == "K") with ONE change: the base FCN is
trained with SapiMouse's recipe (github.com/margitantal68/sapimouse, as transcribed in sapimouse_oneclass_sweep.py):
Adam 1e-4, batch 16, 100 epochs, ReduceLROnPlateau(val_loss, factor 0.5, patience 50), and the weights with the lowest
validation loss are kept. Everything else is E's: the 100 base users and their per-user 80/20 temporal split, the
scaler, the seeds (101-103), the 20 targets, the enrolment (whole 3-min session), the genuine test (whole 1-min
session), the impostor runs, the One-Class SVM and the fine-tuned binary head. Every target's units are checked against
E's stored K arms before anything is scored. The window arms are not re-run: E's stored W-OC and W-BIN scores are used.

Reading rule, fixed before any result exists (owner, 20 Oct 2026). Primary: W-OC minus K-OC(native) on E's primary
endpoint (per-user AUC averaged over the five matched lengths, then over seeds), paired bootstrap over the 20 users.
Windows better if the difference is > 0 with p < 0.05, blocks better if it is < 0 with p < 0.05, otherwise a tie.
Not pre-registered: a sensitivity check of one protocol choice, reported as such.

The analysis also reports SapiMouse's code on its own 72/48 split in the paper's own way (one pooled ROC over every
target's normalised scores), for comparison with its published figure. The 4 Sep 2026 run of that code
(artifacts/sapimouse-fcn/oneclass.json) kept no scores, so the same script, which has kept them since, was re-run on
20 Oct 2026:
    python sapimouse_oneclass_sweep.py --out /app/artifacts/phase6/sapimouse_rerun/oneclass.json

    python analysis/phase6/e_native_blocks.py --run --seed 0 [--threads 4]   # artifacts/phase6/e_native/EN_s0.json
    python analysis/phase6/e_native_blocks.py --analyze                       # artifacts/phase6/e_native_result.json/.txt
    python analysis/phase6/e_native_blocks.py --run --seed 0 --smoke          # 2 targets, 3 epochs, artifacts/phase6/smoke/
"""
import argparse
import gc
import glob
import hashlib
import json
import os
import re
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MA = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, MA)
from repr_arch_study import (ARCHS, build, raw_steps, _read_events, personalise, FeatureScaler,  # noqa: E402
                             NEG_USERS, NEG_PER_USER, NEG_PER_TARGET, BASE_SEEDS, DATA_DIR, HOLDOUT)
from repr_arch_segm import ARCH, units  # noqa: E402

ROOT = "/app/artifacts"
E_DIR = os.path.join(ROOT, "repr_arch_study")
PREREG_E = os.path.join(E_DIR, "PREREGISTRATION_E.md")
OUT = os.path.join(ROOT, "phase6")
SM_LR, SM_BATCH, SM_EPOCHS, SM_PLATEAU = 1e-4, 16, 100, 50   # SapiMouse: util/settings.py, util/fcn.py
PUBLISHED_POOLED = {1: 0.88, 2: 0.92, 3: 0.94, 4: 0.94, 5: 0.95}  # SapiMouse Fig. 8 legend


def sha_of(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def train_base_sapimouse(Xtr, ytr, Xva, yva, n_cls, seed, epochs):
    """SapiMouse's training of the FCN, on E's data: Adam 1e-4, batch 16, ReduceLROnPlateau(val_loss, 0.5, 50) and the
    weights with the lowest validation loss kept (their ModelCheckpoint save_best_only). Same network and seed call as
    E's train_base, so the two runs start from the same initial weights."""
    import tensorflow as tf
    from tensorflow.keras.callbacks import Callback, ReduceLROnPlateau
    from tensorflow.keras.optimizers import Adam
    tf.keras.utils.set_random_seed(seed)
    m = build(ARCH, Xtr.shape[1:], n_cls)
    m.compile(optimizer=Adam(learning_rate=SM_LR), loss="sparse_categorical_crossentropy", metrics=["accuracy"])

    class KeepBest(Callback):
        def __init__(self):
            super().__init__()
            self.best, self.epoch, self.weights = np.inf, -1, None

        def on_epoch_end(self, epoch, logs=None):
            v = (logs or {}).get("val_loss", np.inf)
            if v < self.best:
                self.best, self.epoch, self.weights = v, epoch, self.model.get_weights()

    keep = KeepBest()
    h = m.fit(Xtr, ytr, validation_data=(Xva, yva), epochs=epochs, batch_size=SM_BATCH, verbose=2,
              callbacks=[ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=SM_PLATEAU, min_lr=1e-6), keep])
    m.set_weights(keep.weights)
    hist = {k: [float(x) for x in v] for k, v in h.history.items()}
    return m, hist, keep.epoch + 1


def run(seed_idx, threads, smoke):
    import tensorflow as tf
    from tensorflow.keras import Model
    from sklearn.svm import OneClassSVM
    tf.config.threading.set_intra_op_parallelism_threads(threads)
    tf.config.threading.set_inter_op_parallelism_threads(2)
    seed = BASE_SEEDS[seed_idx]
    e_sha = sha_of(PREREG_E)
    ref = json.load(open(os.path.join(E_DIR, "parts", f"E_s{seed_idx}.json")))
    if ref["preregistrationESha256"] != e_sha:
        sys.exit("REFUSING: E's stored results were produced under a different pre-registration")
    refK = {r["participant"]: r for r in ref["perUser"]}
    print(f"[EN_s{seed_idx}] E's block arms, base trained with SapiMouse's recipe | prereg E {e_sha[:12]}")

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
    seg = "K"

    # ---- base FCN (identification on the 100 base users), E's data, SapiMouse's training ----
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
    if len(Xtr) != ref["meta"]["K"]["trainUnits"]:
        sys.exit(f"REFUSING: {len(Xtr)} training blocks, E had {ref['meta']['K']['trainUnits']}")
    scaler = FeatureScaler.fit(Xtr)
    t0 = time.time()
    base, hist, best_ep = train_base_sapimouse(scaler.transform(Xtr), ytr, scaler.transform(Xva), yva, len(remap),
                                               seed, 3 if smoke else SM_EPOCHS)
    val_top1 = float((base.predict(scaler.transform(Xva), batch_size=1024, verbose=0).argmax(1) == yva).mean())
    base_w = {l.name: l.get_weights() for l in base.layers if l.get_weights()}
    emb = Model(base.input, base.get_layer("embedding").output)
    meta = {"trainUnits": int(len(Xtr)), "valUnits": int(len(Xva)), "unitShape": list(Xtr.shape[1:]),
            "classes": len(remap), "epochsRun": len(hist["loss"]), "bestEpoch": best_ep,
            "bestValLoss": float(min(hist["val_loss"])), "valTop1AtBest": val_top1,
            "baseMinutes": round((time.time() - t0) / 60, 2), "history": hist}
    print(f"[K] base: {Xtr.shape} -> best epoch {best_ep} of {meta['epochsRun']}, val top-1 {val_top1:.4f} "
          f"(chance {1 / len(remap):.4f}), {meta['baseMinutes']} min")

    # ---- material, scaled once, checked against E's stored K arms ----
    test_units = {u: scaler.transform(units(seg, R_of(sessions(u)[1]))) for u in holdout if sessions(u)[1] is not None}
    test_units = {u: x for u, x in test_units.items() if len(x)}
    enrol_units = {u: scaler.transform(units(seg, R_of(sessions(u)[0]))) for u in targets}
    for u in targets:
        rk = refK[u]["K-OC"]
        same = (rk["enrolUnits"] == len(enrol_units[u]) and len(rk["_genuineScores"]) == len(test_units[u])
                and {o: len(v) for o, v in rk["_impostorRuns"].items()}
                == {o: len(x) for o, x in test_units.items() if o != u})
        if not same:
            sys.exit(f"REFUSING: {u}'s blocks differ from E's")
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
        results[u]["K-OC"] = {"_genuineScores": oc.decision_function(test_emb[u]).tolist(),
                              "_impostorRuns": {o: oc.decision_function(x).tolist()
                                                for o, x in test_emb.items() if o != u},
                              "enrolUnits": int(len(enrol_units[u]))}
    del emb
    gc.collect()

    # ---- BIN: Continuum's verifier (fine-tuned, binary head, base-user negatives) ----
    nrng = np.random.default_rng(1000 + seed_idx)
    for u in targets:
        negs = neg_pool[nrng.choice(len(neg_pool), size=min(NEG_PER_TARGET, len(neg_pool)), replace=False)]
        m, pe = personalise(ARCH, base_w, Xtr.shape[1:], ARCHS[ARCH][2], enrol_units[u], negs, seed + 7)
        P = lambda X: m.predict(X, batch_size=1024, verbose=0)[:, 1]
        results[u]["K-BIN"] = {"_genuineScores": P(test_units[u]).tolist(),
                               "_impostorRuns": {o: P(x).tolist() for o, x in test_units.items() if o != u},
                               "enrolUnits": int(len(enrol_units[u])), "epochs": pe}
        del m, P
        tf.keras.backend.clear_session()
        gc.collect()
        print(f"  [K] {u:>8}  enrol {len(enrol_units[u]):>4} blocks  done")

    out_dir = os.path.join(OUT, "smoke" if smoke else "e_native")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"EN_s{seed_idx}.json")
    with open(out, "w") as f:
        json.dump({"what": "experiment E block arms, base FCN trained with SapiMouse's recipe",
                   "preregistrationESha256": e_sha, "scriptSha256": sha_of(os.path.abspath(__file__)),
                   "smoke": bool(smoke), "seedIndex": seed_idx, "baseSeed": seed,
                   "recipe": {"optimizer": "Adam", "learningRate": SM_LR, "batch": SM_BATCH, "epochs": SM_EPOCHS,
                              "reduceLrOnPlateau": {"monitor": "val_loss", "factor": 0.5, "patience": SM_PLATEAU},
                              "keep": "lowest val_loss"},
                   "meta": {"K": meta}, "perUser": list(results.values())}, f)
    print(f"wrote {out}")


def e_recipe_val_top1():
    """Validation accuracy of E's block network at the weights E kept (epoch 1, the first val_accuracy in each log,
    since the K base trains first)."""
    out = []
    for s in range(3):
        txt = open(os.path.join(E_DIR, "logs", f"E_s{s}.log"), encoding="utf-8", errors="replace").read()
        vl = [float(x) for x in re.findall(r"val_loss: ([0-9.]+)", txt)[:13]]
        va = [float(x) for x in re.findall(r"val_accuracy: ([0-9.]+)", txt)[:13]]
        best = int(np.argmin(vl))
        out.append({"seedIndex": s, "bestEpoch": best + 1, "valTop1AtBest": va[best]})
    return out


def pooled_reproduction():
    """Pooled AUC/EER (SapiMouse's reporting: one ROC over every target's normalised scores) from the 20 Oct 2026 re-run
    of SapiMouse's code on its own 72/48 split, next to the paper's Fig. 8 values and the 4 Sep run's per-user means."""
    from keystroke_user_sweep import auc_of, eer_of
    from sapimouse_oneclass_sweep import sets_of
    path = os.path.join(OUT, "sapimouse_rerun", "oneclass.json")
    if not os.path.exists(path):
        return None
    d = json.load(open(path))
    sep4 = json.load(open(os.path.join(ROOT, "sapimouse-fcn", "oneclass.json")))["summary"]
    out = {}
    for k in (1, 2, 3, 4, 5):
        G, I = [], []
        for r in d["perSubject"]:
            g = sets_of(r["_genuine"], k)
            if len(g):
                G.append(g)
            for v in r["_impostorRuns"].values():
                s = sets_of(v, k)
                if len(s):
                    I.append(s)
        G, I = np.concatenate(G), np.concatenate(I)
        pu = [r["blocks"][str(k)]["auc"] for r in d["perSubject"] if r["blocks"].get(str(k))]
        out[k] = {"pooledAuc": float(auc_of(G, I)), "pooledEer": float(eer_of(G, I)[0]),
                  "perUserMeanAuc": float(np.mean(pu)), "perUserMeanAucSep4": sep4[str(k)]["auc"]["mean"],
                  "published": PUBLISHED_POOLED[k]}
    return {"users": len(d["perSubject"]), "fcnValTop1": d["fcnValTop1"], "byBlocks": out}


def analyze():
    import repr_arch_analyze as RA
    from repr_segm_analyze import per_len, KB, KW
    e_sha = sha_of(PREREG_E)
    E = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(E_DIR, "parts", "E_s*.json")))]
    N = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(OUT, "e_native", "EN_s*.json")))]
    if len(E) != 3 or len(N) != 3:
        sys.exit(f"REFUSING: need 3 seeds of each, found E {len(E)} and native {len(N)}")
    if any(d["preregistrationESha256"] != e_sha for d in E + N) or any(d["smoke"] for d in N):
        sys.exit("REFUSING: a result file does not belong to this check")
    if sorted(d["seedIndex"] for d in N) != [0, 1, 2]:
        sys.exit("REFUSING: native seeds are not 0, 1, 2")

    def collect(docs, arm):
        per = {}
        for d in docs:
            for r in d["perUser"]:
                res = [per_len(r[arm], arm, j) for j in range(5)]
                e = per.setdefault(r["participant"], {"prim": [], "auc": [], "eer5": []})
                aucs = [a for a, _ in res]
                e["prim"].append(float(np.nanmean(aucs))); e["auc"].append(aucs); e["eer5"].append(res[4][1])
        return per

    arms = {"K-OC (E, untrained base)": collect(E, "K-OC"), "K-BIN (E, untrained base)": collect(E, "K-BIN"),
            "K-OC (SapiMouse training)": collect(N, "K-OC"), "K-BIN (SapiMouse training)": collect(N, "K-BIN"),
            "W-OC (E)": collect(E, "W-OC"), "W-BIN (E)": collect(E, "W-BIN")}
    users = sorted(set.intersection(*[set(v) for v in arms.values()]))
    prim = {a: [float(np.mean(arms[a][u]["prim"])) for u in users] for a in arms}
    byk = {a: [float(x) for x in np.nanmean([np.nanmean(arms[a][u]["auc"], axis=0) for u in users], axis=0)]
           for a in arms}
    eer5 = {a: float(np.nanmean([np.nanmean(arms[a][u]["eer5"]) for u in users])) for a in arms}

    primary = RA.boot(prim["K-OC (SapiMouse training)"], prim["W-OC (E)"])
    verdict = ("windows better" if primary["meanDiff"] > 0 and primary["p"] < 0.05 else
               "blocks better" if primary["meanDiff"] < 0 and primary["p"] < 0.05 else "tie")
    secondary = RA.boot(prim["K-BIN (SapiMouse training)"], prim["W-BIN (E)"])
    training_effect = RA.boot(prim["K-OC (E, untrained base)"], prim["K-OC (SapiMouse training)"])
    per_length = []
    for j in range(5):
        a = [float(np.nanmean(np.asarray(arms["K-OC (SapiMouse training)"][u]["auc"])[:, j])) for u in users]
        b = [float(np.nanmean(np.asarray(arms["W-OC (E)"][u]["auc"])[:, j])) for u in users]
        per_length.append({"blocks": KB[j], "windows": KW[j], "seconds": round(128 * KB[j] * 0.0269, 1),
                           "W-OC minus K-OC(native)": RA.boot(a, b)})
    base = {"native": [{"seedIndex": d["seedIndex"], "bestEpoch": d["meta"]["K"]["bestEpoch"],
                        "epochsRun": d["meta"]["K"]["epochsRun"], "valTop1AtBest": d["meta"]["K"]["valTop1AtBest"],
                        "baseMinutes": d["meta"]["K"]["baseMinutes"]} for d in sorted(N, key=lambda d: d["seedIndex"])],
            "E": e_recipe_val_top1(), "chance": 1 / N[0]["meta"]["K"]["classes"]}
    repro = pooled_reproduction()

    res = {"what": "sensitivity check of experiment E: block arms with the base trained as SapiMouse's code trains it",
           "preregistrationESha256": e_sha, "scriptSha256": sha_of(os.path.abspath(__file__)), "users": users,
           "lengthsBlocks": KB, "lengthsWindows": KW,
           "primaryAuc": {a: float(np.mean(v)) for a, v in prim.items()}, "aucByLength": byk, "eerAt5Blocks": eer5,
           "primary": {"comparison": "W-OC (E) minus K-OC (SapiMouse training)", **primary, "verdict": verdict},
           "secondary": {"comparison": "W-BIN (E) minus K-BIN (SapiMouse training)", **secondary},
           "trainingEffect": {"comparison": "K-OC (SapiMouse training) minus K-OC (E)", **training_effect},
           "perLength": per_length, "blockBase": base, "sapimouseCodeOnItsSplit": repro}
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "e_native_result.json"), "w") as f:
        json.dump(res, f, indent=1)

    L = [f"E sensitivity check (prereg E {e_sha[:12]}), {len(users)} users, 3 seeds",
         "block base network, validation identification accuracy at the kept weights (chance "
         f"{base['chance']:.3f}): E " + ", ".join(f"{b['valTop1AtBest']:.3f} (epoch {b['bestEpoch']})" for b in base["E"])
         + " | SapiMouse training " + ", ".join(f"{b['valTop1AtBest']:.3f} (epoch {b['bestEpoch']} of "
                                                f"{b['epochsRun']})" for b in base["native"]),
         "", f"{'arm':<30}{'primary':>9}" + "".join(f"{f'{b}b/{w}w':>10}" for b, w in zip(KB, KW)) + f"{'EER@5b':>9}"]
    for a in arms:
        L.append(f"{a:<30}{np.mean(prim[a]):>9.3f}" + "".join(f"{x:>10.3f}" for x in byk[a]) + f"{eer5[a]*100:>8.1f}%")
    fmt = lambda r: (f"{r['meanDiff']:+.4f} [{r['ci95'][0]:+.4f}, {r['ci95'][1]:+.4f}] p {r['p']:.4f}, "
                     f"second higher for {r['bBetter']}/{r['n']}")
    L += ["", f"PRIMARY  W-OC minus K-OC(SapiMouse training): {fmt(primary)} -> {verdict.upper()}",
          f"secondary W-BIN minus K-BIN(SapiMouse training): {fmt(secondary)}",
          f"training effect on blocks, K-OC native minus K-OC E: {fmt(training_effect)}",
          "per length, W-OC minus K-OC(native): " + "; ".join(
              f"{p['blocks']}b {p['W-OC minus K-OC(native)']['meanDiff']:+.3f} (p {p['W-OC minus K-OC(native)']['p']:.3f})"
              for p in per_length),
          ""]
    if repro is None:
        L.append("SapiMouse's code on its own split: re-run not found, not reported")
    else:
        L.append(f"SapiMouse's code on its own split ({repro['users']} users, FCN val top-1 {repro['fcnValTop1']:.3f}):")
        for k, v in repro["byBlocks"].items():
            L.append(f"  {k} blocks: pooled AUC {v['pooledAuc']:.3f} (paper {v['published']:.2f}), pooled EER "
                     f"{v['pooledEer']*100:.1f}%, per-user mean AUC {v['perUserMeanAuc']:.3f} "
                     f"(4 Sep run {v['perUserMeanAucSep4']:.3f})")
    txt = "\n".join(L)
    open(os.path.join(OUT, "e_native_result.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--seed", type=int, choices=[0, 1, 2])
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
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
