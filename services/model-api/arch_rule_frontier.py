"""
Decision-level architecture comparison that does NOT depend on the deployed rule.

THE PROBLEM THIS FIXES
----------------------
Continuum's 15-of-20 sustained vote is an engineering choice made inside this
project, selected by sweeping decision rules against the DEPLOYED architecture's
own score distribution. It is not taken from any published paper.

Evaluating competing architectures under that one rule therefore gives the
incumbent home-field advantage: the rule was fitted to the shape of its scores.
An earlier version of this benchmark did exactly that and concluded the
incumbent won on decision-level capture. That conclusion was not safe.

WHAT THIS DOES INSTEAD
----------------------
For every architecture it sweeps the whole reachable operating space --

    threshold  tau  = the q-th percentile of the head's scores on the target's
                      OWN enrolment windows, q in Q_GRID  (deployable, and
                      identical in form for every architecture)
    rule       = k-of-n vote, or mean/median over the last n windows,
                 for every (n, k) in RULE_GRID

-- and reports, for each architecture, the achievable frontier of

    (median decision-level false-lock, median decision-level capture).

Architectures are then compared at MATCHED FALSE-LOCK. "At the same rate of
interrupting genuine users, which architecture catches more impostors?" is a
question no rule choice can bias, because every architecture is allowed its own
best rule and threshold.

NO SELECTION ON TEST DATA
-------------------------
Impostor identities are split per user into a calibration half and a test half.
The operating point for each architecture is chosen on the CALIBRATION half
(pooled across users) and then evaluated on the TEST half. Genuine streams are
likewise split in time. Nothing is selected on the numbers being reported.

Run:
    python arch_rule_frontier.py --bench /app/artifacts/xai/arch_bench_v2.json
"""
import argparse
import json
import sys

import numpy as np

