"""
Decision-level ROC / EER / AUC / FAR / FRR / TAR@FAR=1% per packet length, pooled over the 99 KeyRecs
users: the method of decision_roc_multi_k.py (thesis Table 11: 6, 10, 20 windows), run again for the
2- and 4-window packets the console offers since 2026-11-05 (the owner's option for sensitive systems),
with the measured lengths alongside so the run can be checked against the stored results
(artifacts/xai/keystroke_decision_multi_k.json). Same simple-majority vote: a packet fires when at
least ceil(K/2) of its windows score below the threshold (1 of 2, 2 of 4, 3 of 6, 5 of 10, 10 of 20).
Sliding packets over each user's genuine score sequence and each contiguous impostor run.

    docker run --rm -v "<continuum>:/app" continuum/model-api:local \
        python /app/services/model-api/analysis/decision_roc_multi_k_2_4.py [out.json] [K,votes ...]

Writes artifacts/xai/keystroke_decision_multi_k_2_4.json by default (never the stored file).
"""
import json
import sys

import numpy as np

SCORES = "/app/artifacts/xai/population_scores.json"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/app/artifacts/xai/keystroke_decision_multi_k_2_4.json"
PAIRS = [tuple(int(x) for x in a.split(",")) for a in sys.argv[2:]] or [(2, 1), (4, 2), (6, 3), (10, 5), (20, 10)]

d = json.load(open(SCORES))


def packets(seq, k):
    seq = np.asarray(seq)
    if len(seq) < k:
        return np.empty((0, k))
    n = len(seq) - k + 1
    return np.stack([seq[i:i + k] for i in range(n)])


def eval_k(K, votes):
    gen_packets, imp_packets = [], []
    for u in d["perUser"]:
        gp = packets(u["_genuineScores"], K)
        if len(gp):
            gen_packets.append(gp)
        for _pid, run in u["_impostorRuns"].items():
            ip = packets(run, K)
            if len(ip):
                imp_packets.append(ip)
    G = np.concatenate(gen_packets, axis=0)
    I = np.concatenate(imp_packets, axis=0)

    thresholds = np.linspace(0.0, 1.0, 201)
    far = np.empty(len(thresholds))
    frr = np.empty(len(thresholds))
    for idx, t in enumerate(thresholds):
        g_below = (G < t).sum(axis=1)
        i_below = (I < t).sum(axis=1)
        frr[idx] = (g_below >= votes).mean()
        far[idx] = 1.0 - (i_below >= votes).mean()
    tar = 1 - frr

    i_eer = np.argmin(np.abs(far - frr))
    eer_v = (far[i_eer] + frr[i_eer]) / 2
    i50 = np.argmin(np.abs(thresholds - 0.50))
    order = np.argsort(far)
    auc = np.trapz(tar[order], far[order])

    def tar_at_far(target):
        valid = np.where(far <= target)[0]
        if len(valid) == 0:
            return None
        idx_t = valid[np.argmax(far[valid])]
        return float(tar[idx_t])

    # keystrokes until the first verdict: K + 1 windows of 50 steps sliding by 10, plus one key for the first step
    first_verdict_keys = 50 + 10 * K + 1
    print(f"K={K:2d}, votes={votes:2d} (majority): N_gen={len(G):6d} N_imp={len(I):7d} | "
          f"EER={eer_v * 100:5.2f}%  AUC={auc:.4f}  "
          f"FAR@0.50={far[i50] * 100:5.2f}%  FRR@0.50={frr[i50] * 100:5.2f}%  "
          f"TAR@FAR1%={(tar_at_far(0.01) or float('nan')) * 100:5.2f}%  first verdict at {first_verdict_keys} keystrokes")
    return dict(K=K, votes=votes, eer=float(eer_v), auc=float(auc), far050=float(far[i50]), frr050=float(frr[i50]),
                tarAtFar01=tar_at_far(0.01), nGenuinePackets=int(len(G)), nImpostorPackets=int(len(I)),
                firstVerdictKeystrokes=first_verdict_keys)


results = [eval_k(K, v) for K, v in PAIRS]
json.dump(results, open(OUT, "w"), indent=2)
print(f"\nwrote {OUT}")
