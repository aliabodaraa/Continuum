"""Phase 2, first development check (EXPLORATORY, development users only; decides nothing).

Run inside the model-api container (it needs TensorFlow):
    cd /app/services/model-api/analysis/phase2 && python frozen_check.py

Question: can a FROZEN embedding with no per-user network training match the deployed per-user
fine-tuning on the development users?

  A   deployed recipe (per-user fine-tuned FCN, Method A, 330 windows)   -- stored P1 streams, order 0
  B   same model family, leave-one-sample-out threshold source          -- stored P1 streams, order 0
  F0  frozen base-80 FCN embedding (GAP layer), centred + L2-normalised; score = cosine to the
      user's enrolment centroid
  F1  F0 + symmetric score normalisation (S-norm) against a cohort of the 80 base-training users
  F2  frozen embedding + logistic-regression head (enrolment windows vs 660 cohort windows)

Same windows (rebuilt with repr_arch_study, verified window-for-window against the P1 stream lengths),
same impostors (the 19 other development users' first 150 windows of their 1-min session), same
330-window enrolment (first 330 windows of the 3-min session). The threshold-source ("ref") scores of
F0-F2 are leave-one-sample-out over the 6 enrolment samples of 55 windows, with the 4 windows on each
side of the held-out sample purged from what is fitted.
"""
import json
import os
import sys

os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"
import numpy as np  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(HERE, "..", "phase1"))
sys.path.insert(0, os.path.join(ROOT, "services", "model-api"))
import eval_decision_level as E  # noqa: E402
import p1lib as L  # noqa: E402
import run_phase1 as R  # noqa: E402

SPLIT = json.load(open(os.path.join(ROOT, "artifacts", "repr_arch_study", "SPLIT_J.json")))
SCALER = json.load(open(os.path.join(ROOT, "artifacts", "mouse-fcn-a5-j80", "scaler.json")))
MODEL = os.path.join(ROOT, "artifacts", "mouse-fcn-a5-j80", "final_model")
DATA = os.path.join(ROOT, "data", "sapimouse")


def build_windows():
    """A5 windows of every SapiMouse user, built with the study's own functions."""
    import glob
    from repr_arch_study import raw_steps, windows, _read_events
    out = {}
    for d in glob.glob(os.path.join(DATA, "user*")):
        u = os.path.basename(d)
        cs = sorted(glob.glob(os.path.join(d, "*.csv")))
        lo = [c for c in cs if "3min" in os.path.basename(c)]
        sh = [c for c in cs if "1min" in os.path.basename(c)]
        if lo:
            out[f"{u}|long"] = windows(raw_steps(_read_events(lo[0])), 1.0, "A5")
        if sh:
            out[f"{u}|short"] = windows(raw_steps(_read_events(sh[0])), 1.0, "A5")
    return out


W = build_windows()
BUDGET, SAMPLE, PURGE, IMP_RUN = 330, 55, 4, 150
OUT = os.path.join(ROOT, "artifacts", "phase2", "frozen_check.json")


def scale(X):
    return ((X - np.asarray(SCALER["mean"])) / np.asarray(SCALER["std"])).astype(np.float32)


def embedder():
    import tensorflow as tf
    tf.config.threading.set_intra_op_parallelism_threads(2)
    m = tf.keras.models.load_model(MODEL, compile=False)
    sub = tf.keras.Model(m.input, m.get_layer("embedding").output)
    return lambda X: sub.predict(scale(X), batch_size=512, verbose=0)


