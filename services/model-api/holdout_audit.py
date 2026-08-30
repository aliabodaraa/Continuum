"""
Is the held-out set that produced the headline keystroke numbers actually clean?

The published subject-disjoint result for user 1 (EER 7.1%, CI 5.6-8.8%) rests entirely on
the 196 windows carved from that user's `is_training=0` samples. This script audits that set
rather than the model, and re-derives the numbers under stricter assumptions.

Three problems were found by inspecting the database, and each is quantified here:

  1. WINDOWS ARE NOT INDEPENDENT OBSERVATIONS. The 196 windows come from only 20 samples
     (58 of the 78 held-out samples are too short to yield even one 50-digraph window), and
     the top 7 samples supply half of them. A bootstrap that resamples windows treats 196
     correlated observations as 196 independent ones and reports an interval far narrower
     than the evidence supports. The correct unit is the sample.

  2. PROMPT REUSE ACROSS THE SPLIT. The five fixed enrolment prompts were typed twice — once
     into the held-out side (ids 56-60, 8 June) and once into the training side (ids 74-78,
     12 June). No row is duplicated, so this is not window leakage, but the model sees the
     same words on both sides. Since key identity carries roughly a fifth of the model's
     discriminative weight, shared content is a plausible inflation mechanism.

  3. DEGENERATE AND DUPLICATE SAMPLES. Ids 66 and 67 are byte-identical (together 17% of all
     held-out windows); id 73 is the letter x repeated 182 times. Neither is natural typing,
     and repeated-character input has unnaturally regular timing that a verifier finds easy.

The script reports the headline numbers, then the same numbers with sample-level clustering,
then with the contaminated samples removed, so the size of each effect is visible separately.

Usage (inside the model-api container):
    python holdout_audit.py --impostors /app/data/keyrecs_impostors.h5 \
        --out /app/artifacts/xai/holdout_audit_user1.json
"""
import argparse
import json
import sqlite3

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

from keystroke_user_sweep import (CA_DB, LIVE_THRESHOLD, auc_of, build_steps, eer_of,
                                  model_path_for, score, steps_to_windows)

# Held-out samples that share their prompt with a training sample (the five fixed enrolment
# prompts, typed once into each side of the split).
PROMPT_REUSE = {56, 57, 58, 59, 60}
# Byte-identical pair; keeping one of the two is enough.
DUPLICATE = {67}
# Not natural typing: the letter x repeated 182 times.
DEGENERATE = {73}


def held_out_by_sample(user_id):
    """Windows grouped by the sample they came from, so the sample can be used as the
    resampling unit instead of the window."""
    con = sqlite3.connect(f"file:{CA_DB}?mode=ro", uri=True)
    ids = [r[0] for r in con.execute(
        "SELECT id FROM keystroke_texts WHERE user_id=? AND is_training=0 ORDER BY id",
        (user_id,)).fetchall()]
    out = {}
    for i in ids:
        ev = con.execute(
            "SELECT key_code, event_type, timestamp_relative, field_name "
            "FROM keystroke_events WHERE keystroke_text_id=? ORDER BY id", (i,)).fetchall()
        w = steps_to_windows(build_steps(ev))
        if len(w):
            out[i] = np.asarray(w, dtype=np.float32)
    con.close()
    return out


def cluster_ci(fn, groups, imp, n_boot=2000, seed=17):
    """Percentile CI resampling GROUPS (samples) with replacement.

    `groups` is a list of per-sample score arrays. Resampling whole samples preserves the
    correlation between windows that came from the same typing act; resampling windows
    destroys it and understates the interval."""
    rng = np.random.default_rng(seed)
    vals = []
    for _ in range(n_boot):
        pick = rng.integers(0, len(groups), len(groups))
        g = np.concatenate([groups[i] for i in pick])
        j = imp[rng.integers(0, len(imp), len(imp))]
        try:
            vals.append(fn(g, j))
        except Exception:
            pass
    return float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))


def window_ci(fn, gen, imp, n_boot=2000, seed=17):
    """The published method: resample WINDOWS independently. Kept for comparison only."""
    rng = np.random.default_rng(seed)
    vals = []
    for _ in range(n_boot):
        g = gen[rng.integers(0, len(gen), len(gen))]
        j = imp[rng.integers(0, len(imp), len(imp))]
        try:
            vals.append(fn(g, j))
        except Exception:
            pass
    return float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))


