"""Build the cohort file F2 serves from (T3.4): artifacts/mouse-fcn-a5/f2_cohort.npz.

F2 scores a user's windows with a logistic head on the deployed network's frozen embedding, centred on
a cohort mean and L2-normalised, against cohort rows as negatives (api.py, section "F2"). The cohort is
exactly the one stage C of protocol L used: 40 windows from each of the network's 100 training users
(seed 7), from c_common.cohort_c(c_common.deployed_embedder(c_common.load_scaler_c())). That function is
called, not re-implemented; validate_f2.py checks the file against it bit for bit.

The file holds mu (the cohort mean embedding), C = unit(Z - mu), and meta (JSON): the recipe and the
hashes of the network and scaler it was built for. api.py refuses the file if either hash changes.
Production needs no SapiMouse data once this file exists.

Run once, inside the model-api container, from /app:
    python services/model-api/build_f2_cohort.py            # refuses to overwrite an existing file
    python services/model-api/build_f2_cohort.py --force    # rebuild: every F2 profile must then be
                                                            # retrained (bump MOUSE_DECISION_VERSION)
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "analysis", "phase2"))
import c_common as CC  # noqa: E402
import l_common as LC  # noqa: E402

OUT = os.path.join(LC.ROOT, "artifacts", "mouse-fcn-a5", "f2_cohort.npz")


def main():
    if os.path.exists(OUT) and "--force" not in sys.argv:
        raise SystemExit(f"{OUT} exists; F2 profiles are trained against it. Use --force to rebuild.")
    emb = CC.deployed_embedder(CC.load_scaler_c())
    mu, C = CC.cohort_c(emb)
    meta = {
        "builtBy": "services/model-api/build_f2_cohort.py",
        "recipe": "analysis/phase2/c_common.cohort_c (stage C of protocol L, Amendment L-2)",
        "users": len(CC.base100_users()), "perUser": LC.COHORT_PER_USER, "seed": LC.COHORT_SEED,
        "rows": int(len(C)), "dim": int(C.shape[1]), "dtype": str(C.dtype),
        "baseModel": "artifacts/mouse-fcn-a5/final_model",
        "baseModelSha256": CC.dir_sha(CC.DEPLOYED["base"]),
        "scaler": "artifacts/mouse-fcn-a5/scaler.json",
        "scalerSha256": LC.sha(CC.DEPLOYED["scaler"]),
    }
    tmp = OUT + ".tmp.npz"
    np.savez(tmp, mu=mu, C=C, meta=np.array(json.dumps(meta, sort_keys=True)))
    os.replace(tmp, OUT)
    print(f"wrote {OUT}: {len(C)} rows x {C.shape[1]}, sha256 {LC.sha(OUT)}")
    print(json.dumps(meta, indent=1, sort_keys=True))


if __name__ == "__main__":
    main()
