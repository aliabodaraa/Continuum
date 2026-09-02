"""
End-to-end evaluation of the AUTHENTICATION DECISION, not the individual window.

Why this exists
---------------
Decision-level rates were previously derived from the per-window rate with a binomial
transform, P(>=3 of 6 windows low). That assumes the six windows are independent draws. They
are not: consecutive windows overlap by 80% (stride 10 of 50) and describe adjacent moments of
the same behaviour. Measured lag-1 autocorrelation of consecutive scores is ~0.28, and the
binomial understated the genuine false-lock rate by roughly 58x (0.07% predicted vs 4.04%
observed). A majority vote over positively-correlated draws has a much heavier tail than the
independent case, because low windows arrive in runs rather than scattered.

So the decision-level numbers are measured here by actually sliding the live rule over real
consecutive windows, exactly as the deployed system does.

Two further corrections over the earlier analysis:

  * Confidence intervals resample SESSIONS, not windows. Windows within a session are
    correlated, so resampling them independently understates uncertainty. A cluster
    (session-level) bootstrap is the correct unit here.

  * Sessions are never concatenated. A packet may only span windows from one continuous
    typing act; joining two sessions would invent a transition the system never sees.

The binomial figure is still printed alongside, explicitly labelled as the independence
lower bound, so the gap between the two is visible rather than hidden.

Usage (inside the model-api container):
    python packet_eval.py --user-id 1 --impostors /app/data/keyrecs_impostors.h5 \
        --out /app/artifacts/xai/packet_user1.json
"""
import argparse
import json
import sqlite3

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

from keystroke_user_sweep import (CA_DB, LIVE_THRESHOLD, build_steps, model_path_for,
                                  packet_rate, score, steps_to_windows)

# ---- identity scope -------------------------------------------------------
# This experiment is part of the FROZEN baseline. It addresses raw historical user_ids and
# must never resolve principal aliases: user_id=1 is 121 held-out samples, whereas the
# principal that owns it also owns 739935229538144, which would make it 243. The guard below
# raises if anything reaches for canonical resolution.
from identity_scope import ResearchScope, assert_research_scope
SCOPE = assert_research_scope(ResearchScope("baseline-keystroke-v1"), "baseline-keystroke-v1")

RECENT = 6        # packet length, mirrors ca-service RECENT_WINDOW_COUNT
VOTE_LOW = 3      # >= this many low windows fires the step-up (PACKET_VOTE_FRACTION 0.5)


def genuine_sessions(user_id, training_flag=0, exclude=()):
    """One list of consecutive windows per stored sample. Each sample is a continuous typing
    act, so packets never span two of them.

    `exclude` drops sample ids by keystroke_text_id — used to rerun on the clean subset after
    holdout_audit.py identified prompt reuse, a byte-identical duplicate and a
    repeated-character sample in user 1's held-out data."""
    con = sqlite3.connect(f"file:{CA_DB}?mode=ro", uri=True)
    ids = [r[0] for r in con.execute(
        "SELECT id FROM keystroke_texts WHERE user_id=? AND is_training=? ORDER BY id",
        (user_id, training_flag)).fetchall()]
    ids = [i for i in ids if i not in set(exclude)]
    out = []
    for i in ids:
        ev = con.execute(
            "SELECT key_code, event_type, timestamp_relative, field_name "
            "FROM keystroke_events WHERE keystroke_text_id=? ORDER BY id", (i,)).fetchall()
        w = steps_to_windows(build_steps(ev))
        if len(w) >= RECENT:
            out.append(w)
    con.close()
    return out


def impostor_sessions(path, max_subjects=40, rng=None, min_participant=40):
    """Consecutive windows grouped per participant. The converter emits them in order, so a
    participant's block is a usable sequence."""
    rng = rng or np.random.default_rng(13)
    with h5py.File(path, "r") as f:
        X = np.asarray(f["windows"])
        pid = np.asarray(f["participant"])
    # participants 0-39 were seeded as demo accounts, so they are training negatives now
    subs = np.unique(pid)
    subs = subs[subs >= min_participant]
    if len(subs) > max_subjects:
        subs = rng.choice(subs, max_subjects, replace=False)
    return [X[pid == s] for s in subs if (pid == s).sum() >= RECENT]


def packet_fires(scores):
    """Slide the live rule; return one boolean per packet position."""
    low = (np.asarray(scores) < LIVE_THRESHOLD).astype(int)
    return [low[i:i + RECENT].sum() >= VOTE_LOW for i in range(len(low) - RECENT + 1)]


