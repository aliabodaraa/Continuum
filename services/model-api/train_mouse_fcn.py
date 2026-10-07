"""
Production mouse base for the final configuration (artifacts/repr_arch_study/RUN_LOG.md):

    base paper      SapiMouse (Antal, Fejer & Buza, IEEE SACI 2021)
    representation  (|dx|, |dy|) per step, 50-step windows, stride 10  (repr_arch_study "A5")
    architecture    SapiMouse's FCN: Conv 128/k8 -> 256/k5 -> 128/k3, BatchNorm + ReLU, GAP
    personalisation api.py base-feature-extractor mode: freeze conv1+bn1, fine-tune the rest
                    with a binary head (the study's `personalise`)

It is built from the SAME functions the pre-registered study used (raw_steps, windows, build,
train_base), so the deployed base is the evaluated one, not a re-implementation of it.

Leakage-safe, as every earlier mouse base: the 20 held-out users of
artifacts/mouse-ws50-aligned/holdout_users.json never enter training or the negatives file.

Outputs
    <out>/final_model/, best_model.h5   identification network (100-way head)
    <out>/scaler.json                   FeatureScaler fitted on the training windows
    <out>/arch.json                     architecture + layers api.py must freeze
    <out>/holdout_users.json            copied, so evaluation reads one directory
    <out>/results.json                  identification metrics and provenance
    <neg>                               raw A5 windows from base users only (key "X")

    python train_mouse_fcn.py --out /app/artifacts/mouse-fcn-a5 \
        --neg /app/data/mouse_only/Mouse_A5_W50_base.h5
"""
import argparse
import glob
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from repr_arch_study import (build, raw_steps, windows, _read_events, train_base,  # noqa: E402
                             FeatureScaler, REPRESENTATIONS, WS, STRIDE, BASE_SEEDS)

ARCH, REP = "B6", "A5"
FREEZE = ["conv1", "bn1"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default="/app/data/sapimouse")
    ap.add_argument("--holdout", default="/app/artifacts/mouse-ws50-aligned/holdout_users.json")
    ap.add_argument("--out", default="/app/artifacts/mouse-fcn-a5")
    ap.add_argument("--neg", default="/app/data/mouse_only/Mouse_A5_W50_base.h5")
    ap.add_argument("--seed", type=int, default=BASE_SEEDS[0])
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--threads", type=int, default=16)
    args = ap.parse_args()

    import tensorflow as tf
    import h5py
    tf.config.threading.set_intra_op_parallelism_threads(args.threads)
    os.makedirs(args.out, exist_ok=True)

    holdout_doc = json.load(open(args.holdout))
    holdout = holdout_doc["holdout_users"]
    uids = sorted((os.path.basename(d) for d in glob.glob(os.path.join(args.data_dir, "user*"))),
                  key=lambda u: int(u[4:]))
    base_users = [u for u in uids if u not in holdout]

    def sessions(u):
        cs = sorted(glob.glob(os.path.join(args.data_dir, u, "*.csv")))
        lo = [c for c in cs if "3min" in os.path.basename(c)]
        sh = [c for c in cs if "1min" in os.path.basename(c)]
        return (lo[0] if lo else None), (sh[0] if sh else None)

    Xtr, ytr, Xva, yva, Xte, yte, neg = [], [], [], [], [], [], []
    for ci, u in enumerate(base_users):
        lo, sh = sessions(u)
        if not lo or not sh:
            continue
        R = raw_steps(_read_events(lo))
        cut = int(len(R) * 0.8)
        a, b = windows(R, 1.0, REP, 0, cut), windows(R, 1.0, REP, cut, None)
        Xtr.append(a); ytr += [ci] * len(a); Xva.append(b); yva += [ci] * len(b)
        neg.append(windows(R, 1.0, REP))
        c = windows(raw_steps(_read_events(sh)), 1.0, REP)
        Xte.append(c); yte += [ci] * len(c)
    Xtr, Xva, Xte = np.concatenate(Xtr), np.concatenate(Xva), np.concatenate(Xte)
    remap = {c: i for i, c in enumerate(sorted(set(ytr)))}
    ytr = np.asarray([remap[c] for c in ytr]); yva = np.asarray([remap[c] for c in yva])
    yte = np.asarray([remap.get(c, -1) for c in yte])
    scaler = FeatureScaler.fit(Xtr)
    scaler.save(os.path.join(args.out, "scaler.json"))
    print(f"base users {len(base_users)} | train {Xtr.shape} val {Xva.shape} test {Xte.shape}")

    t0 = time.time()
    model, epochs = train_base(ARCH, scaler.transform(Xtr), ytr, scaler.transform(Xva), yva,
                               len(remap), args.seed, args.epochs)
    ok = yte >= 0
    top1 = float((model.predict(scaler.transform(Xte[ok]), batch_size=1024, verbose=0)
                  .argmax(1) == yte[ok]).mean())
    model.save(os.path.join(args.out, "final_model"))
    model.save(os.path.join(args.out, "best_model.h5"))
    print(f"trained {epochs} epochs in {(time.time()-t0)/60:.1f} min | identification top-1 on the "
          f"base users' separate 1-min session {top1:.4f} (chance {1/len(remap):.4f})")

    neg = np.concatenate(neg).astype(np.float32)
    os.makedirs(os.path.dirname(args.neg), exist_ok=True)
    with h5py.File(args.neg, "w") as f:
        f.create_dataset("X", data=neg, compression="gzip")
        f.attrs["representation"] = REPRESENTATIONS[REP][0]
        f.attrs["users"] = "base users only (holdout excluded): " + ",".join(base_users)
    print(f"negatives: {neg.shape} raw windows from {len(base_users)} base users -> {args.neg}")

    json.dump({"arch": "fcn", "study_arm": ARCH, "representation": REP,
               "representation_desc": REPRESENTATIONS[REP][0], "window": WS, "stride": STRIDE,
               "freeze": FREEZE, "embedding_layer": "embedding"},
              open(os.path.join(args.out, "arch.json"), "w"), indent=1)
    json.dump(holdout_doc, open(os.path.join(args.out, "holdout_users.json"), "w"), indent=1)
    json.dump({"identificationTop1": top1, "classes": len(remap), "epochs": epochs,
               "seed": args.seed, "trainWindows": int(len(Xtr)), "negativesFile": args.neg,
               "negativeWindows": int(len(neg)),
               "provenance": "repr_arch_study final configuration; see artifacts/repr_arch_study/RUN_LOG.md"},
              open(os.path.join(args.out, "results.json"), "w"), indent=1)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
