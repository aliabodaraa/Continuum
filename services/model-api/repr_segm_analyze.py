"""
Mechanical application of artifacts/repr_arch_study/PREREGISTRATION_E.md.

Per user and arm: AUC at five matched observation lengths (k = 1..5 blocks of 128 steps;
windows k_w = round((128k - 50)/10) + 1 = 9, 22, 34, 47, 60), scores averaged within
non-overlapping groups; primary = mean of the five AUCs, averaged over seeds.
E-1 verifier on K: adopt BIN only if K-BIN - K-OC > 0, Holm p < 0.05, else copy OC.
E-2 segmentation with that verifier: adopt W only if W - K > 0, Holm p < 0.05, else copy K.

    python repr_segm_analyze.py
"""
import glob
import hashlib
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import repr_arch_analyze as RA                                     # noqa: E402
from keystroke_user_sweep import auc_of, eer_of                    # noqa: E402

ROOT = "/app/artifacts/repr_arch_study"
KB = [1, 2, 3, 4, 5]
KW = [int(round((128 * k - 50) / 10)) + 1 for k in KB]            # 9, 22, 34, 47, 60
ARMS = ["K-OC", "K-BIN", "W-OC", "W-BIN"]


def groups(seq, k, stride):
    s = np.asarray(seq, float)
    return np.array([s[i:i + k].mean() for i in range(0, len(s) - k + 1, stride)])


