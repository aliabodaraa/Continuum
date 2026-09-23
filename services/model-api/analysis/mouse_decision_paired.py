"""
Paired per-user comparison of decision rules for MOUSE, against the rule actually deployed.

Unlike keystroke, mouse's live rule in services/ca-service/lib/mouse.js is NOT 3-of-6 — it is
vote 15-of-20 (MOUSE_SUSTAIN_WINDOW=20, MOUSE_SUSTAIN_LOW=15), kept in sync with the browser
extension via an explicit comment contract. decision_sweep.py's printed "Part 5a" baseline is a
keystroke-shaped reference point (3-of-6) inherited unchanged from the keystroke script; it is
NOT what mouse actually runs. This script compares against the real deployed configuration.

Same paired-bootstrap method as keystroke's decision_paired.py: identical users, byte-identical
model outputs, so any difference is attributable to the rule alone.
"""
import json
import sys

import numpy as np

sys.path.insert(0, "services/model-api")
from decision_sweep import fire_vote, fire_mean, rates_for_user  # noqa: E402

doc = json.load(open("artifacts/xai/mouse_population.json"))
users = [u for u in doc["perUser"] if u.get("_impostorRuns")]
print(f"n = {len(users)} users\n")

TAU = 0.50
CFG = {
    "live: vote 15/20 (actual deployed)": (20, "vote", 15),
    "vote 10/20": (20, "vote", 10),
    "mean k=20": (20, "mean", None),
    "vote 8/10": (10, "vote", 8),
    "mean k=10": (10, "mean", None),
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


print("PER-USER DISTRIBUTION — false lock per decision")
print(f"  {'config':<38}{'median':>9}{'IQR':>18}{'min':>8}{'max':>8}{'>10%':>7}{'>25%':>7}")
for n, (lock, catch) in res.items():
    print(f"  {n:<38}{np.median(lock):>8.2%}"
          f"{np.percentile(lock,25):>9.2%}-{np.percentile(lock,75):<8.2%}"
          f"{lock.min():>7.2%}{lock.max():>8.2%}"
          f"{(lock>0.10).sum():>5}/{len(lock)}{(lock>0.25).sum():>4}/{len(lock)}")

print("\nPER-USER DISTRIBUTION — impostor caught")
print(f"  {'config':<38}{'median':>9}{'IQR':>18}{'min':>8}{'max':>8}{'<80%':>8}")
for n, (lock, catch) in res.items():
    print(f"  {n:<38}{np.median(catch):>8.2%}"
          f"{np.percentile(catch,25):>9.2%}-{np.percentile(catch,75):<8.2%}"
          f"{catch.min():>7.2%}{catch.max():>8.2%}{(catch<0.80).sum():>6}/{len(catch)}")

print("\n\nPAIRED DIFFERENCES vs the ACTUAL deployed rule 15/20 (negative = better)")
base_lock, base_catch = res["live: vote 15/20 (actual deployed)"]
print(f"  {'config':<20}{'d falseLock':>14}{'95% CI':>22}{'better for':>13}"
      f"{'d caught':>12}{'95% CI':>22}")
for n, (lock, catch) in res.items():
    if n == "live: vote 15/20 (actual deployed)":
        continue
    dl = lock - base_lock
    dc = catch - base_catch
    cl, cu = boot_med(dl)
    kl, ku = boot_med(dc)
    print(f"  {n:<20}{np.median(dl):>13.2%}"
          f"  [{cl:>+7.2%},{cu:>+7.2%}]{(dl<0).sum():>8}/{len(dl)}"
          f"{np.median(dc):>12.2%}  [{kl:>+7.2%},{ku:>+7.2%}]")

print("\n\nLATENCY — mouse steps arrive far faster than keystrokes")
print("  measured median inter-step interval: 17ms (vs keystroke's ~176ms per digraph)")
dt = 0.017
print(f"  {'config':<38}{'steps':>8}{'seconds':>10}")
for n, (k, rule, m) in CFG.items():
    steps = 50 + (k - 1) * 10
    print(f"  {n:<38}{steps:>8}{steps*dt:>9.2f}s")

json.dump({n: {"falseLock": l.tolist(), "caught": c.tolist()} for n, (l, c) in res.items()},
          open("artifacts/xai/mouse_decision_paired.json", "w"), indent=1)
print("\nwrote artifacts/xai/mouse_decision_paired.json")
