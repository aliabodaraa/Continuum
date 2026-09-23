"""
Priority 3: decision-rule numbers that are not selected on the data they report.

THE PROBLEM
-----------
Section 4-9b compares mouse vote rules (3-of-6, 10-of-20, 15-of-20, mean, median)
by sweeping them over the held-out users' score streams and reporting the winner's
rates on those same streams. Selecting a rule on the data you then report it on
is optimistic by construction -- the same class of error as choosing a threshold
on the test set, which PART 6 of decision_sweep.py already avoids for thresholds
but not for rules.

WHAT THIS DOES
--------------
Splits each user's evaluation material in two and never crosses the line:

    calibration = first half of the genuine stream + every OTHER impostor identity
    test        = second half of the genuine stream + the remaining identities

The rule is chosen ONCE, on calibration data pooled across users, by a stated
objective. It is then evaluated on the untouched test half. The deployed fixed
threshold 0.50 is held constant throughout, because that is what production uses
and it was never tuned on this data.

Reads the deployed model's saved streams -- no retraining.

    python rule_selection_honest.py \\
        --scores /app/artifacts/mouse-ws50-aligned/population_scores.json
"""
import argparse
import json
import sys

import numpy as np

LIVE_TAU = 0.50
RULES = (
    [("vote", n, k) for n in (6, 10, 20) for k in range(max(2, n // 2), n + 1)]
    + [("mean", n, None) for n in (6, 10, 20)]
    + [("median", n, None) for n in (6, 10, 20)]
)


def label(rule, n, k):
    return f"{k}-of-{n}" if rule == "vote" else f"{rule}@{n}"


def fire(seq, tau, rule, n, k):
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


def halves(u):
    g = np.asarray(u["_genuineScores"], float)
    parts = sorted(u["_impostorRuns"].keys())
    h = len(g) // 2
    return {"cal": (g[:h], parts[::2]), "test": (g[h:], parts[1::2])}


def rates(u, half, rule, n, k):
    g, parts = halves(u)[half]
    fl = fire(g, LIVE_TAU, rule, n, k)
    caps = [fire(np.asarray(u["_impostorRuns"][p], float), LIVE_TAU, rule, n, k)
            for p in parts]
    caps = [c for c in caps if c is not None]
    return fl, (float(np.mean(caps)) if caps else None)


def aggregate(users, half, rule, n, k):
    fls, caps = [], []
    for u in users:
        fl, cap = rates(u, half, rule, n, k)
        if fl is not None and cap is not None:
            fls.append(fl); caps.append(cap)
    if len(fls) < 3:
        return None
    return {"fl": float(np.median(fls)), "cap": float(np.median(caps)), "n": len(fls)}


def boot_ci(vals, n=4000, seed=7):
    v = np.asarray(vals, float)
    rng = np.random.default_rng(seed)
    st = [np.median(v[rng.integers(0, len(v), len(v))]) for _ in range(n)]
    return [float(np.percentile(st, 2.5)), float(np.percentile(st, 97.5))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scores",
                    default="/app/artifacts/mouse-ws50-aligned/population_scores.json")
    ap.add_argument("--out", default="/app/artifacts/xai/rule_selection_honest.json")
    ap.add_argument("--budget", type=float, default=0.05,
                    help="false-lock budget the rule must respect ON CALIBRATION")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    doc = json.load(open(args.scores))
    users = [u for u in doc["perUser"]
             if u.get("_genuineScores") and u.get("_impostorRuns")
             and len(u["_genuineScores"]) >= 40 and len(u["_impostorRuns"]) >= 6]
    print(f"users with usable streams: {len(users)}  |  fixed threshold {LIVE_TAU}")
    print("calibration = first half genuine + alternate impostor identities")
    print("test        = second half genuine + the remaining identities\n")

    # ---- 1. every rule, scored on BOTH halves ----
    table = []
    for rule, n, k in RULES:
        c = aggregate(users, "cal", rule, n, k)
        t = aggregate(users, "test", rule, n, k)
        if c and t:
            table.append({"rule": rule, "n": n, "k": k, "label": label(rule, n, k),
                          "calFL": c["fl"], "calCAP": c["cap"],
                          "testFL": t["fl"], "testCAP": t["cap"]})

    # ---- 2. select ONCE on calibration, under a stated objective ----
    ok = [r for r in table if r["calFL"] <= args.budget]
    chosen = max(ok, key=lambda r: r["calCAP"]) if ok else None
    deployed = next((r for r in table if r["label"] == "15-of-20"), None)

    print(f"{'rule':>12}{'cal FL%':>10}{'cal CAP%':>10}{'TEST FL%':>11}{'TEST CAP%':>11}")
    for r in sorted(table, key=lambda r: -r["calCAP"])[:12]:
        mark = ""
        if chosen and r["label"] == chosen["label"]:
            mark = "  <- selected on calibration"
        if deployed and r["label"] == deployed["label"]:
            mark += "  <- deployed"
        print(f"{r['label']:>12}{r['calFL']*100:>10.1f}{r['calCAP']*100:>10.1f}"
              f"{r['testFL']*100:>11.1f}{r['testCAP']*100:>11.1f}{mark}")

    print("\n" + "=" * 78)
    print(f"HONEST NUMBERS  (rule picked on calibration at FL <= {args.budget*100:.0f}%,"
          f" reported on the untouched test half)")
    print("=" * 78)
    for name, r in (("selected", chosen), ("deployed 15-of-20", deployed)):
        if not r:
            continue
        fls, caps = [], []
        for u in users:
            fl, cap = rates(u, "test", r["rule"], r["n"], r["k"])
            if fl is not None and cap is not None:
                fls.append(fl); caps.append(cap)
        print(f"  {name:<20} {r['label']:>10}   "
              f"false-lock {np.median(fls)*100:5.1f}% CI{[round(x*100,1) for x in boot_ci(fls)]}   "
              f"capture {np.median(caps)*100:5.1f}% CI{[round(x*100,1) for x in boot_ci(caps)]}")

    if chosen and deployed:
        d = []
        for u in users:
            _, ca = rates(u, "test", deployed["rule"], deployed["n"], deployed["k"])
            _, cb = rates(u, "test", chosen["rule"], chosen["n"], chosen["k"])
            if ca is not None and cb is not None:
                d.append(cb - ca)
        if len(d) >= 3:
            d = np.asarray(d)
            rng = np.random.default_rng(17)
            st = np.array([np.median(d[rng.integers(0, len(d), len(d))]) for _ in range(4000)])
            p = 2 * min((st <= 0).mean(), (st >= 0).mean())
            print(f"\n  paired capture difference (selected - deployed) on TEST half:"
                  f" {np.median(d)*100:+.1f} pp"
                  f"  CI[{np.percentile(st,2.5)*100:+.1f},{np.percentile(st,97.5)*100:+.1f}]"
                  f"  p={min(1.0,p):.3f}  ({int((d>0).sum())}/{len(d)} users favour the selected rule)")

    json.dump({"fixedThreshold": LIVE_TAU, "budget": args.budget,
               "nUsers": len(users), "allRules": table,
               "selectedOnCalibration": chosen, "deployed": deployed,
               "protocol": "rule chosen on calibration half (first half genuine + alternate "
                           "impostor identities); reported on the untouched test half; fixed "
                           "threshold throughout"},
              open(args.out, "w"), indent=2)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
