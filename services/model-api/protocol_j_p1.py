"""Protocol J, Phase P1: sample order and threshold method (PREREGISTRATION_J.md, section 6).

Per development target: enrolment = first 330 windows of the 3-min session = six 55-window samples,
under 10 orders (identity, the 5 other rotations, 4 permutations from default_rng(20260916)).
  A  current method: contiguous validation tail (20%, gap 5) + boundary purge; threshold from the
     final model's scores on all enrolment windows.
  B  leave-one-sample-out: 6 fold models score the sample they never saw; threshold from the pooled
     out-of-sample scores. Final model on all samples; early stopping on the last 11 windows of every
     sample (the 4 windows before each slice purged).
  C  grouped 3-fold (sample pairs by position in the order); same final model as B (identical recipe,
     so B's final model is reused).
Boundary purge: training/validation windows within 4 windows (in time) of a held-out window are dropped.
Lockbox users are never read.

    python protocol_j_p1.py --worker 0 --workers 4     # trains + scores -> parts/J_P1/<user>.json
    python protocol_j_p1.py --analyze                  # -> analysis_J_P1.json
"""
import argparse
import gc
import json
import os
import shutil
import sys

import numpy as np

os.environ.setdefault("TF_NUM_INTRAOP_THREADS", "6")
os.environ.setdefault("TF_NUM_INTEROP_THREADS", "2")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import protocol_j_common as J  # noqa: E402

BUDGET, SAMPLE, NS, PURGE, VSLICE = 330, 55, 6, 4, 11
PARTS = os.path.join(J.STUDY, "parts", "J_P1")
OUT = os.path.join(J.STUDY, "analysis_J_P1.json")
MODELS = "/app/artifacts/protocol_j/models/P1"


def orders():
    ident = list(range(NS))
    rots = [[(last + 1 + i) % NS for i in range(NS)] for last in range(NS - 1)]   # last element = 0..4
    seen = {tuple(ident)} | {tuple(r) for r in rots}
    rng, perms = np.random.default_rng(20260916), []
    while len(perms) < 4:
        p = [int(x) for x in rng.permutation(NS)]
        if tuple(p) not in seen:
            seen.add(tuple(p)); perms.append(p)
    return [ident] + rots + perms


def sample_idx(s):
    return list(range(SAMPLE * s, SAMPLE * s + SAMPLE))


def purge(idx, held):
    """Drop windows within PURGE (time) of any held-out window."""
    if not held:
        return list(idx)
    h = np.asarray(sorted(held))
    out = []
    for t in idx:
        j = np.searchsorted(h, t)
        near = (j < len(h) and h[j] - t <= PURGE) or (j > 0 and t - h[j - 1] <= PURGE)
        if not near:
            out.append(t)
    return out


def plan_A(order):
    arr = [t for s in order for t in sample_idx(s)]
    n_val = int(round(0.2 * len(arr)))
    cut = len(arr) - n_val
    val = arr[cut:]
    train = purge([arr[p] for p in range(0, cut - 5)], set(val))
    return arr, train, val


def plan_folds(order, held_samples):
    """Training samples in the given order; last VSLICE windows of each validate, the PURGE before it
    are dropped; anything within PURGE of the held-out windows is dropped from both sets."""
    held = [t for s in held_samples for t in sample_idx(s)]
    ordered, train, val = [], [], []
    for s in order:
        if s in held_samples:
            continue
        idx = sample_idx(s)
        ordered += idx
        val += idx[-VSLICE:]
        train += idx[:-(VSLICE + PURGE)]
    return ordered, purge(train, set(held)), purge(val, set(held)), held


def fit_and_score(api, uid, mpath, enrol, ordered, train, val, score_sets):
    """Send enrol[ordered] as the positives (so negatives = 2 x len(ordered) and dedupe act exactly as
    in production); train on the `train` windows and validate on the `val` windows (time indices);
    windows of `ordered` in neither list (gap, purge) are sent but not fitted."""
    pos = {t: p for p, t in enumerate(ordered)}
    res, code = api.train_user_payload({
        "userId": uid, "modality": "mouse", "modelPath": mpath, "positiveWindows": enrol[ordered].tolist(),
        "explicitSplit": {"train": [pos[t] for t in train], "val": [pos[t] for t in val]},
        "overlapGap": 5, "minPositiveWindows": 1, "epochs": 15, "batchSize": 32})
    if code != 200:
        raise RuntimeError(f"{uid}: train failed {code} {res}")
    out = {}
    for name, X in score_sets.items():
        if isinstance(X, dict):
            out[name] = {k: _pred(api, uid, mpath, v) for k, v in X.items()}
        else:
            out[name] = _pred(api, uid, mpath, X)
    api.invalidate_user_model_cache(mpath)
    shutil.rmtree(mpath, ignore_errors=True)
    shutil.rmtree(mpath + "_prev", ignore_errors=True)
    return out, {"split": res.get("splitStrategy"), "negatives": res.get("negativeWindowCount")}


