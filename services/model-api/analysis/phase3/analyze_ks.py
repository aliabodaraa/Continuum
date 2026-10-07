"""Experiment KS analysis (PREREGISTRATION_KS.md section 5).

    python analyze_ks.py     # artifacts/phase3/parts/* -> artifacts/phase3/ks_result.json, ks_result.txt

Decisions are the live packet: step-disjoint blocks of 20 windows (eval_decision_level.blocks,
gap 4) of one contiguous stream (the target's held-out windows, or one impostor's first 150 windows).
The decision score is the block's mean window probability; it needs no threshold. The live rule
(>= 10 of 20 windows below 0.50 -> suspicious) is reported as one operating point.

Primary: A1000 - REF in per-user AUC of 20-window decisions, paired bootstrap over targets (10,000,
seed 17); superiority if the lower 95% bound > 0. Key secondary, only after a primary success:
A1000 - A40 (the amount effect within one source), lower bound > 0.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ks_common as KC  # noqa: E402
import eval_decision_level as E  # noqa: E402
import p1lib as P  # noqa: E402


def load_arm(folder, arm, hashes, smoke):
    d = os.path.join(folder, "parts", arm)
    recs = {}
    for f in sorted(os.listdir(d)):
        if not f.endswith(".json"):
            continue
        r = json.load(open(os.path.join(d, f)))
        if bool(r.get("smokeTest")) != smoke:
            raise SystemExit(f"{arm}/{f}: smokeTest flag does not fit this run")
        for k, v in hashes.items():
            if r.get(k) != v:
                raise SystemExit(f"{arm}/{f}: produced under another {k}")
        recs[r["participant"]] = r
    return recs


def boot(a, b):
    res = P.boot(a, b)
    a, b = np.asarray(a, float), np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    dd = b[ok] - a[ok]
    st = dd[np.random.default_rng(17).integers(0, len(dd), (P.N_BOOT, len(dd)))].mean(1)
    res["se"], res["mde80"] = float(st.std(ddof=1)), 2.8 * float(st.std(ddof=1))
    return res


def per_target(r):
    g = np.asarray(r["genuine"], float)
    runs = [np.asarray(v, float) for v in r["runs"].values()]
    gb = [b for b in KC.blocks(g)]
    ib = [b for v in runs for b in KC.blocks(v)]
    gm, im = np.array([b.mean() for b in gb]), np.array([b.mean() for b in ib])
    low = lambda b: (b < KC.LIVE_THRESHOLD).mean() >= KC.VOTE_FRACTION  # noqa: E731  live rule: suspicious
    imp_w = np.concatenate(runs)
    return {"decAuc": E.auc_fast(gm, im) if len(gm) and len(im) else float("nan"),
            "winAuc": P.auc_of(g, imp_w), "winEer": P.eer_of(g, imp_w)[0],
            "gDec": gm, "iDec": im, "gRej": np.array([low(b) for b in gb]), "iAcc": np.array([not low(b) for b in ib]),
            "nG": len(gm), "nI": len(im)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="SMOKE TEST ONLY")
    a = ap.parse_args()
    hashes = {} if a.smoke else KC.verify_frozen()
    folder = KC.SMOKE if a.smoke else KC.STUDY
    out_json = os.path.join(folder, "ks_result.json")
    if not a.smoke and os.path.exists(out_json):
        raise SystemExit(f"{out_json} exists already; KS is analysed once")
    recs = {arm: load_arm(folder, arm, hashes, a.smoke) for arm in KC.ARMS}
    ids = sorted(recs["REF"])
    for arm in KC.ARMS:
        if sorted(recs[arm]) != ids:
            raise SystemExit(f"arm {arm} has other targets than REF")
    elig = [t for t in ids if all(recs[arm][t]["eligible"] for arm in KC.ARMS)]
    stats = {arm: {t: per_target(recs[arm][t]) for t in elig} for arm in KC.ARMS}
    targets = [t for t in elig if all(stats[arm][t]["nG"] and stats[arm][t]["nI"] for arm in KC.ARMS)]
    val = {arm: [stats[arm][t]["decAuc"] for t in targets] for arm in KC.ARMS}

    res = {**hashes, "experiment": "KS", "smokeTest": a.smoke, "nTargets": len(targets),
           "excluded": [t for t in ids if t not in targets], "packet": KC.N_PACKET,
           "meanPerUserDecisionAuc": {arm: float(np.nanmean(val[arm])) for arm in KC.ARMS},
           "contrasts": {f"{x}-{y}": boot(val[y], val[x]) for x, y in
                         (("A1000", "REF"), ("A200", "REF"), ("A40", "REF"), ("A1000", "A40"))}}
    prim = res["contrasts"]["A1000-REF"]
    res["primary"] = {**prim, "success": bool(prim["ci95"][0] > 0)}
    sec = res["contrasts"]["A1000-A40"]
    res["keySecondary"] = {**sec, "tested": res["primary"]["success"],
                           "success": bool(res["primary"]["success"] and sec["ci95"][0] > 0)}
    rep = {}
    for arm in KC.ARMS:
        S = stats[arm]
        gd = np.concatenate([S[t]["gDec"] for t in targets]); idd = np.concatenate([S[t]["iDec"] for t in targets])
        we = np.array([S[t]["winEer"] for t in targets])
        rep[arm] = {"window": {"aucMean": float(np.mean([S[t]["winAuc"] for t in targets])),
                               "eerMean": float(we.mean()), "eerMedian": float(np.median(we)),
                               "usersAbove20pctEer": int((we > 0.20).sum())},
                    "decisionPooled": {"eer": E.eer_fast(gd, idd), "auc": E.auc_fast(gd, idd),
                                       "frrAtFar1": E.frr_at_far(gd, idd, 0.01), "frrAtFar5": E.frr_at_far(gd, idd, 0.05)},
                    "liveRule": {"far": float(np.concatenate([S[t]["iAcc"] for t in targets]).mean()),
                                 "frr": float(np.concatenate([S[t]["gRej"] for t in targets]).mean()),
                                 "frrMeanPerUser": float(np.mean([S[t]["gRej"].mean() for t in targets]))},
                    "decisions": {"genuine": int(len(gd)), "impostor": int(len(idd))}}
    res["reported"] = rep
    res["perUser"] = {arm: dict(zip([int(t) for t in targets], val[arm])) for arm in KC.ARMS}
    f = lambda c: f"{c['meanDiff']:+.4f} [{c['ci95'][0]:+.4f}, {c['ci95'][1]:+.4f}] p {c['p']:.3f}, better for {c['bBetter']}/{c['n']}"  # noqa: E731
    lines = [f"EXPERIMENT KS (keystroke, Lu per-user training; negatives: KeyRecs 40 vs Aalto 40/200/1000)"
             f"{'  [SMOKE TEST - NOT A RESULT]' if a.smoke else ''}",
             f"{len(targets)} KeyRecs targets; decisions = 20-window packets; score = packet mean",
             "", f"PRIMARY  A1000 - REF, per-user AUC of 20-window decisions: {f(prim)}",
             f"         superiority (lower 95% bound > 0): {'YES' if res['primary']['success'] else 'NO'}; SE {prim['se']:.4f}, MDE80 {prim['mde80']:.4f}",
             f"KEY SECONDARY  A1000 - A40: {f(sec)} -> "
             + ("YES" if res["keySecondary"]["success"] else ("NO" if res["keySecondary"]["tested"] else "not tested (primary failed)")),
             f"reported  A200 - REF: {f(res['contrasts']['A200-REF'])};  A40 - REF: {f(res['contrasts']['A40-REF'])}", ""]
    for arm in KC.ARMS:
        r = rep[arm]
        lines.append(f"  {arm:5s} per-user decision AUC {res['meanPerUserDecisionAuc'][arm]:.4f} | window AUC {r['window']['aucMean']:.3f} "
                     f"EER mean {r['window']['eerMean'] * 100:.1f}% (>20%: {r['window']['usersAbove20pctEer']}) | pooled decision "
                     f"EER {r['decisionPooled']['eer'] * 100:.1f}% FRR@FAR1% {r['decisionPooled']['frrAtFar1'] * 100:.1f}% | "
                     f"live rule FAR {r['liveRule']['far'] * 100:.1f}% FRR {r['liveRule']['frr'] * 100:.1f}%")
    txt = os.path.join(folder, "ks_result.txt")
    open(txt + ".tmp", "w").write("\n".join(lines) + "\n")
    os.replace(txt + ".tmp", txt)
    KC.write_json(out_json, res, indent=1)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
