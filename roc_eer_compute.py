import json
import numpy as np

d = json.load(open('/app/artifacts/xai/population_scores.json'))

all_gen = []
all_imp = []
for u in d['perUser']:
    all_gen.extend(u['_genuineScores'])
    all_imp.extend(u['_impostorScores'])

g = np.array(all_gen)
i = np.array(all_imp)
print(f"pooled genuine windows: {len(g)}, pooled impostor windows: {len(i)}")
print(f"users contributing: {len(d['perUser'])}")

# Sweep thresholds
thresholds = np.linspace(0, 1, 501)
far = np.array([(i >= t).mean() for t in thresholds])   # impostor accepted
frr = np.array([(g < t).mean() for t in thresholds])     # genuine rejected
tar = 1 - frr

# EER: where FAR and FRR cross
diff = far - frr
idx = np.argmin(np.abs(diff))
eer_threshold = thresholds[idx]
eer_value = (far[idx] + frr[idx]) / 2
print(f"\nPooled EER: {eer_value*100:.2f}% at threshold {eer_threshold:.3f}")

# At fixed 0.50
idx50 = np.argmin(np.abs(thresholds - 0.50))
print(f"At threshold 0.50: FAR={far[idx50]*100:.2f}%  FRR={frr[idx50]*100:.2f}%  TAR={tar[idx50]*100:.2f}%")

# AUC via rank-sum (Mann-Whitney), exact
from itertools import product
# Efficient AUC: sort-based
all_scores = np.concatenate([g, i])
labels = np.concatenate([np.ones(len(g)), np.zeros(len(i))])
order = np.argsort(all_scores)
ranks = np.empty(len(all_scores))
ranks[order] = np.arange(1, len(all_scores)+1)
# handle ties by average rank
sorted_scores = all_scores[order]
sorted_ranks = ranks[order].astype(float)
j = 0
while j < len(sorted_scores):
    k = j
    while k+1 < len(sorted_scores) and sorted_scores[k+1] == sorted_scores[j]:
        k += 1
    if k > j:
        avg = sorted_ranks[j:k+1].mean()
        sorted_ranks[j:k+1] = avg
    j = k+1
ranks[order] = sorted_ranks
n_pos = len(g); n_neg = len(i)
sum_ranks_pos = ranks[:n_pos].sum()
auc = (sum_ranks_pos - n_pos*(n_pos+1)/2) / (n_pos*n_neg)
print(f"\nPooled AUC: {auc:.4f}")

# F1 at 0.50 (genuine = positive class)
tp = (g >= 0.50).sum()
fn = (g < 0.50).sum()
fp = (i >= 0.50).sum()
tn = (i < 0.50).sum()
precision = tp / (tp + fp)
recall = tp / (tp + fn)
f1 = 2 * precision * recall / (precision + recall)
print(f"\nAt 0.50: TP={tp} FN={fn} FP={fp} TN={tn}")
print(f"Precision={precision:.4f}  Recall={recall:.4f}  F1={f1:.4f}")

# Save a downsampled curve for plotting (every 10th point + key points)
curve_thresholds = thresholds[::10]
curve_far = far[::10]
curve_frr = frr[::10]
curve_tar = tar[::10]
out = {
    "pooledGenuineN": len(g), "pooledImpostorN": len(i), "usersContributing": len(d['perUser']),
    "eerValue": float(eer_value), "eerThreshold": float(eer_threshold),
    "far050": float(far[idx50]), "frr050": float(frr[idx50]), "tar050": float(tar[idx50]),
    "aucPooled": float(auc),
    "f1At050": float(f1), "precisionAt050": float(precision), "recallAt050": float(recall),
    "tp": int(tp), "fn": int(fn), "fp": int(fp), "tn": int(tn),
    "curve": {
        "thresholds": [round(float(x),3) for x in curve_thresholds],
        "far": [round(float(x),4) for x in curve_far],
        "frr": [round(float(x),4) for x in curve_frr],
        "tar": [round(float(x),4) for x in curve_tar],
    }
}
json.dump(out, open('/app/artifacts/xai/keystroke_roc_eer_curve.json','w'), indent=2)
print("\nwrote /app/artifacts/xai/keystroke_roc_eer_curve.json")
