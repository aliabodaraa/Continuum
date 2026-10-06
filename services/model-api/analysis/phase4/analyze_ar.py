"""Experiment AR analysis (PREREGISTRATION_AR.md section 6).

    python analyze_ar.py     # artifacts/phase4/parts/*.json -> artifacts/phase4/ar_result.json, ar_result.txt

Decisions are KS's: step-disjoint blocks of 20 windows (eval_decision_level.blocks, gap 4) of one
contiguous stream (the target's session-2 test half, or one impostor's first 150 windows); the decision
score is the block's mean window probability; the live rule (>= 10 of 20 below 0.50) is one operating point.

Primary: B - A in per-user AUC of 20-window decisions, paired bootstrap over targets (10,000, seed 17).
B improves on A if the lower 95% bound > 0, harms if the upper bound < 0; otherwise no detectable
difference (the SE and the minimum detectable effect at 80% power are reported). Everything else is
secondary and descriptive, with 95% intervals.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ar_common as AC  # noqa: E402
import eval_decision_level as E  # noqa: E402
import p1lib as P  # noqa: E402

ARMS = AC.ARMS


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
    hashes = {} if a.smoke else AC.verify_frozen()
    folder = AC.SMOKE if a.smoke else AC.STUDY
    out_json = os.path.join(folder, "ar_result.json")
    if not a.smoke and os.path.exists(out_json):
        raise SystemExit(f"{out_json} exists already; AR is analysed once")
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

    res = {**hashes, "experiment": "AR", "smokeTest": a.smoke, "nTargets": len(targets),
           "notEligible": [t for t in sorted(recs) if not recs[t]["eligible"]],
           "excluded": [t for t in elig if t not in targets]}
    res["perUserDecisionAucMean"] = {arm: float(np.nanmean(col(arm, "decAuc"))) for arm in ARMS}
    pairs = (("B", "A"), ("C", "A"), ("D", "A"), ("C", "B"), ("D", "B"), ("R", "A"))
    res["decAuc"] = {f"{x}-{y}": boot(col(y, "decAuc"), col(x, "decAuc")) for x, y in pairs}
    prim = res["decAuc"]["B-A"]
    res["primary"] = {**prim, "improves": bool(prim["ci95"][0] > 0), "harms": bool(prim["ci95"][1] < 0)}
    for k in ("frr", "far", "locksPer100"):
        res[k] = {"mean": {arm: float(np.nanmean(col(arm, k))) for arm in ARMS},
                  "diff": {f"{x}-{y}": boot(col(y, k), col(x, k)) for x, y in pairs[:3] + pairs[5:]}}
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

    # the adaptation itself
    adapt = {}
    for arm in ("B", "C"):
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

    # S1: who passes the gates on the enrolment model
    gp = [d["accepted"] for t in targets for d in recs[t]["S1"]["genuineDays"]]
    ip = [v["accepted"] for t in targets for v in recs[t]["S1"]["impostorChunks"].values()]
    ireasons = {}
    for t in targets:
        for v in recs[t]["S1"]["impostorChunks"].values():
            ireasons[v["reason"]] = ireasons.get(v["reason"], 0) + 1
    per_t = [np.mean([v["accepted"] for v in recs[t]["S1"]["impostorChunks"].values()]) for t in targets
             if recs[t]["S1"]["impostorChunks"]]
    res["S1"] = {"genuineDayPass": float(np.mean(gp)), "genuineDays": len(gp),
                 "impostorChunkPass": float(np.mean(ip)), "impostorChunks": len(ip), "impostorChunksPassed": int(sum(ip)),
                 "targetsWithAnyImpostorPass": int(sum(x > 0 for x in per_t)), "impostorReasons": ireasons}

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
    res["perUser"] = {arm: {int(t): S[arm][t]["decAuc"] for t in targets} for arm in ARMS}

    f = lambda c: f"{c['meanDiff']:+.4f} [{c['ci95'][0]:+.4f}, {c['ci95'][1]:+.4f}] p {c['p']:.3f}, b better for {c['bBetter']}/{c['n']}"  # noqa: E731
    pct = lambda c: f"{c['meanDiff'] * 100:+.1f} pts [{c['ci95'][0] * 100:+.1f}, {c['ci95'][1] * 100:+.1f}] higher for {c['bBetter']}/{c['n']}"  # noqa: E731
    num = lambda c: f"{c['meanDiff']:+.3f} [{c['ci95'][0]:+.3f}, {c['ci95'][1]:+.3f}] higher for {c['bBetter']}/{c['n']}"  # noqa: E731
    verdict = "IMPROVES" if res["primary"]["improves"] else "HARMS" if res["primary"]["harms"] else "NO DETECTABLE DIFFERENCE"
    L = [f"EXPERIMENT AR (adaptive retraining, KeyRecs two sessions){'  [SMOKE TEST - NOT A RESULT]' if a.smoke else ''}",
         f"{len(targets)} targets (not eligible {len(res['notEligible'])}); decisions = 20-window packets; score = packet mean", "",
         f"PRIMARY  B - A, per-user AUC of 20-window decisions on session-2 test: {f(prim)}",
         f"         -> {verdict}; SE {prim['se']:.4f}, MDE80 {prim['mde80']:.4f}"]
    for k in ("C-A", "D-A", "C-B", "D-B", "R-A"):
        L.append(f"  {k}: {f(res['decAuc'][k])}")
    L.append("")
    for arm in ARMS:
        r = rep[arm]
        L.append(f"  {arm}  per-user AUC {res['perUserDecisionAucMean'][arm]:.4f} | live rule FRR {res['frr']['mean'][arm] * 100:.1f}% "
                 f"FAR {res['far']['mean'][arm] * 100:.1f}% (per-user means) | genuine locks per 100 test windows "
                 f"{res['locksPer100']['mean'][arm]:.2f} | pooled EER {r['decisionPooled']['eer'] * 100:.1f}% | window EER mean "
                 f"{r['windowEerMean'] * 100:.1f}%")
    for k in ("frr", "far", "locksPer100"):
        L.append(f"  {k} diffs (lower is better): " + "; ".join(f"{x} {pct(c) if k != 'locksPer100' else num(c)}" for x, c in res[k]["diff"].items()))
    L.append("")
    for arm in ("B", "C"):
        d = adapt[arm]
        L.append(f"  {arm} adaptation: {d['daysAccepted']}/{d['daysTotal']} days accepted ({d['acceptedShare'] * 100:.0f}%), "
                 f"per user mean {d['acceptedPerUserMean']:.1f}; users with a retrain {d['usersWithRetrain']}/{len(targets)}; "
                 f"first retrain after day {d['firstRetrainDayMedian']} (median); reasons {d['reasons']}")
    L.append(f"  days per user (median) {adapt['daysPerUserMedian']}; training time median {adapt['trainingSecondsMedian']:.1f} s")
    s1, s2 = res["S1"], res["S2"]
    L += ["", f"S1 gates on the enrolment model: genuine days pass {s1['genuineDayPass'] * 100:.1f}% of {s1['genuineDays']}; "
              f"impostor chunks pass {s1['impostorChunkPass'] * 100:.2f}% ({s1['impostorChunksPassed']}/{s1['impostorChunks']}), "
              f"targets with any {s1['targetsWithAnyImpostorPass']}; impostor reasons {s1['impostorReasons']}",
          f"S2 forced poisoning ({s2['targets']} targets): attacker decisions accepted {s2['attackerAcceptedBefore'] * 100:.1f}% -> "
          f"{s2['attackerAcceptedAfter'] * 100:.1f}% ({pct(s2['attackerAcceptedDiff'])}); genuine FRR {s2['genuineFrrA'] * 100:.1f}% -> "
          f"{s2['genuineFrrAfterPoison'] * 100:.1f}%; poison chunks that would have passed the gates: "
          f"{(s2['poisonChunksThatWouldPassGates'] or 0) * 100:.1f}%"]
    txt = os.path.join(folder, "ar_result.txt")
    open(txt + ".tmp", "w").write("\n".join(L) + "\n")
    os.replace(txt + ".tmp", txt)
    AC.write_json(out_json, res, indent=1)
    print("\n".join(L))


if __name__ == "__main__":
    main()