def _pred(api, uid, mpath, X):
    if len(X) == 0:
        return []
    r, c = api.predict_user_payload({"userId": uid, "modality": "mouse", "modelPath": mpath, "windows": np.asarray(X).tolist()})
    if c != 200:
        raise RuntimeError(f"{uid}: predict failed {c} {r}")
    return [round(float(p[1]), 6) for p in r["prediction"]]


def run(worker, workers):
    hashes = J.verify_frozen()
    os.environ["MOUSE_BASE_MODEL_PATH"] = J.BASE80["base"]
    os.environ["MOUSE_SCALER_PATH"] = J.BASE80["scaler"]
    os.environ["MOUSE_NEG_DATASET_PATH"] = J.BASE80["neg"]
    import api
    import tensorflow as tf
    R = J.Reader("P1")
    dev = J.split()["development"]
    test = {u: R.windows(R.sessions(u)[1]) for u in dev if R.sessions(u)[1]}
    targets = [u for u in dev if R.sessions(u)[0] and len(R.windows(R.sessions(u)[0])) >= BUDGET]
    mine = targets[worker::workers]
    os.makedirs(PARTS, exist_ok=True)
    ORD = orders()
    for u in mine:
        out_path = os.path.join(PARTS, f"{u}.json")
        if os.path.exists(out_path):
            print(f"[P1 w{worker}] {u} done already"); continue
        enrol = R.windows(R.sessions(u)[0])[:BUDGET]
        streams = {"genuine": test[u], "impostor": {o: x[:J.IMP_RUN] for o, x in test.items() if o != u and len(x)}}
        rec = {**hashes, "phase": "P1", "participant": u, "orders": ORD, "byOrder": []}
        for oi, order in enumerate(ORD):
            base = f"{MODELS}/{u}/o{oi}"
            ent = {"order": order}
            # A
            arr, tr, va = plan_A(order)
            sc, info = fit_and_score(api, f"j-p1-{u}-o{oi}-A", f"{base}/A", enrol, arr, tr, va,
                                     {"enrol": enrol, **streams})
            ent["A"] = {**sc, "info": info}
            # B/C final model (identical recipe): all samples, per-sample validation slices
            od, tr, va, _ = plan_folds(order, [])
            sc, info = fit_and_score(api, f"j-p1-{u}-o{oi}-F", f"{base}/F", enrol, od, tr, va, {"enrol": enrol, **streams})
            ent["final"] = {**sc, "info": info}
            # B folds
            oof = np.full(BUDGET, np.nan)
            for s in order:
                od, tr, va, held = plan_folds(order, [s])
                sc, _ = fit_and_score(api, f"j-p1-{u}-o{oi}-B{s}", f"{base}/B{s}", enrol, od, tr, va, {"held": enrol[held]})
                oof[held] = sc["held"]
            ent["B_oof"] = [round(float(v), 6) for v in oof]
            # C folds: pairs by position in the order
            oof = np.full(BUDGET, np.nan)
            for f in range(3):
                pair = [order[2 * f], order[2 * f + 1]]
                od, tr, va, held = plan_folds(order, pair)
                sc, _ = fit_and_score(api, f"j-p1-{u}-o{oi}-C{f}", f"{base}/C{f}", enrol, od, tr, va, {"held": enrol[held]})
                oof[held] = sc["held"]
            ent["C_oof"] = [round(float(v), 6) for v in oof]
            rec["byOrder"].append(ent)
            print(f"[P1 w{worker}] {u} order {oi + 1}/{len(ORD)} {order}", flush=True)
            gc.collect()
        json.dump(rec, open(out_path + ".tmp", "w"))
        os.replace(out_path + ".tmp", out_path)
        shutil.rmtree(f"{MODELS}/{u}", ignore_errors=True)
        tf.keras.backend.clear_session(); gc.collect()
        print(f"[P1 w{worker}] wrote {out_path}", flush=True)


