"""
Experiment G analysis (artifacts/repr_arch_study/PREREGISTRATION_G.md): the extension's on-device
personalisation (parts/G_device.json, produced by extension/scripts/eval_ondevice_g.js) against the
deployed server pipeline measured in Experiment F (parts/F_new.json), same users, windows and halves.

    python repr_device_g_analyze.py      # writes analysis_G.json
"""
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import repr_arch_analyze as RA   # noqa: E402
import repr_enrol_analyze as RE  # noqa: E402

ROOT = "/app/artifacts/repr_arch_study"
DELTA = 0.02


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    sha = hashlib.sha256(open(os.path.join(ROOT, "PREREGISTRATION_G.md"), "rb").read()).hexdigest()
    G = json.load(open(os.path.join(ROOT, "parts", "G_device.json")))
    F = json.load(open(os.path.join(ROOT, "parts", "F_new.json")))
    if G["preregistrationGSha256"] != sha:
        sys.exit("REFUSING: G results under a different pre-registration")
    if len(G["seeds"]) != 3:
        sys.exit("REFUSING: need 3 seeds")
    b = str(G["budget"])

    # Window level, test half: device averaged over its 3 seeds per user; server single run (F).
    dev = {}
    for d in G["seeds"]:
        for r in d["perUser"]:
            wm = RA.window_metrics(RA.halves(r["M"][b])[1])
            for k, v in wm.items():
                dev.setdefault(r["participant"], {}).setdefault(k, []).append(v)
    dev = {u: {k: float(np.mean(v)) for k, v in m.items()} for u, m in dev.items()}
    srv = {r["participant"]: RA.window_metrics(RA.halves(r)[1]) for r in F["perUser"]}
    users = sorted(set(dev) & set(srv))
    out = {"preregistrationGSha256": sha, "users": len(users), "code": G["code"],
           "perUser": {u: {"server": srv[u], "device": dev[u]} for u in users}}
    for name, per in (("server", srv), ("device", dev)):
        f = lambda k: [per[u][k] for u in users]
        out[name] = {"auc": float(np.mean(f("auc"))), "aucMedian": float(np.median(f("auc"))),
                     "eer": float(np.mean(f("eer"))), "tar01": float(np.mean(f("tar01")))}
        print(f"{name:>6}: AUC mean {out[name]['auc']:.3f} median {out[name]['aucMedian']:.3f} | "
              f"EER {out[name]['eer']*100:.1f}% | TAR@FAR1% {out[name]['tar01']*100:.1f}%")

    diffs = {}
    for k in ("auc", "tar01", "eer"):
        diffs[k] = RA.boot([srv[u][k] for u in users], [dev[u][k] for u in users])
        r = diffs[k]
        print(f"DEVICE - SERVER {k:>5}: {r['meanDiff']:+.4f} [{r['ci95'][0]:+.4f}, {r['ci95'][1]:+.4f}] "
              f"p {r['p']:.4f} (device higher for {r['bBetter']}/{r['n']} users)")
    out["diff"] = diffs
    non_inferior = diffs["auc"]["ci95"][0] >= -DELTA
    tar_lower = diffs["tar01"]["meanDiff"] < 0 and diffs["tar01"]["p"] < 0.05
    out["G1"] = {"aucNonInferior": bool(non_inferior), "tar01SignificantlyLower": bool(tar_lower),
                 "noMeasurableCost": bool(non_inferior and not tar_lower)}
    print(f"\nG-1: AUC non-inferior (CI lower >= -{DELTA}): {non_inferior} | TAR@FAR1% significantly lower: "
          f"{tar_lower} -> {'NO MEASURABLE COST' if out['G1']['noMeasurableCost'] else 'COST REPORTED (price of on-device training)'}")

    # G-2: the device's own operating point, C-3 procedure pooled over (target, seed), F's budget order.
    ops = {}
    for bud in (0.01, 0.02, 0.05):
        op = RE.pooled_op(G["seeds"], "M", int(b), bud)
        ops[str(bud)] = op
        if op:
            print(f"  FL budget {bud:.0%}: q={op['q']:>2} {op['rule']:<6} n={op['n']:>2} k={op['k']} | test FL median "
                  f"{op['testFLmedian']*100:4.1f}% mean {op['testFLmean']*100:4.1f}% | capture median "
                  f"{op['testCaptureMedian']*100:4.1f}% mean {op['testCaptureMean']*100:4.1f}% | interrupted "
                  f"{op['interruptedShare']*100:3.0f}% | never detected {op['neverDetectedShare']*100:.1f}% | "
                  f"latency {op['latencySecondsMedian'] or float('nan'):.1f} s")
        else:
            print(f"  FL budget {bud:.0%}: none meets it on calibration")
    out["ops"] = ops
    chosen = next((ops[k] for k in ("0.01", "0.02", "0.05") if ops[k]), None)
    out["extensionOperatingPoint"] = chosen
    print(f"\nG-2 EXTENSION OPERATING POINT: {chosen and {k: chosen[k] for k in ('q', 'rule', 'n', 'k', 'flBudget')}}")
    Fa = json.load(open(os.path.join(ROOT, "analysis_F.json")))
    out["serverOperatingPoint"] = Fa.get("deployedOperatingPoint")
    json.dump(out, open(os.path.join(ROOT, "analysis_G.json"), "w"), indent=1)
    print("wrote analysis_G.json")


if __name__ == "__main__":
    main()
