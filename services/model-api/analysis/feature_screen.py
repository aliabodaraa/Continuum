"""
PART 7 — which additional features carry identity, measured rather than guessed.

Method
------
A feature is useful for verification if it varies MORE between people than within one
person. That is a one-way ANOVA F-ratio:

        F = between-participant variance / within-participant variance

F ~ 1 means the feature is noise for identity purposes. Large F means the feature separates
people. This is computed per WINDOW so it matches what the model actually consumes, over the
same 99 participants and the same windows the sweep evaluated.

F alone would be misleading if a candidate merely restates something the model already has,
so each candidate is also correlated (Spearman, over participant means) against the existing
feature set. A candidate with high F and low correlation to existing features is the only
kind worth the implementation cost.

Everything here is derived from the 50x6 windows already on disk — no new collection, and no
key identity beyond what the model is already given.
"""
import json
import h5py
import numpy as np

H5 = "data/keyrecs_impostors.h5"
ID1, ID2, DW1, DW2, DD, UD = range(6)


def rank(a):
    a = np.asarray(a, float)
    o = np.argsort(a, kind="mergesort")
    r = np.empty(len(a))
    r[o] = np.arange(len(a), dtype=float)
    _, inv, cnt = np.unique(a, return_inverse=True, return_counts=True)
    for i in np.where(cnt > 1)[0]:
        m = inv == i
        r[m] = r[m].mean()
    return r


def spear(a, b):
    ra, rb = rank(a) - rank(a).mean(), rank(b) - rank(b).mean()
    d = np.sqrt((ra ** 2).sum() * (rb ** 2).sum())
    return float((ra * rb).sum() / d) if d else 0.0


def candidates(w):
    """Per-window scalars. w: (N, 50, 6). Returns {name: (N,) array}.

    Split into what the model already receives (as window means, for reference) and what it
    does not. Nothing here touches key identity beyond id1/id2 already in the input.
    """
    dd, dw1, dw2, ud = w[:, :, DD], w[:, :, DW1], w[:, :, DW2], w[:, :, UD]
    eps = 1e-6
    d_dd = np.diff(dd, axis=1)                       # successive change in rhythm

    return {
        # --- already available to the model (window means of its own inputs) ---
        "[have] dd_mean": dd.mean(1),
        "[have] dwell_mean": dw1.mean(1),
        "[have] ud_mean": ud.mean(1),

        # --- dispersion: the model sees raw timings but never their spread ---
        "dd_std": dd.std(1),
        "dd_cv": dd.std(1) / (dd.mean(1) + eps),
        "dwell_std": dw1.std(1),
        "dwell_cv": dw1.std(1) / (dw1.mean(1) + eps),
        "dd_iqr": np.percentile(dd, 75, axis=1) - np.percentile(dd, 25, axis=1),
        "dd_mad": np.median(np.abs(dd - np.median(dd, axis=1, keepdims=True)), axis=1),

        # --- local jitter: how erratic is the rhythm step to step ---
        "jitter_mean_absdiff": np.abs(d_dd).mean(1),
        "jitter_norm": np.abs(d_dd).mean(1) / (dd.mean(1) + eps),
        "dd_lag1_autocorr": _lag1(dd),

        # --- shape of the timing distribution ---
        "dd_skew": _skew(dd),
        "dd_p90_p50": np.percentile(dd, 90, axis=1) / (np.median(dd, axis=1) + eps),

        # --- pause and burst structure ---
        "pause_frac_300ms": (dd > 0.30).mean(1),
        "pause_frac_500ms": (dd > 0.50).mean(1),
        "burst_frac_100ms": (dd < 0.10).mean(1),
        "longest_burst": _longest_run(dd < 0.15),

        # --- keypress overlap: rollover typing habit, strongly individual ---
        "rollover_frac": (ud < 0).mean(1),
        "dwell_over_dd": (dw1 / (dd + eps)).mean(1),
        "overlap_depth": np.where(ud < 0, -ud, 0).mean(1),

        # --- consistency between the two dwell slots ---
        "dwell_asym": np.abs(dw1.mean(1) - dw2.mean(1)),
    }


def _skew(x):
    m = x.mean(1, keepdims=True)
    s = x.std(1) + 1e-9
    return (((x - m) ** 3).mean(1)) / s ** 3


def _lag1(x):
    a = x[:, :-1] - x[:, :-1].mean(1, keepdims=True)
    b = x[:, 1:] - x[:, 1:].mean(1, keepdims=True)
    d = np.sqrt((a ** 2).sum(1) * (b ** 2).sum(1)) + 1e-9
    return (a * b).sum(1) / d


def _longest_run(mask):
    out = np.zeros(len(mask))
    for i, row in enumerate(mask):
        best = cur = 0
        for v in row:
            cur = cur + 1 if v else 0
            best = max(best, cur)
        out[i] = best
    return out


def f_ratio(vals, pid):
    """One-way ANOVA F: between-participant variance over within-participant variance."""
    parts = np.unique(pid)
    grand = vals.mean()
    between = sum(len(vals[pid == p]) * (vals[pid == p].mean() - grand) ** 2 for p in parts)
    within = sum(((vals[pid == p] - vals[pid == p].mean()) ** 2).sum() for p in parts)
    df_b, df_w = len(parts) - 1, len(vals) - len(parts)
    if within <= 0 or df_w <= 0:
        return float("nan")
    return float((between / df_b) / (within / df_w))


def main():
    with h5py.File(H5, "r") as f:
        pid = f["participant"][:]
        w = f["windows"][:]
    print(f"{len(w)} windows, {len(np.unique(pid))} participants\n")

    cand = candidates(w)
    have = {k: v for k, v in cand.items() if k.startswith("[have]")}

    # participant means, used for the redundancy check
    parts = np.unique(pid)
    pmean = {k: np.array([v[pid == p].mean() for p in parts]) for k, v in cand.items()}

    rows = []
    for name, v in cand.items():
        F = f_ratio(v, pid)
        # worst-case redundancy: strongest |rho| against anything the model already has
        red = max(abs(spear(pmean[name], pmean[h])) for h in have) if not name.startswith("[have]") else 1.0
        rows.append((F, name, red))

    rows.sort(reverse=True)
    print("IDENTITY INFORMATION PER CANDIDATE FEATURE")
    print("  F = between-subject / within-subject variance (higher = separates people better)")
    print("  redundancy = strongest rank correlation with a feature the model already has\n")
    print(f"  {'feature':<24}{'F':>9}{'redundancy':>13}   verdict")
    base_F = max(f_ratio(v, pid) for v in have.values())
    for F, name, red in rows:
        if name.startswith("[have]"):
            print(f"  {name:<24}{F:>9.1f}{'—':>13}   (already an input)")
            continue
        if F < 2:
            verdict = "weak — skip"
        elif red > 0.75:
            verdict = "redundant with existing"
        elif F >= base_F:
            verdict = "STRONG, and new"
        else:
            verdict = "useful, and new"
        print(f"  {name:<24}{F:>9.1f}{red:>13.2f}   {verdict}")

    json.dump({"baseF": base_F,
               "features": [{"name": n, "F": F, "redundancy": r} for F, n, r in rows]},
              open("artifacts/xai/part7_features.json", "w"), indent=1)
    print("\nwrote artifacts/xai/part7_features.json")


if __name__ == "__main__":
    main()
