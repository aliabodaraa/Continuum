"""Phase 1 power check: what a 20-user paired comparison can detect, per endpoint, and how often the
P6/K3 adoption rule would accept a system that is truly better.

Inputs are the stored per-user values of the two untouched tests (P6: S0 vs S1, K3: S0 vs S2); the
spread of per-user differences is what matters here, not which system won.

  MDE80  smallest true mean difference a two-sided paired test at alpha 0.05 detects with 80% power:
         (1.96 + 0.84) x SE of the paired mean difference, SE from the observed per-user differences.
  Rule simulation  the P6/K3 rule exactly: adopt if prompts/min upper 95% bound <= +0.10 AND runs
         caught lower 95% bound >= -0.05 AND at least one of the two improves significantly (Holm).
         Users are resampled from the observed paired differences, re-centred on a chosen TRUE
         difference, and the rule is applied with its own bootstrap (10,000 in the original; 2,000
         here, which moves the bounds by well under 0.01).
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import eval_decision_level as E  # noqa: E402
import p1lib as L  # noqa: E402
import reproduce as RP  # noqa: E402
import run_phase1 as R  # noqa: E402

OUT = os.path.join(os.path.normpath(os.path.join(HERE, "..", "..", "..", "..")), "artifacts", "phase1", "power.json")
Z = 1.959964 + 0.841621


def per_user_endpoints(folder, systems):
    out, tests = RP.lockbox(folder, systems)
    a, b = systems[0]["name"], systems[1]["name"]
    users = sorted(out[a]["_per"])
    d = {k: np.array([out[b]["_per"][u][k] - out[a]["_per"][u][k] for u in users])
         for k in ("promptsPerMin", "runsCaught", "auc", "eer")}
    U = R.lockbox_units(folder, {s["name"]: (s["method"], s["q"]) for s in systems})
    for n in (15, 33):
        ea, eb = E.evaluate(U[a], n), E.evaluate(U[b], n)
        d[f"decAucPct{n}"] = np.array([eb["perUser"][u]["aucPct"] - ea["perUser"][u]["aucPct"] for u in users])
    return d, users


def mde(d):
    se = d.std(ddof=1) / np.sqrt(len(d))
    return float(se), float(Z * se)


def rule_sim(dp, dc, true_p, true_c, reps=2000, inner=2000, seed=11):
    rng = np.random.default_rng(seed)
    n = len(dp)
    dp0, dc0 = dp - dp.mean() + true_p, dc - dc.mean() + true_c
    adopt = margins = p_ok = c_ok = 0
    for _ in range(reps):
        idx = rng.integers(0, n, n)
        sp, sc = dp0[idx], dc0[idx]
        bi = rng.integers(0, n, (inner, n))
        bp, bc = sp[bi].mean(1), sc[bi].mean(1)
        up = np.percentile(bp, 97.5)
        lc = np.percentile(bc, 2.5)
        pp = min(1.0, 2 * min((bp <= 0).mean(), (bp >= 0).mean()))
        pc = min(1.0, 2 * min((bc <= 0).mean(), (bc >= 0).mean()))
        ph = L.holm([pp, pc])
        m_ok = (up <= 0.10) and (lc >= -0.05)
        improved = (sp.mean() < 0 and ph[0] < 0.05) or (sc.mean() > 0 and ph[1] < 0.05)
        margins += m_ok
        p_ok += up <= 0.10
        c_ok += lc >= -0.05
        adopt += m_ok and improved
    return {"truePromptsDiff": true_p, "trueCaptureDiff": true_c, "pAdopt": adopt / reps,
            "pPromptMarginMet": p_ok / reps, "pCaptureMarginMet": c_ok / reps, "pBothMarginsMet": margins / reps}


if __name__ == "__main__":
    res = {"note": "Power of 20-user paired comparisons, from the per-user differences observed in the two untouched tests.",
           "tests": {}}
    for label, folder, systems in (("P6 (S1 - S0)", "J_P6", [RP.S0, RP.S1]), ("K3 (S2 - S0)", "K3", [RP.S0, RP.S2])):
        d, users = per_user_endpoints(folder, systems)
        ep = {}
        for k, v in d.items():
            se, m = mde(v)
            ep[k] = {"observedMeanDiff": float(v.mean()), "sdPerUser": float(v.std(ddof=1)), "se": se, "mde80": m,
                     "usersTied": int((np.abs(v) < 1e-12).sum())}
        sims = [rule_sim(d["promptsPerMin"], d["runsCaught"], 0.0, 0.0),
                rule_sim(d["promptsPerMin"], d["runsCaught"], 0.0, 0.05),
                rule_sim(d["promptsPerMin"], d["runsCaught"], 0.0, 0.10),
                rule_sim(d["promptsPerMin"], d["runsCaught"], -0.05, 0.10),
                rule_sim(d["promptsPerMin"], d["runsCaught"], float(d["promptsPerMin"].mean()), float(d["runsCaught"].mean()))]
        res["tests"][label] = {"n": len(users), "endpoints": ep, "ruleSimulation": sims}
        print(f"\n== {label}, n={len(users)}")
        print(f"   {'endpoint':14s} {'observed':>9s} {'SE':>7s} {'MDE80':>7s}  tied")
        for k, v in ep.items():
            print(f"   {k:14s} {v['observedMeanDiff']:+9.4f} {v['se']:7.4f} {v['mde80']:7.4f}  {v['usersTied']}")
        print("   adoption rule, probability of adopting a system whose TRUE difference is:")
        for s in sims:
            print(f"     prompts {s['truePromptsDiff']:+.3f}/min, capture {s['trueCaptureDiff']*100:+5.1f} pts -> adopt {s['pAdopt']*100:5.1f}%"
                  f"  (prompt margin met {s['pPromptMarginMet']*100:5.1f}%, capture margin met {s['pCaptureMarginMet']*100:5.1f}%)")
    json.dump(res, open(OUT, "w"), indent=1)
    print(f"\nwrote {OUT}")
