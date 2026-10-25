"""SapiMouse's blocks with a FIXED threshold, as Lu et al. use 0.50 for typing (owner, 20 Oct 2026: "fix the threshold
at 50% like Lu and keep the blocks").

No training: it reads the scores already stored for the same 20 held-out users, 3 seeds, enrolment on the whole
3-minute session and test on the 1-minute session against the other users' 1-minute sessions.
  * blocks, one-class SVM (SapiMouse's classifier) -> artifacts/phase6/e_native/EN_s*.json "K-OC" (decision function;
    its own boundary 0 is the fixed threshold, and with scikit-learn's default nu = 0.5 it leaves about half of the
    training blocks outside)
  * blocks, binary head trained against other people  -> EN_s*.json "K-BIN" (probability, fixed 0.50 as in Lu)
  * windows, binary head trained against other people -> artifacts/repr_arch_study/parts/E_s*.json "W-BIN" (0.50)
Rules: a vote (at least half of the units below the threshold: 3 of 5 blocks, 30 of 60 windows) and the mean of the
units below the threshold, on disjoint decisions of 5 blocks or 60 windows (about 17 s), as in repr_segm_analyze.

    python analysis/phase6/fixed_threshold.py      # artifacts/phase6/fixed_threshold_result.json / .txt
"""
import glob
import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
ART = os.path.join(ROOT, "artifacts")


def groups(seq, k, stride):
    s = np.asarray(seq, float)
    return [s[i:i + k] for i in range(0, len(s) - k + 1, stride)]


def evaluate(docs, arm, thr, k, stride, need):
    out = {}
    for rule in ("vote", "mean"):
        g_bad = g_n = i_ok = i_n = 0
        per_user = {}
        for d in docs:
            for r in d["perUser"]:
                u = r[arm]
                low = (lambda grp: (grp < thr).sum() >= need) if rule == "vote" else (lambda grp: grp.mean() < thr)
                gen = [low(x) for x in groups(u["_genuineScores"], k, stride)]
                imp = [low(x) for v in u["_impostorRuns"].values() for x in groups(v, k, stride)]
                g_bad += sum(gen); g_n += len(gen); i_ok += sum(1 for x in imp if not x); i_n += len(imp)
                e = per_user.setdefault(r["participant"], {"frr": [], "far": []})
                if gen:
                    e["frr"].append(float(np.mean(gen)))
                if imp:
                    e["far"].append(float(np.mean([not x for x in imp])))
        out[rule] = {"pooledFAR": i_ok / i_n, "pooledFRR": g_bad / g_n, "genuineDecisions": g_n, "impostorDecisions": i_n,
                     "meanFAR": float(np.mean([np.mean(v["far"]) for v in per_user.values() if v["far"]])),
                     "meanFRR": float(np.mean([np.mean(v["frr"]) for v in per_user.values() if v["frr"]]))}
    g_all = np.concatenate([np.asarray(r[arm]["_genuineScores"]) for d in docs for r in d["perUser"]])
    i_all = np.concatenate([np.asarray(v) for d in docs for r in d["perUser"] for v in r[arm]["_impostorRuns"].values()])
    out["singleUnit"] = {"FRR": float((g_all < thr).mean()), "FAR": float((i_all >= thr).mean())}
    return out


def main():
    E = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(ART, "repr_arch_study", "parts", "E_s*.json")))]
    N = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(ART, "phase6", "e_native", "EN_s*.json")))]
    assert len(E) == 3 and len(N) == 3
    res = {
        "blocks, one-class SVM, its boundary 0": evaluate(N, "K-OC", 0.0, 5, 5, 3),
        "blocks, binary head, 0.50": evaluate(N, "K-BIN", 0.5, 5, 5, 3),
        "windows, binary head, 0.50": evaluate(E, "W-BIN", 0.5, 60, 64, 30),
    }
    res["_reference"] = "deployed window channel (paper Table 6, 19 users, personal threshold, 33 of 60): FAR 10.8%, FRR 10.0%"
    with open(os.path.join(ART, "phase6", "fixed_threshold_result.json"), "w") as f:
        json.dump(res, f, indent=1)
    L = ["Fixed thresholds, 20 users x 3 seeds, decisions of 5 blocks or 60 windows (about 17 s), pooled FAR / FRR"]
    for name, v in res.items():
        if name.startswith("_"):
            continue
        L.append(f"{name:<40} vote {v['vote']['pooledFAR']*100:5.1f}% / {v['vote']['pooledFRR']*100:5.1f}%   "
                 f"mean {v['mean']['pooledFAR']*100:5.1f}% / {v['mean']['pooledFRR']*100:5.1f}%   "
                 f"single unit {v['singleUnit']['FAR']*100:5.1f}% / {v['singleUnit']['FRR']*100:5.1f}%   "
                 f"({v['vote']['genuineDecisions']} genuine, {v['vote']['impostorDecisions']} impostor decisions)")
    L.append(res["_reference"])
    txt = "\n".join(L)
    open(os.path.join(ART, "phase6", "fixed_threshold_result.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