# ------------------------------------------------------------------------------ analysis --
def _units(recs, method, oi):
    """Per user: (streams from the method's deployed model, threshold source scores)."""
    U = {}
    for r in recs:
        e = r["byOrder"][oi]
        model = e["A"] if method == "A" else e["final"]
        src = model["enrol"] if method == "A" else e[f"{method}_oof"]
        u = {"_genuineScores": model["genuine"], "_impostorRuns": model["impostor"]}
        U[r["participant"]] = (J.halves(u), np.asarray(src, float))
    return U


def _select(U):
    rules = ([("vote", n, k) for n in (20, 40, 60) for k in range(-(-n // 2), n + 1)]
             + [("mean", n, None) for n in (20, 40, 60)] + [("median", n, None) for n in (20, 40, 60)])
    for budget in (0.2, 0.5, 1.0):
        best = None
        for q in J.Q_GRID:
            for rule, n, k in rules:
                res = {u: J.per_user(h[0], float(np.percentile(src, q)), rule, n, k) for u, (h, src) in U.items()}
                s = J.summary(res)
                if s["promptsPerMinMean"] > budget:
                    continue
                key = (s["impostorRunsCaught"], -(s["timeToCatchMedianS"] or 1e9), -n, -q)
                if best is None or key > best[0]:
                    best = (key, {"q": q, "rule": rule, "n": n, "k": k, "budget": budget, "cal": s})
        if best:
            return best[1]
    return None


def analyze():
    hashes = J.verify_frozen()
    import repr_arch_analyze as RA
    from keystroke_user_sweep import auc_of, eer_of, tar_at_far
    recs = []
    for f in sorted(os.listdir(PARTS)):
        if f.endswith(".json"):
            r = json.load(open(os.path.join(PARTS, f)))
            for k, v in hashes.items():
                if r.get(k) != v:
                    raise SystemExit(f"{f}: produced under another {k}")
            recs.append(r)
    users = sorted(r["participant"] for r in recs)
    n_orders = len(recs[0]["byOrder"])
    out = {**hashes, "phase": "P1", "targets": len(users), "orders": recs[0]["orders"], "methods": {}}
    per_method = {}
    for m in ("A", "B", "C"):
        op = _select(_units(recs, m, 0))
        rows = {u: [] for u in users}
        for oi in range(n_orders):
            U = _units(recs, m, oi)
            for u, (h, src) in U.items():
                tau = float(np.percentile(src, op["q"]))
                t = h[1]
                imp = np.concatenate(list(t["runs"].values()))
                r = J.per_user(t, tau, op["rule"], op["n"], op["k"])
                rows[u].append({"threshold": tau, "lowWindowRate": r["lowWindowRate"], "promptsPerMin": r["promptsPerMin"],
                                "runsCaught": float(np.mean(r["caught"])), "timeToCatch": float(np.median(r["times"])) if r["times"] else None,
                                "auc": float(auc_of(t["g"], imp)), "eer": float(eer_of(t["g"], imp)[0]),
                                "tar01": float(tar_at_far(t["g"], imp, 0.01)[0])})
        sens = {u: {k: {"sd": float(np.std([x[k] for x in v], ddof=1)), "range": float(np.ptp([x[k] for x in v]))}
                    for k in ("threshold", "lowWindowRate", "promptsPerMin")} for u, v in rows.items()}
        mean_over_orders = {u: {k: float(np.nanmean([x[k] for x in v if x[k] is not None])) if any(x[k] is not None for x in v) else None
                                for k in ("runsCaught", "promptsPerMin", "auc", "eer", "tar01", "lowWindowRate", "threshold")}
                            for u, v in rows.items()}
        per_method[m] = (sens, mean_over_orders)
        matters = sum(1 for u in users if sens[u]["threshold"]["range"] > 0.10 or sens[u]["lowWindowRate"]["range"] > 0.10
                      or sens[u]["promptsPerMin"]["range"] > 0.5)
        out["methods"][m] = {"operatingPoint": op, "perUserByOrder": rows, "sensitivity": sens, "meanOverOrders": mean_over_orders,
                             "usersWhereOrderMatters": matters,
                             "summary": {k: float(np.mean([mean_over_orders[u][k] for u in users if mean_over_orders[u][k] is not None]))
                                         for k in ("runsCaught", "promptsPerMin", "auc", "eer", "tar01", "lowWindowRate")},
                             "sdLowWindowRateMean": float(np.mean([sens[u]["lowWindowRate"]["sd"] for u in users])),
                             "sdThresholdMean": float(np.mean([sens[u]["threshold"]["sd"] for u in users]))}
    # ---- order matters (Method A), pre-registered conclusion
    out["orderMattersA"] = {"users": out["methods"]["A"]["usersWhereOrderMatters"], "of": len(users),
                            "conclusion": out["methods"]["A"]["usersWhereOrderMatters"] >= 0.25 * len(users)}
    # ---- adoption tests
    sA, mA = per_method["A"]
    tests = {}
    for m in ("B", "C"):
        s, mm = per_method[m]
        sd = RA.boot([sA[u]["lowWindowRate"]["sd"] for u in users], [s[u]["lowWindowRate"]["sd"] for u in users])
        cap = RA.boot([mA[u]["runsCaught"] for u in users], [mm[u]["runsCaught"] for u in users])
        rate = RA.boot([mA[u]["promptsPerMin"] for u in users], [mm[u]["promptsPerMin"] for u in users])
        tests[m] = {"sdLowWindowRate": sd, "runsCaught": cap, "promptsPerMin": rate}
    ps = RA.holm([tests["B"]["sdLowWindowRate"]["p"], tests["C"]["sdLowWindowRate"]["p"]])
    for m, ph in zip(("B", "C"), ps):
        t = tests[m]
        t["sdLowWindowRate"]["pHolm"] = float(ph)
        t["qualifies"] = bool(t["sdLowWindowRate"]["meanDiff"] < 0 and ph < 0.05
                              and t["runsCaught"]["ci95"][0] >= -0.05 and t["promptsPerMin"]["ci95"][1] <= 0.1)
    if tests["B"]["qualifies"] and tests["C"]["qualifies"]:
        adopted = "C" if (tests["C"]["runsCaught"]["meanDiff"] - tests["B"]["runsCaught"]["meanDiff"]) >= -0.02 else "B"
    elif tests["B"]["qualifies"]:
        adopted = "B"
    elif tests["C"]["qualifies"]:
        adopted = "C"
    else:
        adopted = "A"
    out["tests"], out["adopted"] = tests, adopted
    json.dump(out, open(OUT, "w"), indent=1)

    print(f"P1: {len(users)} development targets x {n_orders} orders, test halves, live cadence")
    for m in ("A", "B", "C"):
        d = out["methods"][m]; op = d["operatingPoint"]; s = d["summary"]
        print(f"  {m}: point q{op['q']} {op['rule']} n={op['n']} k={op['k']} (cal budget {op['budget']}) | mean over orders: "
              f"caught {s['runsCaught']*100:.1f}% prompts/min {s['promptsPerMin']:.2f} low-window {s['lowWindowRate']*100:.1f}% "
              f"AUC {s['auc']:.3f} | order SD: low-window {d['sdLowWindowRateMean']*100:.1f} pts, threshold {d['sdThresholdMean']:.3f} "
              f"| order matters for {d['usersWhereOrderMatters']}/{len(users)}")
    print(f"  order materially affects Method A: {out['orderMattersA']['conclusion']} ({out['orderMattersA']['users']}/{len(users)} users)")
    for m in ("B", "C"):
        t = tests[m]
        print(f"  {m} vs A: SD(low-window) {t['sdLowWindowRate']['meanDiff']*100:+.1f} pts [{t['sdLowWindowRate']['ci95'][0]*100:+.1f}, "
              f"{t['sdLowWindowRate']['ci95'][1]*100:+.1f}] pHolm {t['sdLowWindowRate']['pHolm']:.4f} | caught {t['runsCaught']['meanDiff']*100:+.1f} "
              f"[{t['runsCaught']['ci95'][0]*100:+.1f}, {t['runsCaught']['ci95'][1]*100:+.1f}] | prompts/min {t['promptsPerMin']['meanDiff']:+.2f} "
              f"[{t['promptsPerMin']['ci95'][0]:+.2f}, {t['promptsPerMin']['ci95'][1]:+.2f}] -> qualifies {t['qualifies']}")
    print(f"  ADOPTED threshold method: {adopted}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", type=int, default=0)
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--analyze", action="store_true")
    a = ap.parse_args()
    analyze() if a.analyze else run(a.worker, a.workers)