Q_GRID = [1, 2, 5, 10, 15, 20, 30, 40, 50]
RULE_GRID = (
    [("vote", n, k) for n in (6, 10, 20) for k in range(max(2, n // 2), n + 1)]
    + [("mean", n, None) for n in (6, 10, 20)]
    + [("median", n, None) for n in (6, 10, 20)]
)
MATCH_FL = [0.01, 0.05, 0.10, 0.20]     # matched false-lock operating points


def fire(seq, tau, rule, n, k):
    """Fraction of length-n packets that FIRE (declare suspicious)."""
    s = np.asarray(seq, float)
    if len(s) < n:
        return None
    if rule == "vote":
        low = (s < tau).astype(int)
        f = [1 if low[i:i + n].sum() >= k else 0 for i in range(len(s) - n + 1)]
    elif rule == "mean":
        f = [1 if s[i:i + n].mean() < tau else 0 for i in range(len(s) - n + 1)]
    else:
        f = [1 if np.median(s[i:i + n]) < tau else 0 for i in range(len(s) - n + 1)]
    return float(np.mean(f)) if f else None


def user_rates(u, tau, rule, n, k, half):
    """(false-lock, capture) for one user on the requested half of the data."""
    g = np.asarray(u["_genuineScores"], float)
    cut = len(g) // 2
    g = g[:cut] if half == "cal" else g[cut:]
    parts = sorted(u["_impostorRuns"].keys())
    sel = parts[::2] if half == "cal" else parts[1::2]
    fl = fire(g, tau, rule, n, k)
    caps = [fire(np.asarray(u["_impostorRuns"][p], float), tau, rule, n, k) for p in sel]
    caps = [c for c in caps if c is not None]
    return fl, (float(np.mean(caps)) if caps else None)


def tau_for(u, q):
    e = np.asarray(u["_enrolScores"], float)
    return float(np.percentile(e, q)) if len(e) else None


def frontier(rows, half):
    """All reachable (FL, CAP) medians for one architecture."""
    pts = []
    for q in Q_GRID:
        taus = {u["participant"]: tau_for(u, q) for u in rows}
        for rule, n, k in RULE_GRID:
            fls, caps = [], []
            for u in rows:
                t = taus.get(u["participant"])
                if t is None:
                    continue
                fl, cap = user_rates(u, t, rule, n, k, half)
                if fl is not None and cap is not None:
                    fls.append(fl); caps.append(cap)
            if len(fls) >= 3:
                pts.append({"q": q, "rule": rule, "n": n, "k": k,
                            "fl": float(np.median(fls)), "cap": float(np.median(caps))})
    return pts


def pick_at(pts, budget):
    """Highest-capture operating point whose false-lock is within budget."""
    ok = [p for p in pts if p["fl"] <= budget]
    return max(ok, key=lambda p: p["cap"]) if ok else None


def paired_cap(rows_a, rows_b, opa, opb, half="test", n_boot=4000, seed=17):
    """Paired per-user capture difference, each architecture at ITS OWN point."""
    A = {u["participant"]: u for u in rows_a}
    B = {u["participant"]: u for u in rows_b}
    d, fa, fb = [], [], []
    for uid in sorted(set(A) & set(B)):
        ta, tb = tau_for(A[uid], opa["q"]), tau_for(B[uid], opb["q"])
        if ta is None or tb is None:
            continue
        fla, ca = user_rates(A[uid], ta, opa["rule"], opa["n"], opa["k"], half)
        flb, cb = user_rates(B[uid], tb, opb["rule"], opb["n"], opb["k"], half)
        if None in (ca, cb, fla, flb):
            continue
        d.append(cb - ca); fa.append(fla); fb.append(flb)
    if len(d) < 3:
        return None
    d = np.asarray(d)
    rng = np.random.default_rng(seed)
    st = np.array([np.median(d[rng.integers(0, len(d), len(d))]) for _ in range(n_boot)])
    p = 2 * min((st <= 0).mean(), (st >= 0).mean())
    return {"n": len(d), "medianDiff": float(np.median(d)),
            "ci95": [float(np.percentile(st, 2.5)), float(np.percentile(st, 97.5))],
            "p": float(min(1.0, p)), "favoursB": int((d > 0).sum()),
            "flA": float(np.median(fa)), "flB": float(np.median(fb))}


def holm(ps):
    idx = np.argsort(ps); adj = np.empty(len(ps)); run = 0.0
    for r, i in enumerate(idx):
        run = max(run, (len(ps) - r) * ps[i]); adj[i] = min(1.0, run)
    return adj.tolist()


def pool(cell):
    out = {}
    for _, rows in cell["bySeed"].items():
        for r in rows:
            if r.get("_genuineScores"):
                out.setdefault(r["participant"], r)   # first seed with streams
    return list(out.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench", default="/app/artifacts/xai/arch_bench_v2.json")
    ap.add_argument("--out", default="/app/artifacts/xai/arch_rule_frontier.json")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    doc = json.load(open(args.bench))
    cells = {k: pool(v) for k, v in doc["cells"].items()}
    cells = {k: v for k, v in cells.items() if v}

    print("=" * 104)
    print("DECISION-LEVEL COMPARISON AT MATCHED FALSE-LOCK -- no dependence on the deployed rule")
    print("operating point chosen on a CALIBRATION half, reported on the held-out TEST half")
    print("=" * 104)

    fronts = {k: frontier(v, "cal") for k, v in cells.items()}
    chosen, report = {}, {}

    for budget in MATCH_FL:
        print(f"\n--- false-lock budget <= {budget*100:.0f}%  (each architecture at its OWN best rule) ---")
        print(f"{'cell':<24}{'chosen rule':>20}{'q':>4}{'cal FL%':>9}{'cal CAP%':>10}"
              f"{'TEST FL%':>10}{'TEST CAP%':>11}")
        chosen[budget] = {}
        for key, rows in cells.items():
            op = pick_at(fronts[key], budget)
            if not op:
                print(f"{key:<24}{'unreachable':>20}"); continue
            fls, caps = [], []
            for u in rows:
                t = tau_for(u, op["q"])
                fl, cap = user_rates(u, t, op["rule"], op["n"], op["k"], "test")
                if fl is not None and cap is not None:
                    fls.append(fl); caps.append(cap)
            tfl, tcap = float(np.median(fls)), float(np.median(caps))
            chosen[budget][key] = {"op": op, "testFL": tfl, "testCAP": tcap}
            label = (f"{op['k']}-of-{op['n']}" if op["rule"] == "vote"
                     else f"{op['rule']}@{op['n']}")
            print(f"{key:<24}{label:>20}{op['q']:>4}{op['fl']*100:>9.1f}{op['cap']*100:>10.1f}"
                  f"{tfl*100:>10.1f}{tcap*100:>11.1f}")

        # paired comparisons against the incumbent, each at its own operating point
        base = "lu_cnn_gru+binary"
        if base in chosen[budget]:
            res = []
            for key in cells:
                if key == base or key not in chosen[budget]:
                    continue
                r = paired_cap(cells[base], cells[key],
                               chosen[budget][base]["op"], chosen[budget][key]["op"])
                if r:
                    r["vs"] = key; res.append(r)
            if res:
                for r, a in zip(res, holm([r["p"] for r in res])):
                    r["pHolm"] = float(a)
                print(f"\n  paired capture difference vs {base} (positive = alternative better)")
                for r in res:
                    sig = r["pHolm"] < 0.05 and not (r["ci95"][0] <= 0 <= r["ci95"][1])
                    print(f"    {r['vs']:<24}{r['medianDiff']*100:>+8.1f} pp  "
                          f"CI[{r['ci95'][0]*100:+.1f},{r['ci95'][1]*100:+.1f}]  "
                          f"p={r['pHolm']:.3f}  {'SIGNIFICANT' if sig else 'ns':<11} "
                          f"(FL {r['flA']*100:.1f}% vs {r['flB']*100:.1f}%)")
                report[str(budget)] = res

    json.dump({"chosen": {str(k): {kk: {"op": vv["op"], "testFL": vv["testFL"],
                                        "testCAP": vv["testCAP"]}
                                   for kk, vv in v.items()} for k, v in chosen.items()},
               "pairedVsIncumbent": report,
               "note": "Every architecture is allowed its own threshold percentile and its own "
                       "decision rule, selected on a calibration half and reported on a held-out "
                       "test half. The deployed 15-of-20 rule has no privileged status here."},
              open(args.out, "w"), indent=2)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
