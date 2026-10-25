"""Lu's fixed 0.50 threshold on the deployed mouse head (F2) with the windows (owner, 20 Oct 2026: "test this now").

Protocol L stage D's stored scores (artifacts/phase2/L/scores_D.json) are the source of the paper's Table 6: 19
development users, the base-80 network, 440-window enrolment, F2 = frozen network + logistic head against the
cohort, FAR 10.8% / FRR 10.0% at the 20th percentile of the leave-one-sample-out scores with 33 of 60. The only thing
changed here is the threshold, which becomes 0.50 for every user as in Lu et al. The vote is tested at 30 of 60 (half,
like typing's 10 of 20) and at the deployed 33 of 60. Decisions and pooling are exactly analyze_l.deployed_point
(step-disjoint 60-window decisions, pooled over users, mean over the stored variants), and the live loop is
analyze_l.operating_point. The personal-threshold rows reproduce stage_D.txt as a check.

    python analysis/phase6/f2_fixed_threshold.py     # artifacts/phase6/f2_fixed_threshold_result.json / .txt
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase2")))
import analyze_l as A  # noqa: E402
import l_common as LC  # noqa: E402
import eval_decision_level as E  # noqa: E402
import p1lib as P  # noqa: E402

OUT = "/app/artifacts/phase6"


def decision_point(vs, targets, tau_of, k):
    far, frr = [], []
    for U in vs.values():
        g_rej = g_n = i_acc = i_n = 0
        for u in targets:
            t = tau_of(U[u])
            for b in E.blocks(U[u]["genuine"], LC.VOTE_N):
                g_n += 1; g_rej += int((b < t).sum() >= k)
            for r in U[u]["runs"].values():
                for b in E.blocks(r, LC.VOTE_N):
                    i_n += 1; i_acc += int((b < t).sum() < k)
        far.append(i_acc / max(i_n, 1)); frr.append(g_rej / max(g_n, 1))
    return {"far": float(np.mean(far)), "frr": float(np.mean(frr))}


def live_loop(vs, targets, tau_of, k):
    sums = []
    for U in vs.values():
        res = {u: P.per_user({"g": np.asarray(U[u]["genuine"], float),
                              "runs": {o: np.asarray(r, float) for o, r in U[u]["runs"].items()}},
                             tau_of(U[u]), "vote", LC.VOTE_N, k) for u in targets}
        sums.append(P.summary(res))
    keys = [x for x in sums[0] if sums[0][x] is not None]
    return {x: float(np.mean([s[x] for s in sums if s[x] is not None])) for x in keys}


def main():
    folder, path, d, hashes, V, code = A.load(False, None)
    targets = list(d["targets"])
    personal = lambda u: u["tau"]                       # 20th percentile of the user's own threshold source
    fixed = lambda u: 0.50
    rows = {}
    for s in ("F2", "REF"):
        rows[s] = {
            "personal20_33of60": {**decision_point(V[s], targets, personal, 33), **live_loop(V[s], targets, personal, 33)},
            "fixed050_30of60": {**decision_point(V[s], targets, fixed, 30), **live_loop(V[s], targets, fixed, 30)},
            "fixed050_33of60": {**decision_point(V[s], targets, fixed, 33), **live_loop(V[s], targets, fixed, 33)},
        }
        g = np.concatenate([np.asarray(U[u]["genuine"], float) for U in V[s].values() for u in targets])
        i = np.concatenate([np.asarray(r, float) for U in V[s].values() for u in targets for r in U[u]["runs"].values()])
        rows[s]["singleWindowAt050"] = {"FRR": float((g < 0.5).mean()), "FAR": float((i >= 0.5).mean())}
        rows[s]["tauPercentile20"] = {"mean": float(np.mean([U[u]["tau"] for U in V[s].values() for u in targets])),
                                      "min": float(np.min([U[u]["tau"] for U in V[s].values() for u in targets])),
                                      "max": float(np.max([U[u]["tau"] for U in V[s].values() for u in targets]))}
    res = {"source": path, "nTargets": len(targets), "rows": rows}
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "f2_fixed_threshold_result.json"), "w") as f:
        json.dump(res, f, indent=1)
    L = [f"Stage D scores, {len(targets)} development users, base-80, 440-window enrolment; 17.2-s decisions, pooled"]
    for s in rows:
        for name in ("personal20_33of60", "fixed050_30of60", "fixed050_33of60"):
            r = rows[s][name]
            L.append(f"{s:<4} {name:<18} FAR {r['far']*100:5.1f}%  FRR {r['frr']*100:5.1f}%  | live loop: prompts/min "
                     f"{r['promptsPerMinMean']:.2f}, users never prompted {r['usersNeverPrompted']*100:.1f}%, impostor runs caught {r['impostorRunsCaught']*100:.1f}%")
        t = rows[s]["tauPercentile20"]
        L.append(f"{s:<4} personal thresholds: mean {t['mean']:.3f} (from {t['min']:.3f} to {t['max']:.3f}); "
                 f"single window at 0.50: FAR {rows[s]['singleWindowAt050']['FAR']*100:.1f}%  "
                 f"FRR {rows[s]['singleWindowAt050']['FRR']*100:.1f}%")
    txt = "\n".join(L)
    open(os.path.join(OUT, "f2_fixed_threshold_result.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
