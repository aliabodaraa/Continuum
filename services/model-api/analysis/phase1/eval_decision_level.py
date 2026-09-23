"""Decision-level evaluation (recovery plan, Phase 1).

The live system never accepts or rejects a single window: it decides over many windows. This module
measures accuracy at that unit, on the stored per-user score streams, without retraining anything.

Decisions
  A decision is a block of N consecutive windows taken from ONE contiguous stream: the target's own
  genuine session, or one impostor's run. Blocks never straddle two streams, and consecutive blocks
  are separated by GAP = 4 windows, so two decisions share no movement step (a window is 50 steps at
  stride 10; windows five apart share none). Decision length in seconds of movement:
  (40 + 10 N) x 0.0269 s, so N = 15 -> 5.1 s, 33 -> 10.0 s, 60 -> 17.2 s (the deployed vote length).

Statistics (higher = more genuine)
  mean  mean raw score of the block. Raw scores are not calibrated across users, so this one is
        only evaluated per user (per-user AUC, then the mean over users).
  vote  share of the block's windows at or above the user's own window threshold tau_u: the family
        of rules the live system uses ("k of N below tau_u"). Comparable across users by design,
        so it is also pooled over users.
  pct   mean percentile of the block's window scores within the user's own threshold-source
        distribution (enrolment scores for Method A, out-of-sample scores for Method B): the raw
        score normalised per user. Pooled over users.

Uncertainty
  Paired cluster bootstrap over users (users are resampled; all of a user's decisions go with
  them), the same unit as every other interval in this project.
"""
import numpy as np

SEC_PER_STEP = 0.0269
GAP = 4
LENGTHS = (15, 33, 60)


def seconds(n):
    return (40 + 10 * n) * SEC_PER_STEP


def blocks(seq, n, gap=GAP):
    """Non-overlapping, step-disjoint blocks of n windows from one contiguous stream."""
    s = np.asarray(seq, float)
    return [s[i:i + n] for i in range(0, len(s) - n + 1, n + gap)]


# ------------------------------------------------------------------ fast metrics ----------
def eer_fast(gen, imp):
    """Identical to keystroke_user_sweep.eer_of (same thresholds, same tie rule), O(n log n)."""
    gen, imp = np.asarray(gen, float), np.asarray(imp, float)
    ths = np.unique(np.concatenate([gen, imp, [0.0, 1.0]]))
    gs, is_ = np.sort(gen), np.sort(imp)
    far = 1.0 - np.searchsorted(is_, ths, "left") / len(is_)    # share of impostors >= t
    frr = np.searchsorted(gs, ths, "left") / len(gs)             # share of genuines  <  t
    i = int(np.argmin(np.abs(far - frr)))
    return float((far[i] + frr[i]) / 2)


def auc_fast(gen, imp):
    """Mann-Whitney AUC with ties counted as half (identical to auc_of)."""
    gen, imp = np.asarray(gen, float), np.asarray(imp, float)
    if not len(gen) or not len(imp):
        return float("nan")
    allv = np.concatenate([gen, imp])
    _, inv, cnt = np.unique(allv, return_inverse=True, return_counts=True)
    order = allv.argsort(kind="mergesort")
    ranks = np.empty(len(allv), float)
    ranks[order] = np.arange(1, len(allv) + 1)
    sums = np.zeros(len(cnt))
    np.add.at(sums, inv, ranks)
    ranks = (sums / cnt)[inv]
    rg = ranks[:len(gen)].sum()
    return float((rg - len(gen) * (len(gen) + 1) / 2) / (len(gen) * len(imp)))


def frr_at_far(gen, imp, far):
    """Share of genuine decisions rejected when the threshold is set so that a share `far` of
    impostor decisions is accepted (1 - TAR@FAR, same threshold rule as tar_at_far)."""
    t = np.quantile(np.asarray(imp, float), 1.0 - far)
    return float((np.asarray(gen, float) < t).mean())


# ------------------------------------------------------------------ per-user decisions ----
def user_decisions(genuine, runs, tau, ref, n):
    """Decision statistics for one user at block length n.

    genuine : 1-D scores of the target's genuine stream, in time order
    runs    : {impostor id: 1-D scores of that impostor's contiguous run}
    tau     : the user's window threshold (for `vote`)
    ref     : the user's threshold-source scores (for `pct`)
    """
    ref = np.sort(np.asarray(ref, float))

    def stats(bl):
        if not bl:
            return {k: np.zeros(0) for k in ("mean", "vote", "pct")}
        B = np.stack(bl)
        return {"mean": B.mean(1),
                "vote": (B >= tau).mean(1),
                "pct": (np.searchsorted(ref, B, "right") / len(ref)).mean(1)}

    g = stats(blocks(genuine, n))
    ib = [b for r in runs.values() for b in blocks(r, n)]
    i = stats(ib)
    return {"g": g, "i": i, "nG": len(g["mean"]), "nI": len(i["mean"])}


def evaluate(users, n, fars=(0.01, 0.05)):
    """users: {uid: {"genuine", "runs", "tau", "ref"}} for ONE system. Returns per-user and pooled
    decision-level metrics plus the raw decisions (for the bootstrap)."""
    dec = {u: user_decisions(d["genuine"], d["runs"], d["tau"], d["ref"], n) for u, d in users.items()}
    per = {}
    for u, x in dec.items():
        ok = x["nG"] > 0 and x["nI"] > 0
        per[u] = {"nG": x["nG"], "nI": x["nI"],
                  "aucMean": auc_fast(x["g"]["mean"], x["i"]["mean"]) if ok else float("nan"),
                  "aucPct": auc_fast(x["g"]["pct"], x["i"]["pct"]) if ok else float("nan")}
    pooled = pooled_metrics(dec, list(dec), fars)
    return {"n": n, "seconds": round(seconds(n), 2), "perUser": per, "pooled": pooled, "_dec": dec}


def pooled_metrics(dec, uids, fars=(0.01, 0.05)):
    out = {}
    for st in ("vote", "pct"):
        g = np.concatenate([dec[u]["g"][st] for u in uids])
        i = np.concatenate([dec[u]["i"][st] for u in uids])
        out[st] = {"eer": eer_fast(g, i), "auc": auc_fast(g, i),
                   **{f"frrAtFar{int(f * 100)}": frr_at_far(g, i, f) for f in fars}}
    return out


def paired_bootstrap(decA, decB, uids, B=2000, seed=17):
    """Cluster bootstrap over users of pooled metric differences (B - A)."""
    rng = np.random.default_rng(seed)
    uids = list(uids)
    base = {s: pooled_metrics(d, uids) for s, d in (("A", decA), ("B", decB))}
    keys = [(st, m) for st in ("vote", "pct") for m in ("eer", "auc", "frrAtFar1", "frrAtFar5")]
    diffs = {k: [] for k in keys}
    for _ in range(B):
        pick = [uids[j] for j in rng.integers(0, len(uids), len(uids))]
        a, b = pooled_metrics(decA, pick), pooled_metrics(decB, pick)
        for st, m in keys:
            diffs[(st, m)].append(b[st][m] - a[st][m])
    res = {}
    for st, m in keys:
        d = np.asarray(diffs[(st, m)])
        obs = base["B"][st][m] - base["A"][st][m]
        p = 2 * min((d <= 0).mean(), (d >= 0).mean())
        res[f"{st}.{m}"] = {"A": base["A"][st][m], "B": base["B"][st][m], "diff": float(obs),
                            "ci95": [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))],
                            "se": float(d.std(ddof=1)), "p": float(min(1.0, p))}
    return res
