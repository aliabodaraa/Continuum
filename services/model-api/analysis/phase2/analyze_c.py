"""Protocol L, stage C analysis on Bogazici (PREREGISTRATION_L.md section 6).

    python analyze_c.py            # L/stageC/scores_C.json -> stage_C.json, stage_C.txt, stage_C_roc.png
    python analyze_c.py --smoke    # SMOKE TEST ONLY

Confirmatory family (Holm): Q1 (L - REF) is not tested because L stopped at stage D, so the family is
Q2 alone and Holm leaves its 95% interval unadjusted.
  Q2  F2 - REF, mean paired difference in per-user AUC of 33-window decisions (N = 33, pct;
      9.9 s in SapiMouse), bootstrap
      over targets (10,000, seed 17): F2 is non-inferior if the lower 95% bound is > -0.010.
  Key secondary (fixed sequence, only after Q2 succeeds): pooled pct EER of 33-window decisions, F2 - REF,
      cluster bootstrap over targets (10,000, seed 17): F2 is better if the upper 95% bound is < 0.
Reported, deciding nothing: N = 15 and 60; window AUC, EER and TAR@FAR 1%; pooled FRR at FAR 1% and
5%; per-user values and the worst 10%; ties at AUC 1.0; the live loop at each system's own operating
point (20th percentile, 33 of 60, one check per 6 windows, run per session); the deployed rule on
60-window decisions; the power (SE, MDE80) at the eligible n; the ROC figure.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402
import c_common as C  # noqa: E402
import eval_decision_level as E  # noqa: E402
import p1lib as P  # noqa: E402

SYSTEMS = ("REF", "F2")
B = 10000


def boot(a, b):
    res = P.boot(a, b)
    a, b = np.asarray(a, float), np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    dd = b[ok] - a[ok]
    st = dd[np.random.default_rng(17).integers(0, len(dd), (P.N_BOOT, len(dd)))].mean(1)
    res["se"], res["mde80"] = float(st.std(ddof=1)), 2.8 * float(st.std(ddof=1))
    return res


def pooled_boot(dec_a, dec_b, users, b=B, seed=17):
    rng = np.random.default_rng(seed)
    base_a, base_b = E.pooled_metrics(dec_a, users)["pct"], E.pooled_metrics(dec_b, users)["pct"]
    diffs = {k: [] for k in base_a}
    for _ in range(b):
        pick = [users[j] for j in rng.integers(0, len(users), len(users))]
        xa, xb = E.pooled_metrics(dec_a, pick)["pct"], E.pooled_metrics(dec_b, pick)["pct"]
        for k in diffs:
            diffs[k].append(xb[k] - xa[k])
    return {k: {"a": base_a[k], "b": base_b[k], "diff": base_b[k] - base_a[k],
                "ci95": [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))]} for k, v in diffs.items()}


def live_loop(U, targets):
    res = {}
    for t in targets:
        u = U[t]
        tau = float(np.percentile(u["ref"], LC.Q_TAU))
        prompts = sum(P.replay(s, tau, "vote", LC.VOTE_N, LC.VOTE_K)[0] for s in u["genuine"])
        nwin = sum(len(s) for s in u["genuine"])
        minutes = nwin * C.SEC_PER_WINDOW_B / 60.0 if C.SEC_PER_WINDOW_B else None
        caught = [any(P.replay(s, tau, "vote", LC.VOTE_N, LC.VOTE_K)[0] for s in r) for r in u["runs"].values()]
        res[t] = {"promptsPer1000Windows": 1000.0 * prompts / nwin if nwin else float("nan"),
                  "promptsPerMin": prompts / minutes if minutes else float("nan"), "prompts": prompts,
                  "runsCaught": float(np.mean(caught)) if caught else float("nan")}
    per_min = [v["promptsPerMin"] for v in res.values() if np.isfinite(v["promptsPerMin"])]
    return {"promptsPer1000WindowsMean": float(np.nanmean([v["promptsPer1000Windows"] for v in res.values()])),
            "promptsPerMinMean": float(np.mean(per_min)) if per_min else float("nan"),
            "runsCaughtMean": float(np.nanmean([v["runsCaught"] for v in res.values()])),
            "usersNeverPrompted": int(sum(v["prompts"] == 0 for v in res.values())), "perUser": res}


def deployed_rule(U, targets):
    g_rej = g_n = i_acc = i_n = 0
    for t in targets:
        u = U[t]
        tau = float(np.percentile(u["ref"], LC.Q_TAU))
        for b in C.stream_blocks(u["genuine"], LC.VOTE_N):
            g_n += 1; g_rej += int((b < tau).sum() >= LC.VOTE_K)
        for r in u["runs"].values():
            for b in C.stream_blocks(r, LC.VOTE_N):
                i_n += 1; i_acc += int((b < tau).sum() < LC.VOTE_K)
    return {"far": i_acc / max(i_n, 1), "frr": g_rej / max(g_n, 1), "nGenuine": g_n, "nImpostor": i_n}


def window_level(U, targets):
    per = {}
    for t in targets:
        g = np.concatenate(U[t]["genuine"])
        imp = np.concatenate([s for r in U[t]["runs"].values() for s in r])
        per[t] = {"auc": P.auc_of(g, imp), "eer": P.eer_of(g, imp)[0], "tar01": P.tar_at_far(g, imp, 0.01)[0]}
    return {"mean": {k: float(np.mean([per[t][k] for t in targets])) for k in ("auc", "eer", "tar01")}, "perUser": per}


def figure(path, decs, targets, dp):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(11, 5))
    col = {"REF": "#444444", "F2": "#1f77b4"}
    for ax, n in zip(axes, (LC.N_DEC, LC.VOTE_N)):
        for s in SYSTEMS:
            g = np.concatenate([decs[n][s][t]["g"]["pct"] for t in targets])
            i = np.concatenate([decs[n][s][t]["i"]["pct"] for t in targets])
            ths = np.unique(np.concatenate([g, i, [0.0, 1.0 + 1e-9]]))[::-1]
            ax.plot([(i >= x).mean() for x in ths], [(g >= x).mean() for x in ths], color=col[s], lw=1.8,
                    label=f"{s}  AUC {E.auc_fast(g, i):.3f}")
            if n == LC.VOTE_N:
                ax.plot(dp[s]["far"], 1 - dp[s]["frr"], "o", ms=8, mfc="white", mew=2, color=col[s])
        ax.plot([0, 1], [0, 1], color="#bbbbbb", lw=0.8)
        ax.set_title(f"Bogazici, decisions of {n} windows, pooled pct score", fontsize=10)
        ax.set_xlabel("false accept rate"); ax.set_ylabel("true accept rate")
        ax.legend(loc="lower right", fontsize=8)
    fig.tight_layout(); fig.savefig(path, dpi=150); plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="SMOKE TEST ONLY")
    a = ap.parse_args()
    hashes = {} if a.smoke else C.verify_stage_c()
    folder = os.path.join(C.OUT_C, "smoke") if a.smoke else C.OUT_C
    src = os.path.join(folder, "scores_C.json")
    out_json = os.path.join(folder, "stage_C.json")
    if not a.smoke and os.path.exists(out_json):
        raise SystemExit(f"{out_json} exists already; stage C is analysed once")
    d = json.load(open(src))
    if bool(d.get("smokeTest")) != a.smoke:
        raise SystemExit("smokeTest flag does not fit this run")
    LC.check_hashes(d, hashes, src)
    U = {s: C.units_from_json(d["systems"][s]) for s in SYSTEMS}
    targets = list(d["targets"])
    res = {**hashes, "protocol": "L", "stage": "C", "smokeTest": a.smoke, "scoresSha256": LC.sha(src),
           "nTargets": len(targets), "targets": targets, "q1": "not tested: L stopped at stage D", "lengths": {}}
    decs = {}
    for n in E.LENGTHS:
        ev = {s: C.evaluate(U[s], n) for s in SYSTEMS}
        decs[n] = {s: ev[s]["_dec"] for s in SYSTEMS}
        val = {s: [ev[s]["perUser"][t]["aucPct"] for t in targets] for s in SYSTEMS}
        res["lengths"][str(n)] = {"seconds": round(E.seconds(n), 2),
                                  "meanPerUserAuc": {s: float(np.nanmean(val[s])) for s in SYSTEMS},
                                  "F2-REF": boot(val["REF"], val["F2"]),
                                  "pooled": {s: ev[s]["pooled"] for s in SYSTEMS},
                                  "perUser": {s: dict(zip(targets, val[s])) for s in SYSTEMS},
                                  "tiesAtAuc1": {s: int(sum(abs(v - 1.0) < 1e-12 for v in val[s])) for s in SYSTEMS}}
    q2 = res["lengths"][str(LC.N_DEC)]["F2-REF"]
    res["Q2"] = {**q2, "margin": C.Q2_MARGIN, "holm": "family = {Q2}; interval unadjusted",
                 "nonInferior": bool(q2["ci95"][0] > C.Q2_MARGIN)}
    pb = pooled_boot(decs[LC.N_DEC]["REF"], decs[LC.N_DEC]["F2"], targets) if res["Q2"]["nonInferior"] else None
    res["keySecondary"] = {"tested": pb is not None, "pooledPctEer": pb["eer"] if pb else None,
                           "better": bool(pb and pb["eer"]["ci95"][1] < 0)}
    res["windowLevel"] = {s: window_level(U[s], targets) for s in SYSTEMS}
    res["liveLoop"] = {s: live_loop(U[s], targets) for s in SYSTEMS}
    res["deployedRule60"] = {s: deployed_rule(U[s], targets) for s in SYSTEMS}
    figure(os.path.join(folder, "stage_C_roc.png"), decs, targets, res["deployedRule60"])
    f = lambda c: f"{c['meanDiff']:+.4f} [{c['ci95'][0]:+.4f}, {c['ci95'][1]:+.4f}], better for {c['bBetter']}/{c['n']}"  # noqa: E731
    lines = [f"PROTOCOL L, STAGE C (Bogazici){'  [SMOKE TEST - NOT A RESULT]' if a.smoke else ''}",
             f"{len(targets)} targets; Q1 not tested (L stopped at stage D)", "",
             f"Q2  F2 - REF, per-user AUC of 33-window decisions: {f(q2)}",
             f"    non-inferior (lower bound > {C.Q2_MARGIN}): {'YES' if res['Q2']['nonInferior'] else 'NO'}; SE {q2['se']:.4f}, MDE80 {q2['mde80']:.4f}",
             "KEY SECONDARY  pooled pct EER F2 - REF: " + (
                 f"{pb['eer']['diff'] * 100:+.2f} pts [{pb['eer']['ci95'][0] * 100:+.2f}, {pb['eer']['ci95'][1] * 100:+.2f}] -> "
                 f"{'F2 better' if res['keySecondary']['better'] else 'not shown better'}" if pb else "not tested (Q2 failed)"), ""]
    for n, r in res["lengths"].items():
        lines.append(f"N = {n} windows: " + "; ".join(
            f"{s} per-user AUC {r['meanPerUserAuc'][s]:.4f}, pooled EER {r['pooled'][s]['pct']['eer'] * 100:.1f}%, "
            f"FRR@FAR1% {r['pooled'][s]['pct']['frrAtFar1'] * 100:.1f}%, FRR@FAR5% {r['pooled'][s]['pct']['frrAtFar5'] * 100:.1f}%"
            for s in SYSTEMS) + f" | F2 - REF {f(r['F2-REF'])}")
    for s in SYSTEMS:
        w, lp, dp = res["windowLevel"][s]["mean"], res["liveLoop"][s], res["deployedRule60"][s]
        lines.append(f"{s}: window AUC {w['auc']:.3f} EER {w['eer'] * 100:.1f}% | live loop {lp['promptsPer1000WindowsMean']:.2f} prompts per 1,000 windows "
                     f"({lp['promptsPerMinMean']:.2f}/min), "
                     f"runs caught {lp['runsCaughtMean'] * 100:.1f}%, never prompted {lp['usersNeverPrompted']}/{len(targets)} | "
                     f"60-window decisions FAR {dp['far'] * 100:.1f}% FRR {dp['frr'] * 100:.1f}%")
    txt = os.path.join(folder, "stage_C.txt")
    open(txt + ".tmp", "w").write("\n".join(lines) + "\n"); os.replace(txt + ".tmp", txt)
    LC.write_json(out_json, res, indent=1)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
