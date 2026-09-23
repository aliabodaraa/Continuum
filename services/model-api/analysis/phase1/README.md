# Phase 1: decision-level evaluation and power check (mouse)

Recovery plan, Phase 1, run 2026-09-23. Analysis only: nothing is retrained and no deployed rule changes.
The scripts run on the host with numpy alone (no Docker), from the stored score streams in
`artifacts/repr_arch_study/parts/`. Results are in `artifacts/phase1/`.

```bash
cd services/model-api/analysis/phase1
python reproduce.py      # 1. must print ALL MATCH before anything else is trusted
python run_phase1.py     # 2. decision-level results   -> artifacts/phase1/decision_level.json
python power_check.py    # 3. power of 20-user tests   -> artifacts/phase1/power.json
```

## 1. Reproduction

`p1lib.py` holds verbatim copies of the metric, live-replay and bootstrap functions of
`keystroke_user_sweep.py`, `protocol_j_common.py` and `repr_arch_analyze.py`. They are copied, not
imported, so the analysis needs no TensorFlow. `reproduce.py` recomputes P0 (development), P6 (lockbox 1) and
K3 (lockbox 2) from the stored streams: **46 of 46 published numbers match exactly**
(`artifacts/phase1/reproduce.txt`).

## 2. Decision-level evaluation (`eval_decision_level.py`)

