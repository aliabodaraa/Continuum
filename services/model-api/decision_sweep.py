"""
Decision-level optimisation and threshold investigation (parts 5 and 6).

Why this exists
---------------
Every headline keystroke number is a WINDOW-level statistic: median EER 14.53% describes
one 50-digraph grid. Nothing a user experiences is a window. The system challenges on a
PACKET — a vote over several consecutive windows — and the packet rule was inherited from
Lu et al. (2020) without ever being swept. So the operating point the deployment actually
sits at has never been chosen; it was assumed.

This script sweeps it, and answers two questions the window-level numbers cannot:

  1. What is the DECISION-level ROC?  TAR at a 1% decision-level FAR is the number that
     decides whether Continuum can stand alone, and it has never been measured.
  2. Does packet voting genuinely buy security, or does correlation between overlapping
     windows eat the benefit while the binomial arithmetic hides it?

Correlation is the whole difficulty
-----------------------------------
Consecutive windows overlap by 80% (stride 10 of 50) and describe adjacent moments of the
same behaviour; measured lag-1 autocorrelation is ~0.28. Three consequences are handled
explicitly here:

  * Packets are built ONLY from one person's own consecutive windows. Genuine packets slide
    over the held-out block (temporal). Impostor packets slide within a single participant's
    contiguous run. Splicing two people together would invent a transition the deployed
    system never sees.

  * The sampled impostor scores in the sweep are drawn globally and thinned ~1-in-13, so
    consecutive SAMPLED windows are not temporally adjacent and carry far less correlation
    than the real stream. Using them would flatter the vote. `_impostorRuns` — contiguous
    per-participant runs — is used instead, and the difference between the two is reported
    as `thinning_illusion` because it quantifies exactly the error this script exists to
    avoid.

  * Overlapping packets (stride 1) are not independent samples. Every rate is therefore
    reported at stride 1 AND at stride k (non-overlapping), and confidence intervals
    bootstrap over USERS and over PARTICIPANTS — never over packets.

Nothing here retrains anything. It is post-processing over saved per-window scores, so every
configuration is evaluated on byte-identical model outputs and the comparison between
configurations is exactly paired.

Usage:
    python decision_sweep.py --scores artifacts/xai/population_scores_run2.json \
        --out artifacts/xai/decision_sweep.json
"""
import argparse
import json

import numpy as np

# Packet lengths worth testing. 6 is the deployed value; 1 is the no-vote control.
KS = [1, 3, 5, 6, 8, 10, 12, 16, 20]
LIVE_TAU = 0.50


# --------------------------------------------------------------------------- rules
def fire_vote(seq, k, tau, m, stride=1):
    """m-of-k vote: fire when at least m of k consecutive windows score below tau.

    m = ceil(k/2) is majority (the deployed rule at k=6, m=3); m = 1 is 'any window low';
    m = k is unanimous."""
    low = (np.asarray(seq) < tau).astype(np.int32)
    if len(low) < k:
        return np.empty(0, dtype=bool)
    c = np.convolve(low, np.ones(k, dtype=np.int32), mode="valid")
    return (c >= m)[::stride]


def fire_mean(seq, k, tau, stride=1):
    """Score averaging: fire when the mean of k consecutive scores falls below tau."""
    s = np.asarray(seq, dtype=float)
    if len(s) < k:
        return np.empty(0, dtype=bool)
    c = np.convolve(s, np.ones(k) / k, mode="valid")
    return (c < tau)[::stride]


def fire_median(seq, k, tau, stride=1):
    """Median aggregation — as averaging, but a single collapsed window cannot drag it."""
    s = np.asarray(seq, dtype=float)
    if len(s) < k:
        return np.empty(0, dtype=bool)
    view = np.lib.stride_tricks.sliding_window_view(s, k)
    return (np.median(view, axis=1) < tau)[::stride]


