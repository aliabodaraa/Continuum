"""
Paired per-user comparison of decision rules, plus the latency each one costs.

A median that moves is not evidence. These are the same 45 users under both rules, scored by
byte-identical model outputs, so the comparison is exactly paired and the only thing that
differs is the rule. Bootstrap resamples USERS — the independent unit — never packets.
"""
import json
import sys

import numpy as np

sys.path.insert(0, "services/model-api")
from decision_sweep import fire_vote, fire_mean, rates_for_user  # noqa: E402

doc = json.load(open("artifacts/xai/population_scores.json"))
users = [u for u in doc["perUser"] if u.get("_impostorRuns")]
print(f"n = {len(users)} users\n")

TAU = 0.50
CFG = {
    "live: vote 3/6": (6, "vote", 3),
    "vote 5/10": (10, "vote", 5),
    "mean k=10": (10, "mean", None),
    "vote 10/20": (20, "vote", 10),
    "mean k=20": (20, "mean", None),
}


def per_user(cfg):
    k, rule, m = cfg
    lock, catch = [], []
    for u in users:
        a, b = rates_for_user(u, k, rule, TAU, m)
        if a is None:
            continue
        lock.append(a)
        catch.append(float(np.mean(b)))
    return np.array(lock), np.array(catch)


res = {n: per_user(c) for n, c in CFG.items()}


def boot_med(d, n=20000, seed=5):
    rng = np.random.default_rng(seed)
    b = [np.median(d[rng.integers(0, len(d), len(d))]) for _ in range(n)]
    return np.percentile(b, 2.5), np.percentile(b, 97.5)


print("PER-USER DISTRIBUTION — false lock per decision (rule 3: never just the median)")
print(f"  {'config':<16}{'median':>9}{'IQR':>18}{'min':>8}{'max':>8}{'>10%':>7}{'>25%':>7}")
for n, (lock, catch) in res.items():
    print(f"  {n:<16}{np.median(lock):>8.2%}"
          f"{np.percentile(lock,25):>9.2%}-{np.percentile(lock,75):<8.2%}"
          f"{lock.min():>7.2%}{lock.max():>8.2%}"
          f"{(lock>0.10).sum():>5}/{len(lock)}{(lock>0.25).sum():>4}/{len(lock)}")

print("\nPER-USER DISTRIBUTION — impostor caught")
print(f"  {'config':<16}{'median':>9}{'IQR':>18}{'min':>8}{'max':>8}{'<80%':>8}")
for n, (lock, catch) in res.items():
    print(f"  {n:<16}{np.median(catch):>8.2%}"
          f"{np.percentile(catch,25):>9.2%}-{np.percentile(catch,75):<8.2%}"
          f"{catch.min():>7.2%}{catch.max():>8.2%}{(catch<0.80).sum():>6}/{len(catch)}")

print("\n\nPAIRED DIFFERENCES vs the deployed rule (negative = better)")
base_lock, base_catch = res["live: vote 3/6"]
print(f"  {'config':<16}{'d falseLock':>14}{'95% CI':>22}{'better for':>13}"
      f"{'d caught':>12}{'95% CI':>22}")
for n, (lock, catch) in res.items():
    if n == "live: vote 3/6":
        continue
    dl = lock - base_lock
    dc = catch - base_catch
    cl, cu = boot_med(dl)
    kl, ku = boot_med(dc)
    print(f"  {n:<16}{np.median(dl):>13.2%}"
          f"  [{cl:>+7.2%},{cu:>+7.2%}]{(dl<0).sum():>8}/{len(dl)}"
          f"{np.median(dc):>12.2%}  [{kl:>+7.2%},{ku:>+7.2%}]")

print("\n\nLATENCY — how much typing a decision costs")
print("  a packet of k windows spans 50 + (k-1)*10 digraphs (stride 10, window 50)")
dd = 0.176   # median inter-key interval, measured over the corpus
print(f"  {'config':<16}{'digraphs':>10}{'seconds':>10}")
for n, (k, rule, m) in CFG.items():
    dig = 50 + (k - 1) * 10
    print(f"  {n:<16}{dig:>10}{dig*dd:>9.1f}s")

json.dump({n: {"falseLock": l.tolist(), "caught": c.tolist()} for n, (l, c) in res.items()},
          open("artifacts/xai/decision_paired.json", "w"), indent=1)
print("\nwrote artifacts/xai/decision_paired.json")
