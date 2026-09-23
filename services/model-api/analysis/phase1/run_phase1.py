"""Phase 1 run: decision-level results for the systems the study already scored.

  development (P1 streams, 19 users x 10 training orders): Method A vs Method B at 330 windows
  lockbox 1   (P6 streams, 20 users): S0 vs S1   -- EXPLORATORY, post hoc on a spent lockbox
  lockbox 2   (K3 streams, 20 users): S0 vs S2   -- EXPLORATORY, post hoc on a spent lockbox

Nothing is retrained and no rule is changed; every number comes from stored score streams.
"""
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import eval_decision_level as E  # noqa: E402
import p1lib as L  # noqa: E402

ROOT = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
STUDY = os.path.join(ROOT, "artifacts", "repr_arch_study")
OUT = os.path.join(ROOT, "artifacts", "phase1", "decision_level.json")
B_POOLED = int(os.environ.get("B_POOLED", "2000"))


def _recs(folder):
    d = os.path.join(STUDY, "parts", folder)
    return [json.load(open(os.path.join(d, f))) for f in sorted(os.listdir(d)) if f.endswith(".json")]


def lockbox_units(folder, systems):
    """systems: {name: (method, q)} -> {name: {uid: unit}}"""
    out = {s: {} for s in systems}
    for r in _recs(folder):
        for s, (method, q) in systems.items():
            d = r["systems"][s]
            ref = np.asarray(d["enrol"] if method == "A" else d["oof"], float)
            out[s][r["participant"]] = {"genuine": d["genuine"], "runs": d["impostor"],
                                        "tau": float(np.percentile(ref, q)), "ref": ref}
    return out


def dev_units(recs, oi):
    """P1 order oi. A: method-A model, threshold source = its in-sample enrolment scores (q 5, P1's
    selected point). B: the final model, threshold source = leave-one-sample-out scores (q 40, P1's
    selected point). Whole 1-min session as genuine: the curve metrics below choose no threshold."""
    A, B = {}, {}
    for r in recs:
        e = r["byOrder"][oi]
        A[r["participant"]] = {"genuine": e["A"]["genuine"], "runs": e["A"]["impostor"],
                               "tau": float(np.percentile(e["A"]["enrol"], 5)), "ref": np.asarray(e["A"]["enrol"], float)}
        B[r["participant"]] = {"genuine": e["final"]["genuine"], "runs": e["final"]["impostor"],
                               "tau": float(np.percentile(e["B_oof"], 40)), "ref": np.asarray(e["B_oof"], float)}
    return A, B


def counts(units, n):
    g = [len(E.blocks(u["genuine"], n)) for u in units.values()]
    i = [sum(len(E.blocks(r, n)) for r in u["runs"].values()) for u in units.values()]
    return {"genuinePerUserMedian": float(np.median(g)), "genuinePerUserMin": int(min(g)),
            "impostorPerUserMedian": float(np.median(i))}


def per_user_auc_test(evA, evB, key="aucPct"):
    users = sorted(evA["perUser"])
    a = [evA["perUser"][u][key] for u in users]
    b = [evB["perUser"][u][key] for u in users]
    tied = int(np.sum(np.abs(np.asarray(b, float) - np.asarray(a, float)) < 1e-12))
    return {"A": float(np.nanmean(a)), "B": float(np.nanmean(b)), "tied": tied, **L.boot(a, b)}


def compare_lockbox(folder, systems, label):
    U = lockbox_units(folder, systems)
    a, b = list(systems)
    res = {"label": label, "systems": {k: {"method": v[0], "q": v[1]} for k, v in systems.items()},
           "exploratory": True, "lengths": {}}
    for n in E.LENGTHS:
        evA, evB = E.evaluate(U[a], n), E.evaluate(U[b], n)
        res["lengths"][str(n)] = {
            "seconds": evA["seconds"], "decisions": counts(U[a], n),
            "perUserAucPct": per_user_auc_test(evA, evB, "aucPct"),
            "pooled": E.paired_bootstrap(evA["_dec"], evB["_dec"], sorted(U[a]), B=B_POOLED)}
    return res


