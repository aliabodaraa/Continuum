"""Verbatim copies of the metric, replay and bootstrap functions the protocol-J/K analyses use
(keystroke_user_sweep.py, protocol_j_common.py, repr_arch_analyze.py), so that numbers computed here
reproduce the published ones exactly before anything new is computed."""
import numpy as np

# ---- keystroke_user_sweep.py -------------------------------------------------------------
def roc(gen, imp):
    ths = np.unique(np.concatenate([gen, imp, [0.0, 1.0]]))
    far = np.array([(imp >= t).mean() for t in ths])
    frr = np.array([(gen < t).mean() for t in ths])
    return ths, far, frr


def eer_of(gen, imp):
    ths, far, frr = roc(gen, imp)
    i = int(np.argmin(np.abs(far - frr)))
    return float((far[i] + frr[i]) / 2), float(ths[i])


def auc_of(gen, imp):
    if not len(gen) or not len(imp):
        return float("nan")
    allv = np.concatenate([gen, imp])
    order = allv.argsort()
    ranks = np.empty(len(allv), float)
    ranks[order] = np.arange(1, len(allv) + 1)
    _, inv, cnt = np.unique(allv, return_inverse=True, return_counts=True)
    sums = np.zeros(len(cnt))
    np.add.at(sums, inv, ranks)
    ranks = (sums / cnt)[inv]
    rg = ranks[:len(gen)].sum()
    return float((rg - len(gen) * (len(gen) + 1) / 2) / (len(gen) * len(imp)))


def tar_at_far(gen, imp, target_far):
    t = np.quantile(imp, 1.0 - target_far)
    return float((gen >= t).mean()), float(t)


# ---- protocol_j_common.py ----------------------------------------------------------------
SEC_PER_WINDOW = 10 * 0.0269
CADENCE = 6
IMP_RUN = 150


def fires(win, tau, rule, k):
    if rule == "vote":
        return int((win < tau).sum()) >= k
    stat = win.mean() if rule == "mean" else np.median(win)
    return stat < tau


def replay(seq, tau, rule, n, k, cadence=CADENCE):
    s = np.asarray(seq, float)
    start, prompts, first, decisions = 0, 0, None, 0
    for i in range(len(s)):
        if (i + 1) % cadence:
            continue
        if i - start + 1 < n:
            continue
        decisions += 1
        if fires(s[i - n + 1:i + 1], tau, rule, k):
            prompts += 1
            if first is None:
                first = i
            start = i + 1
    return prompts, first, decisions


def seconds_at(idx):
    return (50 + 10 * idx) * 0.0269


def per_user(half, tau, rule, n, k, cadence=CADENCE):
    g = half["g"]
    cnt, _, dec = replay(g, tau, rule, n, k, cadence)
    minutes = len(g) * SEC_PER_WINDOW / 60.0
    caught, times = [], []
    for r in half["runs"].values():
        c, f, _ = replay(r, tau, rule, n, k, cadence)
        caught.append(c > 0)
        if c:
            times.append(seconds_at(f))
    return {"promptsPerMin": cnt / minutes if minutes > 0 else float("nan"), "prompts": cnt,
            "decisions": dec, "interruption": (cnt / dec) if dec else 0.0,
            "lowWindowRate": float((np.asarray(g) < tau).mean()) if len(g) else float("nan"),
            "caught": caught, "times": times}


def summary(res):
    rates = np.array([v["promptsPerMin"] for v in res.values()], float)
    caught = [c for v in res.values() for c in v["caught"]]
    times = [t for v in res.values() for t in v["times"]]
    inter = np.array([v["interruption"] for v in res.values()], float)
    return {"promptsPerMinMean": float(np.nanmean(rates)), "promptsPerMinMedian": float(np.nanmedian(rates)),
            "usersNeverPrompted": float(np.mean([v["prompts"] == 0 for v in res.values()])),
            "interruptionMean": float(inter.mean()),
            "impostorRunsCaught": float(np.mean(caught)) if caught else 0.0,
            "impostorRunsNeverCaught": float(1 - np.mean(caught)) if caught else 1.0,
            "timeToCatchMedianS": float(np.median(times)) if times else None}


def halves(u):
    g = np.asarray(u["_genuineScores"], float)
    cut = len(g) // 2
    ids = sorted(u["_impostorRuns"])
    runs = {k: np.asarray(u["_impostorRuns"][k], float) for k in ids}
    return ({"g": g[:cut], "runs": {k: runs[k] for k in ids[0::2]}},
            {"g": g[cut:], "runs": {k: runs[k] for k in ids[1::2]}})


# ---- repr_arch_analyze.py ----------------------------------------------------------------
N_BOOT = 10000


def boot(a, b, seed=17):
    a, b = np.asarray(a, float), np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    d = b[ok] - a[ok]
    rng = np.random.default_rng(seed)
    st = d[rng.integers(0, len(d), (N_BOOT, len(d)))].mean(1)
    p = 2 * min((st <= 0).mean(), (st >= 0).mean())
    return {"meanDiff": float(d.mean()), "ci95": [float(np.percentile(st, 2.5)),
                                                  float(np.percentile(st, 97.5))],
            "p": float(min(1.0, p)), "n": int(len(d)), "bBetter": int((d > 0).sum())}


def holm(ps):
    idx = np.argsort(ps); adj = np.empty(len(ps)); run = 0.0
    for r, i in enumerate(idx):
        run = max(run, (len(ps) - r) * ps[i]); adj[i] = min(1.0, run)
    return adj.tolist()
