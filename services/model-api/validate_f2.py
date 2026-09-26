"""Equivalence gate for F2 in production (T3.4): model-api's serving code must reproduce protocol L's
analysis code, so the F2 that is deployed is the F2 that stage C tested.

1. Cohort: artifacts/mouse-fcn-a5/f2_cohort.npz equals c_common.cohort_c(...) bit for bit (mu and C,
   values and dtypes).
2. Scores: for two of the deployed network's 100 training users (never a development or test user),
   440 enrolment windows and the next 200 windows of their 3-minute session. The serving path,
   api.train_user_f2_payload and then api.predict_user_payload through a scratch model folder, must
   reproduce l_common.head_scores on the same windows to 1e-9: the 440 leave-one-sample-out scores,
   their percentiles (the p20 is the user's threshold) and the 200 test scores.

Both sides get the same float32 windows (the serving path's own to_window_array). The scratch folder,
artifacts/users/_validate_f2/, is removed afterwards. Run inside model-api, from /app:
    python services/model-api/validate_f2.py
"""
import os
import shutil
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "analysis", "phase2"))
import api  # noqa: E402
import c_common as CC  # noqa: E402
import l_common as LC  # noqa: E402

TOL = 1e-9
N_ENROL, N_TEST, N_USERS = 440, 200, 2


def main():
    ok = True
    emb = CC.deployed_embedder(CC.load_scaler_c())
    mu, Cn = CC.cohort_c(emb)
    with np.load(api.F2_COHORT_PATH, allow_pickle=False) as z:
        fmu, fC = z["mu"], z["C"]
    same = (fmu.dtype == mu.dtype and fC.dtype == Cn.dtype and fmu.shape == mu.shape and fC.shape == Cn.shape
            and np.array_equal(fmu, mu) and np.array_equal(fC, Cn))
    ok &= same
    print(f"{'PASS' if same else 'FAIL'}  cohort file equals c_common.cohort_c bit for bit "
          f"({fC.shape[0]} x {fC.shape[1]}, {fC.dtype})")

    users = []
    for u in CC.base100_users():
        W = CC.sapimouse_long(u)
        if len(W) >= N_ENROL + N_TEST:
            users.append((u, W))
        if len(users) == N_USERS:
            break

    scratch = os.path.join(api.ARTIFACTS_DIR, "users", "_validate_f2")
    try:
        for u, W in users:
            enrol = api.to_window_array(W[:N_ENROL].tolist())
            test = api.to_window_array(W[N_ENROL:N_ENROL + N_TEST].tolist())
            out, ref = LC.head_scores(LC.unit(emb(enrol) - mu), Cn, {"test": LC.unit(emb(test) - mu)})

            path = os.path.join(scratch, u, "mouse_model")
            res, code = api.train_user_f2_payload({
                "userId": f"validate-f2-{u}", "modality": "mouse", "headScheme": "f2",
                "thresholdScheme": "leave-one-sample-out", "sampleWindows": LC.SAMPLE,
                "positiveWindows": enrol.tolist(), "modelPath": path})
            if code != 200:
                raise SystemExit(f"FAIL  {u}: training returned {code}: {res}")
            pred, code = api.predict_user_payload({
                "userId": f"validate-f2-{u}", "modality": "mouse", "modelPath": path, "windows": test.tolist()})
            if code != 200 or pred.get("headScheme") != "f2":
                raise SystemExit(f"FAIL  {u}: prediction returned {code}: {pred}")

            d_loso = float(np.max(np.abs(np.asarray(res["losoScores"]) - ref)))
            d_pct = max(abs(res["losoScorePercentiles"][str(q)] - float(np.percentile(ref, q)))
                        for q in api.LOSO_PERCENTILES)
            d_test = float(np.max(np.abs(np.asarray([p[1] for p in pred["prediction"]]) - out["test"])))
            good = max(d_loso, d_pct, d_test) <= TOL and len(res["losoScores"]) == N_ENROL
            ok &= good
            print(f"{'PASS' if good else 'FAIL'}  {u}: max |serving - analysis| LOSO {d_loso:.1e}, "
                  f"percentiles {d_pct:.1e}, {N_TEST} test windows {d_test:.1e}; threshold (p20) "
                  f"{res['losoScorePercentiles']['20']:.6f}; trained in {res['trainingSeconds']:.1f} s")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    print("ALL F2 CHECKS PASSED" if ok else "F2 CHECKS FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
