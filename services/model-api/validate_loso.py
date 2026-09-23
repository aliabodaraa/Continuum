"""
Check: the live leave-one-sample-out mouse enrolment (loso.py, api.train_user_loso_payload) is the
recipe the lockbox evaluated as S1 (AMENDMENT_J1.md §2, protocol_j_p1.py / protocol_j_p6.py).

  1. loso.plan_folds returns the same plans as protocol_j_p1.plan_folds, for every order and held-out
     set the study used (6 samples) and for the live 8-sample enrolment.
  2. On development users, the whole live call reproduces the stored P1 Method-B scores: the pooled
     out-of-sample fold scores (B_oof) and the final model's scores on its own enrolment windows
     (final.enrol), identity order, base-80 network, as protocol_j_p1.py ran it. The stored scores
     are rounded to 6 decimals.

Development users only: the Reader refuses lockbox users, and so does this script.

Run inside the model-api container:
    python validate_loso.py --users user1,user91
"""
import argparse
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import protocol_j_p1 as P1  # noqa: E402  (first: sets the TF thread counts P1 ran with)
import protocol_j_common as J  # noqa: E402
import loso  # noqa: E402

import json  # noqa: E402

import numpy as np  # noqa: E402

TOL = 1e-5
failures = 0


def check(name, ok, detail=""):
    global failures
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures += 1


def plans():
    print("CHECK 1 — fold plans are protocol_j_p1's")
    cases, differ = 0, 0
    for order in P1.orders():
        helds = [[]] + [[s] for s in order] + [[order[2 * f], order[2 * f + 1]] for f in range(3)]
        for held in helds:
            cases += 1
            differ += loso.plan_folds(order, held) != P1.plan_folds(order, held)
    live = list(range(8))
    for held in [[]] + [[s] for s in live]:
        cases += 1
        differ += loso.plan_folds(live, held) != P1.plan_folds(live, held)
    check("plan_folds identical (10 study orders x 10 held-out sets, and the live 8 samples)",
          differ == 0, f"{cases} plans, {differ} differ")
    same_const = (loso.SAMPLE, loso.PURGE, loso.VSLICE) == (P1.SAMPLE, P1.PURGE, P1.VSLICE)
    check("sample size, purge and validation slice match the study", same_const,
          f"loso {loso.SAMPLE}/{loso.PURGE}/{loso.VSLICE}, P1 {P1.SAMPLE}/{P1.PURGE}/{P1.VSLICE}")


def recipe(api, user):
    print(f"CHECK 2 — the live call reproduces P1 Method B for development {user}")
    if user in set(J.split()["lockbox"]):
        raise SystemExit(f"{user} is a lockbox user; refusing to read it")
    R = J.Reader("P1")
    enrol = R.windows(R.sessions(user)[0])[:P1.BUDGET]
    ent = json.load(open(os.path.join(J.STUDY, "parts", "J_P1", f"{user}.json")))["byOrder"][0]
    if ent["order"] != list(range(P1.NS)):
        raise SystemExit("stored order 0 is not the identity order")
    root = f"/app/artifacts/protocol_j/models/validate_loso/{user}"
    mpath = f"{root}/F"
    shutil.rmtree(root, ignore_errors=True)
    try:
        res, code = api.train_user_loso_payload({
            "userId": f"validate-loso-{user}", "modality": "mouse", "modelPath": mpath,
            "positiveWindows": enrol.tolist(), "overlapGap": 5, "epochs": 15, "batchSize": 32})
        check("train call succeeds", code == 200, str(code) if code == 200 else f"{code} {res.get('error')}")
        if code != 200:
            return
        oof, want = np.asarray(res["losoScores"], float), np.asarray(ent["B_oof"], float)
        d = float(np.max(np.abs(oof - want)))
        check("out-of-sample fold scores equal the stored B_oof", d < TOL,
              f"{len(oof)} scores, max |diff| {d:.2e}")
        pred, _ = api.predict_user_payload({"userId": f"validate-loso-{user}", "modality": "mouse",
                                            "modelPath": mpath, "windows": enrol.tolist()})
        fin = np.round(np.asarray([p[1] for p in pred["prediction"]], float), 6)
        d2 = float(np.max(np.abs(fin - np.asarray(ent["final"]["enrol"], float))))
        check("final model's enrolment scores equal the stored final.enrol", d2 < TOL,
              f"{len(fin)} scores, max |diff| {d2:.2e}")
        t_live, t_study = res["losoScorePercentiles"]["20"], float(np.percentile(want, 20))
        check("20th-percentile threshold equals the study's", abs(t_live - t_study) < TOL,
              f"live {t_live:.6f}, study {t_study:.6f}")
        check("fold scratch directory is removed", not os.path.exists(mpath + "_loso"))
    finally:
        api.invalidate_user_model_cache(mpath)
        shutil.rmtree(root, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--users", default="user1")
    a = ap.parse_args()
    plans()
    # Environment exactly as protocol_j_p1.run() set it, before api is imported.
    os.environ["MOUSE_BASE_MODEL_PATH"] = J.BASE80["base"]
    os.environ["MOUSE_SCALER_PATH"] = J.BASE80["scaler"]
    os.environ["MOUSE_NEG_DATASET_PATH"] = J.BASE80["neg"]
    import api
    for u in a.users.split(","):
        recipe(api, u)
    print("\nALL CHECKS PASSED" if failures == 0 else f"\n{failures} CHECK(S) FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