def loso_folds(n=BUDGET, k=SAMPLE):
    """(train_idx, held_idx) per enrolment sample, purging PURGE windows either side of the held block."""
    folds = []
    for s in range(n // k):
        lo, hi = s * k, (s + 1) * k
        held = np.arange(lo, hi)
        keep = np.array([i for i in range(n) if i < lo - PURGE or i >= hi + PURGE])
        folds.append((keep, held))
    return folds


def unit_norm(Z):
    return Z / np.maximum(np.linalg.norm(Z, axis=1, keepdims=True), 1e-12)


def main():
    emb = embedder()
    dev = SPLIT["development"]
    targets = SPLIT["summary"]["developmentEligibleFor330"]
    base = SPLIT["baseTraining"]
    rng = np.random.default_rng(7)

    # cohort: base-training users only (the base network saw them; development users it did not)
    coh_w, coh_cent = [], []
    for u in base:
        X = W[f"{u}|long"]
        Z = emb(X)
        coh_cent.append(Z.mean(0))
        coh_w.append(Z[rng.choice(len(Z), min(40, len(Z)), replace=False)])
    coh_w = np.concatenate(coh_w)
    mu = coh_w.mean(0)                                   # centring vector (GAP features are >= 0)
    C = unit_norm(coh_w - mu)                            # cohort windows
    CC = unit_norm(np.asarray(coh_cent) - mu)            # cohort centroids (80)
    neg_idx = np.random.default_rng(21).choice(len(C), 2 * BUDGET, replace=False)

    Z = {u: {"enrol": unit_norm(emb(W[f"{u}|long"][:BUDGET]) - mu),
             "short": unit_norm(emb(W[f"{u}|short"]) - mu)} for u in dev}

    from sklearn.linear_model import LogisticRegression

    def arms_for(u):
        E_ = Z[u]["enrol"]
        test = {"genuine": Z[u]["short"], **{o: Z[o]["short"][:IMP_RUN] for o in dev if o != u}}

        def cos_scores(cent, X):
            return X @ unit_norm(cent[None])[0]

        def snorm(raw, X, cent):
            # test-side: the probe window against the 80 cohort centroids
            t = X @ CC.T
            # model-side: the cohort windows against this user's centroid
            z = C @ unit_norm(cent[None])[0]
            return 0.5 * ((raw - t.mean(1)) / t.std(1) + (raw - z.mean()) / z.std())

        def lr_fit(P):
            Xf = np.concatenate([P, C[neg_idx]])
            y = np.r_[np.ones(len(P)), np.zeros(len(neg_idx))]
            return LogisticRegression(C=1.0, max_iter=2000).fit(Xf, y)

        out = {}
        cent = E_.mean(0)
        lr = lr_fit(E_)
        full = {"F0": lambda X: cos_scores(cent, X),
                "F1": lambda X: snorm(cos_scores(cent, X), X, cent),
                "F2": lambda X: lr.predict_proba(X)[:, 1]}
        refs = {k: np.zeros(BUDGET) for k in full}
        for keep, held in loso_folds():
            c = E_[keep].mean(0)
            refs["F0"][held] = cos_scores(c, E_[held])
            refs["F1"][held] = snorm(cos_scores(c, E_[held]), E_[held], c)
            refs["F2"][held] = lr_fit(E_[keep]).predict_proba(E_[held])[:, 1]
        for k, f in full.items():
            out[k] = {"genuine": f(test["genuine"]), "runs": {o: f(test[o]) for o in test if o != "genuine"},
                      "ref": refs[k], "tau": float(np.percentile(refs[k], 1))}
        return out

    units = {k: {} for k in ("F0", "F1", "F2")}
    for u in targets:
        a = arms_for(u)
        for k in units:
            units[k][u] = a[k]
        print(f"  {u} done", flush=True)

    recs = R._recs("J_P1")
    A, B = R.dev_units(recs, 0)
    systems = {"A": A, "B": B, **units}

    res = {"note": "EXPLORATORY development check (19 development users, whole 1-min session). Decides nothing.",
           "window": {}, "decision": {}}
    for s, U in systems.items():
        aucs, eers = [], []
        for u in targets:
            g = np.asarray(U[u]["genuine"], float)
            imp = np.concatenate([np.asarray(v, float) for v in U[u]["runs"].values()])
            aucs.append(L.auc_of(g, imp)); eers.append(L.eer_of(g, imp)[0])
        res["window"][s] = {"aucMean": float(np.mean(aucs)), "eerMean": float(np.mean(eers)), "_auc": aucs, "_eer": eers}
    for n in E.LENGTHS:
        ev = {s: E.evaluate(U, n) for s, U in systems.items()}
        row = {}
        for s in systems:
            row[s] = {"perUserAucPct": float(np.mean([ev[s]["perUser"][u]["aucPct"] for u in targets])),
                      "pooledPctEer": ev[s]["pooled"]["pct"]["eer"], "pooledPctAuc": ev[s]["pooled"]["pct"]["auc"]}
        cmp = {}
        for s in ("B", "F0", "F1", "F2"):
            a = [ev["A"]["perUser"][u]["aucPct"] for u in targets]
            b = [ev[s]["perUser"][u]["aucPct"] for u in targets]
            pb = E.paired_bootstrap(ev["A"]["_dec"], ev[s]["_dec"], targets, B=1000)
            cmp[f"{s}-A"] = {"perUserAucPct": L.boot(a, b), "pooledPctEer": pb["pct.eer"]}
        res["decision"][str(n)] = {"seconds": round(E.seconds(n), 1), "systems": row, "vsA": cmp}
    for s in ("B", "F0", "F1", "F2"):
        res["window"][s]["aucVsA"] = L.boot(res["window"]["A"]["_auc"], res["window"][s]["_auc"])
        res["window"][s]["eerVsA"] = L.boot(res["window"]["A"]["_eer"], res["window"][s]["_eer"])
    json.dump(res, open(OUT, "w"), indent=1, default=float)

    print("\nwindow level (19 development users, mean over users)")
    for s in systems:
        w = res["window"][s]
        extra = ""
        if s != "A":
            d = w["aucVsA"]
            extra = f"  AUC vs A {d['meanDiff']:+.3f} [{d['ci95'][0]:+.3f}, {d['ci95'][1]:+.3f}] p {d['p']:.3f}"
        print(f"  {s:3s} AUC {w['aucMean']:.3f}  EER {w['eerMean']*100:5.1f}%{extra}")
    for n, d in res["decision"].items():
        print(f"\ndecisions of {d['seconds']} s")
        for s, v in d["systems"].items():
            extra = ""
            if s != "A":
                c = d["vsA"][f"{s}-A"]
                pa, pe = c["perUserAucPct"], c["pooledPctEer"]
                extra = (f"  per-user AUC vs A {pa['meanDiff']:+.3f} [{pa['ci95'][0]:+.3f}, {pa['ci95'][1]:+.3f}]"
                         f"  pooled EER vs A {pe['diff']*100:+.1f} pts [{pe['ci95'][0]*100:+.1f}, {pe['ci95'][1]*100:+.1f}]")
            print(f"  {s:3s} per-user AUC {v['perUserAucPct']:.3f}  pooled EER {v['pooledPctEer']*100:5.1f}%{extra}")


if __name__ == "__main__":
    main()
