"""
Enrolment requirement for the configuration Experiment E adopts (PREREGISTRATION_E.md,
"Afterwards"): rule C-1 of PREREGISTRATION_C.md -- the smallest enrolment budget whose per-user
test-half AUC is non-inferior to the largest budget within 0.02 (paired bootstrap 95% CI).

Budgets:  W (50-step windows)  55, 110, 220, 330, 440 windows
          K (128-step blocks)   5,   9,  17,  26,  35 blocks   (matched in steps)
The first b units of the target's 3-minute session are used; genuine = the target's 1-minute
session; impostors = the other held-out users' 1-minute sessions. Verifier OC or BIN exactly as in
repr_arch_segm.py.

    python repr_enrol_curve.py --seg W --verifier BIN --seed 0
    python repr_enrol_curve.py --analyze --seg W --verifier BIN
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
from repr_arch_study import (ARCHS, raw_steps, _read_events, train_base, personalise,        # noqa: E402
                             FeatureScaler, NEG_USERS, NEG_PER_USER, NEG_PER_TARGET, BASE_SEEDS,
                             DATA_DIR, HOLDOUT)
from repr_arch_segm import units, ARCH                                                        # noqa: E402

ROOT = "/app/artifacts/repr_arch_study"
PREREG_E = os.path.join(ROOT, "PREREGISTRATION_E.md")
BUDGETS = {"W": [55, 110, 220, 330, 440], "K": [5, 9, 17, 26, 35]}
DELTA = 0.02


def run(args):
    import tensorflow as tf
    from tensorflow.keras import Model
    from sklearn.svm import OneClassSVM
    tf.config.threading.set_intra_op_parallelism_threads(args.threads)
    tf.config.threading.set_inter_op_parallelism_threads(2)
    sha = hashlib.sha256(open(PREREG_E, "rb").read()).hexdigest()
    seed, seg, ver = BASE_SEEDS[args.seed], args.seg, args.verifier
    budgets = BUDGETS[seg]
    holdout = json.load(open(HOLDOUT))["holdout_users"]
    uids = sorted((os.path.basename(d) for d in glob.glob(os.path.join(DATA_DIR, "user*"))),
                  key=lambda u: int(u[4:]))
    base_users = [u for u in uids if u not in holdout]

    def sessions(u):
        cs = sorted(glob.glob(os.path.join(DATA_DIR, u, "*.csv")))
        lo = [c for c in cs if "3min" in os.path.basename(c)]
        sh = [c for c in cs if "1min" in os.path.basename(c)]
        return (lo[0] if lo else None), (sh[0] if sh else None)

    R_of = lambda csv: raw_steps(_read_events(csv))
    Xtr, ytr, Xva, yva = [], [], [], []
    for ci, u in enumerate(base_users):
        lo, sh = sessions(u)
        if not lo or not sh:
            continue
        R = R_of(lo); cut = int(len(R) * 0.8)
        a, b = units(seg, R, 0, cut), units(seg, R, cut, None)
        Xtr.append(a); ytr += [ci] * len(a); Xva.append(b); yva += [ci] * len(b)
    Xtr, Xva = np.concatenate(Xtr), np.concatenate(Xva)
    remap = {c: i for i, c in enumerate(sorted(set(ytr)))}
    ytr = np.asarray([remap[c] for c in ytr]); yva = np.asarray([remap[c] for c in yva])
    scaler = FeatureScaler.fit(Xtr)
    base, ep = train_base(ARCH, scaler.transform(Xtr), ytr, scaler.transform(Xva), yva, len(remap),
                          seed, args.base_epochs)
    base_w = {l.name: l.get_weights() for l in base.layers if l.get_weights()}
    emb = Model(base.input, base.get_layer("embedding").output)
    print(f"[{seg}-{ver} s{args.seed}] base {Xtr.shape} {ep} epochs")

    test = {u: scaler.transform(units(seg, R_of(sessions(u)[1]))) for u in holdout if sessions(u)[1]}
    test = {u: x for u, x in test.items() if len(x)}
    enrol_all = {u: scaler.transform(units(seg, R_of(sessions(u)[0]))) for u in holdout
                 if all(sessions(u)) and u in test}
    targets = [u for u in holdout if u in enrol_all and len(enrol_all[u]) >= max(budgets)]
    if args.limit:
        targets = targets[:args.limit]
    print(f"targets {len(targets)} with >= {max(budgets)} enrolment units")

    if ver == "OC":
        test_emb = {u: emb.predict(x, batch_size=512, verbose=0) for u, x in test.items()}
    else:
        rng = np.random.default_rng(21)
        parts = []
        for u in rng.choice(base_users, size=NEG_USERS, replace=False):
            w = units(seg, R_of(sessions(u)[0]))
            if len(w):
                parts.append(w[rng.choice(len(w), size=min(NEG_PER_USER, len(w)), replace=False)])
        neg_pool = scaler.transform(np.concatenate(parts))
        nrng = np.random.default_rng(1000 + args.seed)

    rows = []
    for u in targets:
        row = {"participant": u}
        if ver == "BIN":
            negs = neg_pool[nrng.choice(len(neg_pool), size=min(NEG_PER_TARGET, len(neg_pool)), replace=False)]
        for b in budgets:
            X = enrol_all[u][:b]
            if ver == "OC":
                oc = OneClassSVM(gamma="scale").fit(emb.predict(X, batch_size=512, verbose=0))
                g = oc.decision_function(test_emb[u]).tolist()
                runs = {o: oc.decision_function(x).tolist() for o, x in test_emb.items() if o != u}
            else:
                m, _ = personalise(ARCH, base_w, Xtr.shape[1:], ARCHS[ARCH][2], X, negs, seed + 7)
                g = m.predict(test[u], batch_size=1024, verbose=0)[:, 1].tolist()
                runs = {o: m.predict(x, batch_size=1024, verbose=0)[:, 1].tolist()
                        for o, x in test.items() if o != u}
                del m
                tf.keras.backend.clear_session(); gc.collect()
            row[str(b)] = {"_genuineScores": g, "_impostorRuns": runs}
        rows.append(row)
        print(f"  {u:>8} done")
    os.makedirs(args.out_dir, exist_ok=True)
    out = os.path.join(args.out_dir, f"CURVE_{seg}-{ver}_s{args.seed}.json")
    json.dump({"preregistrationESha256": sha, "seg": seg, "verifier": ver, "budgets": budgets,
               "seedIndex": args.seed, "perUser": rows}, open(out, "w"))
    print(f"wrote {out}")


def analyze(args):
    import repr_arch_analyze as RA
    sha = hashlib.sha256(open(PREREG_E, "rb").read()).hexdigest()
    docs = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(args.root, "parts",
                                                                     f"CURVE_{args.seg}-{args.verifier}_s*.json")))]
    if len(docs) != 3 or any(d["preregistrationESha256"] != sha for d in docs):
        sys.exit(f"REFUSING: need 3 seeds under prereg E, found {len(docs)}")
    budgets = docs[0]["budgets"]
    auc = {}
    for d in docs:
        for r in d["perUser"]:
            for b in budgets:
                test = RA.halves(r[str(b)])[1]
                auc.setdefault(b, {}).setdefault(r["participant"], []).append(RA.window_metrics(test)["auc"])
    users = sorted(set.intersection(*[set(auc[b]) for b in budgets]))
    A = {b: [float(np.mean(auc[b][u])) for u in users] for b in budgets}
    bmax = max(budgets)
    step = 128 if args.seg == "K" else None
    print(f"{args.seg}-{args.verifier}: {len(users)} users | test-half unit-level AUC by enrolment budget")
    res = {}
    for b in budgets:
        steps = b * 128 if args.seg == "K" else 50 + 10 * (b - 1)
        r = RA.boot(A[bmax], A[b])
        ok = r["ci95"][0] >= -DELTA
        res[b] = {"meanAUC": float(np.mean(A[b])), "diffVsMax": r["meanDiff"], "ci95": r["ci95"], "nonInferior": ok,
                  "secondsOfSession": round(steps * 0.0269, 1)}
        print(f"  b={b:>3} (~{steps*0.0269:4.0f} s): AUC {np.mean(A[b]):.3f}  vs max {r['meanDiff']:+.4f} "
              f"[{r['ci95'][0]:+.4f}, {r['ci95'][1]:+.4f}]  {'non-inferior' if ok else '-'}")
    bmin = min(b for b in budgets if res[b]["nonInferior"])
    print(f"-> enrolment requirement: {bmin} units (~{res[bmin]['secondsOfSession']} s of session)")
    json.dump({"seg": args.seg, "verifier": args.verifier, "users": users, "byBudget": res, "bmin": bmin},
              open(os.path.join(args.root, f"analysis_CURVE_{args.seg}-{args.verifier}.json"), "w"), indent=1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seg", choices=["K", "W"], required=True)
    ap.add_argument("--verifier", choices=["OC", "BIN"], required=True)
    ap.add_argument("--seed", type=int, choices=[0, 1, 2])
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--threads", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--base-epochs", type=int, default=40)
    ap.add_argument("--out-dir", default=os.path.join(ROOT, "parts"))
    ap.add_argument("--root", default=ROOT)
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    analyze(a) if a.analyze else run(a)
