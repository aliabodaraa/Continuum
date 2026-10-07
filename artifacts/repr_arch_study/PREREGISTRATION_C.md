# Pre-registration — Experiment C: enrolment amount and where personalisation runs

Written 2026-09-12, **while Experiment B was still running and before any Experiment C code had
run on data**. Its SHA-256 is recorded in every Experiment C result file, and
`repr_enrol_analyze.py` refuses results produced under a different hash. The protocol items not
restated here are those of `PREREGISTRATION.md` (dataset, held-out users, base users, event
filtering, 50/10 windows, base training, impostor runs, negatives pool, seeds 101–103,
calibration/test split, bootstrap, α = 0.05).

## Why this experiment exists

Continuum's enrolment settings were derived for the retired 7-feature pipeline: the
221-window minimum and 449-window "strong" level come from its enrolment curve. Continuum also
personalises in two different places:

* **server**: `api.py` fine-tunes everything after the first learned layer (Experiments A and B
  measure this);
* **on-device**: the browser extension trains only a dense head on a frozen extractor, because
  TensorFlow.js cannot train Keras recurrent layers. It keeps the user's windows on the device.

Neither the enrolment amount nor the accuracy cost of on-device training has been measured for
the pipeline Continuum will now use.

## Fixed

* **Representation:** A5 (|dx|, |dy|), adopted by Experiment A.
* **Architecture:** whichever architecture Experiment B adopts under its pre-registered rule
  (denoted B\*). Experiment C runs only after that decision.
* **Targets:** the held-out users whose 3-minute session yields at least 440 windows (19 of the
  20; user98 has 324). The same 19 users at every budget, so every comparison is paired.

## Factors

* **Enrolment budget** b ∈ {55, 110, 220, 330, 440} windows: the first b windows of the target's
  3-minute session, in temporal order. At 0.0269 s of session per step these are about
  16, 31, 60, 90 and 120 s of use.
* **Personalisation mode:**
  * **M1 server:** `repr_arch_study.personalise` exactly as in Experiments A and B.
  * **M2 on-device:** a faithful replica of `extension/src/trainer.js`: the base network up to
    its layer named `embedding` is frozen and used as a feature extractor; a single
    Dense(2, softmax) head is trained with Adam (lr 0.002), categorical cross-entropy,
    25 epochs, batch 32, shuffled, no validation. Genuine windows are oversampled to the number
    of negatives, with uniform jitter of ±0.006 in raw feature units on every continuous column,
    and the first pass is kept unjittered. One deliberate difference from the shipped code: when
    there are more genuine windows than negatives, **all** genuine windows are used (trainer.js
    currently truncates to the oldest N). That is the behaviour a fixed extension would have,
    and it only matters at 330 and 440 windows.
  * Both modes use the **same 500 negatives per target** (the Experiment A/B draw), so the mode
    is the only difference.

## Endpoints

As in `PREREGISTRATION.md`: primary = per-user window-level AUC on the **test** half, averaged over
the 3 seeds; key secondary = impostor capture at median calibration false-lock ≤ 5% with each
condition choosing its own threshold percentile and rule on **calibration**; plus EER,
TAR@FAR 1%, genuine interruption, detection latency.

## Decision rules

**C-1 — minimum enrolment (server mode M1).** b_min is the smallest budget b whose paired
difference AUC(b) − AUC(440) has a 95% bootstrap confidence-interval lower bound ≥ −0.02
(non-inferiority margin δ = 0.02 AUC). If no smaller budget qualifies, b_min = 440.

**C-2 — where personalisation runs (at b_min).** On-device M2 is recommended if M2 − M1 on the
primary endpoint has a 95% CI lower bound ≥ −0.02 **and** M2's capture at false-lock ≤ 5% is not
significantly lower than M1's (paired, two-sided p < 0.05). Otherwise server M1 is recommended,
and the accuracy cost of on-device training is reported as the price of privacy.

**C-3 — deployment operating point.** For the recommended mode at b_min, the threshold percentile
and rule are chosen with the same procedure as Experiments A/B (highest median capture subject to
median false-lock ≤ 5%), applied to the calibration halves of all (target, seed) pairs together.
Its test-half capture, false-lock, interruption and latency are reported. The same selection at
false-lock budgets of 1% and 2% is reported alongside, so the security/usability trade-off is
visible.

## Not testable on this dataset, stated in advance

SapiMouse contains one task (a click-and-drag game) and one enrolment session per user. Whether
enrolment should use a guided task or ordinary browsing, and how much several enrolment sessions
help, cannot be measured here. Chong et al. (Sec. X) warn that models trained on one task may learn
(user, task) pairs. Those questions are argued from the literature and recorded as limitations,
not answered with numbers this experiment cannot produce.

## What would change the plan

Nothing in this file is changed after Experiment C results exist. Technical failures are re-run
with identical settings and recorded in `RUN_LOG.md`. Any other analysis is labelled exploratory.
