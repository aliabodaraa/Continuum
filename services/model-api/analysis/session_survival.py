"""
PART 10 — session-level survival: can an impostor get through a whole sitting?

Per-decision rates understate what continuous authentication actually does, because a session
contains many decisions. But the compounding must NOT be computed — multiplying per-decision
rates assumes independence, which is defect 2 all over again (it understated false locks
27-55x). So it is measured by sliding the rule across each participant's full contiguous run
and asking a session-level question directly:

    impostor : does the rule fire at least once before the run ends, and after how long?
    genuine  : does the rule fire at least once during the held-out block?

150 windows per impostor participant is roughly 1,540 digraphs, about 4.5 minutes of
continuous typing at the corpus median rate — a realistic sitting.
"""
import json
import sys

import numpy as np

sys.path.insert(0, "services/model-api")
from decision_sweep import fire_vote, fire_mean  # noqa: E402

doc = json.load(open("artifacts/xai/population_scores.json"))
users = [u for u in doc["perUser"] if u.get("_impostorRuns")]
TAU = 0.50
DD = 0.176  # measured median inter-key interval, seconds

CFG = {
    "live: vote 3/6": (6, "vote", 3),
    "vote 5/10": (10, "vote", 5),
    "vote 10/20": (20, "vote", 10),
    "mean k=20": (20, "mean", None),
}


def fires(seq, k, rule, m, tau=TAU):
    return fire_vote(seq, k, tau, m) if rule == "vote" else fire_mean(seq, k, tau)


print(f"n = {len(users)} target users, each against 40 impostor participants\n")
print("IMPOSTOR SESSION SURVIVAL — 150 contiguous windows (~4.5 min of typing)")
print(f"  {'config':<16}{'sessions escaping':>20}{'median detect':>16}{'p90 detect':>13}")

summary = {}
for name, (k, rule, m) in CFG.items():
    escaped, first = 0, []
    total = 0
    for u in users:
        for _, run in u["_impostorRuns"].items():
            f = fires(run, k, rule, m)
            if len(f) == 0:
                continue
            total += 1
            idx = np.flatnonzero(f)
            if len(idx) == 0:
                escaped += 1
            else:
                # digraphs consumed before the first firing packet completes
                first.append(50 + (k - 1) * 10 + idx[0] * 10)
    first = np.array(first)
    esc = escaped / total
    summary[name] = {"escapeRate": esc, "nSessions": total,
                     "medianDetectDigraphs": float(np.median(first)) if len(first) else None,
                     "p90DetectDigraphs": float(np.percentile(first, 90)) if len(first) else None}
    print(f"  {name:<16}{escaped:>8}/{total:<6} {esc:>5.2%}"
          f"{np.median(first):>10.0f} dg {np.median(first)*DD:>4.0f}s"
          f"{np.percentile(first,90):>8.0f} dg")

print("\n\nGENUINE SESSION — does the real user get interrupted at least once")
print("  in their whole held-out block?")
print(f"  {'config':<16}{'users interrupted':>20}{'median fires/session':>22}")
for name, (k, rule, m) in CFG.items():
    hit, nf = 0, []
    for u in users:
        f = fires(u["_genuineScores"], k, rule, m)
        if len(f) == 0:
            continue
        nf.append(int(f.sum()))
        if f.any():
            hit += 1
    print(f"  {name:<16}{hit:>8}/{len(nf):<6} {hit/len(nf):>5.2%}{np.median(nf):>18.0f}")
    summary[name]["genuineSessionsInterrupted"] = hit / len(nf)

print("\n\nOPERATING PROFILES — decision-level, rule = vote 10/20")
print("  built by sweeping tau on the SAME scores; FAR/TAR are per decision")
k, rule, m = 20, "vote", 10
rows = []
for tau in np.linspace(0.02, 0.98, 97):
    g, i = [], []
    for u in users:
        fg = fires(u["_genuineScores"], k, rule, m, tau)
        if len(fg) == 0:
            continue
        g.append(1 - fg.mean())
        ii = [fires(r, k, rule, m, tau).mean() for r in u["_impostorRuns"].values()
              if len(fires(r, k, rule, m, tau))]
        i.append(1 - float(np.mean(ii)))
    rows.append((tau, float(np.median(i)), float(np.median(g))))   # (tau, FAR, TAR)

for label, target in [("high security", 0.01), ("balanced", None), ("low friction", 0.05)]:
    if target is None:
        best = min(rows, key=lambda r: abs(r[1] - (1 - r[2])))
    else:
        best = min(rows, key=lambda r: abs(r[1] - target))
    tau, far, tar = best
    print(f"  {label:<15} tau {tau:.2f}   FAR {far:>6.2%}   genuine accepted {tar:>6.2%}   "
          f"challenged {1-tar:>6.2%}")
    summary.setdefault("profiles", {})[label] = {"tau": tau, "far": far, "tar": tar}

json.dump(summary, open("artifacts/xai/session_survival.json", "w"), indent=1)
print("\nwrote artifacts/xai/session_survival.json")
