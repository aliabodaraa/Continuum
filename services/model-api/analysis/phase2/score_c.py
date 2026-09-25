"""Protocol L, stage C scoring on Bogazici (PREREGISTRATION_L.md sections 3, 5; Amendments L-1, L-2).

    python score_c.py --threads 8       # -> artifacts/phase2/L/stageC/scores_C.json (written once)
    python score_c.py --smoke           # SMOKE TEST ONLY: synthetic sessions, under L/stageC/smoke/

Refuses to run unless Amendments L-1 and L-2 exist and every stage-C file matches AMENDMENT_L2.sha256.

Per eligible Bogazici user (Amendment L-1 fixes eligibility, sessions and impostor sources):
  enrolment  the first 440 windows of the training sessions, in time order (8 samples of 55)
  genuine    the user's own test sessions (label 0) after enrolment, session by session
  impostors  the unauthorised sessions of the user's test folders (label 1), each cut at 150 windows
Systems (section 3):
  REF  S1 exactly as deployed: api.train_user_loso_payload with mouse.js's payload on the deployed
       base-100 network, scaler and negatives; the 440 leave-one-sample-out scores are the threshold
       source; api.predict_user_payload scores the test windows. The per-user model is deleted after.
  F2   the same network frozen (c_common: base-100 cohort, logistic head, leave-one-sample-out).
"""
import argparse
import os
import shutil
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import l_common as LC  # noqa: E402
import c_common as C  # noqa: E402

def score_ref(api, t, enrol, tests):
    """S1 as deployed. Returns the LOSO scores and {name: [scores per session]}."""
    mpath = os.path.join(C.OUT_C, "models", t, "mouse_model")
    shutil.rmtree(os.path.dirname(mpath), ignore_errors=True)
    res, code = api.train_user_loso_payload({**C.REF_PAYLOAD, "userId": f"bogazici-{t}", "modelPath": mpath,
                                             "positiveWindows": np.asarray(enrol).tolist()})
    if code != 200:
        raise SystemExit(f"{t}: REF training failed ({code}): {res.get('error')} (technical failure: re-run, log it)")
    if res.get("negativeSource") != "dataset":
        raise SystemExit(f"{t}: REF trained without the deployed negatives file ({res.get('negativeSource')}, "
                         f"{res.get('datasetNegativeError')})")

    def pred(X):
        if not len(X):
            return np.zeros(0)
        r, c = api.predict_user_payload({"userId": f"bogazici-{t}", "modality": "mouse", "modelPath": mpath,
                                         "windows": np.asarray(X).tolist()})
        if c != 200:
            raise SystemExit(f"{t}: REF prediction failed ({c}): {r.get('error')}")
        return np.asarray([float(p[1]) for p in r["prediction"]])
    out = {k: [pred(s) for s in v] for k, v in tests.items()}
    api.invalidate_user_model_cache(mpath)
    shutil.rmtree(os.path.dirname(mpath), ignore_errors=True)
    return np.asarray(res["losoScores"], float), out


def score_f2(emb, mu, Cn, enrol, tests):
    E_enrol = LC.unit(emb(enrol) - mu)
    flat, index = {}, []
    for k, sessions in tests.items():
        for j, s in enumerate(sessions):
            key = f"{k}\u0000{j}"
            flat[key] = LC.unit(emb(s) - mu) if len(s) else np.zeros((0, E_enrol.shape[1]))
            index.append((k, j, key))
    s, ref = LC.head_scores(E_enrol, Cn, flat)
    out = {k: [None] * len(v) for k, v in tests.items()}
    for k, j, key in index:
        out[k][j] = s[key]
    return ref, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--smoke", action="store_true", help="SMOKE TEST ONLY")
    a = ap.parse_args()
    if a.smoke:
        import smoke_c
        hashes, data = {}, smoke_c.synthetic_data()
        folder = os.path.join(C.OUT_C, "smoke")
    else:
        hashes = C.verify_stage_c()
        import bogazici_l
        data = bogazici_l.load()
        folder = C.OUT_C
    path = os.path.join(folder, "scores_C.json")
    if not a.smoke and os.path.exists(path):
        raise SystemExit(f"{path} exists already; stage C is scored once")
    os.makedirs(folder, exist_ok=True)
    os.environ["MOUSE_BASE_MODEL_PATH"] = C.DEPLOYED["base"]
    os.environ["MOUSE_SCALER_PATH"] = C.DEPLOYED["scaler"]
    os.environ["MOUSE_NEG_DATASET_PATH"] = C.DEPLOYED["neg"]
    import tensorflow as tf
    if a.threads:
        tf.config.threading.set_intra_op_parallelism_threads(a.threads)
    import api

    scale = C.load_scaler_c()
    emb = C.deployed_embedder(scale)
    mu, Cn = C.cohort_c(emb)
    targets = list(data["targets"])
    units = {"REF": {}, "F2": {}}
    for t in targets:
        d = data["get"](t)
        enrol = np.asarray(d["enrol"][:LC.BUDGET])
        if len(enrol) != LC.BUDGET:
            raise SystemExit(f"{t}: {len(enrol)} enrolment windows, not {LC.BUDGET} (eligibility is L-1's)")
        tests = {"genuine": list(d["test"]), **{f"imp:{o}": [w] for o, w in d["impostor"].items()}}
        ref_r, s_r = score_ref(api, t, enrol, tests)
        ref_f, s_f = score_f2(emb, mu, Cn, enrol, tests)
        for name, ref, s in (("REF", ref_r, s_r), ("F2", ref_f, s_f)):
            u = {"genuine": s["genuine"], "runs": {k[4:]: v for k, v in s.items() if k.startswith("imp:")}, "ref": ref}
            if not (np.isfinite(ref).all() and all(np.isfinite(x).all() for x in u["genuine"])
                    and all(np.isfinite(x).all() for r in u["runs"].values() for x in r)):
                raise SystemExit(f"{name} {t}: non-finite scores")
            units[name][t] = u
        print(f"[L-C] {t}: {sum(len(s) for s in d['test'])} genuine windows in {len(d['test'])} sessions, "
              f"{len(tests) - 1} impostor sessions", flush=True)
        del d
    out = {**hashes, "protocol": "L", "stage": "C", "smokeTest": a.smoke, "targets": targets,
           "excluded": data.get("excluded", {}), "manifest": data.get("manifest", {}),
           "deployed": {k: os.path.relpath(v, LC.ROOT).replace(os.sep, "/") for k, v in C.DEPLOYED.items()},
           "refPayload": C.REF_PAYLOAD, "systems": {k: C.units_to_json(v) for k, v in units.items()}}
    LC.write_json(path, out)
    print(f"[L-C] wrote {path}")


if __name__ == "__main__":
    main()
