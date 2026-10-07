import json
import numpy as np

d = json.load(open('/app/artifacts/xai/population_scores.json'))

def packets(seq, k):
    seq = np.asarray(seq)
    if len(seq) < k:
        return np.empty((0, k))
    n = len(seq) - k + 1
    return np.stack([seq[i:i+k] for i in range(n)])

def eval_k(K, votes):
    gen_packets, imp_packets = [], []
    for u in d['perUser']:
        gp = packets(u['_genuineScores'], K)
        if len(gp): gen_packets.append(gp)
        for pid, run in u['_impostorRuns'].items():
            ip = packets(run, K)
            if len(ip): imp_packets.append(ip)
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
        if len(valid) == 0: return None
        idx_t = valid[np.argmax(far[valid])]
        return tar[idx_t]

    print(f"K={K:2d}, votes={votes:2d} (majority): N_gen={len(G):6d} N_imp={len(I):7d} | "
          f"EER={eer_v*100:5.2f}%  AUC={auc:.4f}  "
          f"FAR@0.50={far[i50]*100:5.2f}%  FRR@0.50={frr[i50]*100:5.2f}%  "
          f"TAR@FAR1%={ (tar_at_far(0.01) or float('nan'))*100:5.2f}%")
    return dict(K=K, votes=votes, eer=float(eer_v), auc=float(auc),
                far050=float(far[i50]), frr050=float(frr[i50]),
                tarAtFar01=tar_at_far(0.01))

results = []
for K, votes in [(6,3),(10,5),(20,10)]:
    results.append(eval_k(K, votes))

json.dump(results, open('/app/artifacts/xai/keystroke_decision_multi_k.json','w'), indent=2)
print("\nwrote /app/artifacts/xai/keystroke_decision_multi_k.json")
