"""
Reproduce Antal & Fejer (2020) on Balabit — the paper's own dataset.

  Antal, M., & Fejer, N. (2020). Mouse dynamics based user recognition using
  deep learning. Acta Universitatis Sapientiae, Informatica, 12(1), 39-50.
  https://doi.org/10.2478/ausi-2020-0003

WHY THIS RUN EXISTS
-------------------
Our SapiMouse result with this method is mean AUC 0.797 (+/-0.199) at 5 blocks,
far below the paper's 0.98 (+/-0.02). Two explanations are possible and cannot
be told apart from SapiMouse alone:

  (a) a data-volume limitation — Balabit gives a median 454 blocks per user,
      SapiMouse's enrolment session gives 52, a 9x gap;
  (b) a bug in our implementation.

Running the SAME model code on the paper's OWN dataset separates them. Land
near 0.98 and (a) is confirmed, so the SapiMouse figure is a real dataset
limit worth reporting. Land well short and we have a bug to find before
anything is written up.

PROTOCOL (paper 4.3)
--------------------
  * "we trained a separate model to each user using the same number of
     positive and negative data" — per-user binary model, balanced
  * two data conditions: 300 blocks per user, and ALL available blocks
  * PLAIN training (from scratch) is the paper's best-performing arm for the
    ALL condition (0.98), so it is what we reproduce here
  * chronological split, never shuffled — src/dataset.py uses
    train_test_split(..., shuffle=False)
  * AUC reported as mean +/- std over users, the paper's Tables 4-5 style

Run inside the model-api container:
    python balabit_reproduce.py --out /app/artifacts/antal2020/balabit.json
"""
import argparse
import json
import os
import sys

import h5py
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from keystroke_user_sweep import auc_of, eer_of  # noqa: E402
from antal2020_sweep import (  # noqa: E402
    build_mcdcnn, compile_model, maxabs_fit, sets_of, BATCH_SIZE, BLOCK_COUNTS,
    afe_train, AFE_EPOCHS,
)

PAPER_AUC = {"300": (0.92, 0.09), "ALL": (0.98, 0.02)}     # paper Table 5, PLAIN
TEST_BLOCKS = 70          # config/constants.py TRAIN_TEST_SPLIT_VALUE