def report(name, groups, imp, note=""):
    gen = np.concatenate([g for g in groups.values()])
    eer = eer_of(gen, imp)[0]
    auc = auc_of(gen, imp)
    glist = list(groups.values())
    ci_w = window_ci(lambda a, b: eer_of(a, b)[0], gen, imp)
    ci_c = cluster_ci(lambda a, b: eer_of(a, b)[0], glist, imp)
    print(f"\n  {name}")
    if note:
        print(f"    {note}")
    print(f"    samples {len(groups):>3}   windows {len(gen):>4}")
    print(f"    EER  {eer:6.2%}   AUC {auc:.4f}   TAR@0.50 {(gen >= LIVE_THRESHOLD).mean():6.2%}")
    print(f"    CI (window bootstrap, published)  {ci_w[0]:.2%} - {ci_w[1]:.2%}"
          f"   width {ci_w[1]-ci_w[0]:.2%}")
    print(f"    CI (sample bootstrap, correct)    {ci_c[0]:.2%} - {ci_c[1]:.2%}"
          f"   width {ci_c[1]-ci_c[0]:.2%}"
          f"   [{(ci_c[1]-ci_c[0])/max(ci_w[1]-ci_w[0], 1e-9):.1f}x wider]")
    return {"name": name, "nSamples": len(groups), "nWindows": int(len(gen)),
            "eer": float(eer), "auc": float(auc),
            "tarAt050": float((gen >= LIVE_THRESHOLD).mean()),
            "ciWindowBootstrap": ci_w, "ciSampleBootstrap": ci_c}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user-id", type=int, default=1)
    ap.add_argument("--impostors", default="/app/data/keyrecs_impostors.h5")
    ap.add_argument("--out", default=None)
    ap.add_argument("--n-impostor", type=int, default=4000)
    ap.add_argument("--min-participant", type=int, default=40,
                    help="exclude participants below this id: 0-39 were seeded as demo "
                         "accounts, so they are training negatives and no longer unseen")
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    model_path, _ = model_path_for(args.user_id)
    groups_raw = held_out_by_sample(args.user_id)
    with h5py.File(args.impostors, "r") as f:
        imp_w = np.asarray(f["windows"], dtype=np.float32)
        imp_pid = np.asarray(f["participant"])
    if args.min_participant:
        keep = imp_pid >= args.min_participant
        print(f"impostors restricted to participants >= {args.min_participant}: "
              f"{keep.sum()} of {len(imp_w)} windows "
              f"({len(np.unique(imp_pid[keep]))} people still unseen by any account)")
        imp_w = imp_w[keep]
    rng = np.random.default_rng(11)
    if len(imp_w) > args.n_impostor:
        imp_w = imp_w[rng.choice(len(imp_w), args.n_impostor, replace=False)]
    imp = score(list(imp_w), args.user_id, model_path)

    groups = {k: score(list(v), args.user_id, model_path) for k, v in groups_raw.items()}
    total = sum(len(v) for v in groups.values())
    sizes = sorted((len(v) for v in groups.values()), reverse=True)
    cum = np.cumsum(sizes)
    half = int(np.searchsorted(cum, total * 0.5) + 1)
    print(f"user {args.user_id} held-out: {len(groups)} samples yielded {total} windows; "
          f"the largest {half} supply half of them")

    res = [report("as published (all held-out samples)", groups, imp)]

    clean = {k: v for k, v in groups.items()
             if k not in PROMPT_REUSE | DUPLICATE | DEGENERATE}
    removed = sorted(set(groups) & (PROMPT_REUSE | DUPLICATE | DEGENERATE))
    lost = total - sum(len(v) for v in clean.values())
    res.append(report(
        "contamination removed", clean,
        imp, f"dropped samples {removed} — {lost} windows ({100*lost/total:.0f}% of the set): "
             "prompts reused across the split, a byte-identical duplicate, and one "
             "repeated-character sample"))

    a, b = res[0], res[1]
    print(f"\n  effect of the contamination: EER {a['eer']:.2%} -> {b['eer']:.2%} "
          f"({b['eer']-a['eer']:+.2%})")
    print(f"  effect of the wrong bootstrap unit: interval width "
          f"{a['ciWindowBootstrap'][1]-a['ciWindowBootstrap'][0]:.2%} -> "
          f"{a['ciSampleBootstrap'][1]-a['ciSampleBootstrap'][0]:.2%}")
    print("\n  The honest headline is the clean EER with the sample-level interval:")
    print(f"    EER {b['eer']:.2%}  CI {b['ciSampleBootstrap'][0]:.2%} - "
          f"{b['ciSampleBootstrap'][1]:.2%}   (n = {b['nSamples']} samples, one user)")

    if args.out:
        with open(args.out, "w") as f:
            json.dump({"userId": args.user_id, "nImpostorWindows": int(len(imp_w)),
                       "removedSamples": removed,
                       "reasons": {"promptReuse": sorted(PROMPT_REUSE),
                                   "byteIdenticalDuplicate": sorted(DUPLICATE),
                                   "repeatedCharacter": sorted(DEGENERATE)},
                       "variants": res}, f, indent=2)
        print("\nwrote", args.out)


if __name__ == "__main__":
    main()
