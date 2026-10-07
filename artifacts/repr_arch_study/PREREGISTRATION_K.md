# Pre-registration K — following SapiMouse's own enrolment: clicks (K1) and session length (K2, K3)

Written 2026-09-19, **before any K code has run on data**, after P6. Protocol items not restated here
are those of `PREREGISTRATION_J.md` (23db222b…) and `AMENDMENT_J1.md` (dfaa0e5f…): same split (the
development users decide, the P6 lockbox is spent and is never reused), same base-80 network, same
live-cadence replay, same statistics.

## Why

Continuum's enrolment page differs from the way SapiMouse collected the data the network learned from:
it asks for **90 seconds in six pieces** on a dot-and-link page, while the paper records **one
continuous 3-minute session** of a game with clicks, right-clicks, double-clicks and drag-and-drop.
Two differences are testable on data we already have.

* **K1 — do clicks carry identity?** A click enters the representation only as a step with no movement
  (|dx| = |dy| = 0); which button was pressed is not a feature. SapiMouse sessions hold 6.0% such steps,
  our own users' enrolments 3.6–4.0%. If those steps carry nothing, adding right-click and double-click
  to the enrolment page cannot help, and the seminar answer is settled by measurement.
* **K2 — how much enrolment, up to the paper's own session?** P3 found accuracy still rising at 440
  windows, the largest budget it tested. The paper enrols on the whole 3-minute session (median 655
  windows for our development users). The budget question is therefore not yet answered at the paper's
  own setting.

## K1 — the click-mark ablation (development users only)

* **Arms, same users and same recipe:** **KEEP** = windows as today. **DROP** = windows rebuilt from the
  same sessions with every zero-displacement step removed before windowing. Removing steps shifts window
  boundaries; that is part of the arm and is stated here, not a defect.
* **Recipe:** the production recipe (Method A, 330 enrolment windows, contiguous 20% validation tail with
  gap 5), base-80, one model per user per arm, 19 development targets.
* **Endpoints, development test halves:** primary per-window AUC; also EER, TAR@FAR 1%, and, at the
  deployed point (1st percentile, 30 of 60), genuine prompts per minute and impostor runs caught.
* **Decision, fixed now:** clicks are declared to carry **no measurable identity** if the paired mean AUC
  difference (DROP − KEEP) has a 95% interval inside ±0.02. If the interval lies below −0.02, clicks
  matter and the enrolment page should produce them; if above +0.02, they are noise and removing them is
  an improvement to test separately. Anything else is reported as inconclusive.

## K2 — enrolment length up to the paper's session (development users)

* **Budgets:** 330 (today), 440 (P3's choice), 550, and **FULL** = every window of the user's 3-minute
  session (variable, median 655). A user enters a budget only if their session provides it: 19 users at
  330 and 440, 17 at 550, 19 at FULL.
* **Method:** the P1 method (B, leave-one-sample-out over 55-window samples, boundary purge) with the
  P2b point (20th percentile of the out-of-sample scores, vote 33 of 60) held fixed for every budget.
* **Endpoints:** as P3 — per-window AUC, EER, TAR@FAR 1%; genuine prompts per minute, impostor runs
  caught, time to catch; threshold stability across the identity order and two rotations.
* **Selection, fixed now:** the **smallest** budget whose differences to FULL satisfy all three margins
  (impostor runs caught lower bound ≥ −5 points, AUC lower bound ≥ −0.02, prompts per minute upper bound
  ≤ +0.1). If that budget is larger than 330, the product's enrolment is a candidate for change, which
  only K3 can decide.

## K3 — one confirmation on a second untouched group

Run only if K2 selects a budget larger than 330.

* **Second lockbox:** 20 users drawn with `numpy.random.default_rng(20260919)` from the base-training
  users that have ≥ 650 windows in the 3-minute session and ≥ 150 in the 1-minute session (39 qualify).
  The shared network is retrained on the remaining 60 base users; the first lockbox is not reused.
* **Compared:** S0 (deployed: 330 windows, Method A, 1st percentile, 30 of 60) against **S2** (K2's
  budget, Method B, its point re-selected on the development calibration halves at that budget).
* **Decision, identical in form to P6:** S2 is declared better if prompts per minute is not higher by
  more than 0.1 (upper bound) and runs caught is not lower by more than 5 points (lower bound), and at
  least one improves significantly (Holm over the two). Otherwise S0 stands.
* Reported beside it, deciding nothing: the same comparison read security-first, i.e. whether S2 reaches
  90% of impostor runs caught and at what prompt rate, so the owner can weigh the trade-off with numbers.
* The second lockbox is scored **once**.

## Statistics

Paired bootstrap over users, 10,000 resamples, seed 17; 95% percentile intervals; Holm within each
phase's confirmatory family; mean paired difference and the share of users improved reported always.
Nineteen to twenty users resolve about 0.04 AUC: an inconclusive result is reported as inconclusive.

## What would change this file

Nothing after any K result exists. Technical failures are re-run with identical settings and recorded in
`RUN_LOG.md`.
