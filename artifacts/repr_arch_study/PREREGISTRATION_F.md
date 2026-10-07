# Pre-registration — Experiment F: final held-out evaluation of the deployed pipeline

Written 2026-09-13, **before any Experiment F code had run on data**. Its SHA-256 is recorded in
every Experiment F result.

## Purpose

Experiments A–E and the enrolment curve used the study harness. F evaluates **the code that will
ship**: `model-api`'s own `train_user_payload` / `predict_user_payload`, the production base
artifact, production personalisation settings, and the enrolment size the study selected. It also
sets the deployed operating point, and measures the current production pipeline under the same
protocol so the change can be reported as a before/after.

## Pipelines

| | NEW (to deploy) | OLD (current production) |
|---|---|---|
| representation | (\|dx\|, \|dy\|), 50-step windows, stride 10 | 7 Continuum features, same windows |
| base | `artifacts/mouse-fcn-a5` (SapiMouse FCN, seed 101) | `artifacts/mouse-ws50-aligned` (Conv1D + 2×GRU) |
| personalisation | api.py, `arch.json`: freeze conv1+bn1, binary head | api.py original path: freeze Conv1D, binary head |
| negatives | base-user windows only (`Mouse_A5_W50_base.h5`) | base-user windows only, 7-feature (`Mouse_WS50_base.h5`) |

The OLD pipeline's production negatives file pools all 120 SapiMouse users, held-out users
included; using it here would train each target against the very impostors it is then tested on.
Both pipelines therefore use base-user-only negatives, drawn by api.py's own rule
(2 × positives, from 2,000 windows sampled with seed 13, then seed 21).

## Protocol (identical for both)

* Targets: the held-out users whose 3-minute session yields ≥ 330 windows (19 of 20; user98 has 324).
* Enrolment: the first **330** windows of the 3-minute session (the requirement the study
  selected), one session group; `epochs` 15, `batchSize` 32, `overlapGap` 5 (as ca-service will send).
* Genuine test: the target's entire 1-minute session. Impostors: each other held-out user's
  1-minute session, first 150 windows, one contiguous run each.
* Calibration/test halves exactly as in Experiments A–C.

## Reported

* Window level, test half: per-user AUC, EER, TAR at FAR 1% (mean, median).
* Decision level: operating points chosen on the calibration halves of all targets together with
  the Experiment C-3 procedure (per-user threshold = q-th percentile of the user's enrolment scores;
  k-of-n vote, mean or median over n ∈ {6, 10, 20}) at median calibration false-lock budgets of
  1%, 2% and 5%; test-half capture, false-lock, genuine interruption, never-detected share and
  latency.
* NEW − OLD, paired over users: AUC and TAR at FAR 1% (bootstrap, 10,000 resamples).

## The deployed operating point, fixed in advance

**NEW's operating point at the 1% calibration false-lock budget**; if no operating point meets 1% on
calibration, the 2% one; then 5%. A passkey step-up is cheap for the genuine user, but a pointer
biometric is weak evidence per decision, so the most conservative budget is preferred.

## What would change the plan

Nothing in this file changes after Experiment F results exist. F does not re-open the choices made
in A–E; it measures the shipped artifact and sets its operating point.
