"""Protocol J: P2 re-run at P3's budget (only when P3 selects E != 330), and Phase P5 (threshold floor).

  python protocol_j_p5.py --p2b     # -> analysis_J_P2b.json  (only if analysis_J_P3.json says rerunP2)
  python protocol_j_p5.py           # -> analysis_J_P5.json

P5 (PREREGISTRATION_J.md, section 6): Spearman correlation across development targets between the
per-user threshold and the per-user share of impostor runs caught (P1-P4 system at its frozen point,
development test halves, identity order at the selected budget). Only if its 95% lower bound is > 0,
floors at the 5th..50th percentiles (step 5) of the development thresholds are compared, together with
"no floor", by the section-5 objective on the development calibration halves.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import protocol_j_common as J  # noqa: E402
import protocol_j_p1 as P1  # noqa: E402

P3_PARTS = os.path.join(J.STUDY, "parts", "J_P3")


def units_at(E):
    U = {}
    for f in sorted(os.listdir(P3_PARTS)):
        if not f.endswith(".json"):
            continue
        r = json.load(open(os.path.join(P3_PARTS, f)))
        e = r["budgets"][str(E)][0]                       # identity order
        m = e["model"]
        U[r["participant"]] = (J.halves({"_genuineScores": m["genuine"], "_impostorRuns": m["impostor"]}),
                               np.asarray(e["oof"], float))
    return U


def p2b():
    hashes = J.verify_frozen()
    p3 = json.load(open(os.path.join(J.STUDY, "analysis_J_P3.json")))
    E = int(p3["selectedBudget"])
    if E == 330:
        print("P3 kept 330 windows: no P2 re-run needed"); return
    op = P1._select(units_at(E))
    json.dump({**hashes, "phase": "P2b", "budget": E, "operatingPoint": op}, open(os.path.join(J.STUDY, "analysis_J_P2b.json"), "w"), indent=1)
    print(f"P2 re-run at E={E}: {op['q']}th percentile, {op['rule']} n={op['n']} k={op['k']} (budget {op['budget']})")


def spearman(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    ra, rb = np.argsort(np.argsort(a)).astype(float), np.argsort(np.argsort(b)).astype(float)
    return float(np.corrcoef(ra, rb)[0, 1])


def p5():
    hashes = J.verify_frozen()
    p3 = json.load(open(os.path.join(J.STUDY, "analysis_J_P3.json")))
    E = int(p3["selectedBudget"])
    p2b_path = os.path.join(J.STUDY, "analysis_J_P2b.json")
    op = json.load(open(p2b_path))["operatingPoint"] if os.path.exists(p2b_path) else json.load(open(os.path.join(J.STUDY, "analysis_J_P2.json")))["operatingPoint"]
    U = units_at(E)
    users = sorted(U)
    tau = {u: float(np.percentile(src, op["q"])) for u, (h, src) in U.items()}
    cap = {u: float(np.mean(J.per_user(U[u][0][1], tau[u], op["rule"], op["n"], op["k"])["caught"])) for u in users}
    rho = spearman([tau[u] for u in users], [cap[u] for u in users])
    rng = np.random.default_rng(17)
    boot = []
    for _ in range(10000):
        idx = rng.integers(0, len(users), len(users))
        a, b = [tau[users[i]] for i in idx], [cap[users[i]] for i in idx]
        if np.ptp(a) > 0 and np.ptp(b) > 0:
            boot.append(spearman(a, b))
    lo, hi = float(np.percentile(boot, 2.5)), float(np.percentile(boot, 97.5))
    out = {**hashes, "phase": "P5", "budget": E, "operatingPoint": op, "thresholds": tau, "runsCaught": cap,
           "spearman": rho, "ci95": [lo, hi], "associationSupported": lo > 0}
    print(f"P5: E={E}, point q{op['q']} {op['rule']} n={op['n']} k={op['k']}; Spearman(threshold, runs caught) = {rho:+.2f} [{lo:+.2f}, {hi:+.2f}]")
    if lo > 0:
        grid = [None] + [float(np.percentile(list(tau.values()), p)) for p in range(5, 55, 5)]
        best = None
        for budget in (0.2, 0.5, 1.0):
            for f in grid:
                res = {u: J.per_user(U[u][0][0], max(tau[u], f) if f is not None else tau[u], op["rule"], op["n"], op["k"]) for u in users}
                s = J.summary(res)
                if s["promptsPerMinMean"] > budget:
                    continue
                key = (s["impostorRunsCaught"], -(s["timeToCatchMedianS"] or 1e9), -(f or 0.0))
                if best is None or key > best[0]:
                    best = (key, {"floor": f, "budget": budget, "cal": s})
            if best:
                break
        out["floorSelection"] = best[1] if best else None
        out["floor"] = best[1]["floor"] if best else None
        if best and best[1]["floor"] is not None:
            test = {u: J.per_user(U[u][0][1], max(tau[u], best[1]["floor"]), op["rule"], op["n"], op["k"]) for u in users}
            out["testHalvesWithFloor"] = J.summary(test)
        print(f"  floor chosen on calibration: {out['floor']}")
    else:
        out["floor"] = None
        print("  association not supported (lower bound <= 0): NO FLOOR")
    json.dump(out, open(os.path.join(J.STUDY, "analysis_J_P5.json"), "w"), indent=1)
    print("wrote analysis_J_P5.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--p2b", action="store_true")
    a = ap.parse_args()
    p2b() if a.p2b else p5()
