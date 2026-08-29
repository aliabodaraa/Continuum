"""
Does fixing the train/validation split actually change anything?

The deployed pipeline shuffled windows randomly before splitting 80/20. Windows slide with an
80% overlap, so that put near-identical copies of the same keystrokes on both sides: measured
here, 100% of validation windows had a near-duplicate in training. Everything computed on the
validation side was therefore measured against data the model had effectively already seen —
val_loss, which drives early stopping, and the per-user threshold calibrated by
`choose_user_threshold`.

This trains the SAME user on the SAME data under both splits and judges them both against a
yardstick neither one saw: the decontaminated held-out samples from holdout_audit.py, scored
against unseen KeyRecs impostors.

What to expect if the diagnosis is right: the old split reports better validation numbers while
being no better — or worse — on the honest held-out set, and calibrates a threshold that is too
low, because its "validation" impostor/genuine separation was inflated by memorised windows.

Usage (inside the model-api container):
    python split_ab_test.py --user-id 1 --out /app/artifacts/xai/split_ab_user1.json
"""
import argparse
import json
import sqlite3

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

import api
from api import (choose_user_threshold, get_dataset_negatives, scale_windows, split_no_overlap)
from keystroke_user_sweep import (CA_DB, LIVE_THRESHOLD, auc_of, build_steps, eer_of,
                                  steps_to_windows)
from holdout_audit import DUPLICATE, DEGENERATE, PROMPT_REUSE, held_out_by_sample

BASE_MODEL = "/app/artifacts/ws50-gru-v2/final_model"
NEG_DATASET = "/app/data/Rand_WS50.h5"
SCALER = "/app/artifacts/ws50-gru-v2/scaler.json"


def training_windows_grouped(user_id):
    """Positives with one group id per window — the same grouping keystrokeSecurity.js now
    sends to the model-api."""
    con = sqlite3.connect(f"file:{CA_DB}?mode=ro", uri=True)
    ids = [r[0] for r in con.execute(
        "SELECT id FROM keystroke_texts WHERE user_id=? AND is_training=1 ORDER BY id",
        (user_id,)).fetchall()]
    W, G = [], []
    for i in ids:
        ev = con.execute(
            "SELECT key_code, event_type, timestamp_relative, field_name "
            "FROM keystroke_events WHERE keystroke_text_id=? ORDER BY id", (i,)).fetchall()
        for w in steps_to_windows(build_steps(ev)):
            W.append(w)
            G.append(i)
    con.close()
    return np.asarray(W, dtype=np.float32), G


def old_split(n, seed=7):
    """Exactly what the deployed pipeline did: shuffle everything, cut at 80%."""
    idx = np.arange(n)
    np.random.default_rng(seed).shuffle(idx)
    cut = max(1, int(n * 0.8))
    if cut >= n:
        cut = n - 1
    return idx[:cut], idx[cut:]


def leakage(train_idx, val_idx, groups, gap=5):
    """Share of validation windows that overlap some training window.

    Two windows overlap when they come from the same sample and their indices differ by less
    than gap. Index distance alone is not enough — windows from different samples never share
    rows however close their positions."""
    tr = set(int(i) for i in train_idx)
    hit = 0
    for v in val_idx:
        v = int(v)
        for t in tr:
            if groups[t] == groups[v] and abs(t - v) < gap:
                hit += 1
                break
    return hit / max(len(val_idx), 1)


