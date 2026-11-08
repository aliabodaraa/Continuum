"""
Action-level mouse verification, following the published protocol of

  M. Antal and E. Egyed-Zsigmond, "Intrusion detection using mouse dynamics",
  IET Biometrics 8(5):285-294, 2019 (arXiv:1810.04668)

and reporting at the aggregation size that paper establishes as necessary.

WHAT IS REPRODUCED FROM THE PAPER
---------------------------------
  * actions, not fixed windows            (preprocess_mouse_actions.py)
  * 39 features per action                (ditto)
  * Random Forest, 100 trees, per user
  * balanced genuine / impostor training set
  * set-of-actions decision by AVERAGING per-action probabilities:
        P(A) = (1/k) * sum(p_i)
  * evaluation reported at k = 1, 5, 10, 13, 20 actions, because the paper finds
    10-20 actions are needed and reaches its best training AUC at 13.

WHAT DELIBERATELY DIFFERS, AND WHY
----------------------------------
  * Dataset. The paper uses Balabit (10 users). We use SapiMouse (120 users,
    Antal et al., SACI 2021), because 10 subjects cannot support a population
    claim and because the segmentation needs only the button/state field, which
    SapiMouse provides. This is the one substitution and it is declared wherever
    these numbers appear.
  * Split. The paper splits each user chronologically 2/3 - 1/3. We keep
    Continuum's stricter subject-disjoint protocol: 20 users are held out of the
    base entirely; each target enrols on its 3-minute session and is tested on
    its 1-minute session, against impostors drawn from the OTHER held-out users,
    with training negatives drawn only from base users. Targets, impostors and
    negative-suppliers are three disjoint sets of people.

Sets of actions slide only WITHIN one person's own contiguous action sequence.
Pooling actions across people and sliding a set over the pool would build
decisions from unrelated moments and inflate the result; the same trap cost the
keystroke channel 8.7 points of apparent impostor capture.

Run inside the model-api container:
    python mouse_action_sweep.py --out /app/artifacts/mouse-actions/action_sweep.json
"""
import argparse
import json
import os
import sys

import h5py
import numpy as np
from sklearn.ensemble import RandomForestClassifier

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from keystroke_user_sweep import auc_of, eer_of, tar_at_far  # noqa: E402

SET_SIZES = [1, 5, 10, 13, 20]
N_TREES = 100                  # the paper's Random Forest size
ENROL_SESSION, TEST_SESSION = 0, 1     # SapiMouse: 0 = 1-min, 1 = 3-min (sorted)


def cluster_boot(values, fn=np.median, n=2000, seed=7):
    v = np.asarray([x for x in values if x is not None and np.isfinite(x)], float)
    if len(v) < 2:
        return None
    rng = np.random.default_rng(seed)
    stat = [fn(v[rng.integers(0, len(v), len(v))]) for _ in range(n)]
    return [float(np.percentile(stat, 2.5)), float(np.percentile(stat, 97.5))]


