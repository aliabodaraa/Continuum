"""
Statistical analysis of the controlled architecture benchmark.

Reads arch_bench.json (3 extractors x 2 verification heads, same users, same
protocol) and answers the only question that matters:

    does architecture X actually outperform architecture Y for Continuum's
    per-user verification task -- or is the difference inside the noise?

Never by comparing medians alone. Every claim here is a PAIRED comparison over
the same held-out users, with a cluster bootstrap resampling USERS (the
independent unit), a 95% interval on the paired median difference, and Holm
correction across the family of comparisons actually made.

Three families are reported separately, because they answer different questions
and pooling them would inflate the comparison count:

  PUBLISHED   the three methods as their authors defined them
              (Lu+binary, Antal+binary, SapiMouse FCN+OCSVM)
  EXTRACTOR   effect of the representation learner, head held fixed
  HEAD        effect of the verification head, extractor held fixed

Run:
    python arch_bench_analyze.py --bench /app/artifacts/xai/arch_bench.json
"""
import argparse
import itertools
import json
import sys

import numpy as np

PRIMARY = "auc"          # ranking metric: threshold-free, per-user, open-set
LOWER_BETTER = {"eer", "decisionFalseLock", "farAtTau"}


def cluster_boot_median(v, n=4000, seed=7):
    v = np.asarray([x for x in v if x is not None and np.isfinite(x)], float)
    if len(v) < 2:
        return None
    rng = np.random.default_rng(seed)
    s = [np.median(v[rng.integers(0, len(v), len(v))]) for _ in range(n)]
    return [float(np.percentile(s, 2.5)), float(np.percentile(s, 97.5))]


def paired(a_rows, b_rows, key, n=4000, seed=17):
    """Paired difference (b - a) over users present in BOTH cells."""
    A = {r["participant"]: r.get(key) for r in a_rows}
    B = {r["participant"]: r.get(key) for r in b_rows}
    users = [u for u in A if u in B
             and A[u] is not None and B[u] is not None
             and np.isfinite(A[u]) and np.isfinite(B[u])]
    if len(users) < 3:
        return None
    d = np.array([B[u] - A[u] for u in users], float)
    rng = np.random.default_rng(seed)
    stat = np.array([np.median(d[rng.integers(0, len(d), len(d))]) for _ in range(n)])
    p = 2 * min((stat <= 0).mean(), (stat >= 0).mean())
    return {"n": len(users), "medianDiff": float(np.median(d)),
            "ci95": [float(np.percentile(stat, 2.5)), float(np.percentile(stat, 97.5))],
            "p": float(min(1.0, p)),
            "favoursB": int((d > 0).sum()), "favoursA": int((d < 0).sum()),
            # Cliff's delta: non-parametric effect size on paired signs
            "cliffDelta": float(((d > 0).sum() - (d < 0).sum()) / len(d))}


def holm(ps):
    idx = np.argsort(ps); adj = np.empty(len(ps)); run = 0.0
    for rank, i in enumerate(idx):
        run = max(run, (len(ps) - rank) * ps[i]); adj[i] = min(1.0, run)
    return adj.tolist()


def pool_seeds(cell):
    """Average each user's metrics across seeds -> one row per user per cell.

    Training is non-deterministic, so a single seed is one draw. Averaging per
    user keeps the pairing intact (same user across cells) while removing part
    of the seed noise."""
    per_user = {}
    for _, rows in cell["bySeed"].items():
        for r in rows:
            per_user.setdefault(r["participant"], []).append(r)
    out = []
    for uid, rs in per_user.items():
        row = {"participant": uid, "nSeeds": len(rs)}
        for k in ("auc", "eer", "tarAtFar01", "tarAtFar05", "farAtTau", "tarAtTau",
                  "decisionFalseLock", "decisionCaught"):
            v = [r[k] for r in rs if r.get(k) is not None and np.isfinite(r[k])]
            row[k] = float(np.mean(v)) if v else None
        row["embeddingDim"] = rs[0].get("embeddingDim")
        out.append(row)
    return out


def describe(rows, key):
    v = np.array([r[key] for r in rows if r.get(key) is not None
                  and np.isfinite(r[key])], float)
    if not len(v):
        return None
    return {"n": int(len(v)), "median": float(np.median(v)), "mean": float(v.mean()),
            "iqr": [float(np.percentile(v, 25)), float(np.percentile(v, 75))],
            "min": float(v.min()), "max": float(v.max()),
            "ci95_median": cluster_boot_median(v)}


