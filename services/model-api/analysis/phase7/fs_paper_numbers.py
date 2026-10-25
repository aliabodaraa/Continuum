"""The mouse numbers of the paper and thesis recomputed for the network trained with SapiMouse's settings (owner,
2026-10-22: "adopt SapiMouse's settings", after experiment FS, docs/recovery/RESULTS_FS.md).

The source is experiment FS's stage D units (artifacts/phase7/fs/scores_FS.json): the base-80 network trained with
SapiMouse's recipe, protocol L stage D's F2 path, the 19 development users. Every number is computed with the same code
as the paper's current ones, and the stored F2 units (scores_D.json) go through the same lines as a check. They must
reproduce paper Table 6 (0.942 / 0.964 / 0.969, FAR 14.2 / 12.9 / 10.8%, FRR 15.1 / 10.0 / 10.0%, EER 13.3 / 9.1 /
9.6%), the single-window mean AUC 0.870 and EER 19.9%, and the live loop of mouse_live_decision_length.py.

- Table 6 rows: N = 15, 33, 60 windows, the passkey at K = ceil(0.55 N) low windows, FAR/FRR on step-disjoint decisions
  pooled over users (mouse_decision_length.rates), pooled EER and per-user AUC of the N-window decisions (pct
  statistic, analyze_l.per_user_auc / pooled_avg, as stage_D.json).
- Single windows: analyze_l.window_level (mean over users).
- Live loop: mouse_live_decision_length.live (a check every 6 windows, the buffer emptied after a request).

    python services/model-api/analysis/phase7/fs_paper_numbers.py   # artifacts/phase7/fs_paper_numbers.json / .txt
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase2")))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase6")))
import l_common as LC  # noqa: E402
import analyze_l as A  # noqa: E402
import mouse_decision_length as MDL  # noqa: E402
import mouse_live_decision_length as MLD  # noqa: E402

OUT = "/app/artifacts/phase7"
LENGTHS = (15, 33, 60)
# Paper Table 6 / thesis Table 15 rows since 23 Oct 2026 (owner: "apply"): the movement of one, three and five
# SapiMouse blocks of 128 events, (40 + 10 N) steps = 128 B, so N = 9, 34 and 60. LENGTHS stays the check against the
# stored F2 numbers of the earlier table.
TABLE_LENGTHS = (9, 34, 60)


def numbers(V, targets, lengths=LENGTHS):
    s = next(iter(V))
    rows = []
    for n in lengths:
        k = math.ceil(0.55 * n)
        far, frr = MDL.rates(V[s], targets, n, k)
        val, _pv, decs = A.per_user_auc(V, targets, n)
        eer = A.pooled_avg(decs[s], targets)["pct"]["eer"]
        lv = [MLD.live(U, targets, n, k) for U in V[s].values()]
        rows.append({"windows": n, "lowNeeded": k, "far": far, "frr": frr, "pooledEer": float(eer),
                     "perUserAuc": float(np.mean([val[s][u] for u in targets])),
                     "live": {key: float(np.mean([x[key] for x in lv if x[key] is not None])) for key in lv[0]}})
    wl = A.window_level(V, targets)[s]["mean"]
    return {"rows": rows, "singleWindow": {"auc": wl["auc"], "eer": wl["eer"]}}


def main():
    folder, path, d, hashes, V, code = A.load(False, None)
    targets = list(d["targets"])
    fs_units = LC.units_from_json(json.load(open(os.path.join(OUT, "fs", "scores_FS.json")))["units"])
    for u in fs_units.values():
        u["tau"] = float(np.percentile(u["ref"], LC.Q_TAU))
    res = {"F2_check": numbers({"F2": V["F2"]}, targets), "FS": numbers({"FS": {"fs": fs_units}}, targets),
           "FS_table": numbers({"FS": {"fs": fs_units}}, targets, TABLE_LENGTHS),
           "users": len(targets)}
    json.dump(res, open(os.path.join(OUT, "fs_paper_numbers.json"), "w"), indent=1)
    L = [f"Mouse numbers, {len(targets)} development users, stage D path (F2 = current recipe as a check, FS = SapiMouse's recipe)"]
    for name in ("F2_check", "FS", "FS_table"):
        r = res[name]
        for row in r["rows"]:
            lv = row["live"]
            L.append(f"  {name:<8} N={row['windows']:>2} ({row['lowNeeded']} low): FAR {row['far'] * 100:5.1f}%  FRR {row['frr'] * 100:5.1f}%  "
                     f"EER {row['pooledEer'] * 100:5.1f}%  per-user AUC {row['perUserAuc']:.4f} | live {lv['promptsPerMinMean']:.2f}/min, "
                     f"never asked {lv['usersNeverPrompted'] * 100:.0f}%, caught {lv['impostorRunsCaught'] * 100:.1f}%, "
                     f"time to catch {lv['timeToCatchMeanS']:.1f} s")
        L.append(f"  {name:<8} single window: mean AUC {r['singleWindow']['auc']:.3f}, mean EER {r['singleWindow']['eer'] * 100:.1f}%")
    txt = "\n".join(L)
    open(os.path.join(OUT, "fs_paper_numbers.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
