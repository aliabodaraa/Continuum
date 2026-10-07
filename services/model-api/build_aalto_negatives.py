"""Build the live keystroke negatives file (T3.3): the windows of KS's A200 arm.

    python build_aalto_negatives.py [--root /app] [--size 200]

Experiment KS (artifacts/phase3/PREREGISTRATION_KS.md, docs/recovery/RESULTS_KS.md) trained Lu's
per-user model against Aalto typists instead of the 40 KeyRecs accounts, and every Aalto arm beat
that reference. The live system takes the A200 arm: the first 200 typists of the pool's draw order
(aalto_pool_ks.json["kept"], exactly run_ks.negatives_for). This writes their windows, unscaled as
in the pool, under `X` (the key api.get_dataset_negatives reads) with `participant` and `section`
beside them, and prints the file's sha256 for the RUN_LOG.
"""
import argparse
import hashlib
import json
import os

import h5py
import numpy as np


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
    ap.add_argument("--size", type=int, default=200)
    a = ap.parse_args()

    manifest_path = os.path.join(a.root, "artifacts", "phase3", "aalto_pool_ks.json")
    manifest = json.load(open(manifest_path))
    if manifest.get("smokeTest"):
        raise SystemExit("the pool manifest is a smoke test")
    pool_path = os.path.join(a.root, manifest["poolH5"])
    pool_sha = sha256(pool_path)
    if pool_sha != manifest["poolH5Sha256"]:
        raise SystemExit(f"{pool_path} differs from its manifest")

    with h5py.File(pool_path, "r") as f:
        W = np.asarray(f["windows"], np.float32)
        P = np.asarray(f["participant"]).astype(np.int64)
        S = np.asarray(f["section"]).astype(np.int64)
    ids = [int(x) for x in manifest["kept"][:a.size]]
    m = np.isin(P, ids)
    if len(np.unique(P[m])) != a.size:
        raise SystemExit(f"expected {a.size} typists, found {len(np.unique(P[m]))}")

    name = f"aalto_neg_A{a.size}.h5"
    out = os.path.join(a.root, "data", name)
    tmp = out + ".tmp"
    with h5py.File(tmp, "w") as f:
        f.create_dataset("X", data=W[m])
        f.create_dataset("participant", data=P[m])
        f.create_dataset("section", data=S[m])
        f.attrs["source"] = "Aalto 136M keystrokes (Dhakal et al. 2018), KS pool"
        f.attrs["arm"] = f"A{a.size}"
        f.attrs["typists"] = a.size
        f.attrs["poolH5Sha256"] = pool_sha
    os.replace(tmp, out)
    print(f"{out}: {int(m.sum())} windows of {a.size} typists, shape {W[m].shape}")
    print(f"sha256 {sha256(out)}")


if __name__ == "__main__":
    main()
