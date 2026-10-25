"""Experiment FS, step 2: protocol L stage D's F2 path with the SapiMouse-trained network, against the stored F2
(artifacts/phase7/PREREGISTRATION_FS.md sections 3 and 4).

    python services/model-api/analysis/phase7/score_fs.py --threads 6
    python services/model-api/analysis/phase7/score_fs.py --smoke          # SMOKE TEST ONLY: the 1-epoch smoke network

The new network's GAP output goes through l_common.score_targets exactly as score_l.py's F2: the 19 development targets,
the development users' one-minute sessions as impostor runs, the 80 base users as the cohort, 440 enrolment windows, the
reference base-80 scaler (train_fs.py checked it is the same), and the threshold at the 20th percentile of the
leave-one-sample-out scores. The stored F2 units come from analyze_l.load (scores_D.json). Primary: the paired
difference in per-user AUC of 60-window decisions with a bootstrap interval over the targets (10,000, seed 17);
non-inferior if the lower bound is above -0.010.
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "phase2")))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402
import analyze_l as A  # noqa: E402
import p1lib as P  # noqa: E402
import train_fs as T  # noqa: E402

B, SEED, MARGIN, LENGTHS = 10000, 17, -0.010, (15, 33, 60)


def boot(d):
    d = np.asarray(d, float)
    m = d[np.random.default_rng(SEED).integers(0, len(d), (B, len(d)))].mean(1)
    return {"mean": float(d.mean()), "lo": float(np.percentile(m, 2.5)), "hi": float(np.percentile(m, 97.5)),
            "higherFor": int((d > 0).sum()), "lowerFor": int((d < 0).sum()), "n": len(d)}


def live(units, targets):
    per = {u: P.per_user({"g": np.asarray(units[u]["genuine"], float),
                          "runs": {o: np.asarray(r, float) for o, r in units[u]["runs"].items()}},
                         units[u]["tau"], "vote", LC.VOTE_N, LC.VOTE_K) for u in targets}
    caught = [c for v in per.values() for c in v["caught"]]
    times = [t for v in per.values() for t in v["times"]]
    return {"promptsPerMinMean": float(np.nanmean([v["promptsPerMin"] for v in per.values()])),
            "usersNeverPrompted": float(np.mean([v["prompts"] == 0 for v in per.values()])),
            "impostorRunsCaught": float(np.mean(caught)), "timeToCatchMeanS": float(np.mean(times)) if times else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=6)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    hashes = {} if a.smoke else T.verify_frozen()
    import tensorflow as tf
    tf.config.threading.set_intra_op_parallelism_threads(a.threads)
    net = os.path.join(T.OUT, "smoke_net") if a.smoke else T.NET
    info = json.load(open(os.path.join(net, "results.json")))
    if not a.smoke and info.get("preregistrationFsSha256") != hashes["preregistrationFsSha256"]:
        raise SystemExit("the network was trained under another pre-registration")

    m = tf.keras.models.load_model(os.path.join(net, "final_model"), compile=False)
    emb = LC.embedder_from(tf.keras.Model(m.input, m.get_layer("embedding").output), LC.load_scaler())
    j, _ = LC.splits()
    W = LC.Windows("FS stage D")
    dev = list(j["development"])
    targets = sorted([u for u in dev if len(W.get(u, "long")) >= LC.BUDGET], key=lambda u: int(u[4:]))
    pool = [u for u in dev if len(W.get(u, "short"))]
    units = LC.score_targets(emb, W, targets, pool, LC.base80_users())
    LC.check_finite(units, "FS")
    for u in units.values():
        u["tau"] = float(np.percentile(u["ref"], LC.Q_TAU))

    folder, path, d, _h, V, _code = A.load(False, None)
    f2 = V["F2"]
    for U in f2.values():                               # section 5: the same streams as the stored F2
        if sorted(U) != sorted(units):
            raise SystemExit("targets differ from the stored F2")
        for u in targets:
            if len(U[u]["genuine"]) != len(units[u]["genuine"]) or sorted(U[u]["runs"]) != sorted(units[u]["runs"]) or \
                    any(len(U[u]["runs"][o]) != len(units[u]["runs"][o]) for o in units[u]["runs"]):
                raise SystemExit(f"{u}: streams differ from the stored F2")
    Vc = {"F2": f2, "FS": {"fs": units}}

    res = {**hashes, "smokeTest": a.smoke, "targets": len(targets), "auc": {}, "deployed": A.deployed_point(Vc, targets),
           "live": {"F2": float("nan")}, "identificationTop1": {
               "FS": info["identificationTop1"],
               "F2": json.load(open(os.path.join(T.REF, "results.json")))["identificationTop1"]},
           "fsTraining": {k: info[k] for k in ("epochsRun", "bestEpoch", "bestValLoss", "minutes", "recipe")}}
    for n in LENGTHS:
        val, _pv, _dec = A.per_user_auc(Vc, targets, n)
        res["auc"][str(n)] = {"F2": float(np.mean([val["F2"][u] for u in targets])),
                              "FS": float(np.mean([val["FS"][u] for u in targets])),
                              "pairedFsMinusF2": boot([val["FS"][u] - val["F2"][u] for u in targets])}
    res["live"] = {"F2": live(next(iter(f2.values())), targets), "FS": live(units, targets)}
    p = res["auc"]["60"]["pairedFsMinusF2"]
    res["nonInferior"] = bool(p["lo"] > MARGIN)

    out_dir = os.path.join(T.OUT, "smoke" if a.smoke else "")
    os.makedirs(out_dir, exist_ok=True)
    json.dump({"units": LC.units_to_json(units)}, open(os.path.join(out_dir, "scores_FS.json"), "w"))
    out = os.path.join(T.ROOT, "artifacts", "phase7", "fs_smoke_result" if a.smoke else "fs_result")
    json.dump(res, open(out + ".json", "w"), indent=1)
    L = [f"EXPERIMENT FS ({'SMOKE TEST' if a.smoke else 'frozen run'}): base-80 FCN trained with SapiMouse's settings vs the "
         f"deployed recipe, stage D F2 path, {len(targets)} development users"]
    for n in LENGTHS:
        r = res["auc"][str(n)]; q = r["pairedFsMinusF2"]
        L.append(f"  {n:>2}-window decisions: per-user AUC F2 {r['F2']:.4f}  FS {r['FS']:.4f}  FS-F2 {q['mean']:+.4f} "
                 f"[{q['lo']:+.4f}, {q['hi']:+.4f}] (higher for {q['higherFor']}, lower for {q['lowerFor']})")
    for s in ("F2", "FS"):
        dp, lv = res["deployed"][s], res["live"][s]
        L.append(f"  {s}: deployed rule FAR {dp['far'] * 100:.1f}% FRR {dp['frr'] * 100:.1f}% | live loop {lv['promptsPerMinMean']:.2f}/min, "
                 f"never asked {lv['usersNeverPrompted'] * 100:.0f}%, runs caught {lv['impostorRunsCaught'] * 100:.1f}%, "
                 f"time to catch {lv['timeToCatchMeanS']:.1f} s | identification top-1 {res['identificationTop1'][s]:.4f}")
    L.append(f"  FS training: {info['epochsRun']} epochs, best {info['bestEpoch']}, {info['minutes']:.0f} min")
    L.append(f"  primary (60 windows, margin {MARGIN}): {'NON-INFERIOR' if res['nonInferior'] else 'not shown non-inferior'}")
    txt = "\n".join(L)
    open(out + ".txt", "w", encoding="utf-8").write(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
