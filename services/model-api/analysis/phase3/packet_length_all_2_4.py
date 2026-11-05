"""Packet lengths 2 and 4 added to the thesis's packet-length table (Table 10), by the method of its rows.

The table's rows for 6, 10 and 20 windows come from packet_length_a200.py run on the all-impostors amendment
(artifacts/phase8_allimp/table4_all.json: the deployed arm A200 of experiment KS scored against all 98 other
participants, artifacts/phase7/im/parts). This runs the same code on the same parts for the 2- and 4-window
packets the console offers since 2026-11-05, with 6, 10 and 20 alongside so the run can be checked against
the stored results. Same decision definition: step-disjoint blocks of n windows (gap 4), block score = its
mean; a block is suspicious at the live rule when at least half of its windows score below 0.50 (1 of 2,
2 of 4); pooled EER and AUC, the mean over users of the per-user AUC, TAR at FAR = 1%.

    docker run --rm -v "<continuum>:/app" -w /app continuum/model-api:local \
        python services/model-api/analysis/phase3/packet_length_all_2_4.py
Output: artifacts/phase8_allimp/table4_all_2_4.json (the stored table4_all.json is never written).
"""
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
sys.path.insert(0, HERE)
import packet_length_a200 as P  # noqa: E402

LENGTHS = (2, 4, 6, 10, 20)
PARTS = os.path.join(ROOT, "artifacts", "phase7", "im", "parts")
STORED = os.path.join(ROOT, "artifacts", "phase8_allimp", "table4_all.json")
OUT = os.path.join(ROOT, "artifacts", "phase8_allimp", "table4_all_2_4.json")


def load_all_impostors():
    users = []
    for f in sorted(glob.glob(os.path.join(PARTS, "*.json"))):
        x = json.load(open(f, encoding="utf-8"))
        if x.get("eligible"):
            users.append((x["participant"], np.asarray(x["genuine"], float), [np.asarray(v, float) for v in x["runs"].values()]))
    return users


def main():
    users = load_all_impostors()
    result = {"source": "artifacts/phase7/im/parts (KS A200 models, all 98 other participants)",
              "method": "packet_length_a200.py (blocks of n windows, gap 4, block mean; live rule: at least half the windows below 0.50)",
              "lengths": {}}
    stored = json.load(open(STORED, encoding="utf-8"))["lengths"] if os.path.exists(STORED) else {}
    for n in LENGTHS:
        s = P.summarise(P.decisions(users, n))
        # keystrokes until the first verdict: n + 1 windows of 50 steps sliding by 10, plus one key for the first step
        s["firstVerdictKeystrokes"] = 50 + 10 * n + 1
        result["lengths"][str(n)] = s
        print("n=%2d  FAR %.1f%%  FRR %.1f%%  EER %.2f%%  pooled AUC %.3f  per-user AUC %.4f  TAR@FAR1%% %.1f%%  (users %d, first verdict at %d keystrokes)" % (
            n, 100 * s["far"], 100 * s["frr"], 100 * s["eer"], s["auc"], s["aucPerUserMean"], 100 * s["tarAtFar1"], s["users"], s["firstVerdictKeystrokes"]))
        if str(n) in stored:
            same = all(abs(float(stored[str(n)][k]) - float(s[k])) < 1e-9 for k in ("far", "frr", "eer", "auc", "aucPerUserMean", "tarAtFar1"))
            print("      stored table4_all.json row:", "identical" if same else "DIFFERS")
    json.dump(result, open(OUT, "w", encoding="utf-8"), indent=2)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