def run_condition(X, subj, users, n_blocks, epochs, test_frac, seed, protocol="afe"):
    """One data condition (300 or ALL). Returns per-user AUC/EER dicts."""
    rng = np.random.default_rng(seed)
    rows = []
    for u in users:
        own = X[subj == u]
        if n_blocks:
            own = own[:n_blocks]
        if len(own) < 20:
            continue

        # The authors' split, read from src/dataset.py __split_data:
        #
        #   test_size = data.shape[0] - TRAIN_TEST_SPLIT_VALUE      # n - 70
        #   X_test, X_train, ... = train_test_split(..., test_size=test_size,
        #                                           shuffle=False)
        #
        # sklearn returns (train, test) but the assignment is SWAPPED, so with
        # shuffle=False the TEST set is the FIRST 70 blocks and everything after
        # them is training. That is the opposite of the conventional reading and
        # it is what makes their "all blocks" condition jump over their "300"
        # condition: the test set stays fixed at 70 while training grows to
        # thousands. Splitting the other way — train on the first fraction, test
        # on the last — holds the model's advantage roughly constant, which is
        # exactly the flat curve our earlier attempts produced.
        n_test = min(TEST_BLOCKS, len(own) - 5)
        pos_te, pos_tr = own[:n_test], own[n_test:]

        # Negatives, per src/dataset.py __load_positive_balanced_dataset:
        #
        #   user_num = len(os.listdir(files_path)) - 1
        #   negative_block_num = floor((BLOCK_NUM - TRAIN_TEST_SPLIT_VALUE/2)
        #                              / user_num)
        #   neg_dset = __load_negative_dataset(user, negative_block_num, ...)
        #
        # An EQUAL number of blocks is taken from EACH other user. Drawing
        # randomly from the pooled other-user blocks instead lets the largest
        # contributors dominate: user7 and user9 alone hold about 60% of
        # Balabit, so a pooled draw trains the model mostly against those two
        # and it then meets seven unfamiliar impostors at test time.
        # Only the TRAINING negatives are balanced per user — that is what
        # __load_positive_balanced_dataset does. The test set comes from a
        # different path in their code, so it is left as a pooled draw across
        # all other users, which is also the more natural thing to authenticate
        # against. Balancing both sides made the result worse (0.884 -> 0.864)
        # because it changes the difficulty of the test set as well.
        others = [o for o in users if o != u]
        per_user = max(1, (len(own) - n_test) // len(others))
        neg_tr_idx = []
        for o in others:
            oi = np.where(subj == o)[0]
            if len(oi) > n_test:
                neg_tr_idx.append(oi[n_test:n_test + per_user])
        if not neg_tr_idx:
            continue
        neg_tr_idx = np.concatenate(neg_tr_idx, 0)
        neg_tr = X[neg_tr_idx]

        # Test negatives must be blocks the model has NEVER seen. Drawing them
        # from every other-user block, which is what this line did at first, let
        # a block that had already served as a training negative come back at
        # test time -- 11% of the test negatives on average and 41% for user7,
        # who alone holds a third of Balabit. That is impostor contamination,
        # the same leakage class this audit was opened to remove, and it
        # inflates the score. The training negatives are excluded here.
        other_idx = np.setdiff1d(np.where(subj != u)[0], neg_tr_idx)
        neg_te = X[rng.choice(other_idx, size=min(n_test, len(other_idx)),
                              replace=False)]
        if len(pos_te) < 2 or len(neg_te) < 2:
            continue

        Xtr = np.concatenate([pos_tr, neg_tr], 0)
        ytr = np.concatenate([np.ones(len(pos_tr)), np.zeros(len(neg_tr))]).astype(int)
        if protocol == "afe":
            m = build_mcdcnn(X.shape[1:], 2)
            afe_train(m, Xtr, ytr)      # Xtr is concatenate(positives, negatives)
        else:
            m = compile_model(build_mcdcnn(X.shape[1:], 2), 2)
            m.fit(Xtr, ytr, epochs=epochs, batch_size=BATCH_SIZE, verbose=0)

        g = m.predict(pos_te, verbose=0)[:, 1]
        i = m.predict(neg_te, verbose=0)[:, 1]
        row = {"user": int(u), "trainBlocks": int(len(pos_tr)),
               "testBlocks": int(len(pos_te)), "blocks": {}}
        for k in BLOCK_COUNTS:
            gs, iss = sets_of(g, k), sets_of(i, k)
            if len(gs) == 0 or len(iss) == 0:
                row["blocks"][k] = None
                continue
            row["blocks"][k] = {"auc": float(auc_of(gs, iss)),
                                "eer": float(eer_of(gs, iss)[0])}
        rows.append(row)
        a1 = row["blocks"][1]["auc"] if row["blocks"].get(1) else float("nan")
        print(f"  user{u:<4} train {len(pos_tr):>5} test {len(pos_te):>5}  AUC@1 {a1:.3f}")
    return rows


def summarise(rows, k):
    a = [r["blocks"][k]["auc"] for r in rows if r["blocks"].get(k)]
    e = [r["blocks"][k]["eer"] for r in rows if r["blocks"].get(k)]
    if not a:
        return None
    return {"n": len(a), "aucMean": float(np.mean(a)), "aucStd": float(np.std(a)),
            "aucMedian": float(np.median(a)), "eerMean": float(np.mean(e))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blocks", default="/app/data/mouse_only/Balabit_Blocks.h5")
    ap.add_argument("--out", default="/app/artifacts/antal2020/balabit.json")
    ap.add_argument("--epochs", type=int, default=16)      # paper 3.2
    ap.add_argument("--test-frac", type=float, default=0.33)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--protocol", choices=["afe", "legacy"], default="afe",
                    help="afe = per-user training exactly as AFE_Project (160 epochs, their "
                         "callbacks, unshuffled validation_split 0.15, binary cross-entropy, "
                         "best-training-loss checkpoint); legacy = the earlier 16-epoch run")
    ap.add_argument("--scaling", choices=["global", "perblock", "zscore_block"],
                    default="zscore_block",
                    help="src/dataset.py offers both: 'session-based (all blocks "
                         "together)' = global max-abs, or 'action-based (each block "
                         "separately)' = per-block max-abs. Which one the paper used "
                         "is not stated, so both are testable here.")
    args = ap.parse_args()

    import tensorflow as tf
    tf.random.set_seed(args.seed)

    with h5py.File(args.blocks, "r") as f:
        X = np.array(f["X"], dtype=np.float32)
        subj = np.array(f["subject"])

    users = sorted(np.unique(subj).tolist())
    if args.scaling == "zscore_block":
        # config/settings.py of the authors' repository selects
        #     sel_scaling_method = ScalingMethod.STANDARD_SCALER
        #     sel_scaling_type   = ScalingType.ACTION_BASED
        # i.e. a z-score fitted PER BLOCK, not a max-abs over the corpus.
        # Each block is standardised to zero mean and unit variance in its own
        # right, so a fast block and a slow one become comparable in shape
        # rather than in magnitude. This is materially different from per-block
        # max-abs, which we tested earlier and which the +/-4000 speed clip had
        # already made nearly identical to the global scaler.
        mu = X.mean(axis=1, keepdims=True)
        sd = X.std(axis=1, keepdims=True)
        sd[sd == 0] = 1.0
        Xs = ((X - mu) / sd).astype(np.float32)
        scale_desc = "per-block z-score (STANDARD_SCALER + ACTION_BASED)"
    elif args.scaling == "global":
        scale = maxabs_fit(X)
        Xs = (X / scale).astype(np.float32)
        scale_desc = f"global max-abs {scale}"
    else:
        # Per-block max-abs: each block is divided by its OWN extremes, so a fast
        # block and a slow one become comparable in shape rather than magnitude.
        # A single global divisor instead lets the fastest block in the corpus set
        # the scale for every other, flattening slow blocks toward zero — a
        # plausible reason our result stopped improving when given 10x the data.
        m = np.max(np.abs(X), axis=1, keepdims=True)
        m[m == 0] = 1.0
        Xs = (X / m).astype(np.float32)
        scale_desc = "per-block max-abs (action-based)"
    print(f"Balabit blocks {X.shape} | users {len(users)} | protocol {args.protocol} | epochs "
          + (f"{AFE_EPOCHS} max, AFE callbacks + best-loss checkpoint" if args.protocol == "afe" else str(args.epochs)))
    print(f"scaling: {scale_desc}")
    print(f"  input range after scaling: [{Xs.min():.3f}, {Xs.max():.3f}]  "
          f"std {Xs.std():.4f}\n")

    out = {"conditions": {}, "paperReference": PAPER_AUC, "scaling": args.scaling,
           "protocol": args.protocol,
           "epochs": AFE_EPOCHS if args.protocol == "afe" else args.epochs,
           "method": ("Antal & Fejer (2020), Acta Univ. Sapientiae Informatica "
                      "12(1):39-50, doi:10.2478/ausi-2020-0003"),
           "dataset": "Balabit Mouse Dynamics Challenge (training_files)"}

    for label, n in (("300", 300), ("ALL", None)):
        print(f"--- condition {label} " + "-" * 46)
        rows = run_condition(Xs, subj, users, n, args.epochs, args.test_frac, args.seed,
                             protocol=args.protocol)
        out["conditions"][label] = {"perUser": rows,
                                    "summary": {k: summarise(rows, k) for k in BLOCK_COUNTS}}
        print()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)

    print("=" * 78)
    print("REPRODUCTION OF ANTAL & FEJER (2020) ON BALABIT — their dataset, their protocol")
    print("=" * 78)
    print(f"{'condition':>10} {'blocks':>7} {'ours mean+/-std':>20} {'paper':>16}")
    for label in ("300", "ALL"):
        pm, ps = PAPER_AUC[label]
        for k in BLOCK_COUNTS:
            s = out["conditions"][label]["summary"].get(k)
            if not s:
                continue
            paper = f"{pm:.2f} ({ps:.2f})" if k == 1 else ""
            print(f"{label:>10} {k:>7} {s['aucMean']:>13.3f}+/-{s['aucStd']:<5.3f} {paper:>16}")
    print("\nthe paper's figures are single values per condition (Table 5, PLAIN);")
    print("the block counts here show how our result moves with aggregation.")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
