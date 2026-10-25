"""Experiment MC: how much mouse enrolment the deployed classifier needs (artifacts/phase7/PREREGISTRATION_MC.md).

Owner, 22 Oct 2026: "can you try the mouse sample-entry interface and judge whether it is enough to train the model ...
we want to show why we chose a certain number of training samples". Paper Table 6's system (experiment FS: the base-80
network trained with SapiMouse's settings, the F2 head, the 19 development targets), with the enrolment cut to the first
M windows of the 3-minute session: M = 110 to 440 (2 to 8 samples) and FULL (the whole session in whole samples).
Every budget goes through l_common.head_scores, the same code as score_fs.py, and M = 440 must reproduce the stored FS
units. Each M is compared with FULL on per-user AUC of 60-window decisions, live prompts per minute and impostor runs
caught, paired bootstrap over the users, with P3's margins (the reading rule is in the pre-registration).

    python services/model-api/analysis/phase7/run_mc.py --threads 6     # artifacts/phase7/mc_result.json / .txt
"""
import argparse
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase2")))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase6")))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402
import analyze_l as A  # noqa: E402
import mouse_decision_length as MDL  # noqa: E402
import mouse_live_decision_length as MLD  # noqa: E402
import train_fs as T  # noqa: E402

PREREG = "/app/artifacts/phase7/PREREGISTRATION_MC.md"
OUT = "/app/artifacts/phase7"
BUDGETS = (110, 165, 220, 275, 330, 385, 440)
N, K = 60, 33
B, SEED = 10000, 17
MARGIN_AUC, MARGIN_CAUGHT, MARGIN_PROMPTS, SATURATION = -0.02, -0.05, 0.1, -0.005


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def boot(d):
    d = np.asarray(d, float)
    m = d[np.random.default_rng(SEED).integers(0, len(d), (B, len(d)))].mean(1)
    return {"mean": float(d.mean()), "lo": float(np.percentile(m, 2.5)), "hi": float(np.percentile(m, 97.5)), "n": len(d)}


