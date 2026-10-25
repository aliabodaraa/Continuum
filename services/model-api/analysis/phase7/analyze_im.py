"""Experiment IM analysis (artifacts/phase7/PREREGISTRATION_IM.md).

    python services/model-api/analysis/phase7/analyze_im.py   # artifacts/phase7/im/parts -> im_result.json, im_result.txt

The same models are scored against three impostor sets: S40 (participants 40 to 79, the published set), ALL (every
other participant) and NEW (the ones S40 leaves out). Decisions and metrics are analyze_ks.per_target's; the primary
endpoint is the mean per-user AUC of 20-window decisions, ALL minus S40, with analyze_ks.boot (10,000, seed 17).
Reading rule: robust if |ALL - S40| < 0.01 in mean per-user AUC and the live-rule FAR differs by less than 2 points.
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "phase3"))
sys.path.insert(0, HERE)
import ks_common as KC  # noqa: E402
import analyze_ks as AK  # noqa: E402
import eval_decision_level as E  # noqa: E402
import run_im as RI  # noqa: E402

S40 = set(range(40, 80))


def subset(r, keep):
    return {**r, "runs": {p: v for p, v in r["runs"].items() if keep(int(p))}}


def main():
    stamp = RI.verify_frozen()
    out_json = os.path.join(RI.STUDY, "im_result.json")
    if os.path.exists(out_json):
        raise SystemExit(f"{out_json} exists already; IM is analysed once")
    recs = {}
    for f in sorted(os.listdir(RI.PARTS)):
        r = json.load(open(os.path.join(RI.PARTS, f)))
        for k, v in stamp.items():
            if r.get(k) != v:
                raise SystemExit(f"{f}: produced under another {k}")
        recs[r["participant"]] = r
    ids = sorted(recs)
    if len(ids) != 99:
        raise SystemExit(f"{len(ids)} owners, expected 99")
    ids_all = [int(i) for i in ids]
    sets = {"S40": lambda t: (lambda p: p in S40 and p != t),
            "ALL": lambda t: (lambda p: p != t),
            "NEW": lambda t: (lambda p: p not in S40 and p != t)}

    # reproduction check against the published KS A200 parts
    maxdiff_g = maxdiff_r = 0.0
    for t in ids:
        if not recs[t]["eligible"]:
            continue
        ks = json.load(open(os.path.join(KC.STUDY, "parts", "A200", f"{t}.json")))
        g1, g2 = np.asarray(recs[t]["genuine"]), np.asarray(ks["genuine"])
        maxdiff_g = max(maxdiff_g, float(np.abs(g1 - g2).max()) if len(g1) == len(g2) else float("inf"))
        for p, v in ks["runs"].items():
            a, b = np.asarray(recs[t]["runs"][p]), np.asarray(v)
            maxdiff_r = max(maxdiff_r, float(np.abs(a - b).max()) if len(a) == len(b) else float("inf"))

    elig = [t for t in ids if recs[t]["eligible"]]
    stats = {s: {t: AK.per_target(subset(recs[t], fn(t))) for t in elig} for s, fn in sets.items()}
    targets = [t for t in elig if all(stats[s][t]["nG"] and stats[s][t]["nI"] for s in sets)]
    val = {s: [stats[s][t]["decAuc"] for t in targets] for s in sets}
    rep = {}
    for s in sets:
        S = stats[s]
        gd = np.concatenate([S[t]["gDec"] for t in targets]); idd = np.concatenate([S[t]["iDec"] for t in targets])
        rep[s] = {"meanPerUserDecisionAuc": float(np.nanmean(val[s])),
                  "decisionPooled": {"eer": E.eer_fast(gd, idd), "auc": E.auc_fast(gd, idd)},
                  "liveRule": {"far": float(np.concatenate([S[t]["iAcc"] for t in targets]).mean()),
                               "frr": float(np.concatenate([S[t]["gRej"] for t in targets]).mean())},
                  "impostorPeoplePerOwner": float(np.mean([len(subset(recs[t], sets[s](t))["runs"]) for t in targets])),
                  "decisions": {"genuine": int(len(gd)), "impostor": int(len(idd))}}
    prim = AK.boot(val["S40"], val["ALL"])
    sec = AK.boot(val["S40"], val["NEW"])
    d_auc = rep["ALL"]["meanPerUserDecisionAuc"] - rep["S40"]["meanPerUserDecisionAuc"]
    d_far = rep["ALL"]["liveRule"]["far"] - rep["S40"]["liveRule"]["far"]
    robust = bool(abs(d_auc) < 0.01 and abs(d_far) < 0.02)
    res = {**stamp, "experiment": "IM", "nTargets": len(targets), "excluded": [int(t) for t in ids if t not in targets],
           "reproduction": {"maxAbsDiffGenuine": maxdiff_g, "maxAbsDiffS40Runs": maxdiff_r},
           "reported": rep, "primary": {"contrast": "ALL-S40", **prim}, "secondary": {"contrast": "NEW-S40", **sec},
           "reading": {"deltaMeanPerUserAuc": d_auc, "deltaLiveRuleFar": d_far, "robust": robust},
           "perUser": {s: dict(zip([int(t) for t in targets], val[s])) for s in sets}}
    f = lambda c: f"{c['meanDiff']:+.4f} [{c['ci95'][0]:+.4f}, {c['ci95'][1]:+.4f}], higher for {c['bBetter']}/{c['n']}"  # noqa: E731
    lines = ["EXPERIMENT IM (deployed typing recipe, KS arm A200, scored against every other KeyRecs participant)",
             f"{len(targets)} owners; decisions = 20-window blocks scored by their mean; live rule >= 10 of 20 below 0.50",
             f"reproduction of the KS A200 parts: max |diff| genuine {maxdiff_g:.2e}, S40 runs {maxdiff_r:.2e}", ""]
    for s in sets:
        r = rep[s]
        lines.append(f"  {s:3s} ({r['impostorPeoplePerOwner']:.1f} impostors/owner, {r['decisions']['impostor']} impostor decisions): "
                     f"per-user AUC {r['meanPerUserDecisionAuc']:.4f} | live rule FAR {r['liveRule']['far'] * 100:.1f}% "
                     f"FRR {r['liveRule']['frr'] * 100:.1f}% | pooled decision EER {r['decisionPooled']['eer'] * 100:.2f}%")
    lines += ["", f"PRIMARY  ALL - S40, per-user AUC: {f(prim)}", f"SECONDARY NEW - S40: {f(sec)}",
              f"READING  |dAUC| {abs(d_auc):.4f} (< 0.01?) and |dFAR| {abs(d_far) * 100:.2f} points (< 2?): "
              + ("ROBUST to the choice of impostors" if robust else "NOT robust: report ALL next to the published numbers")]
    txt = os.path.join(RI.STUDY, "im_result.txt")
    open(txt + ".tmp", "w").write("\n".join(lines) + "\n")
    os.replace(txt + ".tmp", txt)
    KC.write_json(out_json, res, indent=1)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