def compare_dev():
    recs = _recs("J_P1")
    n_orders = len(recs[0]["byOrder"])
    users = sorted(r["participant"] for r in recs)
    res = {"label": "development, Method A vs Method B, 330 windows, mean over 10 training orders",
           "exploratory": False, "lengths": {}}
    for n in E.LENGTHS:
        per = {"A": {u: [] for u in users}, "B": {u: [] for u in users}}
        decs = []
        for oi in range(n_orders):
            A, B = dev_units(recs, oi)
            evA, evB = E.evaluate(A, n), E.evaluate(B, n)
            for u in users:
                per["A"][u].append(evA["perUser"][u]["aucPct"])
                per["B"][u].append(evB["perUser"][u]["aucPct"])
            decs.append((evA["_dec"], evB["_dec"]))
            if oi == 0:
                cnt = counts(A, n)
        a = [float(np.nanmean(per["A"][u])) for u in users]
        b = [float(np.nanmean(per["B"][u])) for u in users]
        # pooled pct metrics: averaged over orders, cluster bootstrap over users
        rng = np.random.default_rng(17)

        def pooled_avg(pick):
            ma = [E.pooled_metrics(dA, pick)["pct"] for dA, _ in decs]
            mb = [E.pooled_metrics(dB, pick)["pct"] for _, dB in decs]
            return ({k: float(np.mean([m[k] for m in ma])) for k in ma[0]},
                    {k: float(np.mean([m[k] for m in mb])) for k in mb[0]})
        baseA, baseB = pooled_avg(users)
        diffs = {k: [] for k in baseA}
        for _ in range(max(200, B_POOLED // 5)):
            pick = [users[j] for j in rng.integers(0, len(users), len(users))]
            xa, xb = pooled_avg(pick)
            for k in diffs:
                diffs[k].append(xb[k] - xa[k])
        pooled = {}
        for k in baseA:
            d = np.asarray(diffs[k])
            pooled[f"pct.{k}"] = {"A": baseA[k], "B": baseB[k], "diff": baseB[k] - baseA[k],
                                  "ci95": [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))],
                                  "se": float(d.std(ddof=1)), "p": float(min(1.0, 2 * min((d <= 0).mean(), (d >= 0).mean())))}
        res["lengths"][str(n)] = {"seconds": round(E.seconds(n), 2), "decisions": cnt,
                                  "perUserAucPct": {"A": float(np.mean(a)), "B": float(np.mean(b)),
                                                     "tied": int(np.sum(np.abs(np.asarray(b) - np.asarray(a)) < 1e-12)), **L.boot(a, b)},
                                  "pooled": pooled}
    return res


def show(res):
    print(f"\n== {res['label']}{'  [EXPLORATORY]' if res['exploratory'] else ''}")
    for n, r in res["lengths"].items():
        c = r["decisions"]
        print(f" N={n:>2} ({r['seconds']:.1f} s): genuine decisions/user median {c['genuinePerUserMedian']:.0f} (min {c['genuinePerUserMin']}), "
              f"impostor decisions/user {c['impostorPerUserMedian']:.0f}")
        t = r["perUserAucPct"]
        print(f"   per-user AUC (pct):  A {t['A']:.3f}  B {t['B']:.3f}  diff {t['meanDiff']:+.3f} "
              f"[{t['ci95'][0]:+.3f}, {t['ci95'][1]:+.3f}] p {t['p']:.3f}  better for {t['bBetter']}/{t['n']}, tied {t.get('tied', 0)}")
        for k, v in r["pooled"].items():
            if k.endswith(("eer", "auc", "frrAtFar1", "frrAtFar5")):
                print(f"   pooled {k:18s} A {v['A']:.3f}  B {v['B']:.3f}  diff {v['diff']:+.3f} "
                      f"[{v['ci95'][0]:+.3f}, {v['ci95'][1]:+.3f}] p {v['p']:.3f}")


if __name__ == "__main__":
    t0 = time.time()
    out = {"note": "Phase 1 decision-level results. Lockbox analyses are post hoc on spent test sets: exploratory, they decide nothing.",
           "gap": E.GAP, "lengths": list(E.LENGTHS), "bootstrap": {"pooled": B_POOLED, "perUser": L.N_BOOT, "seed": 17},
           "development": compare_dev(),
           "lockbox1": compare_lockbox("J_P6", {"S0": ("A", 1), "S1": ("B", 20)}, "lockbox 1 (P6): S0 vs S1"),
           "lockbox2": compare_lockbox("K3", {"S0": ("A", 1), "S2": ("B", 20)}, "lockbox 2 (K3): S0 vs S2")}
    for k in ("development", "lockbox1", "lockbox2"):
        show(out[k])
    json.dump(out, open(OUT, "w"), indent=1)
    print(f"\nwrote {OUT} in {time.time() - t0:.0f} s")
