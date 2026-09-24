"""Mouse numbers for the defense deck (task T5.1): S1 as deployed, on lockbox 1 (P6 streams).

EXPLORATORY, post hoc on a spent lockbox: it decides nothing. Lockbox 1 (20 users) was never used
for a design choice and was spent by the pre-registered P6 test. The operating-point numbers the
deck quotes (runs caught, prompts/min) come from that pre-registered test (analysis_J_P6.json). This
script adds the threshold-free numbers and a figure, all on the same whole streams:

  window level      each window's score
  decision level    step-disjoint blocks of 60 windows (17.2 s, the deployed vote length)

Both are reported per user (mean over users; raw scores, which need no calibration within a user) and
pooled over users on the pct score (a window's percentile within the user's own leave-one-sample-out
scores, averaged over the decision; comparable across users). The deployed rule (20th percentile of
those scores, 33 of 60 below it) is marked as one operating point. Fixed-FAR rows replace any
hand-picked cutoff.

    python deck_mouse_s1.py     # -> artifacts/phase1/deck_mouse_s1.json, deck_mouse_s1_roc.png
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import eval_decision_level as E  # noqa: E402
import p1lib as P  # noqa: E402
import run_phase1 as R  # noqa: E402

OUT = os.path.join(R.ROOT, "artifacts", "phase1")
N, K, Q = 60, 33, 20
FARS = (0.01, 0.05, 0.10)


def window_pct(u):
    ref = np.sort(np.asarray(u["ref"], float))
    f = lambda x: np.searchsorted(ref, np.asarray(x, float), "right") / len(ref)  # noqa: E731
    return f(u["genuine"]), np.concatenate([f(r) for r in u["runs"].values()])


def frr_at(g, i, far):
    return E.frr_at_far(g, i, far)


def curve(g, i):
    ths = np.unique(np.concatenate([g, i, [0.0, 1.0 + 1e-9]]))[::-1]
    return np.array([(i >= t).mean() for t in ths]), np.array([(g >= t).mean() for t in ths])


def main():
    U = R.lockbox_units("J_P6", {"S1": ("B", Q)})["S1"]
    users = sorted(U, key=lambda x: int(x[4:]))
    # window level
    per_w = {u: {"auc": P.auc_of(np.asarray(U[u]["genuine"], float),
                                 np.concatenate([np.asarray(r, float) for r in U[u]["runs"].values()])),
                 "eer": P.eer_of(np.asarray(U[u]["genuine"], float),
                                 np.concatenate([np.asarray(r, float) for r in U[u]["runs"].values()]))[0]} for u in users}
    wg = np.concatenate([window_pct(U[u])[0] for u in users])
    wi = np.concatenate([window_pct(U[u])[1] for u in users])
    # decision level (60 windows, step-disjoint)
    ev = E.evaluate(U, N)
    dec = ev["_dec"]
    dg = np.concatenate([dec[u]["g"]["pct"] for u in users])
    di = np.concatenate([dec[u]["i"]["pct"] for u in users])
    per_d = {}
    for u in users:
        g, i = dec[u]["g"]["mean"], dec[u]["i"]["mean"]
        per_d[u] = {"auc": ev["perUser"][u]["aucMean"], "eer": P.eer_of(g, i)[0] if len(g) and len(i) else float("nan")}
    # the deployed rule on the same 60-window decisions
    g_rej = g_n = i_acc = i_n = 0
    for u in users:
        t = U[u]["tau"]
        for b in E.blocks(U[u]["genuine"], N):
            g_n += 1; g_rej += int((b < t).sum() >= K)
        for r in U[u]["runs"].values():
            for b in E.blocks(r, N):
                i_n += 1; i_acc += int((b < t).sum() < K)
    p6 = json.load(open(os.path.join(R.STUDY, "analysis_J_P6.json")))["summary"]["S1"]
    res = {"note": "EXPLORATORY, post hoc on the spent lockbox 1 (P6 streams), S1 as deployed; decides nothing.",
           "users": len(users),
           "window": {"perUserMean": {k: float(np.nanmean([per_w[u][k] for u in users])) for k in ("auc", "eer")},
                      "pooledPct": {"eer": E.eer_fast(wg, wi), "auc": E.auc_fast(wg, wi),
                                    **{f"frrAtFar{int(f * 100)}": frr_at(wg, wi, f) for f in FARS}},
                      "n": {"genuine": int(len(wg)), "impostor": int(len(wi))}},
           "decision60": {"seconds": round(E.seconds(N), 2),
                          "perUserMean": {k: float(np.nanmean([per_d[u][k] for u in users])) for k in ("auc", "eer")},
                          "perUserMeanAucPct": float(np.nanmean([ev["perUser"][u]["aucPct"] for u in users])),
                          "pooledPct": {"eer": E.eer_fast(dg, di), "auc": E.auc_fast(dg, di),
                                        **{f"frrAtFar{int(f * 100)}": frr_at(dg, di, f) for f in FARS}},
                          "n": {"genuine": int(len(dg)), "impostor": int(len(di))},
                          "deployedRule": {"far": i_acc / i_n, "frr": g_rej / g_n}},
           "operatingPointP6": {k: p6[k] for k in ("promptsPerMin", "runsCaught", "usersNeverPrompted",
                                                   "usersBelow80pctCapture", "timeToCatchMedianS")},
           "operatingPointSource": "analysis_J_P6.json (pre-registered P6 test, test halves)"}
    json.dump(res, open(os.path.join(OUT, "deck_mouse_s1.json"), "w"), indent=1)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(6.2, 5.4))
    for (g, i, lab, st) in ((wg, wi, f"single window (50 steps, 1.3 s)   AUC {res['window']['pooledPct']['auc']:.3f}", "--"),
                            (dg, di, f"decision, 60 windows (17.2 s)   AUC {res['decision60']['pooledPct']['auc']:.3f}", "-")):
        far, tar = curve(g, i)
        ax.plot(far, tar, st, lw=1.8, color="#1f4e79" if st == "-" else "#7f7f7f", label=lab)
    dp = res["decision60"]["deployedRule"]
    ax.plot(dp["far"], 1 - dp["frr"], "o", ms=9, mfc="white", mew=2.2, color="#c00000",
            label=f"deployed rule (20th pct, 33 of 60): FAR {dp['far'] * 100:.1f}%, FRR {dp['frr'] * 100:.1f}%")
    ax.plot([0, 1], [0, 1], color="#cccccc", lw=0.8)
    ax.set_xlabel("false accept rate")
    ax.set_ylabel("true accept rate")
    ax.set_title("Mouse, S1 on 20 untouched users (lockbox 1): ROC of the pct score", fontsize=10)
    ax.legend(loc="lower right", fontsize=8)
    ax.set_xlim(-0.01, 1.01); ax.set_ylim(-0.01, 1.01)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "deck_mouse_s1_roc.png"), dpi=170)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