def live_per_user(U, targets):
    out = {}
    for u in targets:
        v = MLD.P.per_user({"g": np.asarray(U[u]["genuine"], float),
                            "runs": {o: np.asarray(r, float) for o, r in U[u]["runs"].items()}},
                           U[u]["tau"], "vote", N, K, MLD.CADENCE)
        out[u] = {"prompts": float(v["promptsPerMin"]), "caught": float(np.mean(v["caught"]))}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=6)
    a = ap.parse_args()
    prereg = sha(PREREG)
    if prereg != open(PREREG.replace(".md", ".sha256")).read().split()[0]:
        raise SystemExit("PREREGISTRATION_MC.md changed after it was frozen")
    import tensorflow as tf
    tf.config.threading.set_intra_op_parallelism_threads(a.threads)

    m = tf.keras.models.load_model(os.path.join(T.NET, "final_model"), compile=False)
    emb = LC.embedder_from(tf.keras.Model(m.input, m.get_layer("embedding").output), LC.load_scaler())
    j, _ = LC.splits()
    W = LC.Windows("MC")
    dev = list(j["development"])
    targets = sorted([u for u in dev if len(W.get(u, "long")) >= LC.BUDGET], key=lambda u: int(u[4:]))
    pool = [u for u in dev if len(W.get(u, "short"))]
    mu, C = LC.cohort(emb, W, LC.base80_users())
    Z = {u: LC.unit(emb(W.get(u, "short")) - mu) for u in sorted(set(targets) | set(pool))}
    long_ = {u: W.get(u, "long") for u in targets}
    full = {u: (len(long_[u]) // LC.SAMPLE) * LC.SAMPLE for u in targets}
    plan = {str(b): {u: b for u in targets} for b in BUDGETS}
    plan["FULL"] = full

    units = {}
    for name, per in plan.items():
        U = {}
        for u in targets:
            E_enrol = LC.unit(emb(long_[u][:per[u]]) - mu)      # embedded exactly as score_targets does
            tests = {"genuine": Z[u], **{o: Z[o][:LC.IMP_RUN] for o in pool if o != u and len(Z[o])}}
            s, ref = LC.head_scores(E_enrol, C, tests)
            U[u] = LC._unit_of(s, ref)
        LC.check_finite(U, f"MC {name}")
        units[name] = U
        print(f"[MC] budget {name}: {len(U)} users scored", flush=True)

    # validity: M = 440 is Table 6's own system, so it must reproduce the stored FS units
    fs = LC.units_from_json(json.load(open(os.path.join(T.OUT, "scores_FS.json")))["units"])
    worst = max(float(np.max(np.abs(np.asarray(units["440"][u][k], float) - np.asarray(fs[u][k], float))))
                for u in targets for k in ("genuine", "ref"))
    if worst > 1e-6:
        raise SystemExit(f"M = 440 does not reproduce the stored FS units (max difference {worst:.2e})")

    rows, per_user = {}, {}
    for name, U in units.items():
        val, _pv, decs = A.per_user_auc({name: {"m": U}}, targets, N)
        far, frr = MDL.rates({"m": U}, targets, N, K)
        lv = live_per_user(U, targets)
        per_user[name] = {u: {"auc": val[name][u], **lv[u]} for u in targets}
        windows = [plan[name][u] for u in targets]
        rows[name] = {"windowsMean": float(np.mean(windows)), "samplesMean": float(np.mean(windows)) / LC.SAMPLE,
                      "secondsMean": float(np.mean([(40 + 10 * w) * MLD.P.SEC_PER_WINDOW / 10 for w in windows])),
                      "perUserAuc": float(np.mean([val[name][u] for u in targets])), "far": far, "frr": frr,
                      "pooledEer": float(A.pooled_avg(decs[name], targets)["pct"]["eer"]),
                      "promptsPerMin": float(np.nanmean([lv[u]["prompts"] for u in targets])),
                      "runsCaught": float(np.mean([lv[u]["caught"] for u in targets]))}

    def against(ref_name):
        out = {}
        for name in units:
            if name == ref_name:
                continue
            d = {k: boot([per_user[name][u][k] - per_user[ref_name][u][k] for u in targets])
                 for k in ("auc", "prompts", "caught")}
            d["meetsMargins"] = bool(d["auc"]["lo"] >= MARGIN_AUC and d["caught"]["lo"] >= MARGIN_CAUGHT
                                     and d["prompts"]["hi"] <= MARGIN_PROMPTS)
            d["saturated"] = bool(d["auc"]["lo"] > SATURATION)
            out[name] = d
        return out

    vs_full, vs_440 = against("FULL"), against("440")
    enough = next((b for b in map(str, BUDGETS) if vs_full[b]["meetsMargins"]), None)
    saturation = next((b for b in map(str, BUDGETS) if vs_full[b]["saturated"]), None)
    res = {"what": "experiment MC, the mouse enrolment curve of the deployed classifier (Table 6's system)",
           "preregistrationMcSha256": prereg, "network": T.NET, "users": len(targets), "decision": {"windows": N, "low": K},
           "fullWindowsPerUser": full, "validityMaxDifferenceAt440": worst, "rows": rows, "againstFull": vs_full,
           "against440": vs_440, "enoughBudget": enough, "saturationBudget": saturation, "perUser": per_user}
    json.dump(res, open(os.path.join(OUT, "mc_result.json"), "w"), indent=1)

    L = [f"EXPERIMENT MC (prereg {prereg[:12]}): mouse enrolment curve, {len(targets)} development users, "
         f"60-window decisions, 33 low; M = 440 reproduces Table 6's units (max difference {worst:.1e})",
         f"{'budget':>6} {'samples':>7} {'move s':>6} {'AUC':>6} {'FAR':>6} {'FRR':>6} {'EER':>6} {'prompts/min':>11} "
         f"{'caught':>7} | AUC vs FULL [95%]  prompts vs FULL  caught vs FULL  margins"]
    for name, r in rows.items():
        d = vs_full.get(name)
        cmp = "" if d is None else (
            f" | {d['auc']['mean']:+.4f} [{d['auc']['lo']:+.4f}, {d['auc']['hi']:+.4f}]  "
            f"{d['prompts']['mean']:+.2f} (hi {d['prompts']['hi']:+.2f})  "
            f"{d['caught']['mean'] * 100:+.1f} (lo {d['caught']['lo'] * 100:+.1f})  {'MET' if d['meetsMargins'] else 'not met'}")
        L.append(f"{name:>6} {r['samplesMean']:7.1f} {r['secondsMean']:6.0f} {r['perUserAuc']:6.3f} {r['far'] * 100:5.1f}% "
                 f"{r['frr'] * 100:5.1f}% {r['pooledEer'] * 100:5.1f}% {r['promptsPerMin']:11.2f} {r['runsCaught'] * 100:6.1f}%{cmp}")
    L.append(f"ENOUGH (smallest budget meeting P3's margins against FULL): {enough or 'none below FULL'}")
    L.append(f"SATURATION (AUC lower bound against FULL above -0.005): {saturation or 'none below FULL'}")
    txt = "\n".join(L)
    open(os.path.join(OUT, "mc_result.txt"), "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