def sprt_latency(seq, tau, bound, max_len):
    """Sequential evidence accumulation (Wald-style).

    Accumulates log-odds against the genuine hypothesis, window by window, and fires the
    moment the running total crosses `bound`. Unlike a fixed packet this has no set length:
    strong evidence fires early, weak evidence never fires. Returns (fired, latency) where
    latency is the number of windows consumed — the quantity a fixed-k rule cannot trade.

    Scores are clipped before the log so a single saturated window cannot dominate the sum.
    """
    s = np.clip(np.asarray(seq, dtype=float), 1e-3, 1 - 1e-3)
    llr = np.log((1.0 - s) / s) - np.log((1.0 - tau) / tau)
    run = 0.0
    for n, step in enumerate(llr[:max_len], start=1):
        run += step
        if run >= bound:
            return True, n
        run = max(run, 0.0)          # reset on evidence of genuineness
    return False, min(len(s), max_len)


# --------------------------------------------------------------------------- helpers
def boot_ci(vals, n=4000, seed=17):
    """Percentile bootstrap over the supplied unit (users, or participants)."""
    v = np.asarray(vals, dtype=float)
    if len(v) < 2:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    m = [np.median(v[rng.integers(0, len(v), len(v))]) for _ in range(n)]
    return float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))


def rates_for_user(u, k, rule, tau, m=None, stride=1):
    """Genuine-fire and impostor-fire rates for one target, packets built honestly.

    Returns (genuine_fire_rate, impostor_fire_rate_per_participant list).
    genuine fire = false lock. impostor fire = caught.
    """
    g = u["_genuineScores"]
    if rule == "vote":
        gf = fire_vote(g, k, tau, m, stride)
    elif rule == "mean":
        gf = fire_mean(g, k, tau, stride)
    else:
        gf = fire_median(g, k, tau, stride)
    if len(gf) == 0:
        return None, None

    imp = []
    for _, run in u["_impostorRuns"].items():
        if rule == "vote":
            f = fire_vote(run, k, tau, m, stride)
        elif rule == "mean":
            f = fire_mean(run, k, tau, stride)
        else:
            f = fire_median(run, k, tau, stride)
        if len(f):
            imp.append(float(f.mean()))
    if not imp:
        return None, None
    return float(gf.mean()), imp


def decision_roc(users, k, rule, m=None, stride=1, grid=None):
    """Sweep tau to build a DECISION-level ROC, then read EER and TAR at FAR=1% off it.

    Axes are decision-level:
        FAR = impostor packets that do NOT fire (a stranger passes a decision)
        TAR = genuine packets that do NOT fire (the real user is not interrupted)
    """
    grid = grid if grid is not None else np.linspace(0.01, 0.99, 99)
    far, tar = [], []
    for tau in grid:
        gs, is_ = [], []
        for u in users:
            gf, imp = rates_for_user(u, k, rule, tau, m, stride)
            if gf is None:
                continue
            gs.append(1.0 - gf)                 # genuine accepted
            is_.append(1.0 - float(np.mean(imp)))  # impostor accepted
        if not gs:
            continue
        tar.append(float(np.median(gs)))
        far.append(float(np.median(is_)))
    far, tar = np.array(far), np.array(tar)
    o = np.argsort(far)
    far, tar = far[o], tar[o]
    # EER: where FAR crosses 1-TAR
    frr = 1.0 - tar
    d = far - frr
    idx = int(np.argmin(np.abs(d)))
    eer = float((far[idx] + frr[idx]) / 2.0)
    tar_at_1 = float(np.interp(0.01, far, tar)) if far.min() <= 0.01 <= far.max() else float("nan")
    tar_at_5 = float(np.interp(0.05, far, tar)) if far.min() <= 0.05 <= far.max() else float("nan")
    return {"eer": eer, "tarAtFar01": tar_at_1, "tarAtFar05": tar_at_5,
            "far": far.tolist(), "tar": tar.tolist()}


