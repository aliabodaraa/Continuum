"""
End-to-end test of the per-user fine-tuning + prediction pipeline.

Simulates a real user: takes windows from one overlap group of the dataset
(one person's typing stretch) as enrollment positives, fine-tunes a per-user
model through api.py's train_user_payload, then checks that held-out windows
from the same group score high (genuine) while windows from other groups
score low (impostor).

Run inside Docker:
  docker run --rm -v <continuum>:/app -w /app \
    -e MODEL_PATH=/app/artifacts/ws50-gru-v2/final_model \
    continuum-model-api python e2e_user_test.py
"""
import numpy as np
import h5py

from data_loader import compute_overlap_groups
import api


def main():
    with h5py.File("data/Rand_WS50.h5", "r") as f:
        X = np.array(f["train_data"])
        y = np.array(f["train_labels"]).reshape(-1)

    print("Computing overlap groups to isolate one user's typing stretch...")
    groups = compute_overlap_groups(X)
    unique, counts = np.unique(groups, return_counts=True)

    # Pick a medium-sized genuine-labeled group as "the user".
    candidates = [g for g, c in zip(unique, counts) if 60 <= c <= 200]
    user_group = None
    for g in candidates:
        idx = np.where(groups == g)[0]
        if y[idx].mean() > 0.9:  # group is mostly genuine-labeled windows
            user_group = g
            break
    if user_group is None:
        user_group = candidates[0]

    user_idx = np.where(groups == user_group)[0]
    rng = np.random.default_rng(3)
    rng.shuffle(user_idx)
    enroll_idx = user_idx[:40]
    holdout_idx = user_idx[40:60]

    impostor_idx = np.where(groups != user_group)[0]
    impostor_idx = rng.choice(impostor_idx, size=20, replace=False)

    print(f"User group {user_group}: {len(user_idx)} windows "
          f"({len(enroll_idx)} enroll, {len(holdout_idx)} holdout)")

    # 1) Train per-user model through the API code path.
    result, status = api.train_user_payload({
        "userId": "e2e-test",
        "positiveWindows": X[enroll_idx].tolist(),
        "epochs": 30,
        "batchSize": 16,
    })
    assert status == 200, f"training failed: {result}"
    print(f"Trained from: {result['trainedFrom']}, negatives: {result['negativeSource']}, "
          f"val accuracy: {result['accuracy']:.3f}, threshold: {result['threshold']:.2f}")

    # 2) Predict on held-out genuine windows.
    genuine, status = api.predict_user_payload({
        "userId": "e2e-test",
        "windows": X[holdout_idx].tolist(),
        "threshold": result["threshold"],
    })
    assert status == 200, f"genuine prediction failed: {genuine}"

    # 3) Predict on impostor windows.
    impostor, status = api.predict_user_payload({
        "userId": "e2e-test",
        "windows": X[impostor_idx].tolist(),
        "threshold": result["threshold"],
    })
    assert status == 200, f"impostor prediction failed: {impostor}"

    print(f"\nGenuine holdout: score={genuine['genuineScore']:.3f} "
          f"suspicious={genuine['isSuspicious']}")
    print(f"Impostors:       score={impostor['genuineScore']:.3f} "
          f"suspicious={impostor['isSuspicious']}")

    ok = (not genuine["isSuspicious"]) and impostor["isSuspicious"]
    print(f"\nE2E RESULT: {'PASS' if ok else 'FAIL'} "
          f"(genuine accepted: {not genuine['isSuspicious']}, "
          f"impostor flagged: {impostor['isSuspicious']})")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
