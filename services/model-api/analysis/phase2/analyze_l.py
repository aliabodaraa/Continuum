"""Protocol L, stage D analysis (PREREGISTRATION_L.md section 6).

    python analyze_l.py            # L/scores_D.json -> L/stage_D.json, stage_D.txt, stage_D_roc.png
    python analyze_l.py --smoke    # SMOKE TEST ONLY: the same under L/smoke/

Primary endpoint: the mean over targets of the paired difference in per-user AUC of 9.9-s decisions
(N = 33, pct, eval_decision_level.py unchanged), bootstrap over targets (10,000 resamples, seed 17).
A target's value is the mean over REF's three sample orders and over L's three seeds.
Kill criterion: L goes on to stage C only if the lower 95% bound of L - REF is > 0.
Also reported: F2 - REF and L - F2.

Reported, deciding nothing: N = 15 and 60; window AUC, EER and TAR@FAR 1%; pooled pct and vote EER,
AUC and FRR at FAR 1% and 5% (cluster bootstrap over targets for the pct differences at N = 33); L per
seed; per-user values, the worst 10% of targets and the known weak development users; ties at AUC 1.0;
the live loop at each system's own operating point (20th percentile of its threshold-source scores,
33 of the last 60 windows below it, one check per 6 windows): prompts per minute and impostor runs
caught; L with centroid cosine; the pooled ROC of pct decisions with each system's deployed rule marked.

Why two kinds of numbers: EER and ROC AUC need a continuous score but no threshold. The pct statistic
(each window's percentile within the target's own threshold-source scores, averaged over the decision)
is that score. The deployed rule's fixed threshold is reported separately, as one operating point.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402
import eval_decision_level as E  # noqa: E402
import p1lib as P  # noqa: E402

SYSTEMS = ("REF", "F2", "L", "Lcos")
LABEL = {"REF": "REF (S1, per-user fine-tuning)", "F2": "F2 (frozen base-80 + head)",
         "L": "L (metric embedding + head)", "Lcos": "L, centroid cosine (reference)"}
CONTRASTS = (("L", "REF"), ("F2", "REF"), ("L", "F2"))
WEAK = ("user91", "user70", "user1", "user16")
B_POOLED = 10000                              # as the primary endpoint (section 6); smoke tests may lower it


def load(smoke, amended=None):
    folder = LC.SMOKE if smoke else LC.OUT
    path = os.path.join(folder, "scores_D.json")
    if not os.path.exists(path):
        raise SystemExit(f"{path} missing: run score_l.py first")
    d = json.load(open(path))
    hashes = LC.verify_frozen()
    LC.check_hashes(d, hashes, path)
    if bool(d.get("smokeTest")) != smoke:
        raise SystemExit(f"{path}: smokeTest={d.get('smokeTest')} does not fit this run")
    sel_path = os.path.join(LC.SMOKE, "SELECTION_L.SMOKE.json") if smoke else LC.SELECTION
    if LC.sha(sel_path) != d["selectionSha256"]:
        raise SystemExit(f"{path} was scored under another {os.path.basename(sel_path)}")
    code = LC.check_code(LC.load_selection(sel_path, allow_smoke=smoke), amended)
    V = {}
    for s in SYSTEMS:
        V[s] = {}
        for v, units in d["systems"][s].items():
            U = LC.units_from_json(units)
            for u in U.values():                   # every system: tau from its own stored threshold source
                u["tau"] = float(np.percentile(u["ref"], LC.Q_TAU))
            V[s][v] = U
    return folder, path, d, hashes, V, code


def boot(a, b):
    """p1lib.boot (b - a; 10,000 resamples over targets, seed 17) plus its SE and MDE80 = 2.8 x SE."""
    res = P.boot(a, b)
    a, b = np.asarray(a, float), np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    dd = b[ok] - a[ok]
    st = dd[np.random.default_rng(17).integers(0, len(dd), (P.N_BOOT, len(dd)))].mean(1)
    res["se"] = float(st.std(ddof=1))
    res["mde80"] = 2.8 * res["se"]
    return res


def per_user_auc(V, targets, n):
    """{system: {target: mean over variants of per-user pct AUC}}, per variant, and the raw decisions."""
    val, per_var, decs = {}, {}, {}
    for s, vs in V.items():
        per_var[s], decs[s] = {}, {}
        for v, U in vs.items():
            ev = E.evaluate(U, n)
            per_var[s][v] = {u: ev["perUser"][u]["aucPct"] for u in targets}
            decs[s][v] = ev["_dec"]
        val[s] = {u: float(np.nanmean([per_var[s][v][u] for v in vs])) for u in targets}
    return val, per_var, decs


def pooled_avg(decs_s, pick):
    out = {}
    for st in ("pct", "vote"):
        ms = [E.pooled_metrics(dv, pick)[st] for dv in decs_s.values()]
        out[st] = {k: float(np.mean([m[k] for m in ms])) for k in ms[0]}
    return out


def pooled_boot(decs_a, decs_b, users, B=B_POOLED, seed=17):
    """Cluster bootstrap over targets of pooled pct metrics (b - a), averaged over variants."""
    rng = np.random.default_rng(seed)
    base_a, base_b = pooled_avg(decs_a, users)["pct"], pooled_avg(decs_b, users)["pct"]
    diffs = {k: [] for k in base_a}
    for _ in range(B):
        pick = [users[j] for j in rng.integers(0, len(users), len(users))]
        xa, xb = pooled_avg(decs_a, pick)["pct"], pooled_avg(decs_b, pick)["pct"]
        for k in diffs:
            diffs[k].append(xb[k] - xa[k])
    res = {}
    for k in base_a:
        dd = np.asarray(diffs[k])
        res[k] = {"a": base_a[k], "b": base_b[k], "diff": base_b[k] - base_a[k],
                  "ci95": [float(np.percentile(dd, 2.5)), float(np.percentile(dd, 97.5))],
                  "p": float(min(1.0, 2 * min((dd <= 0).mean(), (dd >= 0).mean())))}
    return res


def window_level(V, targets):
    out = {}
    for s, vs in V.items():
        rows = {u: {"auc": [], "eer": [], "tar01": []} for u in targets}
        for U in vs.values():
            for u in targets:
                g = np.asarray(U[u]["genuine"], float)
                imp = np.concatenate([np.asarray(r, float) for r in U[u]["runs"].values()])
                rows[u]["auc"].append(P.auc_of(g, imp))
                rows[u]["eer"].append(P.eer_of(g, imp)[0])
                rows[u]["tar01"].append(P.tar_at_far(g, imp, 0.01)[0])
        per = {u: {k: float(np.nanmean(x)) for k, x in r.items()} for u, r in rows.items()}
        out[s] = {"mean": {k: float(np.mean([per[u][k] for u in targets])) for k in ("auc", "eer", "tar01")},
                  "median": {k: float(np.median([per[u][k] for u in targets])) for k in ("auc", "eer", "tar01")},
                  "perUser": per}
    return out


def operating_point(V, targets):
    """The live loop (protocol_j_common.replay): vote 33 of 60 below tau, a check every 6 windows,
    the buffer empties after a prompt; whole genuine session and every impostor run."""
    out = {}
    for s, vs in V.items():
        sums = []
        for U in vs.values():
            res = {u: P.per_user({"g": np.asarray(U[u]["genuine"], float),
                                  "runs": {o: np.asarray(r, float) for o, r in U[u]["runs"].items()}},
                                 U[u]["tau"], "vote", LC.VOTE_N, LC.VOTE_K) for u in targets}
            sums.append(P.summary(res))
        keys = [k for k in sums[0] if sums[0][k] is not None]
        out[s] = {k: float(np.mean([x[k] for x in sums if x[k] is not None])) for k in keys}
    return out


def deployed_point(V, targets):
    """The deployed rule on step-disjoint 60-window decisions: FAR = share of impostor decisions
    accepted (fewer than 33 of 60 below tau), FRR = share of genuine decisions rejected; pooled."""
    out = {}
    for s, vs in V.items():
        far, frr = [], []
        for U in vs.values():
            g_rej, g_n, i_acc, i_n = 0, 0, 0, 0
            for u in targets:
                t = U[u]["tau"]
                for b in E.blocks(U[u]["genuine"], LC.VOTE_N):
                    g_n += 1; g_rej += int((b < t).sum() >= LC.VOTE_K)
                for r in U[u]["runs"].values():
                    for b in E.blocks(r, LC.VOTE_N):
                        i_n += 1; i_acc += int((b < t).sum() < LC.VOTE_K)
            far.append(i_acc / max(i_n, 1)); frr.append(g_rej / max(g_n, 1))
        out[s] = {"far": float(np.mean(far)), "frr": float(np.mean(frr))}
    return out


def roc_points(decs_s, users):
    """The plotted curve pools the decisions of all variants (orders or seeds); its AUC is that curve's."""
    g = np.concatenate([np.concatenate([dv[u]["g"]["pct"] for u in users]) for dv in decs_s.values()])
    i = np.concatenate([np.concatenate([dv[u]["i"]["pct"] for u in users]) for dv in decs_s.values()])
    ths = np.unique(np.concatenate([g, i, [0.0, 1.0 + 1e-9]]))[::-1]
    far = np.array([(i >= t).mean() for t in ths])
    tar = np.array([(g >= t).mean() for t in ths])
    return far, tar, E.auc_fast(g, i)