def per_len(unit_scores, arm, j):
    k = KB[j] if arm.startswith("K") else KW[j]
    stride = k if arm.startswith("K") else k + 4
    g = groups(unit_scores["_genuineScores"], k, stride)
    runs = [groups(v, k, stride) for v in unit_scores["_impostorRuns"].values()]
    runs = [r for r in runs if len(r)]
    if len(g) < 2 or not runs:
        return np.nan, np.nan
    i = np.concatenate(runs)
    return float(auc_of(g, i)), float(eer_of(g, i)[0])


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    sha = hashlib.sha256(open(os.path.join(ROOT, "PREREGISTRATION_E.md"), "rb").read()).hexdigest()
    docs = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(ROOT, "parts", "E_s*.json")))]
    if len(docs) != 3:
        sys.exit(f"REFUSING: need 3 seeds, found {len(docs)}")
    if any(d["preregistrationESha256"] != sha for d in docs):
        sys.exit("REFUSING: results produced under a different Experiment E pre-registration")

    per = {}          # arm -> user -> {"prim": [...seeds], "auc": [[5 per seed]], "eer5": [...]}
    for d in docs:
        for r in d["perUser"]:
            for arm in ARMS:
                res = [per_len(r[arm], arm, j) for j in range(5)]
                aucs = [a for a, _ in res]
                e = per.setdefault(arm, {}).setdefault(r["participant"], {"prim": [], "auc": [], "eer5": []})
                e["prim"].append(float(np.nanmean(aucs))); e["auc"].append(aucs); e["eer5"].append(res[4][1])
    users = sorted(set.intersection(*[set(per[a]) for a in ARMS]))
    P = {a: {u: float(np.mean(per[a][u]["prim"])) for u in users} for a in ARMS}
    vec = lambda a: [P[a][u] for u in users]

    print(f"pre-registration E {sha[:12]} verified | {len(users)} users | lengths {KB} blocks = {KW} windows")
    print(f"\n{'arm':<7}{'primary AUC':>13}{'median':>8}" + "".join(f"{f'@{k}b':>8}" for k in KB) + f"{'EER@5b':>9}")
    for a in ARMS:
        byk = np.nanmean([np.nanmean(per[a][u]["auc"], axis=0) for u in users], axis=0)
        eer5 = np.nanmean([np.nanmean(per[a][u]["eer5"]) for u in users])
        print(f"{a:<7}{np.mean(vec(a)):>13.3f}{np.median(vec(a)):>8.3f}" + "".join(f"{x:>8.3f}" for x in byk)
              + f"{eer5*100:>8.1f}%")

    e1 = RA.boot(vec("K-OC"), vec("K-BIN"))
    e2_raw = {v: RA.boot(vec(f"K-{v}"), vec(f"W-{v}")) for v in ("OC", "BIN")}
    # Holm across the two planned comparisons {E-1, E-2}; E-2 uses the verifier E-1 selects.
    # If E-1 adopts BIN under the pairing with E-2(BIN), that pairing is the family; otherwise
    # the verifier stays OC and the family is {E-1, E-2(OC)}.
    adjB = RA.holm([e1["p"], e2_raw["BIN"]["p"]])
    if e1["meanDiff"] > 0 and adjB[0] < 0.05:
        v_star, adj = "BIN", adjB
    else:
        v_star, adj = "OC", RA.holm([e1["p"], e2_raw["OC"]["p"]])
    e1["pHolm"] = adj[0]
    e2 = e2_raw[v_star]
    e2["pHolm"] = adj[1]
    seg_star = "W" if (e2["meanDiff"] > 0 and e2["pHolm"] < 0.05) else "K"
    print(f"\nE-1 verifier on blocks: K-BIN - K-OC = {e1['meanDiff']:+.4f} "
          f"[{e1['ci95'][0]:+.4f}, {e1['ci95'][1]:+.4f}] p_holm {e1['pHolm']:.4f} -> "
          f"{'adopt BIN (change)' if v_star == 'BIN' else 'copy OC (paper)'}")
    print(f"E-2 segmentation with {v_star}: W - K = {e2['meanDiff']:+.4f} "
          f"[{e2['ci95'][0]:+.4f}, {e2['ci95'][1]:+.4f}] p_holm {e2['pHolm']:.4f} -> "
          f"{'adopt W (change)' if seg_star == 'W' else 'copy K (paper)'}")
    other = "OC" if v_star == "BIN" else "BIN"
    x = e2_raw[other]
    print(f"   (reported only) W - K with {other}: {x['meanDiff']:+.4f} p {x['p']:.4f}")
    print(f"\nDECISION (pre-registered): segmentation {seg_star}, verifier {v_star} -> {seg_star}-{v_star}")

    # EXPLORATORY, not a decision test: the pre-registered order compares verifiers on blocks
    # only. On windows, the comparison the final recommendation relies on (and says so).
    xw = RA.boot(vec("W-OC"), vec("W-BIN"))
    eer5 = {a: [float(np.nanmean(per[a][u]["eer5"])) for u in users] for a in ("W-OC", "W-BIN")}
    xe = RA.boot(eer5["W-OC"], eer5["W-BIN"])
    print("\n" + f"EXPLORATORY (not a decision test) on windows: W-BIN - W-OC = {xw['meanDiff']:+.4f} "
          f"[{xw['ci95'][0]:+.4f}, {xw['ci95'][1]:+.4f}] p {xw['p']:.4f}, BIN higher for {xw['bBetter']}/{xw['n']}; "
          f"EER at 5 block-lengths {xe['meanDiff']*100:+.1f} pp")

    out = {"preregistrationESha256": sha, "users": users, "lengthsBlocks": KB, "lengthsWindows": KW,
           "primary": {a: {"mean": float(np.mean(vec(a))), "median": float(np.median(vec(a)))} for a in ARMS},
           "E1": e1, "E2": e2, "E2other": x, "adopted": f"{seg_star}-{v_star}",
           "exploratory": {"note": "not a pre-registered decision test",
                           "W-BIN_minus_W-OC_primaryAUC": xw, "W-BIN_minus_W-OC_EER_at5blocks": xe}}
    with open(os.path.join(ROOT, "analysis_E.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(f"wrote {os.path.join(ROOT, 'analysis_E.json')}")


if __name__ == "__main__":
    main()
