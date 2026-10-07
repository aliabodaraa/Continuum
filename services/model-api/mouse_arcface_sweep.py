"""
Prototype-distance enrollment sweep for the ArcFace mouse embedding.

Mirrors mouse_enroll_sweep_v2.py (same holdout, targets, impostor users, budgets)
so the EER is directly comparable to the Stage-1 Dense(2) head-swap numbers, but
verification here is embedding-native:

  enrol   = mean L2-normalised embedding of N genuine windows  (the prototype)
  score   = cosine similarity of a window's embedding to the prototype
  EER     = threshold-independent equal-error rate from genuine vs impostor scores

No model-api, no per-user head, no negative selection — pure embedding geometry.

Point ART_DIR at the ArcFace output dir (holds embed_model/ + scaler.json +
holdout_users.json). Runs inside the model-api container (needs TF).
"""
import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tensorflow as tf  # noqa: E402
from preprocess_mouse import events_to_steps, steps_to_windows, _read_events  # noqa: E402

DATA_DIR = "/app/data/sapimouse"
ART_DIR = os.getenv("SWEEP_ART_DIR", "/app/artifacts/mouse-ws50-arcface")
WS, STRIDE = 50, 10
BUDGETS = [80, 150, 250]
N_TARGETS = 5
N_IMPOSTOR_USERS = 5
IMP_WINDOWS_PER_USER = 60


def session_csvs(uid):
    csvs = sorted(glob.glob(os.path.join(DATA_DIR, uid, "*.csv")))
    long_s = next((c for c in csvs if "3min" in os.path.basename(c)), None)
    short_s = next((c for c in csvs if "1min" in os.path.basename(c)), None)
    return long_s, short_s


def windows_of(csv):
    if not csv:
        return np.empty((0, WS, 11), np.float32)
    return np.asarray(steps_to_windows(events_to_steps(_read_events(csv)), WS, STRIDE), np.float32)


def eer_from_scores(gen, imp):
    """Equal-error rate: sweep the threshold, find where FAR == FRR."""
    if len(gen) == 0 or len(imp) == 0:
        return None
    thrs = np.unique(np.concatenate([gen, imp]))
    best, be = 1.0, 1.0
    for t in thrs:
        frr = float(np.mean(gen < t))          # genuine rejected
        far = float(np.mean(imp >= t))         # impostor accepted
        if abs(far - frr) < be:
            be = abs(far - frr); best = (far + frr) / 2.0
    return round(best, 4)


def main():
    scaler = json.load(open(os.path.join(ART_DIR, "scaler.json")))
    mean = np.asarray(scaler["mean"], np.float32)
    std = np.asarray(scaler["std"], np.float32); std[std == 0] = 1.0

    def embed(model, W):
        if len(W) == 0:
            return np.empty((0, model.output_shape[-1]), np.float32)
        Z = ((W - mean) / std).astype(np.float32)
        e = model.predict(Z, batch_size=256, verbose=0)
        return e / (np.linalg.norm(e, axis=1, keepdims=True) + 1e-9)

    # Prefer a purpose-trained embedding model; otherwise cut an embedding out of a
    # softmax-ID base (id_model.h5) at EMBED_LAYER (default the Flatten feature vector).
    # This lets us test prototype-distance verification on the already-trained enriched
    # base without any retraining, isolating the verification method from ArcFace's
    # cold-start training difficulty.
    embed_dir = os.path.join(ART_DIR, "embed_model")
    if os.path.isdir(embed_dir):
        model = tf.keras.models.load_model(embed_dir, compile=False)
    else:
        idm = tf.keras.models.load_model(os.path.join(ART_DIR, "id_model.h5"), compile=False)
        layer_name = os.getenv("EMBED_LAYER", "flatten")
        model = tf.keras.Model(idm.input, idm.get_layer(layer_name).output)
        print(f"embedding cut from id_model.h5 at layer '{layer_name}' (dim={model.output_shape[-1]})")

    holdout = json.load(open(os.path.join(ART_DIR, "holdout_users.json")))["holdout_users"]
    targets = []
    for u in holdout:
        long_s, short_s = session_csvs(u)
        if long_s and short_s and len(windows_of(long_s)) >= max(BUDGETS):
            targets.append(u)
        if len(targets) == N_TARGETS:
            break
    impostor_users = [u for u in holdout if u not in targets][:N_IMPOSTOR_USERS]
    print(f"targets: {targets}\nimpostor-test users: {impostor_users}")

    imp_wins = np.concatenate([
        windows_of(session_csvs(u)[1])[:IMP_WINDOWS_PER_USER]
        for u in impostor_users if session_csvs(u)[1] is not None], axis=0)
    imp_emb = embed(model, imp_wins)
    print(f"impostor test pool: {imp_wins.shape}\n")

    results = {"embed_model": ART_DIR, "budgets": {}, "targets": targets,
               "impostor_users": impostor_users}
    print(f"{'budget':>7} {'genMean':>8} {'impMean':>8} {'EER%':>7}   per-target EER%")
    for N in BUDGETS:
        rows = []
        for uid in targets:
            long_s, short_s = session_csvs(uid)
            enroll = windows_of(long_s)[:N]
            gen_test = windows_of(short_s)
            e_enroll = embed(model, enroll)
            proto = e_enroll.mean(0); proto = proto / (np.linalg.norm(proto) + 1e-9)
            g = embed(model, gen_test) @ proto
            i = imp_emb @ proto
            rows.append({"target": uid, "genMean": round(float(g.mean()), 4),
                         "impMean": round(float(i.mean()), 4),
                         "eer": eer_from_scores(g, i)})
        eers = [r["eer"] for r in rows if r["eer"] is not None]
        mean_eer = float(np.mean(eers)) if eers else None
        results["budgets"][N] = {"per_target": rows,
                                 "mean": {"eer": mean_eer,
                                          "genMean": round(float(np.mean([r["genMean"] for r in rows])), 4),
                                          "impMean": round(float(np.mean([r["impMean"] for r in rows])), 4)}}
        per = " ".join(f"{r['target']}:{r['eer']*100:.0f}" for r in rows)
        gm = np.mean([r["genMean"] for r in rows]); im = np.mean([r["impMean"] for r in rows])
        print(f"{N:>7} {gm:>8.3f} {im:>8.3f} {mean_eer*100:>7.1f}   {per}")

    out = os.path.join(ART_DIR, "arcface_sweep_results.json")
    json.dump(results, open(out, "w"), indent=2)
    print(f"\nSaved {out}")


if __name__ == "__main__":
    main()
