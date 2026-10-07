"""
PART 4 — why does Continuum work for some users and not others?

Extracts behavioural features per KeyRecs participant from the SAME windows the
population sweep evaluated, then relates them to that participant's measured EER.

No model is trained here and no evaluation protocol is touched. This is
observational analysis of the frozen baseline's own inputs and outputs.

Spearman (rank) correlation is used throughout: the relationships need not be
linear, and rank correlation is not dragged around by a few extreme typists.
"""
import json
import h5py
import numpy as np

H5 = "data/keyrecs_impostors.h5"
POP = "artifacts/xai/population_keystroke.json"

# column order verified against the data: [id1/254, id2/254, dwell1, dwell2, DD, UD]
ID1, ID2, DW1, DW2, DD, UD = range(6)


def rank(a):
    """Average-rank transform, ties shared — needed for a correct Spearman."""
    order = np.argsort(a, kind="mergesort")
    r = np.empty(len(a), dtype=float)
    r[order] = np.arange(len(a), dtype=float)
    # average tied ranks
    _, inv, cnt = np.unique(a, return_inverse=True, return_counts=True)
    for i in np.where(cnt > 1)[0]:
        m = inv == i
        r[m] = r[m].mean()
    return r


def spearman(a, b):
    ra, rb = rank(np.asarray(a, float)), rank(np.asarray(b, float))
    ra -= ra.mean()
    rb -= rb.mean()
    d = np.sqrt((ra ** 2).sum() * (rb ** 2).sum())
    return float((ra * rb).sum() / d) if d else 0.0


def perm_p(a, b, n=20000, seed=7):
    """Permutation p-value for the rank correlation — no scipy available."""
    rng = np.random.default_rng(seed)
    obs = abs(spearman(a, b))
    b = np.asarray(b, float)
    hits = sum(abs(spearman(a, rng.permutation(b))) >= obs for _ in range(n))
    return (hits + 1) / (n + 1)


def features(w):
    """Behavioural descriptors for one participant's windows. w: (N, 50, 6)."""
    flat = w.reshape(-1, 6)
    dd, dw1, ud = flat[:, DD], flat[:, DW1], flat[:, UD]

    # per-window means, so between-window spread = session/passage variation
    win_dd = w[:, :, DD].mean(axis=1)

    # digraph vocabulary: how varied is the key material this person produced
    pairs = (np.round(w[:, :, ID1] * 254).astype(int) * 256
             + np.round(w[:, :, ID2] * 254).astype(int)).ravel()

    return {
        "n_windows": len(w),
        # speed
        "dd_mean": float(dd.mean()),
        "dwell_mean": float(dw1.mean()),
        # variability — the "is your rhythm steady" family
        "dd_std": float(dd.std()),
        "dd_cv": float(dd.std() / dd.mean()),
        "dwell_std": float(dw1.std()),
        "dwell_cv": float(dw1.std() / dw1.mean()),
        "ud_std": float(ud.std()),
        # robust spread, immune to the long right tail of pauses
        "dd_iqr": float(np.percentile(dd, 75) - np.percentile(dd, 25)),
        # pause structure
        "pause_rate_300ms": float((dd > 0.30).mean()),
        "pause_rate_500ms": float((dd > 0.50).mean()),
        # drift across the session: do later windows differ from earlier ones
        "between_window_std": float(win_dd.std()),
        "within_window_std": float(w[:, :, DD].std(axis=1).mean()),
        # text material
        "digraph_unique": int(len(np.unique(pairs))),
        "digraph_entropy": float(_entropy(pairs)),
    }


def _entropy(x):
    _, c = np.unique(x, return_counts=True)
    p = c / c.sum()
    return float(-(p * np.log2(p)).sum())


def main():
    pop = json.load(open(POP))
    per = {u["participant"]: u for u in pop["perUser"]}

    with h5py.File(H5, "r") as f:
        pid = f["participant"][:]
        W = f["windows"]
        rows = []
        for t in sorted(per):
            w = W[pid == t]
            if len(w) == 0:
                continue
            r = features(w)
            r.update(participant=t, eer=per[t]["eer"], auc=per[t]["auc"],
                     tar_far01=per[t]["tarAtFar01"], n_enrol=per[t]["nEnrol"],
                     gen_mean=per[t]["genuineMean"], imp_mean=per[t]["impostorMean"])
            rows.append(r)

    print(f"n = {len(rows)} participants\n")
    eer = [r["eer"] for r in rows]

    feats = ["n_enrol", "n_windows", "dd_mean", "dwell_mean", "dd_std", "dd_cv",
             "dwell_std", "dwell_cv", "ud_std", "dd_iqr", "pause_rate_300ms",
             "pause_rate_500ms", "between_window_std", "within_window_std",
             "digraph_unique", "digraph_entropy"]

    print("SPEARMAN RANK CORRELATION WITH PER-USER EER  (higher EER = worse)")
    print(f"  {'feature':<22} {'rho':>7}  {'p':>8}   note")
    out = []
    for k in feats:
        v = [r[k] for r in rows]
        if len(set(v)) < 3:
            continue
        rho = spearman(eer, v)
        p = perm_p(eer, v)
        out.append((abs(rho), k, rho, p))
    for _, k, rho, p in sorted(out, reverse=True):
        star = "***" if p < 0.001 else "**" if p < 0.01 else "*" if p < 0.05 else "ns"
        print(f"  {k:<22} {rho:+7.3f}  {p:8.4f}   {star}")

    # --- tercile comparison -------------------------------------------------
    rows.sort(key=lambda r: r["eer"])
    n = len(rows)
    groups = [("EASY  (best third)", rows[:n // 3]),
              ("MEDIAN(middle third)", rows[n // 3:2 * n // 3]),
              ("HARD  (worst third)", rows[2 * n // 3:])]

    print("\n\nTERCILE COMPARISON")
    cols = ["eer", "auc", "tar_far01", "gen_mean", "imp_mean", "n_enrol",
            "dd_mean", "dd_cv", "dwell_cv", "between_window_std",
            "pause_rate_300ms", "digraph_entropy"]
    print(f"  {'group':<22}" + "".join(f"{c:>13}" for c in cols))
    for name, g in groups:
        line = f"  {name:<22}"
        for c in cols:
            line += f"{np.median([r[c] for r in g]):13.4f}"
        print(line)

    # explicit test of the enrolment-volume hypothesis
    print("\n\nCONTROLLED TEST — does more enrolment data help?")
    med = np.median([r["n_enrol"] for r in rows])
    lo = [r["eer"] for r in rows if r["n_enrol"] <= med]
    hi = [r["eer"] for r in rows if r["n_enrol"] > med]
    print(f"  below-median enrolment (n={len(lo)}): median EER {np.median(lo):.2%}")
    print(f"  above-median enrolment (n={len(hi)}): median EER {np.median(hi):.2%}")
    print(f"  difference: {np.median(hi) - np.median(lo):+.2%}")
    obs = np.median(hi) - np.median(lo)
    rng = np.random.default_rng(11)
    allv = np.array([r["eer"] for r in rows])
    k = len(hi)
    null = []
    for _ in range(20000):
        s = rng.permutation(allv)
        null.append(np.median(s[:k]) - np.median(s[k:]))
    p = (np.sum(np.abs(null) >= abs(obs)) + 1) / 20001
    print(f"  permutation p = {p:.4f}  -> {'no effect' if p > 0.05 else 'effect'}")

    json.dump(rows, open("artifacts/xai/part4_difficulty.json", "w"), indent=1)
    print("\nwrote artifacts/xai/part4_difficulty.json")


if __name__ == "__main__":
    main()
