import json
import numpy as np

d = json.load(open('/app/artifacts/xai/population_scores.json'))

all_g = []
all_i = []
tar01_list = []
for u in d['perUser']:
    all_g.extend(u['_genuineScores'])
    all_i.extend(u['_impostorScores'])
    if u.get('tarAtFar01') is not None:
        tar01_list.append(u['tarAtFar01'])

g = np.array(all_g)
i = np.array(all_i)
print(f"pooled window-level: {len(g)} genuine windows, {len(i)} impostor windows")
print(f"median per-user tarAtFar01 (already stored): {np.median(tar01_list)*100:.2f}% (n={len(tar01_list)} users)")

thresholds = np.linspace(0, 1, 1001)
far = np.array([(i >= t).mean() for t in thresholds])
tar = np.array([(g >= t).mean() for t in thresholds])

def tar_at_far(target):
    valid = np.where(far <= target)[0]
    if len(valid) == 0:
        return None, None
    idx_t = valid[np.argmax(far[valid])]
    return tar[idx_t], thresholds[idx_t]

t1, th1 = tar_at_far(0.01)
print(f"pooled window-level TAR@FAR=1%: {t1*100:.2f}% (threshold {th1:.3f})")
