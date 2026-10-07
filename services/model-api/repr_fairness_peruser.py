"""Per-user fairness of the mouse channel's personal threshold (descriptive, not pre-registered).

For each of Experiment F's 19 held-out users, at the deployed server rule (threshold = 1st
percentile of the user's own enrolment scores; prompt when 30 of the last 60 windows are below it),
on the test half: the user's threshold, their per-window AUC, the burden on them (genuine passkey
prompts per minute of movement, live loop replayed exactly as in Experiment I) and the protection
they get (share of impostor runs against them that draw a prompt, and how fast).

Comparison: ONE shared threshold for everyone, same rule, chosen on the calibration halves the way
Experiment I chose its point (most impostor runs caught at <= 0.2 genuine prompts per minute), then
measured per user on the test halves. Same average burden, so the question is only how burden and
protection are distributed across people.

    python repr_fairness_peruser.py   ->  artifacts/repr_arch_study/fairness_per_user.json
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import repr_arch_analyze as RA  # noqa: E402
import repr_interrupt_i as I  # noqa: E402

ART = os.path.join(HERE, "..", "..", "artifacts", "repr_arch_study")
if not os.path.isdir(ART):
    ART = "/app/artifacts/repr_arch_study"

RULE, N, K = "vote", 60, 30
Q_DEPLOYED = 1
BUDGET = 0.2


def spearman(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    ra = np.argsort(np.argsort(a[ok])).astype(float)
    rb = np.argsort(np.argsort(b[ok])).astype(float)
    return float(np.corrcoef(ra, rb)[0, 1])


def per_user_at(units, tau_of, which):
    out = {}
    for u, (halves, enrol) in units.items():
        tau = tau_of(u, enrol)
        r = I.per_user(halves[which], tau, RULE, N, K)
        g = halves[which]["g"]
        out[u] = {"threshold": tau, "promptsPerMin": float(r["rate"]), "prompts": int(r["prompts"]),
                  "impostorRunsCaught": float(np.mean(r["caught"])) if r["caught"] else None,
                  "impostorRuns": len(r["caught"]),
                  "timeToCatchMedianS": float(np.median(r["times"])) if r["times"] else None,
                  "genuineBelowThreshold": float((g < tau).mean())}
    return out


def dist(res):
    rates = np.array([v["promptsPerMin"] for v in res.values()])
    caps = np.array([v["impostorRunsCaught"] for v in res.values()], float)
    return {"promptsPerMinMean": float(rates.mean()), "promptsPerMinMax": float(rates.max()),
            "usersNeverPrompted": int((rates == 0).sum()),
            "usersAbove1PromptPerMin": int((rates > 1).sum()),
            "impostorCaughtMedianOverUsers": float(np.median(caps)),
            "impostorCaughtMinOverUsers": float(caps.min()),
            "usersWithCaptureBelow50pct": int((caps < 0.5).sum()),
            "usersWithCaptureBelow80pct": int((caps < 0.8).sum()),
            "impostorRunsCaughtPooled": float(np.mean([c for v in res.values() for c in [v["impostorRunsCaught"]] * v["impostorRuns"]]))}


def main():
    F = json.load(open(os.path.join(ART, "parts", "F_new.json")))
    U = I.units_of(F["perUser"], lambda r: r)
    users = sorted(U)

    # ---- personal threshold (deployed) ----
    personal = per_user_at(U, lambda u, e: float(np.percentile(e, Q_DEPLOYED)), 1)
    for u in users:
        personal[u]["aucTestHalf"] = RA.window_metrics(U[u][0][1])["auc"]

    # ---- one shared threshold, chosen on calibration at the same budget ----
    best = None
    for tau in np.round(np.arange(0.005, 0.996, 0.005), 3):
        cal = per_user_at(U, lambda u, e, t=tau: float(t), 0)
        rate = np.mean([v["promptsPerMin"] for v in cal.values()])
        if rate > BUDGET:
            continue
        caught = [c for v in cal.values() for c in [v["impostorRunsCaught"]] * v["impostorRuns"]]
        key = (float(np.mean(caught)), -float(tau))
        if best is None or key > best[0]:
            best = (key, float(tau))
    tau_shared = best[1]
    shared = per_user_at(U, lambda u, e: tau_shared, 1)

    p = {u: personal[u] for u in users}
    out = {
        "note": "descriptive, not pre-registered; test halves; rule vote 30 of 60; live loop replayed as in Experiment I",
        "source": "parts/F_new.json",
        "personal": {"rule": f"{Q_DEPLOYED}st percentile of own enrolment scores", "summary": dist(p), "perUser": p},
        "shared": {"rule": "one threshold for all users, chosen on calibration at <= 0.2 prompts/min",
                   "threshold": tau_shared, "summary": dist(shared), "perUser": shared},
        "correlations": {
            "thresholdVsCapture_spearman": spearman([p[u]["threshold"] for u in users], [p[u]["impostorRunsCaught"] for u in users]),
            "aucVsCapture_spearman": spearman([p[u]["aucTestHalf"] for u in users], [p[u]["impostorRunsCaught"] for u in users]),
            "thresholdVsAuc_spearman": spearman([p[u]["threshold"] for u in users], [p[u]["aucTestHalf"] for u in users]),
        },
    }
    json.dump(out, open(os.path.join(ART, "fairness_per_user.json"), "w"), indent=1)

    print(f"{'user':>8} {'thresh':>7} {'AUC':>6} {'below':>6} {'prompts/min':>11} {'caught':>7} {'t_catch':>7}")
    for u in sorted(users, key=lambda x: p[x]["threshold"]):
        v = p[u]
        print(f"{u:>8} {v['threshold']:7.3f} {v['aucTestHalf']:6.3f} {v['genuineBelowThreshold']*100:5.1f}% "
              f"{v['promptsPerMin']:11.2f} {v['impostorRunsCaught']*100:6.1f}% "
              f"{(v['timeToCatchMedianS'] or float('nan')):6.1f}s")
    print("personal:", out["personal"]["summary"])
    print(f"shared (tau={tau_shared}):", out["shared"]["summary"])
    print("correlations:", out["correlations"])


if __name__ == "__main__":
    main()
