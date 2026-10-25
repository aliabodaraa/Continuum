"""Lu et al.'s own decision rule on the DEPLOYED typing model (arm A200 of experiment KS), against the adopted rule.

Lu et al. (Computers & Security 96, 2020, Section 4.2, Figs 8-9 and Section 6) judge a packet of window probabilities and
flag an intruder when MORE than p of them are below 0.50. Their live test used a packet of L = 50 keystrokes and a
window of C = 30, giving L - C = 20 probabilities, with p = (L - C) x 15% = 3. Their paper has no six-window packet and no
majority vote. This script applies that share to the adopted 20-window packet (an intruder when at least 4 of 20 windows
are below 0.50) and compares it with the adopted rule (the passkey when at least 10 of 20 are below 0.50), with the
decision definition of paper Table 4 (`packet_length_a200.decisions`): step-disjoint blocks of 20 windows
(`eval_decision_level.blocks`, gap 4), 99 KeyRecs owners, impostors = participants 40-79.
Check: the adopted rule reproduces Table 4's 20-window row (FAR 11.9%, FRR 3.3%).

    python services/model-api/analysis/phase3/lu_vote_rule.py
Output: artifacts/phase3/lu_vote_rule.json
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import packet_length_a200 as PL  # noqa: E402

E = PL.E
N = 20
THRESHOLD = 0.50
RULES = {"lu": {"label": "Lu et al.: more than 3 of 20 windows below 0.50", "lowAtLeast": 4},
         "adopted": {"label": "Adopted: at least 10 of 20 windows below 0.50", "lowAtLeast": 10}}


def rates(users, low_at_least):
    g_rej = g_n = i_acc = i_n = 0
    for pid, g, runs in users:
        gb = E.blocks(g, N)
        ib = [b for v in runs for b in E.blocks(v, N)]
        if not gb or not ib:
            continue
        g_n += len(gb); g_rej += sum(int((b < THRESHOLD).sum() >= low_at_least) for b in gb)
        i_n += len(ib); i_acc += sum(int((b < THRESHOLD).sum() < low_at_least) for b in ib)
    return {"far": i_acc / i_n, "frr": g_rej / g_n, "decisionsGenuine": g_n, "decisionsImpostor": i_n}


def main():
    users = PL.load("A200")
    result = {"arm": "A200", "users": len(users), "windowsPerDecision": N, "threshold": THRESHOLD,
              "method": __doc__.split("\n\n")[0].strip(), "rules": {}}
    for key, r in RULES.items():
        result["rules"][key] = {**r, **rates(users, r["lowAtLeast"])}
    out = os.path.join(PL.ROOT, "artifacts", "phase3", "lu_vote_rule.json")
    json.dump(result, open(out, "w", encoding="utf-8"), indent=2)
    for r in result["rules"].values():
        print("%-48s FAR %.1f%%  FRR %.1f%%  (%d genuine, %d impostor decisions)" % (
            r["label"], 100 * r["far"], 100 * r["frr"], r["decisionsGenuine"], r["decisionsImpostor"]))
    print("wrote", out)


if __name__ == "__main__":
    main()