def fit(X_tr, y_tr, X_va, y_va, epochs=25):
    from tensorflow.keras.models import load_model
    from tensorflow.keras.optimizers import Adam
    from tensorflow.keras.callbacks import EarlyStopping
    from tensorflow.keras import backend as K
    K.clear_session()
    m = load_model(BASE_MODEL)
    m.layers[0].trainable = False
    m.compile(optimizer=Adam(learning_rate=3e-4),
              loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    h = m.fit(X_tr, y_tr, validation_data=(X_va, y_va), epochs=epochs, batch_size=16,
              verbose=0, callbacks=[EarlyStopping(patience=6, restore_best_weights=True,
                                                  monitor="val_loss")])
    return m, len(h.history.get("loss", []))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user-id", type=int, default=1)
    ap.add_argument("--impostors", default="/app/data/keyrecs_impostors.h5")
    ap.add_argument("--out", default=None)
    ap.add_argument("--repeats", type=int, default=3,
                    help="refits per arm; training is stochastic so a single fit proves little")
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    pos, pgroups = training_windows_grouped(args.user_id)
    neg = get_dataset_negatives(pos.shape[1], pos.shape[2], dataset_path=NEG_DATASET)
    if len(neg) == 0:
        raise SystemExit(f"no negatives loaded from {NEG_DATASET} — the comparison would be "
                         "meaningless (a positives-only model calls everything genuine)")
    want = max(len(pos) * 2, 60)
    neg = neg[np.random.default_rng(21).choice(len(neg), min(want, len(neg)), replace=False)]
    ngroups = [f"ds-{i}" for i in range(len(neg))]     # dataset negatives are independent

    pos_s = scale_windows(pos, SCALER)
    neg_s = scale_windows(neg, SCALER)
    print(f"user {args.user_id}: {len(pos)} positive windows from {len(set(pgroups))} samples, "
          f"{len(neg)} negatives")

    # honest yardstick: decontaminated held-out genuine vs unseen impostors
    groups_raw = held_out_by_sample(args.user_id)
    clean = {k: v for k, v in groups_raw.items()
             if k not in PROMPT_REUSE | DUPLICATE | DEGENERATE}
    held = scale_windows(np.concatenate([v for v in clean.values()]).astype(np.float32), SCALER)
    with h5py.File(args.impostors, "r") as f:
        imp_all = np.asarray(f["windows"], dtype=np.float32)
    imp = scale_windows(
        imp_all[np.random.default_rng(11).choice(len(imp_all), 4000, replace=False)], SCALER)
    print(f"yardstick: {len(held)} clean held-out windows from {len(clean)} samples "
          f"vs {len(imp)} unseen impostor windows\n")

    arms = {}
    for name in ("old (random shuffle)", "new (group split)"):
        rows = []
        for rep in range(args.repeats):
            if name.startswith("old"):
                p_tr, p_va = old_split(len(pos), seed=7 + rep)
                n_tr, n_va = old_split(len(neg), seed=7 + rep)
            else:
                p_tr, p_va, _ = split_no_overlap(len(pos), pgroups, seed=7 + rep)
                n_tr, n_va, _ = split_no_overlap(len(neg), ngroups, seed=7 + rep)

            X_tr = np.concatenate([pos_s[p_tr], neg_s[n_tr]])
            y_tr = np.concatenate([np.ones(len(p_tr)), np.zeros(len(n_tr))]).astype(np.int64)
            X_va = np.concatenate([pos_s[p_va], neg_s[n_va]])
            y_va = np.concatenate([np.ones(len(p_va)), np.zeros(len(n_va))]).astype(np.int64)
            sh = np.random.default_rng(3).permutation(len(X_tr))

            m, epochs = fit(X_tr[sh], y_tr[sh], X_va, y_va)
            val_pred = m.predict(X_va, verbose=0)[:, 1]
            thr, bal = choose_user_threshold(val_pred, y_va)
            g = m.predict(held, verbose=0)[:, 1]
            i = m.predict(imp, verbose=0)[:, 1]
            rows.append({
                "leakage": leakage(p_tr, p_va, pgroups),
                "valAccuracy": float(((val_pred >= 0.5).astype(int) == y_va).mean()),
                "calibratedThreshold": float(thr),
                "balancedAccuracy": bal,
                "epochs": epochs,
                "heldOutEer": float(eer_of(g, i)[0]),
                "heldOutAuc": float(auc_of(g, i)),
                "heldOutTarAt050": float((g >= LIVE_THRESHOLD).mean()),
                "heldOutFarAt050": float((i >= LIVE_THRESHOLD).mean()),
            })
            print(f"  {name:<22} rep{rep+1}  leak {rows[-1]['leakage']:5.1%}  "
                  f"val acc {rows[-1]['valAccuracy']:.3f}  thr {thr:.3f}  "
                  f"held-out EER {rows[-1]['heldOutEer']:.2%}  AUC {rows[-1]['heldOutAuc']:.3f}")
        arms[name] = rows

    def avg(name, key):
        vals = [r[key] for r in arms[name] if r[key] is not None]
        return float(np.mean(vals)) if vals else float("nan")

    print("\n  averaged over", args.repeats, "fits per arm")
    print(f"  {'':<22} {'leakage':>8} {'val acc':>8} {'threshold':>10} "
          f"{'EER':>8} {'AUC':>7} {'TAR@.5':>8} {'FAR@.5':>8}")
    for name in arms:
        print(f"  {name:<22} {avg(name,'leakage'):>7.1%} {avg(name,'valAccuracy'):>8.3f} "
              f"{avg(name,'calibratedThreshold'):>10.3f} {avg(name,'heldOutEer'):>7.2%} "
              f"{avg(name,'heldOutAuc'):>7.3f} {avg(name,'heldOutTarAt050'):>7.1%} "
              f"{avg(name,'heldOutFarAt050'):>7.1%}")

    o, n = "old (random shuffle)", "new (group split)"
    print(f"\n  validation leakage      {avg(o,'leakage'):.1%} -> {avg(n,'leakage'):.1%}")
    print(f"  reported val accuracy   {avg(o,'valAccuracy'):.3f} -> {avg(n,'valAccuracy'):.3f}"
          f"   ({'optimism removed' if avg(o,'valAccuracy') > avg(n,'valAccuracy') else 'no change'})")
    print(f"  calibrated threshold    {avg(o,'calibratedThreshold'):.3f} -> "
          f"{avg(n,'calibratedThreshold'):.3f}")
    d = avg(n, "heldOutEer") - avg(o, "heldOutEer")
    print(f"  HONEST held-out EER     {avg(o,'heldOutEer'):.2%} -> {avg(n,'heldOutEer'):.2%} "
          f"({d:+.2%})")
    print("\n  " + ("the fix removes inflated validation reporting without costing real accuracy"
                    if d <= 0.005 else
                    "the new split reports a WORSE held-out EER — investigate before shipping"))

    if args.out:
        with open(args.out, "w") as f:
            json.dump({"userId": args.user_id, "repeats": args.repeats,
                       "nPositive": int(len(pos)), "nPositiveSamples": len(set(pgroups)),
                       "nHeldOutClean": int(len(held)), "arms": arms}, f, indent=2)
        print("\nwrote", args.out)


if __name__ == "__main__":
    main()
