"""
PART 4b — is "more enrolment data correlates with worse EER" real, or a confound?

The naive read of part4 is alarming: more data associates with HIGHER error.
Before reporting that, test whether n_enrol is standing in for something else —
most plausibly text diversity, since a participant who typed more also typed more
varied material, and diversity itself correlates with error.

Partial Spearman = correlate the rank residuals after regressing out the control.
"""
import json
import numpy as np

rows = json.load(open("artifacts/xai/part4_difficulty.json"))


def rank(a):
    a = np.asarray(a, float)
    order = np.argsort(a, kind="mergesort")
    r = np.empty(len(a))
    r[order] = np.arange(len(a), dtype=float)
    _, inv, cnt = np.unique(a, return_inverse=True, return_counts=True)
    for i in np.where(cnt > 1)[0]:
        m = inv == i
        r[m] = r[m].mean()
    return r


def pear(a, b):
    a = a - a.mean()
    b = b - b.mean()
    d = np.sqrt((a ** 2).sum() * (b ** 2).sum())
    return float((a * b).sum() / d) if d else 0.0


def spear(x, y):
    return pear(rank(x), rank(y))


def resid(y, x):
    """Residual of rank(y) after removing linear dependence on rank(x)."""
    ry, rx = rank(y), rank(x)
    rx0 = rx - rx.mean()
    beta = (rx0 * (ry - ry.mean())).sum() / (rx0 ** 2).sum()
    return (ry - ry.mean()) - beta * rx0


def partial(y, x, ctrl):
    return pear(resid(y, ctrl), resid(x, ctrl))


def perm_p(y, x, stat, n=20000, seed=3):
    rng = np.random.default_rng(seed)
    obs = abs(stat)
    x = np.asarray(x, float)
    hits = sum(abs(spear(y, rng.permutation(x))) >= obs for _ in range(n))
    return (hits + 1) / (n + 1)


col = lambda k: np.array([r[k] for r in rows], float)
eer = col("eer")

print("STEP 1 — are the 'independent' predictors actually independent?\n")
keys = ["n_enrol", "digraph_entropy", "digraph_unique", "dd_cv", "dd_mean"]
print(f"  {'':<18}" + "".join(f"{k:>17}" for k in keys))
for a in keys:
    line = f"  {a:<18}"
    for b in keys:
        line += f"{spear(col(a), col(b)):17.3f}"
    print(line)

print("\n\nSTEP 2 — partial correlations with EER\n")
print(f"  {'predictor':<18} {'raw rho':>9} {'controlling for':>22} {'partial':>9}")
tests = [
    ("n_enrol", "digraph_entropy"),
    ("n_enrol", "dd_cv"),
    ("digraph_entropy", "n_enrol"),
    ("digraph_entropy", "dd_cv"),
    ("dd_cv", "n_enrol"),
    ("dd_cv", "digraph_entropy"),
    ("dd_mean", "dd_cv"),
]
for pred, ctrl in tests:
    raw = spear(eer, col(pred))
    par = partial(eer, col(pred), col(ctrl))
    print(f"  {pred:<18} {raw:+9.3f} {ctrl:>22} {par:+9.3f}")

print("\n\nSTEP 3 — multiple-comparison reality check")
print("  16 features were screened. Bonferroni threshold = 0.05/16 = 0.0031")
for k in ["dd_cv", "digraph_entropy", "digraph_unique", "dd_mean", "n_enrol"]:
    s = spear(eer, col(k))
    p = perm_p(eer, col(k), s)
    verdict = "SURVIVES" if p < 0.0031 else "does not survive"
    print(f"  {k:<18} rho {s:+.3f}  p={p:.4f}  -> {verdict}")

print("\n\nSTEP 4 — stratified test: within narrow enrolment bands, does data help?")
ne = col("n_enrol")
qs = np.percentile(ne, [33, 66])
bands = [("low   ", ne <= qs[0]), ("middle", (ne > qs[0]) & (ne <= qs[1])),
         ("high  ", ne > qs[1])]
for name, m in bands:
    print(f"  enrolment {name} (n={m.sum():2d}, {ne[m].min():.0f}-{ne[m].max():.0f} windows): "
          f"median EER {np.median(eer[m]):.2%}   median dd_cv {np.median(col('dd_cv')[m]):.3f}")

print("\n\nSTEP 5 — the honest summary statistic")
print("  Spearman(EER, dd_cv)          = %+.3f   rhythm inconsistency" % spear(eer, col("dd_cv")))
print("  Spearman(EER, n_enrol)        = %+.3f   enrolment volume" % spear(eer, col("n_enrol")))
print("  partial(EER, n_enrol | dd_cv) = %+.3f" % partial(eer, col("n_enrol"), col("dd_cv")))
print("  partial(EER, dd_cv | n_enrol) = %+.3f" % partial(eer, col("dd_cv"), col("n_enrol")))