def saturation(V, targets):
    """Share of window scores at exactly 1.0 (ties that no threshold can split), per system."""
    out = {}
    for s, vs in V.items():
        x = np.concatenate([np.concatenate([U[u]["genuine"], *U[u]["runs"].values()]) for U in vs.values() for u in targets])
        out[s] = float((x >= 1.0).mean())
    return out


def figure(path, curves, points, aucs):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    col = {"REF": "#444444", "F2": "#1f77b4", "L": "#d62728", "Lcos": "#d62728"}
    fig, axes = plt.subplots(1, 2, figsize=(11, 5))
    for ax, n in zip(axes, (LC.N_DEC, LC.VOTE_N)):
        for s in SYSTEMS:
            far, tar, _ = curves[n][s]
            ax.plot(far, tar, color=col[s], lw=1.0 if s == "Lcos" else 1.8, ls="--" if s == "Lcos" else "-",
                    label=f"{LABEL[s]}  AUC {aucs[n][s]:.3f}")
        if n == LC.VOTE_N:
            for s in ("REF", "F2", "L"):
                p = points[s]
                ax.plot(p["far"], 1 - p["frr"], "o", color=col[s], ms=8, mfc="white", mew=2)
            ax.plot([], [], "o", color="k", mfc="white", mew=2, label="each system's rule: 20th pct, 33 of 60")
        ax.plot([0, 1], [0, 1], color="#bbbbbb", lw=0.8)
        ax.set_xlabel("false accept rate (impostor decisions accepted)")
        ax.set_ylabel("true accept rate (genuine decisions accepted)")
        ax.set_title(f"{round(E.seconds(n), 2):g}-s decisions (N = {n}), pooled pct score")
        ax.legend(loc="lower right", fontsize=7.5)
        ax.set_xlim(-0.01, 1.01); ax.set_ylim(-0.01, 1.01)
    fig.suptitle("Protocol L, stage D: threshold-free ROC; the fixed-threshold rule is one point", fontsize=11)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="SMOKE TEST ONLY")
    ap.add_argument("--amended", default=None, help="the amendment that changed code frozen in SELECTION_L.json")
    a = ap.parse_args()
    global B_POOLED
    if a.smoke:
        B_POOLED = int(os.environ.get("B_POOLED", B_POOLED))
    folder, path, d, hashes, V, code = load(a.smoke, a.amended)
    out_json = os.path.join(folder, "stage_D.json")
    if not a.smoke and os.path.exists(out_json):
        raise SystemExit(f"{out_json} exists already; stage D is analysed once")
    targets = list(d["targets"])
    res = {**hashes, "protocol": "L", "stage": "D", "smokeTest": a.smoke, "scoresSha256": LC.sha(path),
           "selectionSha256": d["selectionSha256"], "code": code, "scoringCode": d.get("code"),
           "nTargets": len(targets), "targets": targets,
           "variants": {s: sorted(V[s]) for s in SYSTEMS}, "lengths": {}}
    curves, aucs = {}, {}
    for n in E.LENGTHS:
        val, per_var, decs = per_user_auc(V, targets, n)
        row = {"seconds": round(E.seconds(n), 2),
               "meanPerUserAuc": {s: float(np.nanmean(list(val[s].values()))) for s in SYSTEMS},
               "contrasts": {f"{x}-{y}": boot([val[y][u] for u in targets], [val[x][u] for u in targets])
                             for x, y in CONTRASTS + (("Lcos", "REF"),)},
               "pooled": {s: pooled_avg(decs[s], targets) for s in SYSTEMS},
               "perUser": val}
        if n == LC.N_DEC:
            row["pooledContrasts"] = {f"{x}-{y}": pooled_boot(decs[y], decs[x], targets, B=B_POOLED) for x, y in CONTRASTS}
            row["pooledBootstrap"] = {"resamples": B_POOLED, "seed": 17, "unit": "targets (cluster)"}
            row["lPerSeed"] = {v: {"meanPerUserAuc": float(np.nanmean(list(per_var["L"][v].values()))),
                                   "vsREF": boot([val["REF"][u] for u in targets], [per_var["L"][v][u] for u in targets])}
                               for v in sorted(per_var["L"])}
            k = max(1, int(np.ceil(0.1 * len(targets))))
            row["worst10pct"] = {s: sorted([kv for kv in val[s].items() if np.isfinite(kv[1])], key=lambda kv: kv[1])[:k]
                                 for s in SYSTEMS}
            row["knownWeak"] = {u: {s: val[s][u] for s in SYSTEMS} for u in WEAK if u in val["REF"]}
            row["tiesAtAuc1"] = {**{s: int(sum(abs(val[s][u] - 1.0) < 1e-12 for u in targets)) for s in SYSTEMS},
                                 "L_and_REF": int(sum(abs(val["L"][u] - 1.0) < 1e-12 and abs(val["REF"][u] - 1.0) < 1e-12
                                                      for u in targets))}
        if n in (LC.N_DEC, LC.VOTE_N):
            curves[n] = {s: roc_points(decs[s], targets) for s in SYSTEMS}
            aucs[n] = {s: curves[n][s][2] for s in SYSTEMS}
        res["lengths"][str(n)] = row
    prim = res["lengths"][str(LC.N_DEC)]["contrasts"]["L-REF"]
    res["primary"] = {"endpoint": "mean paired difference in per-user AUC of 9.9-s decisions (pct), L - REF",
                      **prim, "killCriterion": "lower 95% bound > 0", "passesToStageC": bool(prim["ci95"][0] > 0)}
    res["windowLevel"] = window_level(V, targets)
    res["operatingPoint"] = operating_point(V, targets)
    res["deployedRuleOn60WindowDecisions"] = deployed_point(V, targets)
    res["scoresAtExactly1"] = saturation(V, targets)
    res["notes"] = {"precision": d.get("precision"),
                    "rocFigure": "curves pool all variants' decisions; legend AUC = the plotted curve's AUC"}
    fig_path = os.path.join(folder, "stage_D_roc.png")
    figure(fig_path, curves, res["deployedRuleOn60WindowDecisions"], aucs)
    lines = report(res)
    txt = os.path.join(folder, "stage_D.txt")
    open(txt + ".tmp", "w").write("\n".join(lines) + "\n")
    os.replace(txt + ".tmp", txt)
    LC.write_json(out_json, res, indent=1)
    print("\n".join(lines))
    print(f"\nwrote {out_json}, stage_D.txt, {os.path.basename(fig_path)}")


