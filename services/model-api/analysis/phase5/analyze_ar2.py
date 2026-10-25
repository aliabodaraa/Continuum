"""Experiment AR2 analysis (PREREGISTRATION_AR2.md section 6).

    python analyze_ar2.py     # artifacts/phase5/parts/*.json -> artifacts/phase5/ar2_result.json, ar2_result.txt

As AR's analysis: decisions are step-disjoint blocks of 20 windows (eval_decision_level.blocks, gap 4) of one
contiguous stream (the target's session-2 test half, or one impostor's first 150 windows); the decision score is
the block's mean window probability; the live rule (>= 10 of 20 below 0.50, no confirmation by later checks) is
one operating point, reported as FAR and FRR.

Primary: B - A in per-user AUC of 20-window decisions, paired bootstrap over targets (10,000, seed 17).
B improves on A if the lower 95% bound > 0, harms if the upper bound < 0; otherwise no detectable difference
(the SE and the minimum detectable effect at 80% power are reported). Everything else is secondary and
descriptive, with 95% intervals.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ar2_common as C2  # noqa: E402

AC = C2.AC
sys.path.insert(0, os.path.join(AC.ROOT, "services", "model-api", "analysis", "phase1"))
import eval_decision_level as E  # noqa: E402
import p1lib as P  # noqa: E402

ARMS = C2.ARMS
VARS = tuple(C2.VARIANTS)


def boot(a, b):
    res = P.boot(a, b)
    a, b = np.asarray(a, float), np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    dd = b[ok] - a[ok]
    st = dd[np.random.default_rng(17).integers(0, len(dd), (P.N_BOOT, len(dd)))].mean(1)
    res["se"], res["mde80"] = float(st.std(ddof=1)), 2.8 * float(st.std(ddof=1))
    return res


def low(b):
    return (b < AC.LIVE_THRESHOLD).mean() >= AC.VOTE_FRACTION


def per_arm(r):
    g = np.asarray(r["genuine"], float)
    runs = [np.asarray(v, float) for v in r["runs"].values()]
    gb = AC.blocks(g)
    ib = [b for v in runs for b in AC.blocks(v)]
    gm, im = np.array([b.mean() for b in gb]), np.array([b.mean() for b in ib])
    return {"decAuc": E.auc_fast(gm, im) if len(gm) and len(im) else float("nan"),
            "winAuc": P.auc_of(g, np.concatenate(runs)), "winEer": P.eer_of(g, np.concatenate(runs))[0],
            "gDec": gm, "iDec": im, "frr": float(np.mean([low(b) for b in gb])) if gb else float("nan"),
            "far": float(np.mean([not low(b) for b in ib])) if ib else float("nan"),
            "gRej": np.array([low(b) for b in gb]), "iAcc": np.array([not low(b) for b in ib]),
            "locksPer100": 100.0 * len(r["testLockAt"]) / max(len(g), 1), "nG": len(gm), "nI": len(im)}


def accepted_share(blocks_list):
    return float(np.mean([not low(b) for b in blocks_list])) if blocks_list else float("nan")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="SMOKE TEST ONLY")
    a = ap.parse_args()
    hashes = {} if a.smoke else C2.verify_frozen()
    folder = C2.SMOKE if a.smoke else C2.STUDY
    out_json = os.path.join(folder, "ar2_result.json")
    if not a.smoke and os.path.exists(out_json):
        raise SystemExit(f"{out_json} exists already; AR2 is analysed once")
    parts = os.path.join(folder, "parts")
    recs = {}
    for f in sorted(os.listdir(parts), key=lambda x: int(x.split(".")[0]) if x.split(".")[0].isdigit() else 0):
        if not f.endswith(".json"):
            continue
        r = json.load(open(os.path.join(parts, f)))
        if bool(r.get("smokeTest")) != a.smoke:
            raise SystemExit(f"{f}: smokeTest flag does not fit this run")
        for k, v in hashes.items():
            if r.get(k) != v:
                raise SystemExit(f"{f}: produced under another {k}")
        recs[r["participant"]] = r
    elig = [t for t in sorted(recs) if recs[t]["eligible"]]
    S = {arm: {t: per_arm(recs[t][arm]) for t in elig} for arm in ARMS}
    targets = [t for t in elig if all(S[arm][t]["nG"] and S[arm][t]["nI"] for arm in ARMS)]
    col = lambda arm, k: [S[arm][t][k] for t in targets]  # noqa: E731

    res = {**hashes, "experiment": "AR2", "smokeTest": a.smoke, "nTargets": len(targets),
           "notEligible": [t for t in sorted(recs) if not recs[t]["eligible"]],
           "excluded": [t for t in elig if t not in targets]}
    res["perUserDecisionAucMean"] = {arm: float(np.nanmean(col(arm, "decAuc"))) for arm in ARMS}
    pairs = tuple((x, "A") for x in ARMS if x != "A") + (("B1", "B"), ("B2", "B"), ("Bany", "B"), ("D", "B"))
    res["decAuc"] = {f"{x}-{y}": boot(col(y, "decAuc"), col(x, "decAuc")) for x, y in pairs}
    prim = res["decAuc"]["B-A"]
    res["primary"] = {**prim, "improves": bool(prim["ci95"][0] > 0), "harms": bool(prim["ci95"][1] < 0)}
    vsA = tuple((x, "A") for x in ARMS if x != "A")
    for k in ("frr", "far", "locksPer100"):
        res[k] = {"mean": {arm: float(np.nanmean(col(arm, k))) for arm in ARMS},
                  "diff": {f"{x}-{y}": boot(col(y, k), col(x, k)) for x, y in vsA}}
    rep = {}
    for arm in ARMS:
        gd = np.concatenate([S[arm][t]["gDec"] for t in targets])
        idd = np.concatenate([S[arm][t]["iDec"] for t in targets])
        we = np.array(col(arm, "winEer"))
        rep[arm] = {"windowAucMean": float(np.mean(col(arm, "winAuc"))), "windowEerMean": float(we.mean()),
                    "windowEerMedian": float(np.median(we)),
                    "decisionPooled": {"eer": E.eer_fast(gd, idd), "auc": E.auc_fast(gd, idd)},
                    "liveRulePooled": {"frr": float(np.concatenate([S[arm][t]["gRej"] for t in targets]).mean()),
                                       "far": float(np.concatenate([S[arm][t]["iAcc"] for t in targets]).mean())},
                    "decisions": {"genuine": int(len(gd)), "impostor": int(len(idd))}}
    res["reported"] = rep

    # reproducibility: the enrolment model A of AR2 against AR's (same seeds, same data)
    ar1 = json.load(open(os.path.join(AC.ROOT, "artifacts", "phase4", "ar_result.json")))["perUser"]["A"]
    diffs = [abs(S["A"][t]["decAuc"] - ar1[str(t)]) for t in targets if str(t) in ar1]
    res["reproducesARsA"] = {"targetsCompared": len(diffs), "maxAbsDifference": float(max(diffs)) if diffs else None,
                             "meanAbsDifference": float(np.mean(diffs)) if diffs else None}

    # the adaptation itself
    adapt = {}
    for arm in VARS:
        acc = [sum(d["accepted"] for d in recs[t][arm]["days"]) for t in targets]
        ndays = [len(recs[t][arm]["days"]) for t in targets]
        ntr = [len(recs[t][arm]["trainings"]) for t in targets]
        first = [recs[t][arm]["trainings"][0]["afterDay"] + 1 for t in targets if recs[t][arm]["trainings"]]
        reasons = {}
        for t in targets:
            for d in recs[t][arm]["days"]:
                reasons[d["reason"]] = reasons.get(d["reason"], 0) + 1
        adapt[arm] = {"daysTotal": int(sum(ndays)), "daysAccepted": int(sum(acc)),
                      "acceptedShare": float(sum(acc) / max(sum(ndays), 1)),
                      "acceptedPerUserMean": float(np.mean(acc)), "acceptedPerUserMedian": float(np.median(acc)),
                      "usersWithRetrain": int(sum(n > 0 for n in ntr)), "retrainsTotal": int(sum(ntr)),
                      "firstRetrainDayMedian": float(np.median(first)) if first else None, "reasons": reasons}
    adapt["daysPerUserMedian"] = float(np.median([recs[t]["nDays"] for t in targets]))
    secs = [tr["seconds"] for t in targets for arm in ARMS for tr in recs[t][arm]["trainings"]]
    adapt["trainingSecondsMedian"] = float(np.median(secs))
    res["adaptation"] = adapt

    # S1: who passes the rule on the enrolment model
    s1 = {}
    for m in ("end", "any"):
        gp = [d[m]["accepted"] for t in targets for d in recs[t]["S1"]["genuineDays"]]
        ip = [v[m]["accepted"] for t in targets for v in recs[t]["S1"]["impostorChunks"].values()]
        per_t = [np.mean([v[m]["accepted"] for v in recs[t]["S1"]["impostorChunks"].values()]) for t in targets
                 if recs[t]["S1"]["impostorChunks"]]
        reasons = {}
        for t in targets:
            for v in recs[t]["S1"]["impostorChunks"].values():
                reasons[v[m]["reason"]] = reasons.get(v[m]["reason"], 0) + 1
        s1[m] = {"genuineDayPass": float(np.mean(gp)), "genuineDays": len(gp),
                 "impostorChunkPass": float(np.mean(ip)), "impostorChunks": len(ip), "impostorChunksPassed": int(sum(ip)),
                 "targetsWithAnyImpostorPass": int(sum(x > 0 for x in per_t)), "impostorReasons": reasons}
    res["S1"] = s1

    # S2: forced poisoning by the most similar impostor
    s2t = [t for t in targets if recs[t]["S2"]]
    before = [accepted_share(AC.blocks(np.asarray(recs[t]["S2"]["attackerTestBefore"], float))) for t in s2t]
    after = [accepted_share(AC.blocks(np.asarray(recs[t]["S2"]["attackerTestAfter"], float))) for t in s2t]
    gfrr_after = [float(np.mean([low(b) for b in AC.blocks(np.asarray(recs[t]["S2"]["genuineTestAfter"], float))]))
                  for t in s2t]
    gfrr_a = [S["A"][t]["frr"] for t in s2t]
    would = [x for t in s2t for x in recs[t]["S2"]["poisonWouldPassGates"]]
    res["S2"] = {"targets": len(s2t), "attackerAcceptedBefore": float(np.nanmean(before)),
                 "attackerAcceptedAfter": float(np.nanmean(after)), "attackerAcceptedDiff": boot(before, after),
                 "genuineFrrA": float(np.mean(gfrr_a)), "genuineFrrAfterPoison": float(np.mean(gfrr_after)),
                 "genuineFrrDiff": boot(gfrr_a, gfrr_after),
                 "poisonChunksThatWouldPassGates": float(np.mean(would)) if would else None}

    # S3: a takeover at the end of a sample
    s3 = {}
    for t in ("0", "1", "2", "3"):
        n = sum(recs[x]["S3"][t]["n"] for x in targets)
        s3[t] = {"samples": int(n), "finalRule": sum(recs[x]["S3"][t]["final"] for x in targets) / max(n, 1),
                 "meanOnly": sum(recs[x]["S3"][t]["meanOnly"] for x in targets) / max(n, 1)}
    res["S3"] = s3
    res["perUser"] = {arm: {int(t): S[arm][t]["decAuc"] for t in targets} for arm in ARMS}

    f = lambda c: f"{c['meanDiff']:+.4f} [{c['ci95'][0]:+.4f}, {c['ci95'][1]:+.4f}] p {c['p']:.3f}, b better for {c['bBetter']}/{c['n']}"  # noqa: E731
    pct = lambda c: f"{c['meanDiff'] * 100:+.1f} pts [{c['ci95'][0] * 100:+.1f}, {c['ci95'][1] * 100:+.1f}] higher for {c['bBetter']}/{c['n']}"  # noqa: E731
    num = lambda c: f"{c['meanDiff']:+.3f} [{c['ci95'][0]:+.3f}, {c['ci95'][1]:+.3f}] higher for {c['bBetter']}/{c['n']}"  # noqa: E731
    verdict = "IMPROVES" if res["primary"]["improves"] else "HARMS" if res["primary"]["harms"] else "NO DETECTABLE DIFFERENCE"
    L = [f"EXPERIMENT AR2 (adaptive retraining with the sample rule as built, KeyRecs two sessions){'  [SMOKE TEST - NOT A RESULT]' if a.smoke else ''}",
         f"{len(targets)} targets (not eligible {len(res['notEligible'])}); decisions = 20-window packets; score = packet mean", "",
         f"PRIMARY  B - A, per-user AUC of 20-window decisions on session-2 test: {f(prim)}",
         f"         -> {verdict}; SE {prim['se']:.4f}, MDE80 {prim['mde80']:.4f}"]
    for k in [f"{x}-{y}" for x, y in pairs if f"{x}-{y}" != "B-A"]:
        L.append(f"  {k}: {f(res['decAuc'][k])}")
    L.append("")
    for arm in ARMS:
        r = rep[arm]
        L.append(f"  {arm:<4} per-user AUC {res['perUserDecisionAucMean'][arm]:.4f} | live rule FRR {res['frr']['mean'][arm] * 100:.1f}% "
                 f"FAR {res['far']['mean'][arm] * 100:.1f}% (per-user means) | pooled FRR {r['liveRulePooled']['frr'] * 100:.1f}% FAR "
                 f"{r['liveRulePooled']['far'] * 100:.1f}% | genuine locks per 100 test windows {res['locksPer100']['mean'][arm]:.2f} | "
                 f"pooled EER {r['decisionPooled']['eer'] * 100:.1f}% | window EER mean {r['windowEerMean'] * 100:.1f}%")
    for k in ("frr", "far", "locksPer100"):
        L.append(f"  {k} diffs vs A (lower is better): " + "; ".join(f"{x} {pct(c) if k != 'locksPer100' else num(c)}" for x, c in res[k]["diff"].items()))
    L.append("")
    for arm in VARS:
        d = adapt[arm]
        L.append(f"  {arm:<4} adaptation: {d['daysAccepted']}/{d['daysTotal']} days accepted ({d['acceptedShare'] * 100:.0f}%), "
                 f"per user mean {d['acceptedPerUserMean']:.1f}; users with a retrain {d['usersWithRetrain']}/{len(targets)}; "
                 f"retrains {d['retrainsTotal']}; first retrain after day {d['firstRetrainDayMedian']} (median); reasons {d['reasons']}")
    L.append(f"  days per user (median) {adapt['daysPerUserMedian']}; training time median {adapt['trainingSecondsMedian']:.1f} s")
    rp = res["reproducesARsA"]
    L.append(f"  A reproduces AR's A: {rp['targetsCompared']} targets compared, max |difference| in per-user AUC {rp['maxAbsDifference']}")
    L.append("")
    for m in ("end", "any"):
        x = s1[m]
        L.append(f"S1 [{m}] rule on the enrolment model: genuine days pass {x['genuineDayPass'] * 100:.1f}% of {x['genuineDays']}; "
                 f"impostor chunks pass {x['impostorChunkPass'] * 100:.2f}% ({x['impostorChunksPassed']}/{x['impostorChunks']}), "
                 f"targets with any {x['targetsWithAnyImpostorPass']}; impostor reasons {x['impostorReasons']}")
    s2r = res["S2"]
    L.append(f"S2 forced poisoning ({s2r['targets']} targets): attacker decisions accepted {s2r['attackerAcceptedBefore'] * 100:.1f}% -> "
             f"{s2r['attackerAcceptedAfter'] * 100:.1f}% ({pct(s2r['attackerAcceptedDiff'])}); genuine FRR {s2r['genuineFrrA'] * 100:.1f}% -> "
             f"{s2r['genuineFrrAfterPoison'] * 100:.1f}%; poison chunks that would have passed the gates: "
             f"{(s2r['poisonChunksThatWouldPassGates'] or 0) * 100:.1f}%")
    L.append("S3 takeover at the end (samples accepted by the score checks): " + "; ".join(
        f"t={t}: rule {s3[t]['finalRule'] * 100:.1f}%, mean only {s3[t]['meanOnly'] * 100:.1f}% (n {s3[t]['samples']})" for t in s3))
    txt = os.path.join(folder, "ar2_result.txt")
    open(txt + ".tmp", "w").write("\n".join(L) + "\n")
    os.replace(txt + ".tmp", txt)
    AC.write_json(out_json, res, indent=1)
    print("\n".join(L))


if __name__ == "__main__":
    main()
