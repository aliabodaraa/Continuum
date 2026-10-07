"""
Experiment I (artifacts/repr_arch_study/PREREGISTRATION_I.md): choose the mouse operating point by
how often a genuine user is prompted per minute of movement, replaying the live decision loop
(buffer emptied after each prompt). Analysis only: uses the recorded score streams of Experiment F
(deployed server model) and, as a secondary, Experiment G (the extension's model).

    python repr_interrupt_i.py      # writes analysis_I.json
"""
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import repr_arch_analyze as RA  # noqa: E402

ROOT = "/app/artifacts/repr_arch_study"
PREREG_I = os.path.join(ROOT, "PREREGISTRATION_I.md")
SEC_PER_WINDOW = 10 * 0.0269            # stride 10 steps
Q_GRID = [1, 2, 5, 10, 15, 20, 30, 40, 50]
NS = (20, 40, 60)
RULES = ([("vote", n, k) for n in NS for k in range(-(-n // 2), n + 1)]
         + [("mean", n, None) for n in NS] + [("median", n, None) for n in NS])
BUDGETS = (0.2, 0.5, 1.0)


def fires_at(win, tau, rule, k):
    if rule == "vote":
        return int((win < tau).sum()) >= k
    stat = win.mean() if rule == "mean" else np.median(win)
    return stat < tau


def replay(seq, tau, rule, n, k):
    """Prompts in a stream under the live loop; returns (count, index of the first prompt)."""
    s = np.asarray(seq, float)
    start, count, first = 0, 0, None
    for i in range(len(s)):
        if i - start + 1 < n:
            continue
        if fires_at(s[i - n + 1:i + 1], tau, rule, k):
            count += 1
            if first is None:
                first = i
            start = i + 1
    return count, first


def seconds_at(idx):
    return (50 + 10 * idx) * 0.0269


def per_user(half, tau, rule, n, k):
    g = half["g"]
    cnt, _ = replay(g, tau, rule, n, k)
    minutes = len(g) * SEC_PER_WINDOW / 60.0
    runs = []
    for r in half["runs"].values():
        c, f = replay(r, tau, rule, n, k)
        runs.append((c > 0, seconds_at(f) if f is not None else None))
    return {"rate": cnt / minutes if minutes > 0 else np.nan, "prompts": cnt,
            "caught": [c for c, _ in runs], "times": [t for c, t in runs if c]}


def evaluate(units, q, rule, n, k, which):
    out = {}
    for u, (halves, enrol) in units.items():
        tau = float(np.percentile(enrol, q))
        out[u] = per_user(halves[which], tau, rule, n, k)
    return out


def summary(res):
    rates = [v["rate"] for v in res.values()]
    caught = [c for v in res.values() for c in v["caught"]]
    times = [t for v in res.values() for t in v["times"]]
    return {"promptsPerMinMean": float(np.mean(rates)), "promptsPerMinMedian": float(np.median(rates)),
            "usersNeverPrompted": float(np.mean([v["prompts"] == 0 for v in res.values()])),
            "impostorRunsCaught": float(np.mean(caught)) if caught else 0.0,
            "impostorRunsNeverCaught": float(1 - np.mean(caught)) if caught else 1.0,
            "timeToCatchMedianS": float(np.median(times)) if times else None}


def select(units):
    for budget in BUDGETS:
        best = None
        for q in Q_GRID:
            for rule, n, k in RULES:
                s = summary(evaluate(units, q, rule, n, k, 0))
                if s["promptsPerMinMean"] > budget:
                    continue
                key = (s["impostorRunsCaught"], -(s["timeToCatchMedianS"] or 1e9), -n)
                if best is None or key > best[0]:
                    best = (key, {"q": q, "rule": rule, "n": n, "k": k, "budget": budget, "cal": s})
        if best:
            return best[1]
    return None


def units_of(rows, getter):
    return {r["participant"]: (RA.halves(getter(r)), np.asarray(getter(r)["_enrolScores"], float)) for r in rows}


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    sha = hashlib.sha256(open(PREREG_I, "rb").read()).hexdigest()
    out = {"preregistrationISha256": sha}

    # ---- primary: deployed server model ----
    F = json.load(open(os.path.join(ROOT, "parts", "F_new.json")))
    U = units_of(F["perUser"], lambda r: r)
    dep = {"q": 5, "rule": "vote", "n": 20, "k": 12}
    dep_test = evaluate(U, dep["q"], dep["rule"], dep["n"], dep["k"], 1)
    sel = select(U)
    sel_test = evaluate(U, sel["q"], sel["rule"], sel["n"], sel["k"], 1)
    users = sorted(U)
    cmp_rate = RA.boot([dep_test[u]["rate"] for u in users], [sel_test[u]["rate"] for u in users])
    s_dep, s_sel = summary(dep_test), summary(sel_test)
    adopt = bool(cmp_rate["meanDiff"] < 0 and cmp_rate["p"] < 0.05 and s_sel["impostorRunsCaught"] >= 0.90)
    out["server"] = {"deployed": {**dep, "test": s_dep}, "selected": {**sel, "test": s_sel},
                     "selectedMinusDeployedRate": cmp_rate, "adopt": adopt}
    print(f"SERVER deployed q5 12/20: test prompts/min mean {s_dep['promptsPerMinMean']:.2f} median {s_dep['promptsPerMinMedian']:.2f} | "
          f"never prompted {s_dep['usersNeverPrompted']*100:.0f}% | impostor runs caught {s_dep['impostorRunsCaught']*100:.1f}% | "
          f"time to catch {s_dep['timeToCatchMedianS']:.1f} s")
    print(f"SERVER selected q{sel['q']} {sel['rule']} n={sel['n']} k={sel['k']} (cal budget {sel['budget']}/min): test prompts/min mean "
          f"{s_sel['promptsPerMinMean']:.2f} median {s_sel['promptsPerMinMedian']:.2f} | never prompted {s_sel['usersNeverPrompted']*100:.0f}% | "
          f"impostor runs caught {s_sel['impostorRunsCaught']*100:.1f}% | time to catch {s_sel['timeToCatchMedianS']:.1f} s")
    print(f"  selected - deployed prompts/min: {cmp_rate['meanDiff']:+.2f} [{cmp_rate['ci95'][0]:+.2f}, {cmp_rate['ci95'][1]:+.2f}] "
          f"p {cmp_rate['p']:.4f} -> {'ADOPT' if adopt else 'keep deployed'}")

    # ---- secondary: the extension's model, 3 seeds ----
    G = json.load(open(os.path.join(ROOT, "parts", "G_device.json")))
    gdep = {"q": 10, "rule": "vote", "n": 20, "k": 14}
    # Calibration pooled over (target, seed), as in G-2; per-user test rates averaged over seeds.
    Ug = {}
    for d in G["seeds"]:
        for u, v in units_of(d["perUser"], lambda r: r["M"]["330"]).items():
            Ug[f"{u}|{d['seedIndex']}"] = v
    sg = select(Ug)
    t_sel = evaluate(Ug, sg["q"], sg["rule"], sg["n"], sg["k"], 1)
    t_dep = evaluate(Ug, gdep["q"], gdep["rule"], gdep["n"], gdep["k"], 1)
    rates_sel, rates_dep = {}, {}
    for key in t_sel:
        u = key.split("|")[0]
        rates_sel.setdefault(u, []).append(t_sel[key]["rate"])
        rates_dep.setdefault(u, []).append(t_dep[key]["rate"])
    gu = sorted(rates_sel)
    gcmp = RA.boot([np.mean(rates_dep[u]) for u in gu], [np.mean(rates_sel[u]) for u in gu])
    gs_sel, gs_dep = summary(t_sel), summary(t_dep)
    gadopt = bool(gcmp["meanDiff"] < 0 and gcmp["p"] < 0.05 and gs_sel["impostorRunsCaught"] >= 0.90)
    out["extension"] = {"deployed": {**gdep, "test": gs_dep}, "selected": {**sg, "test": gs_sel},
                        "selectedMinusDeployedRate": gcmp, "adopt": gadopt}
    print(f"EXTENSION deployed q10 14/20: test prompts/min mean {gs_dep['promptsPerMinMean']:.2f} | caught "
          f"{gs_dep['impostorRunsCaught']*100:.1f}% | time {gs_dep['timeToCatchMedianS']:.1f} s")
    print(f"EXTENSION selected q{sg['q']} {sg['rule']} n={sg['n']} k={sg['k']} (budget {sg['budget']}): test prompts/min mean "
          f"{gs_sel['promptsPerMinMean']:.2f} median {gs_sel['promptsPerMinMedian']:.2f} | never prompted {gs_sel['usersNeverPrompted']*100:.0f}% | "
          f"caught {gs_sel['impostorRunsCaught']*100:.1f}% | time {gs_sel['timeToCatchMedianS']:.1f} s")
    print(f"  extension selected - deployed prompts/min: {gcmp['meanDiff']:+.2f} p {gcmp['p']:.4f} -> {'ADOPT' if gadopt else 'keep deployed'}")
    json.dump(out, open(os.path.join(ROOT, "analysis_I.json"), "w"), indent=1)
    print("wrote analysis_I.json")


if __name__ == "__main__":
    main()