def report(res):
    f = lambda c: f"{c['meanDiff']:+.4f} [{c['ci95'][0]:+.4f}, {c['ci95'][1]:+.4f}] p {c['p']:.3f}, better for {c['bBetter']}/{c['n']}"  # noqa: E731
    p = res["primary"]
    out = [f"PROTOCOL L, STAGE D{'  [SMOKE TEST - NOT A RESULT]' if res['smokeTest'] else ''}",
         f"{res['nTargets']} targets; REF = mean over {len(res['variants']['REF'])} sample orders, "
         f"L = mean over {len(res['variants']['L'])} seeds",
         "",
         f"PRIMARY  L - REF, per-user AUC of 9.9-s decisions (pct): {f(p)}",
         f"         kill criterion (lower 95% bound > 0): {'PASSED -> stage C tests Q1' if p['passesToStageC'] else 'NOT PASSED -> L stops here'}",
         f"         SE {p['se']:.4f}, MDE80 {p['mde80']:.4f}"]
    for n, r in res["lengths"].items():
        out.append("")
        out.append(f"N = {n} ({r['seconds']:.1f} s)" + ("  <- primary length" if int(n) == LC.N_DEC else "  (reported)"))
        for s in SYSTEMS:
            pp = r["pooled"][s]["pct"]
            out.append(f"  {LABEL[s]:34s} per-user AUC {r['meanPerUserAuc'][s]:.4f}   pooled pct: EER {pp['eer'] * 100:5.2f}%  "
                     f"AUC {pp['auc']:.4f}  FRR@FAR1% {pp['frrAtFar1'] * 100:5.1f}%  FRR@FAR5% {pp['frrAtFar5'] * 100:5.1f}%")
        for k, c in r["contrasts"].items():
            out.append(f"  {k:9s} per-user AUC {f(c)}")
        if "pooledContrasts" in r:
            for k, c in r["pooledContrasts"].items():
                e = c["eer"]
                out.append(f"  {k:9s} pooled pct EER {e['diff'] * 100:+.2f} pts [{e['ci95'][0] * 100:+.2f}, {e['ci95'][1] * 100:+.2f}]")
            for v, x in r["lPerSeed"].items():
                out.append(f"  L {v}: per-user AUC {x['meanPerUserAuc']:.4f}; vs REF {f(x['vsREF'])}")
            out.append("  worst 10% of targets: " + "; ".join(f"{s}: " + ", ".join(f"{u} {v:.3f}" for u, v in r["worst10pct"][s]) for s in SYSTEMS))
            if r["knownWeak"]:
                out.append("  known weak users: " + "; ".join(f"{u} " + " ".join(f"{s} {v:.3f}" for s, v in x.items()) for u, x in r["knownWeak"].items()))
            out.append("  ties at AUC 1.0: " + ", ".join(f"{k} {v}" for k, v in r["tiesAtAuc1"].items()))
    out.append("")
    out.append("WINDOW LEVEL (mean over targets): " + "; ".join(
        f"{s} AUC {w['mean']['auc']:.3f} EER {w['mean']['eer'] * 100:.1f}% TAR@FAR1% {w['mean']['tar01'] * 100:.1f}%"
        for s, w in res["windowLevel"].items()))
    out.append("SCORES AT EXACTLY 1.0 (unsplittable ties): " + ", ".join(f"{s} {v * 100:.2f}%" for s, v in res["scoresAtExactly1"].items()))
    out.append("")
    out.append("OPERATING POINT (live loop: 20th percentile of each system's own threshold-source scores, 33 of 60, check every 6 windows)")
    for s, o in res["operatingPoint"].items():
        dp = res["deployedRuleOn60WindowDecisions"][s]
        out.append(f"  {LABEL[s]:34s} prompts/min {o['promptsPerMinMean']:.2f}  runs caught {o['impostorRunsCaught'] * 100:5.1f}%  "
                 f"users never prompted {o['usersNeverPrompted'] * 100:5.1f}%  | 17.2-s decisions: FAR {dp['far'] * 100:.1f}%  FRR {dp['frr'] * 100:.1f}%")
    return out


if __name__ == "__main__":
    main()
