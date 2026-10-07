"""
Mimicry sweep: how closely must an attacker imitate a user's timing before they get in?

Why not "generate fake users"
-----------------------------
Synthetic impostors are only as strong as their generator. Sampling random timings produces
attackers no real person resembles, the model rejects them all, and the resulting FAR looks
excellent while meaning nothing — it measures the weakness of the generator, not the strength
of the system. Any single synthetic FAR number is therefore untrustworthy by construction.

What is measurable instead is a CURVE. Take real impostors and move their timing a controlled
fraction alpha of the way toward the target's, then plot FAR against alpha. alpha=0 is a real
unseen person; alpha=1 is an attacker who has perfectly reproduced the target's timing
statistics. The curve answers a security question no single number can: how much mimicry does
an attack actually require, and how sharply does the defence fail as it improves.

The real-impostor FAR at alpha=0 anchors the curve to measured reality, so the synthetic part
is an extrapolation from a real point rather than an invention.

Precedent: Sun & Upadhyaya, "Synthetic forgery attack against continuous keystroke
authentication systems", IJCB 2018 — reference [29] in the manuscript.

What is perturbed
-----------------
Only the four TIMING features (dwell1, dwell2, dd, ud). Key codes are left untouched: an
attacker types the same characters, and identity of keys is content, not behaviour. The
attribution study found timing carries 81% of the model's discriminative weight, so this is
the axis an attacker would have to work on.

Note dd/dwell1/ud are not independent — UD == DD - dwell1 identically — so ud is recomputed
after shifting rather than perturbed on its own, keeping every synthetic window physically
consistent.

Usage (inside the model-api container):
    python synth_users.py --user-id 1 --impostors /tmp/keyrecs_partial.h5 \
        --out /app/artifacts/xai/mimicry_user1.json
"""
import argparse
import json

import numpy as np

try:
    import h5py
except Exception:                                    # pragma: no cover
    h5py = None

from keystroke_user_sweep import (auc_of, genuine_windows, model_path_for, score,
                                  LIVE_THRESHOLD)

# column order: id1, id2, dwell1, dwell2, dd, ud
C_DWELL1, C_DWELL2, C_DD, C_UD = 2, 3, 4, 5
TIMING_COLS = (C_DWELL1, C_DWELL2, C_DD)   # ud is derived, not shifted independently


def mimic(imp, gen, alpha):
    """Move impostor timing a fraction alpha toward the genuine user's distribution.

    Per feature, shift by alpha*(mean_gen - mean_imp) and scale the spread toward the
    target's. alpha=0 leaves the real impostor untouched; alpha=1 matches the target's
    first two moments. Key codes are never altered.

    ud is then recomputed from the identity UD = DD - dwell1 so the window stays physically
    realisable — perturbing it independently would produce timings no keyboard can emit."""
    out = imp.copy()
    for c in TIMING_COLS:
        mi, si = imp[:, :, c].mean(), imp[:, :, c].std()
        mg, sg = gen[:, :, c].mean(), gen[:, :, c].std()
        target_m = mi + alpha * (mg - mi)
        target_s = si + alpha * (sg - si)
        if si > 1e-9:
            out[:, :, c] = (out[:, :, c] - mi) * (target_s / si) + target_m
        else:
            out[:, :, c] = target_m
    # keep timings physical: non-negative, and ud consistent with dd and dwell1
    np.clip(out[:, :, C_DWELL1], 0.001, None, out=out[:, :, C_DWELL1])
    np.clip(out[:, :, C_DWELL2], 0.001, None, out=out[:, :, C_DWELL2])
    np.clip(out[:, :, C_DD], 0.001, None, out=out[:, :, C_DD])
    out[:, :, C_UD] = out[:, :, C_DD] - out[:, :, C_DWELL1]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user-id", type=int, required=True)
    ap.add_argument("--impostors", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--n-impostor", type=int, default=800)
    ap.add_argument("--alphas", default="0,0.25,0.5,0.75,0.9,1.0")
    args = ap.parse_args()
    if h5py is None:
        raise SystemExit("h5py is required")

    model_path, _ = model_path_for(args.user_id)
    gen = np.asarray(genuine_windows(args.user_id, 0), dtype=np.float32)
    with h5py.File(args.impostors, "r") as f:
        imp = np.asarray(f["windows"], dtype=np.float32)
    rng = np.random.default_rng(5)
    if len(imp) > args.n_impostor:
        imp = imp[rng.choice(len(imp), args.n_impostor, replace=False)]

    gs = score(list(gen), args.user_id, model_path)
    print(f"user {args.user_id}: genuine n={len(gs)} mean={gs.mean():.3f} "
          f"accepted@{LIVE_THRESHOLD}={100*(gs>=LIVE_THRESHOLD).mean():.1f}%\n")

    print("  alpha   meaning                              FAR@0.50   mean score   AUC")
    rows = []
    for a in [float(x) for x in args.alphas.split(",")]:
        cohort = imp if a == 0 else mimic(imp, gen, a)
        s = score(list(cohort), args.user_id, model_path)
        far = float((s >= LIVE_THRESHOLD).mean())
        label = ("real unseen people" if a == 0 else
                 "timing fully matched" if a >= 1.0 else
                 f"{a:.0%} of the way to target")
        rows.append({"alpha": a, "far": far, "meanScore": float(s.mean()),
                     "auc": auc_of(gs, s), "label": label})
        print(f"  {a:5.2f}   {label:<36} {far:7.1%}    {s.mean():.3f}      {auc_of(gs, s):.3f}")

    base = rows[0]["far"]
    full = rows[-1]["far"]
    print(f"\n  real impostors get in {base:.1%} of windows; a perfect timing mimic "
          f"gets in {full:.1%}")
    # where does the defence start to fail?
    knee = next((r["alpha"] for r in rows if r["far"] >= 0.5), None)
    print("  FAR crosses 50% at alpha=" + (f"{knee}" if knee is not None else ">1.0 (never)"))

    res = {"userId": args.user_id, "threshold": LIVE_THRESHOLD,
           "genuineMean": float(gs.mean()), "nImpostorWindows": int(len(imp)),
           "method": "real impostors shifted a fraction alpha toward the target's timing "
                     "distribution (first two moments); key codes untouched; ud recomputed "
                     "from UD = DD - dwell1",
           "caveat": "alpha>0 rows are SYNTHETIC and bound FAR from below for a mimicry "
                     "attacker; only alpha=0 is measured reality",
           "curve": rows}
    if args.out:
        with open(args.out, "w") as f:
            json.dump(res, f, indent=2)
        print("\nwrote", args.out)


if __name__ == "__main__":
    main()