def binomial_expectation(p_low, k, m):
    """P(at least m of k low) assuming INDEPENDENT windows. They are not — this is printed
    only so the gap against the measured rate is visible rather than hidden."""
    from math import comb
    return sum(comb(k, j) * p_low ** j * (1 - p_low) ** (k - j) for j in range(m, k + 1))


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scores", required=True)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    doc = json.load(open(args.scores))
    users = [u for u in doc["perUser"] if u.get("_impostorRuns") and u.get("_genuineScores")]
    print(f"loaded {len(users)} users with score runs\n")
    if len(users) < 10:
        raise SystemExit(
            f"only {len(users)} users carry contiguous impostor runs — this file was written "
            "by an older revision of population_sweep.py (or by more than one concurrent run). "
            "Re-run the sweep, and check no stale process is writing the same output:\n"
            "  docker exec -e PAT=populationXsweep continuum-model-api-1 sh -c "
            "'P=$(echo $PAT | sed s/X/_/); for d in /proc/[0-9]*; do p=$(basename $d); "
            "[ \"$p\" = \"$$\" ] && continue; c=$(tr \"\\0\" \" \" < $d/cmdline 2>/dev/null); "
            "case \"$c\" in *$P*) echo $p;; esac; done'")

    report = {"nUsers": len(users), "configs": [], "thinning": {}, "threshold": {}}

    # ---- 1. the deployed rule, measured honestly ---------------------------
    print("=" * 78)
    print("PART 5a — the deployed rule (>=3 of 6 below 0.50), per user")
    print("=" * 78)
    gf, cat = [], []
    for u in users:
        a, b = rates_for_user(u, 6, "vote", LIVE_TAU, 3)
        if a is None:
            continue
        gf.append(a)
        cat.append(float(np.mean(b)))
    gf, cat = np.array(gf), np.array(cat)
    print(f"  false-lock per decision : median {np.median(gf):.2%}  "
          f"IQR {np.percentile(gf,25):.2%}-{np.percentile(gf,75):.2%}  "
          f"min {gf.min():.2%}  max {gf.max():.2%}")
    print(f"  impostor caught         : median {np.median(cat):.2%}  "
          f"IQR {np.percentile(cat,25):.2%}-{np.percentile(cat,75):.2%}")
    print(f"  users challenged on >10% of decisions: {(gf > 0.10).sum()}/{len(gf)}")
    print(f"  users challenged on >25% of decisions: {(gf > 0.25).sum()}/{len(gf)}")
    report["deployed"] = {
        "falseLockMedian": float(np.median(gf)), "falseLockIQR": [float(np.percentile(gf, 25)), float(np.percentile(gf, 75))],
        "falseLockCI": boot_ci(gf), "impostorCaughtMedian": float(np.median(cat)),
        "impostorCaughtCI": boot_ci(cat),
        "usersOver10pct": int((gf > 0.10).sum()), "usersOver25pct": int((gf > 0.25).sum()),
        "perUserFalseLock": gf.tolist(), "perUserCaught": cat.tolist(),
    }

    # ---- 2. does thinning create an illusion? ------------------------------
    # Only meaningful for a sweep that ALSO saved a globally-thinned sample alongside the
    # contiguous runs (keystroke's population_sweep.py does; a sweep whose every impostor
    # score is already a full contiguous session, like mouse's, has nothing to compare against
    # and this section is skipped rather than faked).
    if all("_impostorScores" in u for u in users):
        print("\n" + "=" * 78)
        print("PART 5b — would the thinned impostor sample have flattered the vote?")
        print("=" * 78)
        thin_cat = []
        for u in users:
            s = u["_impostorScores"]
            f = fire_vote(s, 6, LIVE_TAU, 3)
            if len(f):
                thin_cat.append(float(f.mean()))
        print(f"  impostor caught, CONTIGUOUS runs (honest) : {np.median(cat):.2%}")
        print(f"  impostor caught, THINNED sample (wrong)   : {np.median(thin_cat):.2%}")
        print(f"  difference                                : {np.median(thin_cat)-np.median(cat):+.2%}")
        report["thinning"] = {"honest": float(np.median(cat)), "thinned": float(np.median(thin_cat))}
    else:
        print("\n" + "=" * 78)
        print("PART 5b — skipped (no globally-thinned sample in this score file; every")
        print("impostor score here already comes from a full contiguous session)")
        print("=" * 78)

    # ---- 3. correlation vs the binomial -----------------------------------
    print("\n" + "=" * 78)
    print("PART 5c — measured vs binomial: how much does correlation cost?")
    print("=" * 78)
    print(f"  {'':<10}{'per-window':>12}{'binomial':>12}{'measured':>12}{'ratio':>10}")
    for label, seqs, kind in (("genuine", [u["_genuineScores"] for u in users], "lock"),
                              ("impostor", [np.concatenate([np.asarray(r) for r in u["_impostorRuns"].values()])
                                            for u in users], "catch")):
        pw = np.median([float((np.asarray(s) < LIVE_TAU).mean()) for s in seqs])
        bino = binomial_expectation(pw, 6, 3)
        meas = np.median(gf) if kind == "lock" else np.median(cat)
        ratio = meas / bino if bino > 0 else float("nan")
        print(f"  {label:<10}{pw:>11.2%}{bino:>12.2%}{meas:>12.2%}{ratio:>9.1f}x")
        report.setdefault("binomialGap", {})[label] = {
            "perWindow": float(pw), "binomial": float(bino), "measured": float(meas),
            "ratio": float(ratio)}

    # ---- 4. the packet sweep ----------------------------------------------
    print("\n" + "=" * 78)
    print("PART 5d — packet-size and rule sweep, at the live threshold 0.50")
    print("=" * 78)
    print(f"  {'rule':<16}{'k':>3}{'m':>3}{'falseLock':>11}{'caught':>9}{'decFAR':>9}"
          f"{'latency':>9}{'nonOverlap':>12}")
    for k in KS:
        cands = [("vote", max(1, int(np.ceil(k / 2))))]          # majority
        if k >= 4:
            cands.append(("vote", max(1, int(np.ceil(0.75 * k)))))  # strict
            cands.append(("vote", 1))                               # any-low
            cands.append(("mean", None))
            cands.append(("median", None))
        for rule, m in cands:
            g1, c1, g2, c2 = [], [], [], []
            for u in users:
                a, b = rates_for_user(u, k, rule, LIVE_TAU, m, 1)
                if a is None:
                    continue
                g1.append(a)
                c1.append(float(np.mean(b)))
                a2, b2 = rates_for_user(u, k, rule, LIVE_TAU, m, max(1, k))
                if a2 is not None:
                    g2.append(a2)
                    c2.append(float(np.mean(b2)))
            if not g1:
                continue
            name = rule if rule != "vote" else f"vote {m}/{k}"
            row = {"rule": rule, "k": k, "m": m,
                   "falseLock": float(np.median(g1)), "caught": float(np.median(c1)),
                   "decFAR": float(1 - np.median(c1)), "latencyWindows": k,
                   "falseLockNonOverlap": float(np.median(g2)) if g2 else None,
                   "caughtNonOverlap": float(np.median(c2)) if c2 else None}
            report["configs"].append(row)
            print(f"  {name:<16}{k:>3}{(m if m else 0):>3}{row['falseLock']:>10.2%}"
                  f"{row['caught']:>9.2%}{row['decFAR']:>9.2%}{k:>8}w"
                  f"{(row['falseLockNonOverlap'] or 0):>11.2%}")

    # ---- 5. decision-level ROC for the best candidates ---------------------
    print("\n" + "=" * 78)
    print("PART 5e — DECISION-level ROC (this is the standalone-viability number)")
    print("=" * 78)
    print(f"  {'config':<20}{'dec EER':>10}{'TAR@FAR=1%':>13}{'TAR@FAR=5%':>13}")
    roc_cfgs = [("window (k=1)", 1, "vote", 1),
                ("vote 3/6 (live)", 6, "vote", 3),
                ("vote 5/10", 10, "vote", 5),
                ("vote 8/10", 10, "vote", 8),
                ("mean k=6", 6, "mean", None),
                ("mean k=10", 10, "mean", None),
                ("mean k=20", 20, "mean", None),
                ("vote 10/20", 20, "vote", 10),
                ("vote 15/20", 20, "vote", 15)]
    for name, k, rule, m in roc_cfgs:
        r = decision_roc(users, k, rule, m)
        r.pop("far"), r.pop("tar")
        report.setdefault("roc", {})[name] = dict(r, k=k, rule=rule, m=m)
        print(f"  {name:<20}{r['eer']:>9.2%}{r['tarAtFar01']:>13.2%}{r['tarAtFar05']:>13.2%}")

    # ---- 6. PART 6 — threshold personalisation -----------------------------
    print("\n" + "=" * 78)
    print("PART 6 — fixed vs per-user threshold, calibrated and tested on disjoint data")
    print("=" * 78)
    print("  calibration = first half of held-out genuine + half the impostor participants")
    print("  test        = second half of held-out genuine + the OTHER impostor participants\n")

    def eer_thresh(gen, imp):
        best, bt = 1e9, LIVE_TAU
        for t in np.linspace(0.02, 0.98, 97):
            far = float((np.asarray(imp) >= t).mean())
            frr = float((np.asarray(gen) < t).mean())
            if abs(far - frr) < best:
                best, bt = abs(far - frr), t
        return bt

    rows = []
    for u in users:
        g = np.asarray(u["_genuineScores"], dtype=float)
        parts = sorted(u["_impostorRuns"].keys())
        if len(g) < 20 or len(parts) < 8:
            continue
        half = len(g) // 2
        g_cal, g_te = g[:half], g[half:]
        p_cal, p_te = parts[:len(parts) // 2], parts[len(parts) // 2:]
        i_cal = np.concatenate([np.asarray(u["_impostorRuns"][p]) for p in p_cal])
        i_te = np.concatenate([np.asarray(u["_impostorRuns"][p]) for p in p_te])

        t_cal = eer_thresh(g_cal, i_cal)      # honest: chosen on calibration only
        t_oracle = eer_thresh(g_te, i_te)     # cheating: chosen on the test data itself

        def ev(t):
            return (float((i_te >= t).mean()), float((g_te < t).mean()))

        far_f, frr_f = ev(LIVE_TAU)
        far_c, frr_c = ev(t_cal)
        far_o, frr_o = ev(t_oracle)
        rows.append({"participant": u["participant"], "tCal": t_cal, "tOracle": t_oracle,
                     "fixed": [far_f, frr_f], "cal": [far_c, frr_c], "oracle": [far_o, frr_o]})

    def show(label, key):
        far = np.array([r[key][0] for r in rows])
        frr = np.array([r[key][1] for r in rows])
        bal = (far + frr) / 2
        print(f"  {label:<34}FAR {np.median(far):>7.2%}  FRR {np.median(frr):>7.2%}  "
              f"balanced-err {np.median(bal):>7.2%}")
        return bal

    b_fixed = show("fixed tau = 0.50", "fixed")
    b_cal = show("per-user, calibrated honestly", "cal")
    b_oracle = show("per-user, chosen ON the test set", "oracle")

    d = b_cal - b_fixed
    better = int((d < 0).sum())
    print(f"\n  honest personalisation vs fixed: median change {np.median(d):+.2%} "
          f"(better for {better}/{len(d)} users)")
    print(f"  CI on that change: {boot_ci(d)}")
    gap = b_oracle - b_cal
    print(f"  optimism of choosing the threshold on the test set: {np.median(gap):+.2%}")
    print(f"    -> that gap is how much 'improvement' would have been an artefact")
    report["threshold"] = {
        "fixedBalancedErr": float(np.median(b_fixed)),
        "calibratedBalancedErr": float(np.median(b_cal)),
        "oracleBalancedErr": float(np.median(b_oracle)),
        "calMinusFixed": float(np.median(d)), "calMinusFixedCI": boot_ci(d),
        "betterForUsers": better, "nUsers": len(d),
        "oracleOptimism": float(np.median(gap)),
        "perUser": rows,
    }

    if args.out:
        json.dump(report, open(args.out, "w"), indent=1)
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