* **Decision** = N consecutive windows from one contiguous stream (the target's own session, or one
  impostor's run), never straddling two streams. Consecutive decisions are 4 windows apart, so they share
  no movement step. N = 15, 33 and 60 windows = 5.1, 9.9 and 17.2 s of movement (60 = the deployed vote length).
* **Statistics.** *pct* = mean percentile of the block's window scores within the user's own
  threshold-source scores (enrolment for Method A, leave-one-sample-out for Method B), i.e. the score
  normalised per user. *vote* = share of windows at or above the user's threshold (the deployed rule family).
* **Metrics.** Per-user AUC (mean over users) and pooled EER / AUC / FRR at FAR 1% and 5%. The
  uncertainty is a paired cluster bootstrap over users (seed 17).
* **Development** uses the P1 streams (19 users x 10 training orders, 330 windows, whole 1-min session;
  the curve metrics choose no threshold). **Lockboxes 1 and 2 are post hoc on spent test sets:
  exploratory, they decide nothing.**

Pooled EER of the per-user-normalised statistic (window EER is the published figure):

| Data | System | window | 5.1 s | 9.9 s | 17.2 s |
| --- | --- | --- | --- | --- | --- |
| development | A (as deployed, 330) | 20.0% | 16.2% | 13.3% | 12.3% |
| development | B (leave-one-sample-out, 330) | - | 16.2% | 13.3% | 11.3% |
| lockbox 1 | S0 (deployed) | 20.7% | 17.2% | 16.1% | 14.8% |
| lockbox 1 | S1 (440, B) | 18.8% | 14.5% | 11.3% | 10.5% |
| lockbox 2 | S0 (deployed) | 16.8% | 9.6% | 7.9% | 6.0% |
| lockbox 2 | S2 (full session, B) | 14.5% | 11.3% | 10.2% | 8.7% |

Findings:

1. **Deciding over more movement helps, but far less than the withdrawn 1.6% figure implied.** On
   untouched users, the deployed system's 17-s decision has a pooled EER of 14.8% and 6.0%. Those users
   are drawn from the same population, which shows how much 20-user groups differ.
2. **Method B ranks each user's decisions better, consistently.** Per-user AUC of 9.9-s decisions:
   development 0.943 -> 0.958 (+0.015 [+0.005, +0.026], same 330 windows, so this is the method alone);
   lockbox 1 +0.026 [+0.012, +0.041]; lockbox 2 +0.008 [+0.001, +0.016]. **That gain does not
   reliably carry over to pooled operation:** development shows no pooled change, lockbox 1 improves
   (vote EER -8.9 pts at 9.9 s, CI excludes zero), and lockbox 2 is worse (pct AUC -0.015, p 0.04).
3. **Per-user normalisation already does most of the cross-user calibration.** Pooled AUC is within
   0.00-0.02 of the mean per-user AUC.
4. **A strict budget is out of reach for the mouse alone.** At FAR 1%, pooled FRR of 9.9-s decisions is
   28-74%, with intervals about +/-0.3 wide. 20 users cannot measure that tail at all.
5. **Decisions per user are few.** Median genuine decisions per user: 11-13 (5.1 s), 5-6 (9.9 s),
   3 (17.2 s). Per-user EER at >= 10 s is not estimable, and per-user AUC saturates: 4-14 of 20 users
   are tied at 1.0 at 9.9-17.2 s.

## 3. Power of 20-user paired tests (`power_check.py`)

These come from the per-user differences observed in P6 and K3. MDE80 is the smallest true mean
difference detected with 80% power (two-sided, alpha 0.05).

| Endpoint | MDE80, P6 spread | MDE80, K3 spread |
| --- | --- | --- |
| prompts per minute (live replay) | 0.23 /min | 0.23 /min |
| impostor runs caught | 17 pts | 8.5 pts |
| window AUC (per user) | 0.019 | 0.012 |
| 5.1-s decision AUC, pct (per user) | 0.023 | 0.014 |
| 9.9-s decision AUC, pct (per user) | 0.021 | 0.011 |
| 9.9-s decision EER, pooled pct | 8.2 pts | 4.9 pts |

**The P6/K3 adoption rule could almost never adopt a better system.** The rule requires the
prompts/min upper bound <= +0.10, the capture lower bound >= -5 pts, and one significant improvement.
Simulated probability of adoption:

| True difference | P6 spread | K3 spread |
| --- | --- | --- |
| none (0 prompts, 0 pts) | 1.0% | 6.9% |
| equal prompts, +10 pts capture | 14.2% | 33.1% |
| -0.05 prompts/min, +10 pts capture | 24.1% | 46.4% |

Even with truly identical prompt rates, the prompt margin is met only 30-34% of the time: 16 of 20
users have zero prompts in both systems, and the rest decide the interval.

## 4. Recommendation for the Phase 2 pre-registration

* **Primary endpoint:** per-user AUC of 9.9-s decisions (pct statistic), paired over users. It detects
  about 0.011-0.021 with 20 users.
* **Key secondary:** pooled EER of 9.9-s decisions (MDE 5-8 pts), and window AUC/EER for the literature.
* **Prompts per minute and runs caught:** report them descriptively on SapiMouse, never as adoption
  margins. Test them in the user study, where each person contributes hours rather than 27-56 s.

## RUN_LOG entry (appended to `artifacts/repr_arch_study/RUN_LOG.md` on 2026-09-23)

> - 2026-09-23: PHASE 1 (recovery plan), analysis only, EXPLORATORY where it touches lockbox data. Scripts: services/model-api/analysis/phase1; results: artifacts/phase1. The published P0/P6/K3 numbers are reproduced exactly from the stored streams (46/46). The decision-level evaluation uses non-overlapping, step-disjoint blocks of 15/33/60 windows (5.1/9.9/17.2 s) from contiguous streams. The deployed S0 at 17.2 s has pooled EER 14.8% (lockbox 1) and 6.0% (lockbox 2), vs 20.7% and 16.8% per window; this supersedes the withdrawn overlapping-group 1.6%. Method B raises per-user AUC of 9.9-s decisions in all three data sets (development +0.015 [+0.005, +0.026]), but pooled operation does not improve consistently. Power at n = 20: prompts/min MDE80 0.23/min; P(adopt) for a truly better system (equal prompts, +10 pts capture) is 14-33% under the P6/K3 rule. Recommended primary endpoint for the next pre-registration: per-user AUC of 9.9-s decisions (MDE80 0.011-0.021).
