"""
Enrollment-budget sweep for the mouse modality — v2, leakage-safe.

Fixes over mouse_enroll_sweep.py:
  * Targets come from artifacts/mouse-ws50-gru/holdout_users.json — users the
    identification base model has NEVER seen (true transfer measurement).
  * Enroll/test split is cross-session: enrollment windows from the 3-min
    session (temporal order), genuine test = the 1-min session. Overlapping
    sliding windows therefore never straddle enroll/test (the v1 shuffle did
    exactly that and inflated TAR).
  * Impostor test windows come from OTHER holdout users; training negatives
    come from BASE users — impostor-test identities are unseen both by the
    base model and by the per-user negatives.
  * Fine-tunes from the identification base export (v1 trained from scratch).
  * Distinct modelPath per (target, budget) so the API's model cache can
    never serve a stale model.

Reports per budget, averaged over targets: mean genuine score, TAR@0.5,
FAR@0.5, and EER computed from the score distributions.
Writes artifacts/mouse-ws50-gru/enroll_sweep_results.json.

Run inside the model-api container:
  python services/model-api/mouse_enroll_sweep_v2.py
"""
import glob
import json
import os
import sys
import urllib.request

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from preprocess_mouse import events_to_steps, steps_to_windows, _read_events  # noqa: E402

MODEL_API = "http://localhost:5000"
DATA_DIR = "/app/data/sapimouse"
ART_DIR = "/app/artifacts/mouse-ws50-gru"
BASE_MODEL = f"{ART_DIR}/best_model.h5"
SCALER = f"{ART_DIR}/scaler.json"
WS, STRIDE = 50, 10
BUDGETS = [80, 150, 250]
EPOCHS = 15
THRESH = 0.5
N_TARGETS = 5
N_IMPOSTOR_USERS = 5
IMP_WINDOWS_PER_USER = 60


def post(path, body):
    req = urllib.request.Request(
        MODEL_API + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=1200) as r:
        return json.load(r)


def session_csvs(uid):
    csvs = sorted(glob.glob(os.path.join(DATA_DIR, uid, "*.csv")))
    long_s = [c for c in csvs if "3min" in os.path.basename(c)]
    short_s = [c for c in csvs if "1min" in os.path.basename(c)]
    return (long_s[0] if long_s else None), (short_s[0] if short_s else None)


def windows_of(csv):
    return np.asarray(
        steps_to_windows(events_to_steps(_read_events(csv)), WS, STRIDE), np.float32)


def scores(windows, model_path):
    if len(windows) == 0:
        return np.array([])
    r = post("/api/user/predict", {
        "userId": "sweep", "windows": windows.tolist(),
        "modelPath": model_path, "scalerPath": SCALER, "threshold": THRESH})
    return np.array([float(p[1]) for p in r.get("prediction", [])])


def eer_from_scores(gen, imp):
    if len(gen) == 0 or len(imp) == 0:
        return None
    best = (1.0, 0.5)
    for t in np.linspace(0, 1, 501):
        far = float(np.mean(imp >= t))
        frr = float(np.mean(gen < t))
        if abs(far - frr) < best[0]:
            best = (abs(far - frr), t, (far + frr) / 2)
    return round(best[2], 4)


def main():
    with open(os.path.join(ART_DIR, "holdout_users.json")) as f:
        holdout = json.load(f)["holdout_users"]
    all_users = sorted(
        os.path.basename(d) for d in glob.glob(os.path.join(DATA_DIR, "user*")))
    base_users = [u for u in all_users if u not in holdout]

    # negatives for fine-tuning: sampled from base users' 3-min sessions
    rng = np.random.default_rng(21)
    neg_pool = []
    for u in rng.choice(base_users, size=30, replace=False):
        long_s, _ = session_csvs(u)
        if long_s is not None:
            w = windows_of(long_s)
            if len(w):
                neg_pool.append(w[rng.choice(len(w), size=min(40, len(w)), replace=False)])
    neg_pool = np.concatenate(neg_pool, axis=0)
    print(f"negative pool: {neg_pool.shape} from base users")

    # targets: first N holdout users with enough enrollment data
    targets = []
    for u in holdout:
        long_s, short_s = session_csvs(u)
        if long_s and short_s and len(windows_of(long_s)) >= max(BUDGETS):
            targets.append(u)
        if len(targets) == N_TARGETS:
            break
    impostor_users = [u for u in holdout if u not in targets][:N_IMPOSTOR_USERS]
    print(f"targets: {targets}\nimpostor-test users: {impostor_users}")

    imp_test = np.concatenate([
        windows_of(session_csvs(u)[1])[:IMP_WINDOWS_PER_USER]
        for u in impostor_users if session_csvs(u)[1] is not None], axis=0)
    print(f"impostor test pool: {imp_test.shape}\n")

    results = {"base_model": BASE_MODEL, "budgets": {}, "targets": targets,
               "impostor_users": impostor_users, "threshold": THRESH, "epochs": EPOCHS}
    # Two operating points per target: the GLOBAL 0.5 cutoff (tar/far) and the
    # PER-USER calibrated threshold the model-api returns from enrollment
    # (tarCal/farCal). EER is the threshold-independent ceiling. The gap between
    # the *Cal columns and EER shows how much per-user calibration recovers.
    header = (f"{'budget':>7} {'genMean':>8} {'TAR%':>7} {'FAR%':>7} "
              f"{'thr':>5} {'TARc%':>7} {'FARc%':>7} {'EER%':>7}")
    print(header)
    for N in BUDGETS:
        rows = []
        for uid in targets:
            long_s, short_s = session_csvs(uid)
            enroll = windows_of(long_s)[:N]  # temporal order, cross-session vs test
            gen_test = windows_of(short_s)
            negs = neg_pool[rng.choice(len(neg_pool), size=2 * N, replace=False)]
            model_path = f"/app/artifacts/users/sweep-{uid}-{N}/mouse_model"
            tr = post("/api/user/train", {
                "userId": f"sweep-{uid}-{N}", "positiveWindows": enroll.tolist(),
                "negativeWindows": negs.tolist(), "minPositiveWindows": 12,
                "modelPath": model_path, "scalerPath": SCALER,
                "baseModelPath": BASE_MODEL, "epochs": EPOCHS, "batchSize": 32})
            thr = float(tr.get("threshold", THRESH))
            g = scores(gen_test, model_path)
            i = scores(imp_test, model_path)
            rows.append({
                "target": uid, "genMean": round(float(np.mean(g)), 4),
                "tar": round(float(np.mean(g >= THRESH)) * 100, 2),
                "far": round(float(np.mean(i >= THRESH)) * 100, 2),
                "thr": round(thr, 3), "thrSource": tr.get("thresholdSource"),
                "tarCal": round(float(np.mean(g >= thr)) * 100, 2),
                "farCal": round(float(np.mean(i >= thr)) * 100, 2),
                "eer": eer_from_scores(g, i)})
        mean = {k: round(float(np.mean([r[k] for r in rows if r[k] is not None])), 4)
                for k in ("genMean", "tar", "far", "thr", "tarCal", "farCal", "eer")}
        results["budgets"][N] = {"per_target": rows, "mean": mean}
        print(f"{N:>7} {mean['genMean']:>8.3f} {mean['tar']:>7.1f} {mean['far']:>7.1f} "
              f"{mean['thr']:>5.2f} {mean['tarCal']:>7.1f} {mean['farCal']:>7.1f} "
              f"{mean['eer']*100:>7.1f}")

    out = os.path.join(ART_DIR, "enroll_sweep_thr_results.json")
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nSaved {out}")


if __name__ == "__main__":
    main()
