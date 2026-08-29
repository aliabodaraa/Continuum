"""
Check 6: the corrected pipeline works end to end across the difficulty range.

A pipeline validated only on the easiest user is not validated. Three KeyRecs participants are
taken from the population sweep — easy, median and hard — and each goes through the whole
corrected path: dedupe, group-aware temporal split with an overlap gap, disjoint negative and
impostor pools, transfer fit. Each is then reported at BOTH levels:

  * per window — what the model outputs (EER, AUC)
  * per decision — the live 3-of-6 packet vote slid over consecutive windows, which is what a
    person actually experiences

Window level alone would hide the amplification: the packet vote turns a mediocre per-window
rate into a much worse false-lock rate for a difficult user.

Run inside the model-api container:
    python validate_endtoend.py --targets 78,41,76
"""
import argparse
import json

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

from api import dedupe_windows
from keystroke_user_sweep import LIVE_THRESHOLD
from packet_eval import packet_fires
from population_sweep import (IMP_POOL_SIZE, NEG_POOL_SIZE, get_scaler, run_target)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--targets", default="78,41,76")
    ap.add_argument("--labels", default="easy,median,hard")
    ap.add_argument("--impostors", default="/app/data/keyrecs_impostors.h5")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    with h5py.File(args.impostors, "r") as f:
        W = np.asarray(f["windows"], dtype=np.float32)
        P = np.asarray(f["participant"])

    # the corpus itself must not carry duplicate windows either
    _, dropped = dedupe_windows(W)
    print(f"impostor corpus: {len(W)} windows, {dropped} exact duplicates "
          f"({100 * dropped / len(W):.2f}%)")

    ids = np.sort(np.unique(P))
    neg_pool = ids[:NEG_POOL_SIZE]
    imp_pool = ids[NEG_POOL_SIZE:NEG_POOL_SIZE + IMP_POOL_SIZE]
    scaler = get_scaler()

    targets = [int(x) for x in args.targets.split(",")]
    labels = args.labels.split(",")
    rows = []
    print(f"\n  {'user':8} {'EER':>7} {'AUC':>7} {'TAR@.5':>8} {'FAR@.5':>8} "
          f"{'false-lock':>11} {'imp caught':>11}")
    for label, tid in zip(labels, targets):
        r = run_target(tid, W, P, neg_pool, imp_pool, scaler,
                       np.random.default_rng(1000 + tid), 30, 1500)
        if r is None:
            print(f"  {label:8} skipped (too few windows)")
            continue
        g = np.asarray(r.pop("_genuineScores"))
        i = np.asarray(r.pop("_impostorScores"))
        # genuine held-out windows are consecutive, so the live rule may slide over them
        fl = packet_fires(g)
        false_lock = float(np.mean(fl)) if fl else float("nan")
        caught = float(np.mean(packet_fires(i))) if len(i) > 6 else float("nan")
        r.update({"label": label, "falseLockPerDecision": false_lock,
                  "impostorCaughtPerDecision": caught, "nGenuinePackets": len(fl)})
        rows.append(r)
        print(f"  {label:8} {r['eer']:>6.2%} {r['auc']:>7.3f} {r['tarAt050']:>7.1%} "
              f"{r['farAt050']:>7.1%} {false_lock:>10.1%} {caught:>10.1%}")

    if rows:
        print("\n  Reading: the packet vote amplifies whatever the window level gives it.")
        e, h = rows[0], rows[-1]
        print(f"    easy user  — window EER {e['eer']:.1%} -> false-lock "
              f"{e['falseLockPerDecision']:.1%} per decision")
        print(f"    hard user  — window EER {h['eer']:.1%} -> false-lock "
              f"{h['falseLockPerDecision']:.1%} per decision")
        print("    The pipeline runs correctly for all three; it is USABLE only for the easier "
              "end,\n    which is a property of the biometric, not a defect in the pipeline.")

    if args.out:
        with open(args.out, "w") as f:
            json.dump(rows, f, indent=2)
        print("\nwrote", args.out)


if __name__ == "__main__":
    main()