def rate_with_cluster_ci(per_session_flags, n_boot=2000, seed=17):
    """Pooled rate plus a percentile CI from resampling SESSIONS with replacement.

    Resampling windows would treat correlated observations as independent and produce an
    interval that is too narrow; the session is the independent unit."""
    flat = [f for s in per_session_flags for f in s]
    if not flat:
        return float("nan"), (float("nan"), float("nan")), 0
    point = float(np.mean(flat))
    rng = np.random.default_rng(seed)
    n = len(per_session_flags)
    vals = []
    for _ in range(n_boot):
        pick = rng.integers(0, n, n)
        s = [f for i in pick for f in per_session_flags[i]]
        if s:
            vals.append(np.mean(s))
    lo, hi = (float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))) if vals else (float("nan"),) * 2
    return point, (lo, hi), len(flat)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user-id", type=int, required=True)
    ap.add_argument("--impostors", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--max-impostor-subjects", type=int, default=40)
    ap.add_argument("--exclude", default="",
                    help="comma-separated keystroke_text_ids to drop (contaminated samples "
                         "identified by holdout_audit.py)")
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    model_path, _ = model_path_for(args.user_id)

    exclude = [int(x) for x in args.exclude.split(",") if x.strip()]
    gsess = genuine_sessions(args.user_id, 0, exclude)
    if exclude:
        print(f"excluding contaminated samples: {exclude}")
    isess = impostor_sessions(args.impostors, args.max_impostor_subjects)
    print(f"genuine sessions: {len(gsess)}  impostor participants: {len(isess)}")

    g_flags, g_low = [], []
    for w in gsess:
        s = score(w, args.user_id, model_path)
        g_flags.append(packet_fires(s))
        g_low.append((s < LIVE_THRESHOLD).mean())

    i_flags, i_low = [], []
    for w in isess:
        s = score(list(w), args.user_id, model_path)
        i_flags.append(packet_fires(s))
        i_low.append((s < LIVE_THRESHOLD).mean())

    g_rate, g_ci, g_n = rate_with_cluster_ci(g_flags)
    i_rate, i_ci, i_n = rate_with_cluster_ci(i_flags)

    gw = float(np.mean([x for w, s in zip(gsess, g_low) for x in [s]]))
    iw = float(np.mean(i_low))
    binom_g, binom_i = packet_rate(gw), packet_rate(iw)

    print()
    print("  PER-WINDOW (the model's raw output)")
    print(f"    genuine low rate  {gw:.3%}      impostor low rate  {iw:.3%}")
    print()
    print("  PER-DECISION (the live 3-of-6 rule, slid over real consecutive windows)")
    print(f"    false lock      {g_rate:.3%}  CI({g_ci[0]:.3%}, {g_ci[1]:.3%})   n={g_n} packets")
    print(f"    impostor caught {i_rate:.3%}  CI({i_ci[0]:.3%}, {i_ci[1]:.3%})   n={i_n} packets")
    print()
    print("  BINOMIAL (assumes independent windows — lower bound only)")
    print(f"    false lock      {binom_g:.3%}   -> understates by {g_rate/binom_g:.0f}x"
          if binom_g > 0 else "    false lock      0")
    print(f"    impostor caught {binom_i:.3%}")
    print()
    print(f"  CI unit: session-level cluster bootstrap over {len(gsess)} genuine / "
          f"{len(isess)} impostor sessions")

    res = {
        "userId": args.user_id, "excludedSamples": exclude, "rule": f">={VOTE_LOW} of {RECENT} windows below {LIVE_THRESHOLD}",
        "perWindow": {"genuineLowRate": gw, "impostorLowRate": iw},
        "perDecisionEmpirical": {
            "falseLockRate": g_rate, "falseLockCI": g_ci, "nGenuinePackets": g_n,
            "impostorCatchRate": i_rate, "impostorCatchCI": i_ci, "nImpostorPackets": i_n,
            "nGenuineSessions": len(gsess), "nImpostorSessions": len(isess),
        },
        "perDecisionBinomial": {
            "falseLockRate": binom_g, "impostorCatchRate": binom_i,
            "note": "assumes independent windows; consecutive windows overlap 80% and are "
                    "positively correlated, so this is a LOWER BOUND on false locks",
        },
        "ciMethod": "session-level cluster bootstrap (windows within a session are correlated, "
                    "so resampling windows would understate uncertainty)",
    }
    if args.out:
        with open(args.out, "w") as f:
            json.dump(res, f, indent=2)
        print("\nwrote", args.out)


if __name__ == "__main__":
    main()
