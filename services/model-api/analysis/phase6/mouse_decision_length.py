"""The mouse decision length, in the same form as the paper's typing packet table (owner, 21 Oct 2026: "can we make the
same table as for keystroke and test several settings?").

Protocol L stage D's stored F2 scores (the deployed head type; 19 development users, base-80 network, 440-window
enrolment; the source of the paper's Table 6). The threshold stays the deployed one, the 20th percentile of each user's
leave-one-sample-out scores. The decision covers N windows, and the passkey is asked when at least K = ceil(0.55 N) of
them are low, the deployed share (33 of 60). N = 15, 33 and 60 windows, about 5, 10 and 17 s of movement, as in
eval_decision_level. FAR / FRR come from step-disjoint N-window decisions pooled over users (analyze_l.deployed_point).
The per-user AUC and the pooled EER are stage D's own, from stage_D.json.

    python analysis/phase6/mouse_decision_length.py     # artifacts/phase6/mouse_decision_length.json / .txt
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase2")))
import analyze_l as A  # noqa: E402
import eval_decision_level as E  # noqa: E402

OUT = "/app/artifacts/phase6"


def rates(vs, targets, n, k):
    far, frr = [], []
    for U in vs.values():
        g_rej = g_n = i_acc = i_n = 0
        for u in targets:
            t = U[u]["tau"]
            for b in E.blocks(U[u]["genuine"], n):
                g_n += 1; g_rej += int((b < t).sum() >= k)
            for r in U[u]["runs"].values():
                for b in E.blocks(r, n):
                    i_n += 1; i_acc += int((b < t).sum() < k)
        far.append(i_acc / max(i_n, 1)); frr.append(g_rej / max(g_n, 1))
    return float(np.mean(far)), float(np.mean(frr))


def main():
    folder, path, d, hashes, V, code = A.load(False, None)
    targets = list(d["targets"])
    sd = json.load(open(os.path.join(folder, "stage_D.json")))
    rows = []
    for n in (15, 33, 60):
        k = math.ceil(0.55 * n)
        far, frr = rates(V["F2"], targets, n, k)
        L = sd["lengths"][str(n)]
        rows.append({"windows": n, "votesNeeded": k, "seconds": L["seconds"], "far": far, "frr": frr,
                     "pooledEer": L["pooled"]["F2"]["pct"]["eer"], "perUserAuc": L["meanPerUserAuc"]["F2"]})
    res = {"source": path, "users": len(targets), "threshold": "20th percentile of leave-one-sample-out scores",
           "rule": "passkey when at least ceil(0.55 N) of the last N windows are low", "rows": rows}
    with open(os.path.join(OUT, "mouse_decision_length.json"), "w") as f:
        json.dump(res, f, indent=1)
    lines = [f"Mouse decision length, {len(targets)} users (stage D, F2), threshold = 20th percentile"]
    for r in rows:
        lines.append(f"{r['windows']:>3} windows ({r['votesNeeded']} low, about {r['seconds']:.0f} s): FAR {r['far']*100:.1f}%  "
                     f"FRR {r['frr']*100:.1f}%  EER {r['pooledEer']*100:.1f}%  per-user AUC {r['perUserAuc']:.3f}")
    txt = "\n".join(lines)
    open(os.path.join(OUT, "mouse_decision_length.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