def sets_of(probs, k):
    """Mean probability over every window of k CONSECUTIVE actions."""
    p = np.asarray(probs, float)
    if k <= 1:
        return p
    if len(p) < k:
        return np.array([])
    c = np.cumsum(np.insert(p, 0, 0.0))
    return (c[k:] - c[:-k]) / k


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--actions", default="/app/data/mouse_only/Mouse_Actions.h5")
    ap.add_argument("--holdout", default="/app/artifacts/mouse-ws50-gru/holdout_users.json")
    ap.add_argument("--out", default="/app/artifacts/mouse-actions/action_sweep.json")
    ap.add_argument("--seed", type=int, default=13)
    ap.add_argument("--model", choices=["rf", "cnnrnn"], default="rf",
                    help="rf = Antal 2019 (39 features + Random Forest); "
                         "cnnrnn = Chong TIFS 2020 / RUMBA IEEE CNS 2020 "
                         "(CNN+RNN over the action's resampled point sequence)")
    ap.add_argument("--epochs", type=int, default=25)
    args = ap.parse_args()

    with h5py.File(args.actions, "r") as f:
        X = np.array(f["X"], dtype=np.float64)
        SEQ = np.array(f["seq"], dtype=np.float32) if "seq" in f else None
        subj = np.array(f["subject"])
        sess = np.array(f["session"])
        names = f.attrs["feature_names"].split(",")
    if args.model == "cnnrnn" and SEQ is None:
        raise SystemExit("no `seq` dataset — re-run preprocess_mouse_actions.py")

    holdout = [int("".join(c for c in u if c.isdigit()))
               for u in json.load(open(args.holdout))["holdout_users"]]
    all_users = sorted(np.unique(subj).tolist())
    base_users = [u for u in all_users if u not in holdout]

    print(f"actions {X.shape}  users {len(all_users)}  "
          f"base {len(base_users)}  holdout {len(holdout)}")
    label = (f"RandomForest({N_TREES}) on 39 action features [Antal 2019]"
             if args.model == "rf" else
             "CNN+GRU on resampled action sequences [Chong TIFS 2020 / RUMBA CNS 2020]")
    print(f"model: {label} | set sizes {SET_SIZES}")
    print("targets, impostors and negative-suppliers are disjoint sets of people\n")

    rng = np.random.default_rng(args.seed)
    neg_pool_idx = np.where(np.isin(subj, base_users))[0]

    # ---- CNN-RNN arm: pre-train a shared identifier on the BASE users --------
    # Chong et al. and RUMBA-Mouse learn from the movement sequence itself
    # rather than from handcrafted summaries. As in the window pipeline the
    # shared model is pre-trained on subject IDENTIFICATION (a property a
    # sequence actually has) and only the head is replaced per user.
    base_net = scaler = None
    if args.model == "cnnrnn":
        from tensorflow.keras.callbacks import EarlyStopping
        from model import build_1d_cnn_2rnn, LEGACY_NETWORK
        from preprocessing import FeatureScaler

        bi = np.where(np.isin(subj, base_users))[0]
        remap = {u: i for i, u in enumerate(base_users)}
        yb = np.array([remap[s] for s in subj[bi]])
        # session-disjoint: identify from session 0, validate on session 1
        tr = bi[sess[bi] == ENROL_SESSION]
        va = bi[sess[bi] == TEST_SESSION]
        ytr_b = np.array([remap[s] for s in subj[tr]])
        yva_b = np.array([remap[s] for s in subj[va]])

        scaler = FeatureScaler.fit(SEQ[tr])
        Xb, Xv = scaler.transform(SEQ[tr]), scaler.transform(SEQ[va])
        base_net = build_1d_cnn_2rnn(Xb.shape[1:], num_classes=len(base_users),
                                     units=32, rnn_type="gru", **LEGACY_NETWORK)
        base_net.compile(optimizer="adam", loss="sparse_categorical_crossentropy",
                         metrics=["accuracy"])
        print(f"pre-training CNN+GRU identifier on {len(base_users)} base users "
              f"({len(tr)} actions)...")
        base_net.fit(Xb, ytr_b, validation_data=(Xv, yva_b), epochs=40, batch_size=128,
                     verbose=2,
                     callbacks=[EarlyStopping(patience=8, monitor="val_loss",
                                              restore_best_weights=True)])
        acc = float((base_net.predict(Xv, verbose=0).argmax(1) == yva_b).mean())
        print(f"  base identification top-1 = {acc:.4f} (chance {1/len(base_users):.4f})\n")

    targets = [u for u in holdout
               if ((subj == u) & (sess == ENROL_SESSION)).sum() >= 20
               and ((subj == u) & (sess == TEST_SESSION)).sum() >= 20]
    print(f"{'target':>7} {'enrol':>6} {'gen':>5} {'imp':>6} "
          + " ".join(f"{'EER@'+str(k):>8}" for k in SET_SIZES))

    rows = []
    for u in targets:
        tr_i = np.where((subj == u) & (sess == ENROL_SESSION))[0]
        te_i = np.where((subj == u) & (sess == TEST_SESSION))[0]

        # balanced negatives from BASE users only
        negs = rng.choice(neg_pool_idx, size=min(len(tr_i), len(neg_pool_idx)), replace=False)
        ytr = np.concatenate([np.ones(len(tr_i)), np.zeros(len(negs))])

        if args.model == "rf":
            clf = RandomForestClassifier(n_estimators=N_TREES, random_state=args.seed, n_jobs=-1)
            clf.fit(np.vstack([X[tr_i], X[negs]]), ytr)
            score = lambda idx: clf.predict_proba(X[idx])[:, 1]          # noqa: E731
        else:
            # transfer: copy every layer except the identification head into a
            # fresh binary model, then fine-tune with Conv1D frozen — the same
            # transfer contract the window pipeline uses.
            from tensorflow.keras.callbacks import EarlyStopping
            from model import build_1d_cnn_2rnn, LEGACY_NETWORK
            net = build_1d_cnn_2rnn(SEQ.shape[1:], num_classes=2, units=32, rnn_type="gru", **LEGACY_NETWORK)
            for i in range(len(net.layers) - 1):
                w = base_net.layers[i].get_weights()
                if w:
                    net.layers[i].set_weights(w)
            net.layers[0].trainable = False
            net.compile(optimizer="adam", loss="sparse_categorical_crossentropy",
                        metrics=["accuracy"])
            Xtr = scaler.transform(np.concatenate([SEQ[tr_i], SEQ[negs]], axis=0))
            net.fit(Xtr, ytr, epochs=args.epochs, batch_size=32, verbose=0,
                    callbacks=[EarlyStopping(patience=6, monitor="loss",
                                             restore_best_weights=True)])
            score = lambda idx: net.predict(scaler.transform(SEQ[idx]), verbose=0)[:, 1]  # noqa: E731

        g = score(te_i)

        # one contiguous run per impostor identity, never pooled
        imp_runs = {}
        for other in holdout:
            if other == u:
                continue
            oi = np.where((subj == other) & (sess == TEST_SESSION))[0]
            if len(oi):
                imp_runs[int(other)] = score(oi)
        if not imp_runs or len(g) == 0:
            continue

        row = {"participant": int(u), "enrolActions": int(len(tr_i)),
               "genuineActions": int(len(g)),
               "impostorParticipants": len(imp_runs),
               "impostorActions": int(sum(len(v) for v in imp_runs.values())), "sets": {}}

        for k in SET_SIZES:
            gs = sets_of(g, k)
            iss = [sets_of(v, k) for v in imp_runs.values()]
            iss = np.concatenate([a for a in iss if len(a)]) if any(len(a) for a in iss) else np.array([])
            if len(gs) == 0 or len(iss) == 0:
                row["sets"][k] = None
                continue
            eer, _ = eer_of(gs, iss)
            row["sets"][k] = {
                "eer": float(eer), "auc": float(auc_of(gs, iss)),
                "tarAtFar01": float(tar_at_far(gs, iss, 0.01)[0]),
                "nGenuineSets": int(len(gs)), "nImpostorSets": int(len(iss)),
            }
        rows.append(row)
        cells = " ".join(
            f"{row['sets'][k]['eer']*100:7.2f}%" if row["sets"][k] else f"{'-':>8}"
            for k in SET_SIZES)
        print(f"{u:>7} {len(tr_i):>6} {len(g):>5} {row['impostorActions']:>6} {cells}")

    # ---- summarise over users -----------------------------------------------
    summary = {}
    for k in SET_SIZES:
        e = [r["sets"][k]["eer"] for r in rows if r["sets"].get(k)]
        a = [r["sets"][k]["auc"] for r in rows if r["sets"].get(k)]
        t = [r["sets"][k]["tarAtFar01"] for r in rows if r["sets"].get(k)]
        if not e:
            continue
        summary[k] = {
            "nUsers": len(e),
            "eer": {"median": float(np.median(e)), "mean": float(np.mean(e)),
                    "iqr": [float(np.percentile(e, 25)), float(np.percentile(e, 75))],
                    "min": float(np.min(e)), "max": float(np.max(e)),
                    "ci95_median": cluster_boot(e)},
            "auc": {"median": float(np.median(a)), "ci95_median": cluster_boot(a)},
            "tarAtFar01": {"median": float(np.median(t)), "ci95_median": cluster_boot(t)},
        }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump({"perUser": rows, "summary": summary,
                   "method": "Antal & Egyed-Zsigmond, IET Biometrics 8(5):285-294, 2019",
                   "dataset": "SapiMouse (Antal et al., SACI 2021)",
                   "classifier": label,
                   "featureNames": names, "setSizes": SET_SIZES}, f, indent=2)

    print("\n" + "=" * 78)
    print(f"ACTION-BASED MOUSE VERIFICATION  n={len(rows)} held-out subjects")
    print(f"segmentation: Antal & Egyed-Zsigmond 2019 | data: SapiMouse")
    print(f"model: {label}")
    print("=" * 78)
    print(f"{'k actions':>10} {'median EER':>12} {'IQR':>17} {'CI95 median':>18} {'AUC':>8} {'TAR@FAR1%':>11}")
    for k in SET_SIZES:
        if k not in summary:
            continue
        s = summary[k]
        ci = s["eer"]["ci95_median"]
        print(f"{k:>10} {s['eer']['median']*100:>11.2f}% "
              f"{s['eer']['iqr'][0]*100:>7.2f}-{s['eer']['iqr'][1]*100:<8.2f} "
              f"{ci[0]*100:>7.2f}-{ci[1]*100:<8.2f} "
              f"{s['auc']['median']:>8.3f} {s['tarAtFar01']['median']*100:>10.2f}%")
    print(f"\nreference point — the paper reports 0.8994 AUC / 0.1880 EER for 20-action")
    print(f"sets on Balabit (10 users); the row above for k=20 is the same protocol")
    print(f"applied to SapiMouse with a subject-disjoint split.")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
