"""
Enroll-size sweep for the mouse modality — determines the minimum number of
enrollment windows a user needs to be reliably recognized.

Method (uses SapiMouse so identity is known and we have a real held-out set):
  * Pick a GENUINE user. Split their windows into ENROLL (train) + HELD-OUT (test).
  * Pick a disjoint set of IMPOSTOR users for negatives (train) and for a
    separate impostor TEST pool (to measure FAR).
  * For each enroll budget N in [40, 80, 120, 160, 200, 300]:
      - train a per-user model on N genuine windows + SapiMouse negatives,
      - score the held-out GENUINE windows  -> TAR (higher = better)
      - score the held-out IMPOSTOR windows  -> FAR (lower  = better)
      - report mean genuine score, TAR, FAR, and the gap.
  The knee of the TAR curve (where it stops improving) is the practical minimum.

Runs INSIDE the model-api container (it has TF + the model-api on localhost).
"""
import os
import sys
import glob
import numpy as np

sys.path.insert(0, "/app")
from preprocess_mouse import events_to_steps, steps_to_windows, _read_events  # noqa: E402

MODEL_API = "http://localhost:5000"
DATA_DIR = "/app/data/sapimouse"
SCALER = "/app/artifacts/mouse-ws50-gru/scaler.json"
NEG_DATASET = "/app/data/mouse_only/Mouse_WS50.h5"
WS, STRIDE = 50, 10
# Kept short (3 budgets, 15 epochs) so the whole sweep finishes inside Docker
# Desktop's short uptime windows. Widen once Docker is stable for a finer curve.
BUDGETS = [80, 150, 250]
EPOCHS = 15
THRESH = 0.5


def user_windows(uid_dir):
    wins = []
    for csv in sorted(glob.glob(os.path.join(uid_dir, "*.csv"))):
        wins.extend(steps_to_windows(events_to_steps(_read_events(csv)), WS, STRIDE))
    return np.asarray(wins, dtype=np.float32) if wins else np.empty((0, WS, 6), np.float32)


def post(path, body):
    import json, urllib.request
    req = urllib.request.Request(
        MODEL_API + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)


def scores(windows, model_path):
    if len(windows) == 0:
        return np.array([])
    r = post("/api/user/predict", {
        "userId": "sweep", "windows": windows.tolist(),
        "modelPath": model_path, "scalerPath": SCALER, "threshold": THRESH,
    })
    return np.array([float(p[1]) for p in r.get("prediction", [])])


def main():
    users = sorted(glob.glob(os.path.join(DATA_DIR, "user*")),
                   key=lambda p: int("".join(c for c in os.path.basename(p) if c.isdigit()) or 0))
    # genuine = the user with the MOST windows (so budgets up to 300 are feasible)
    counts = [(u, len(user_windows(u))) for u in users[:40]]  # cap scan for speed
    counts.sort(key=lambda t: -t[1])
    genuine_dir, gcount = counts[0]
    genuine = user_windows(genuine_dir)
    rng = np.random.default_rng(7)
    rng.shuffle(genuine)
    heldout_n = min(120, len(genuine) // 3)
    gen_test = genuine[:heldout_n]
    gen_pool = genuine[heldout_n:]  # enrollment comes from here
    print(f"GENUINE {os.path.basename(genuine_dir)}: {gcount} windows "
          f"-> {len(gen_pool)} enroll pool + {len(gen_test)} held-out test")

    # impostor TEST pool: 5 other users NOT used as negatives during training
    others = [u for u, _ in counts[1:]]
    imp_test = np.concatenate([user_windows(u)[:60] for u in others[:5]], axis=0)
    print(f"IMPOSTOR test pool: {len(imp_test)} windows from 5 users\n")

    model_path = "/app/artifacts/users/user-sweep/mouse_model"
    print(f"{'enroll':>7} {'genMean':>8} {'TAR%':>7} {'FAR%':>7} {'gap':>7} {'balAcc':>7}")
    for N in BUDGETS:
        if N > len(gen_pool):
            print(f"{N:>7}   (only {len(gen_pool)} available — skipped)")
            continue
        enroll = gen_pool[:N]
        res = post("/api/user/train", {
            "userId": "sweep", "positiveWindows": enroll.tolist(),
            "minPositiveWindows": 12, "modelPath": model_path,
            "scalerPath": SCALER, "negativeDatasetPath": NEG_DATASET,
            "baseModelPath": "__none__", "epochs": EPOCHS, "batchSize": 32,
        })
        gt = scores(gen_test, model_path)
        it = scores(imp_test, model_path)
        tar = float(np.mean(gt >= THRESH)) * 100 if len(gt) else 0
        far = float(np.mean(it >= THRESH)) * 100 if len(it) else 0
        print(f"{N:>7} {np.mean(gt):>8.3f} {tar:>7.1f} {far:>7.1f} {tar-far:>7.1f} "
              f"{(res.get('balancedAccuracy') or 0):>7.3f}")


if __name__ == "__main__":
    main()
