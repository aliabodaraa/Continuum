import json
import numpy as np

d = json.load(open('/app/artifacts/xai/population_scores.json'))

PACKET = 6  # deployed packet size

def packet_means(seq, k):
    seq = np.asarray(seq)
    if len(seq) < k:
        return np.array([])
    # sliding, non-overlapping-by-1 packets over REAL temporal order (preserves autocorrelation)
    return np.array([seq[i:i+k].mean() for i in range(len(seq) - k + 1)])

all_gen_packets = []
all_imp_packets = []
for u in d['perUser']:
    g = packet_means(u['_genuineScores'], PACKET)
    all_gen_packets.extend(g.tolist())
    for pid, run in u['_impostorRuns'].items():
        ip = packet_means(run, PACKET)
        all_imp_packets.extend(ip.tolist())

g = np.array(all_gen_packets)
i = np.array(all_imp_packets)
print(f"decision-level (packet-mean, k={PACKET}) pooled: {len(g)} genuine packets, {len(i)} impostor packets")
print(f"from {len(d['perUser'])} users, genuine packets are REAL sliding packets over each user's own temporal held-out sequence")
print(f"impostor packets are REAL sliding packets within each of 40 impostors' own 150-window contiguous runs (never spliced across people)")

thresholds = np.linspace(0, 1, 501)
far = np.array([(i >= t).mean() for t in thresholds])
frr = np.array([(g < t).mean() for t in thresholds])
tar = 1 - frr

diff = far - frr
idx = np.argmin(np.abs(diff))
eer_t = thresholds[idx]
eer_v = (far[idx] + frr[idx]) / 2
print(f"\nDecision-level EER: {eer_v*100:.2f}% at packet-mean threshold {eer_t:.3f}")

idx50 = np.argmin(np.abs(thresholds - 0.50))
print(f"At threshold 0.50: FAR={far[idx50]*100:.2f}%  FRR={frr[idx50]*100:.2f}%  TAR={tar[idx50]*100:.2f}%")

# AUC via rank-sum
all_scores = np.concatenate([g, i])
labels = np.concatenate([np.ones(len(g)), np.zeros(len(i))])
order = np.argsort(all_scores)
ranks = np.empty(len(all_scores))
ranks[order] = np.arange(1, len(all_scores)+1)
sorted_scores = all_scores[order]
sorted_ranks = ranks[order].astype(float)
j = 0
while j < len(sorted_scores):
    k2 = j
    while k2+1 < len(sorted_scores) and sorted_scores[k2+1] == sorted_scores[j]:
        k2 += 1
    if k2 > j:
        sorted_ranks[j:k2+1] = sorted_ranks[j:k2+1].mean()
    j = k2+1
ranks[order] = sorted_ranks
n_pos = len(g); n_neg = len(i)
sum_ranks_pos = ranks[:n_pos].sum()
auc = (sum_ranks_pos - n_pos*(n_pos+1)/2) / (n_pos*n_neg)
print(f"\nDecision-level AUC: {auc:.4f}")

# TAR at FAR=1% and FAR=5%
def tar_at_far(target):
    # find threshold giving FAR closest to (but not exceeding) target, from the high-threshold side
    valid = np.where(far <= target)[0]
    if len(valid) == 0:
        return None, None
    idx_t = valid[np.argmax(far[valid])]  # highest FAR that still <= target (finest achievable)
    return tar[idx_t], thresholds[idx_t]

tar1, t1 = tar_at_far(0.01)
tar5, t5 = tar_at_far(0.05)
print(f"\nDecision-level TAR@FAR=1%: {tar1*100:.2f}% (threshold {t1:.3f})" if tar1 is not None else "no threshold achieves FAR<=1%")
print(f"Decision-level TAR@FAR=5%: {tar5*100:.2f}% (threshold {t5:.3f})" if tar5 is not None else "no threshold achieves FAR<=5%")

# Compare directly to window-level numbers already reported
print(f"\n--- for direct comparison, window-level (already reported) ---")
print("Window-level: EER median 14.53% (per-user) / 15.51% (pooled); AUC 0.930 (per-user) / 0.921 (pooled); TAR@FAR=1% median 12.4%")

out = {
    "packetSize": PACKET,
    "pooledGenuinePackets": len(g), "pooledImpostorPackets": len(i),
    "eerValue": float(eer_v), "eerThreshold": float(eer_t),
    "far050": float(far[idx50]), "frr050": float(frr[idx50]), "tar050": float(tar[idx50]),
    "aucPooled": float(auc),
    "tarAtFar01": float(tar1) if tar1 is not None else None,
    "tarAtFar01Threshold": float(t1) if t1 is not None else None,
    "tarAtFar05": float(tar5) if tar5 is not None else None,
    "curve": {
        "thresholds": [round(float(x),3) for x in thresholds[::10]],
        "far": [round(float(x),4) for x in far[::10]],
        "frr": [round(float(x),4) for x in frr[::10]],
        "tar": [round(float(x),4) for x in tar[::10]],
    }
}
json.dump(out, open('/app/artifacts/xai/keystroke_decision_roc_eer.json','w'), indent=2)
print("\nwrote /app/artifacts/xai/keystroke_decision_roc_eer.json")
