"""
Experiment G inputs (artifacts/repr_arch_study/PREREGISTRATION_G.md): the exact windows
Experiment F used, exported for the extension's on-device code, which runs under Node.

  * targets: the 19 held-out users with >= 330 windows in their 3-minute session; enrolment =
    the first 330 windows, genuine test = the whole 1-minute session (as F)
  * impostor runs: every held-out user's 1-minute session, first 150 windows (as F)
  * negatives: the 660 windows api.py draws for a 330-window enrolment (2,000 sampled from
    Mouse_A5_W50_base.h5 with seed 13, then 660 with seed 21), plus the production base's
    Keras embeddings of them, for the TF.js parity check

    python export_g_inputs.py      # writes /app/artifacts/final_eval/g_inputs.json
"""
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from repr_arch_study import raw_steps, windows, session_scale, _read_events  # noqa: E402

DATA = "/app/data/sapimouse"
HOLDOUT = "/app/artifacts/mouse-ws50-aligned/holdout_users.json"
NEG = "/app/data/mouse_only/Mouse_A5_W50_base.h5"
BASE = "/app/artifacts/mouse-fcn-a5/final_model"
SCALER = "/app/artifacts/mouse-fcn-a5/scaler.json"
OUT = "/app/artifacts/final_eval/g_inputs.json"
BUDGET, IMP_RUN = 330, 150


def main():
    import h5py
    import tensorflow as tf

    def wins(csv):
        ev = _read_events(csv)
        return windows(raw_steps(ev), session_scale(ev), "A5")

    def sessions(u):
        cs = sorted(glob.glob(os.path.join(DATA, u, "*.csv")))
        lo = [c for c in cs if "3min" in os.path.basename(c)]
        sh = [c for c in cs if "1min" in os.path.basename(c)]
        return (lo[0] if lo else None), (sh[0] if sh else None)

    holdout = json.load(open(HOLDOUT))["holdout_users"]
    test = {u: wins(sessions(u)[1]) for u in holdout if sessions(u)[1]}
    targets = [u for u in holdout if sessions(u)[0] and len(wins(sessions(u)[0])) >= BUDGET]

    with h5py.File(NEG, "r") as f:
        data = f["X"]
        idx = np.sort(np.random.default_rng(13).choice(len(data), size=min(2000, len(data)), replace=False))
        pool = np.array(data[idx], dtype=np.float32)
    neg = pool[np.random.default_rng(21).choice(len(pool), size=2 * BUDGET, replace=False)]

    base = tf.keras.models.load_model(BASE)
    sc = json.load(open(SCALER))
    extractor = tf.keras.Model(base.input, base.get_layer("embedding").output)
    neg_emb = extractor.predict((neg - np.asarray(sc["mean"], np.float32)) / np.asarray(sc["std"], np.float32),
                                batch_size=512, verbose=0)

    out = {
        "note": "Experiment G inputs; windows are 50 x [|dx|, |dy|] px exactly as in Experiment F",
        "targets": [{"participant": u, "enrol": wins(sessions(u)[0])[:BUDGET].tolist(),
                     "genuine": test[u].tolist()} for u in targets],
        "impostorRuns": {u: x[:IMP_RUN].tolist() for u, x in test.items() if len(x)},
        "negatives": neg.tolist(),
        "negativesKerasEmbedding": neg_emb.tolist(),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w"))
    print(f"targets {len(targets)} | impostor runs {len(out['impostorRuns'])} | negatives {neg.shape} "
          f"| embedding {neg_emb.shape} -> {OUT}")


if __name__ == "__main__":
    main()
