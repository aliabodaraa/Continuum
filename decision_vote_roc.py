import json
import numpy as np

d = json.load(open('/app/artifacts/xai/population_scores.json'))
K = 6      # RECENT_WINDOW_COUNT (deployed)
VOTES = 3  # deployed vote requirement (>=3-of-6)

def packets(seq, k):
    seq = np.asarray(seq)
    if len(seq) < k:
        return np.empty((0, k))
    n = len(seq) - k + 1
    return np.stack([seq[i:i+k] for i in range(n)])

gen_packets = []
imp_packets = []
for u in d['perUser']:
    gp = packets(u['_genuineScores'], K)
    if len(gp): gen_packets.append(gp)
    for pid, run in u['_impostorRuns'].items():
        ip = packets(run, K)
        if len(ip): imp_packets.append(ip)

G = np.concatenate(gen_packets, axis=0)  # (Ngen, 6)
I = np.concatenate(imp_packets, axis=0)  # (Nimp, 6)
print(f"pooled real sliding packets (k={K}): {len(G)} genuine, {len(I)} impostor")

thresholds = np.linspace(0.0, 1.0, 201)
far = np.empty(len(thresholds))
frr = np.empty(len(thresholds))
for idx, t in enumerate(thresholds):
    g_below = (G < t).sum(axis=1)
    i_below = (I < t).sum(axis=1)
    g_flagged_suspicious = g_below >= VOTES
    i_flagged_suspicious = i_below >= VOTES
    frr[idx] = g_flagged_suspicious.mean()          # genuine wrongly rejected
    far[idx] = 1.0 - i_flagged_suspicious.mean()    # impostor wrongly accepted

tar = 1 - frr

diff = np.abs(far - frr)
i_eer = np.argmin(diff)
eer_t = thresholds[i_eer]
eer_v = (far[i_eer] + frr[i_eer]) / 2
print(f"\nDeployed vote-rule (>= {VOTES}-of-{K}) decision-level EER: {eer_v*100:.2f}% at per-window threshold {eer_t:.3f}")

i50 = np.argmin(np.abs(thresholds - 0.50))
print(f"At the LIVE per-window threshold 0.50: FAR={far[i50]*100:.2f}%  FRR={frr[i50]*100:.2f}%  TAR={tar[i50]*100:.2f}%")

def tar_at_far(target):
    valid = np.where(far <= target)[0]
    if len(valid) == 0:
        return None, None
    idx_t = valid[np.argmax(far[valid])]
    return tar[idx_t], thresholds[idx_t]

t1, th1 = tar_at_far(0.01)
t5, th5 = tar_at_far(0.05)
print(f"Decision-level (deployed vote rule) TAR@FAR=1%: {t1*100:.2f}% (per-window threshold {th1:.3f})" if t1 is not None else "unreachable")
print(f"Decision-level (deployed vote rule) TAR@FAR=5%: {t5*100:.2f}% (per-window threshold {th5:.3f})" if t5 is not None else "unreachable")

# AUC via trapezoid on (far, tar) sorted by far
order = np.argsort(far)
auc = np.trapz(tar[order], far[order])
print(f"\nDecision-level (deployed vote rule) AUC (trapezoid): {auc:.4f}")

out = {
    "packetSize": K, "votesRequired": VOTES,
    "pooledGenuinePackets": int(len(G)), "pooledImpostorPackets": int(len(I)),
    "eerValue": float(eer_v), "eerThresholdOnWindowScore": float(eer_t),
    "far050": float(far[i50]), "frr050": float(frr[i50]), "tar050": float(tar[i50]),
    "aucPooled": float(auc),
    "tarAtFar01": float(t1) if t1 is not None else None,
    "tarAtFar01Threshold": float(th1) if th1 is not None else None,
    "tarAtFar05": float(t5) if t5 is not None else None,
    "curve": {
        "thresholds": [round(float(x),4) for x in thresholds],
        "far": [round(float(x),5) for x in far],
        "frr": [round(float(x),5) for x in frr],
        "tar": [round(float(x),5) for x in tar],
    }
}
json.dump(out, open('/app/artifacts/xai/keystroke_decision_vote_roc.json','w'), indent=2)
print("\nwrote /app/artifacts/xai/keystroke_decision_vote_roc.json")
