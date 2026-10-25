"""Experiment IM: the deployed typing recipe (KS arm A200) scored against every other KeyRecs participant
(artifacts/phase7/PREREGISTRATION_IM.md).

    python services/model-api/analysis/phase7/run_im.py --threads 8

`run_ks.run_target` line for line, with the impostor pool widened from ids[40:80] to all 99 ids (the owner is skipped
by run_target itself). One JSON per owner under artifacts/phase7/im/parts/; a finished owner is never trained again.
Refuses to run unless the IM files match PREREGISTRATION_IM.sha256.
"""
import argparse
import hashlib
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "phase3"))
import ks_common as KC  # noqa: E402
import run_ks as RK  # noqa: E402

STUDY = os.path.join(KC.ROOT, "artifacts", "phase7")
PARTS = os.path.join(STUDY, "im", "parts")
SHA_FILE = os.path.join(STUDY, "PREREGISTRATION_IM.sha256")
FROZEN = ["artifacts/phase7/PREREGISTRATION_IM.md",
          "services/model-api/analysis/phase7/run_im.py",
          "services/model-api/analysis/phase7/analyze_im.py",
          "services/model-api/analysis/phase3/run_ks.py",
          "services/model-api/analysis/phase3/ks_common.py",
          "services/model-api/analysis/phase3/analyze_ks.py",
          "services/model-api/analysis/phase1/eval_decision_level.py"]


def hashes():
    return {rel: KC.sha(os.path.join(KC.ROOT, rel)) for rel in FROZEN}


def verify_frozen():
    if not os.path.exists(SHA_FILE):
        raise SystemExit(f"{SHA_FILE} missing: the pre-registration is not frozen")
    want = dict(reversed(line.split()) for line in open(SHA_FILE) if line.strip())
    got = hashes()
    bad = [k for k in got if want.get(k) != got[k]]
    if bad:
        raise SystemExit("differs from PREREGISTRATION_IM.sha256: " + ", ".join(bad) + "; refusing to run")
    return {"preregistrationIMSha256": got[FROZEN[0]],
            "frozenSetSha256": hashlib.sha256("".join(f"{k}{got[k]}" for k in sorted(got)).encode()).hexdigest()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()
    stamp = verify_frozen()

    import tensorflow as tf
    if a.threads:
        tf.config.threading.set_intra_op_parallelism_threads(a.threads)
    tf.config.experimental.enable_op_determinism()

    K, kpid = KC.load_h5(KC.KEYRECS)
    ids, keyrecs_neg, _s40 = KC.keyrecs_pools(kpid)
    manifest = KC.json.load(open(os.path.join(KC.STUDY, "aalto_pool_ks.json")))
    pool_h5 = os.path.join(KC.ROOT, manifest["poolH5"])
    if KC.sha(pool_h5) != manifest["poolH5Sha256"]:
        raise SystemExit(f"{pool_h5} differs from its manifest")
    PW, PP = KC.load_h5(pool_h5)
    pool = (PW, PP, [int(x) for x in manifest["kept"]])
    scaler = KC.load_scaler()
    NEG, npid, neg_pool, source = RK.negatives_for("A200", K, kpid, keyrecs_neg, pool, False)
    os.makedirs(PARTS, exist_ok=True)
    print(f"[IM] A200: {len(neg_pool)} negative people ({source}), {len(ids)} owners, impostors = all other participants",
          flush=True)
    t0 = time.time()
    for tid in ids:
        path = os.path.join(PARTS, f"{int(tid)}.json")
        if os.path.exists(path):
            continue
        r = RK.run_target(int(tid), K, kpid, NEG, npid, neg_pool, source, ids, scaler, KC.EPOCHS)
        rec = {**stamp, "experiment": "IM", "arm": "A200", "negSource": source, "negPoolSize": len(neg_pool),
               "eligible": r is not None, **(r or {"participant": int(tid)})}
        KC.write_json(path, rec)
        if r:
            print(f"  {int(tid):>4}: enrol {r['nEnrol']:4d} held {r['nHeldOut']:4d} impostors {len(r['runs'])}, "
                  f"{r['epochsRun']} epochs, {(time.time() - t0) / 60:.1f} min", flush=True)
    print(f"[IM] done in {(time.time() - t0) / 60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