def fmt_pct(x, w=6):
    return f"{'--':>{w}}" if x is None else f"{x * 100:>{w}.1f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench", default="/app/artifacts/xai/arch_bench.json")
    ap.add_argument("--out", default="/app/artifacts/xai/arch_bench_stats.json")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    doc = json.load(open(args.bench))
    cells = {k: pool_seeds(v) for k, v in doc["cells"].items()}
    meta = {k: v["description"] for k, v in doc["cells"].items()}
    nseeds = max((r["nSeeds"] for rows in cells.values() for r in rows), default=0)

    print("=" * 100)
    print("PER-USER VERIFICATION -- 3 extractors x 2 heads, identical protocol")
    print(f"vote rule {doc.get('voteRule')} | seeds averaged per user: {nseeds}")
    print("=" * 100)
    hdr = (f"{'cell':<24}{'dim':>6}{'AUC med':>9}{'AUC CI95':>17}"
           f"{'EER%':>7}{'T@F1%':>7}{'FL%':>7}{'CAP%':>7}")
    print(hdr); print("-" * 100)

    summary = {}
    for key, rows in cells.items():
        s = {m: describe(rows, m) for m in
             ("auc", "eer", "tarAtFar01", "tarAtFar05", "farAtTau", "tarAtTau",
              "decisionFalseLock", "decisionCaught")}
        summary[key] = {"description": meta[key], "nUsers": len(rows),
                        "embeddingDim": rows[0].get("embeddingDim") if rows else None,
                        "metrics": s}
        a, ci = s["auc"]["median"], s["auc"]["ci95_median"]
        print(f"{key:<24}{str(rows[0].get('embeddingDim')):>6}{a:>9.3f}"
              f"{f'[{ci[0]:.3f},{ci[1]:.3f}]' if ci else '--':>17}"
              f"{fmt_pct(s['eer']['median'],7)}{fmt_pct(s['tarAtFar01']['median'],7)}"
              f"{fmt_pct(s['decisionFalseLock']['median'],7)}"
              f"{fmt_pct(s['decisionCaught']['median'],7)}")

    # ------------------------------------------------------------ families --
    FAMILIES = {
        "PUBLISHED (methods as their authors defined them)":
            [("lu_cnn_gru+binary", "antal_twotower+binary"),
             ("lu_cnn_gru+binary", "sapi_fcn+ocsvm"),
             ("antal_twotower+binary", "sapi_fcn+ocsvm")],
        "EXTRACTOR effect (head held fixed)":
            [(f"{a}+{h}", f"{b}+{h}")
             for h in ("binary", "ocsvm")
             for a, b in itertools.combinations(
                 ("lu_cnn_gru", "antal_twotower", "sapi_fcn"), 2)],
        "HEAD effect (extractor held fixed)":
            [(f"{e}+binary", f"{e}+ocsvm")
             for e in ("lu_cnn_gru", "antal_twotower", "sapi_fcn")],
    }

    stats = {}
    for fam, pairs in FAMILIES.items():
        pairs = [(a, b) for a, b in pairs if a in cells and b in cells]
        if not pairs:
            continue
        res = []
        for a, b in pairs:
            r = paired(cells[a], cells[b], PRIMARY)
            if r:
                r["a"], r["b"] = a, b
                res.append(r)
        if not res:
            continue
        for r, adj in zip(res, holm([r["p"] for r in res])):
            r["pHolm"] = float(adj)
        stats[fam] = res

        print("\n" + "=" * 100)
        print(f"{fam}   -- paired on AUC, bootstrap over users, Holm-corrected")
        print("=" * 100)
        print(f"{'comparison (B - A)':<52}{'medDiff':>9}{'95% CI':>19}"
              f"{'p_holm':>8}{'delta':>7}  verdict")
        for r in res:
            sig = r["pHolm"] < 0.05 and not (r["ci95"][0] <= 0 <= r["ci95"][1])
            better = r["b"] if r["medianDiff"] > 0 else r["a"]
            verdict = f"{better.split('+')[0]} better" if sig else "indistinguishable"
            print(f"{r['a']+' -> '+r['b']:<52}{r['medianDiff']:>+9.3f}"
                  f"{f'[{r[chr(99)+chr(105)+chr(57)+chr(53)][0]:+.3f},{r[chr(99)+chr(105)+chr(57)+chr(53)][1]:+.3f}]':>19}"
                  f"{r['pHolm']:>8.3f}{r['cliffDelta']:>+7.2f}  {verdict}"
                  f"   ({r['favoursB']}/{r['n']} users favour B)")

    json.dump({"summary": summary, "comparisons": stats,
               "primaryMetric": PRIMARY, "seedsAveraged": nseeds,
               "note": "AUC is the ranking metric: threshold-free and computed per user "
                       "on open-set impostors. Decision-level FL/CAP use the deployed "
                       f"{doc.get('voteRule')} rule at an enrolment-derived threshold."},
              open(args.out, "w"), indent=2)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
