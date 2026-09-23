# Pre-registration — Experiment H: where should the per-user threshold come from?

Written 2026-09-13, **before any Experiment H code had run on data**. Its SHA-256 is recorded in
every Experiment H result, and the analysis refuses results produced under a different hash.
Protocol items not restated here are those of `PREREGISTRATION_F.md`.

## Why this experiment exists

The deployed server pipeline (Experiment F) sets each user's threshold at the q-th percentile of the
scores the user's model gives **to its own training windows**. Those scores are in-sample and
therefore optimistic: in F the threshold is placed so that 5% of enrolment windows fall below it,
yet in the user's separate test session a median 32% of genuine windows do
(`independence_check.json`). The 12-of-20 vote absorbs that for most users, but not for all: the
median false-lock rate is 5.7% while the mean is 21.1%, and one user has every genuine test window
below the threshold. In live use a user was locked out repeatedly right after enrolling. A threshold
estimated from genuine windows the model did **not** train on should sit where genuine behaviour
actually lies.

## Arms (the model is the same in every arm; only the threshold's source differs)

* **ENR** (deployed): q-th percentile of the model's scores on the user's enrolment windows, all of
  them, as `api.py` returns today.
* **VAL**: q-th percentile of the scores of the enrolment windows `api.py` holds out from training
  for validation (its contiguous tail with a 5-window gap when the enrolment is one session; whole
  sessions when there are several). Costs the user nothing extra.
* **USE**: q-th percentile of the scores of the user's first **55** windows of normal use after
  enrolment (about 16 s of movement), during which the channel does not lock. In the evaluation,
  these are the first 55 windows of the target's 1-minute session.

## Protocol

* Models: trained through model-api's own `train_user_payload`, exactly as in Experiment F (same
  production base, settings, 330-window enrolment, negatives), extended only to return the scores of
  its held-out genuine validation windows. One trained model per target serves all three arms.
* Targets: the 19 held-out users of Experiment F. Impostors: every other held-out user's 1-minute
  session, first 150 windows, one contiguous run each.
* Genuine evaluation stream: the target's 1-minute session **after its first 55 windows**, identical
  for all three arms (USE's calibration windows are never scored as test material). That stream is
  cut into a calibration half and a test half as in Experiments A–G; impostor identities alternate
  between the halves as before.
* Operating point: for each arm separately, the Experiment C-3 procedure on the calibration halves
  (q ∈ {1, 2, 5, 10, 15, 20, 30, 40, 50}; vote, mean or median over n ∈ {6, 10, 20}), at a 1% median
  calibration false-lock budget, else 2%, else 5% (F's order).

## Endpoints (test half, at each arm's own operating point)

* **Primary:** per-user genuine false-lock rate (fraction of decisions that lock), mean over users.
* Guard: per-user impostor capture.
* Also reported: median false-lock, users interrupted at least once, users never locked, never-
  detected impostor runs, latency.

## Decision rule, fixed in advance

For each of VAL and USE against ENR, paired over users (bootstrap, 10,000 resamples; Holm over the
two comparisons):

* the arm **qualifies** if its mean false-lock is significantly lower (difference < 0, Holm
  p < 0.05) **and** its capture is non-inferior (95% CI lower bound of the capture difference
  ≥ −0.05, i.e. at most 5 points worse);
* if both qualify, adopt the one with the lower mean false-lock on the test half; if exactly one
  qualifies, adopt it; if neither, keep ENR.

If USE is adopted, the deployed channel gains a bounded calibration phase: after training, the first
55 windows of use set the threshold and nothing locks during them. That phase is bounded by
construction (it ends at 55 windows) and happens once per trained model.

## Secondary analysis (reported, decides nothing for the server)

The browser extension's model (Experiment G, `parts/G_device.json`) with ENR vs USE only, same
genuine stream and selection, so the extension can follow the server if the effect repeats there.

## Limits stated in advance

SapiMouse's enrolment and test sessions are the same task on the same day. The shift the USE arm
corrects in the evaluation is therefore only the session-to-session shift; the larger shift from a
guided enrolment task to free browsing, which is what happened in live use, cannot be measured here,
and USE is the only arm whose calibration windows come from the kind of use that is later checked.
The calibration phase assumes the person using the account for its first 16 s of movement after
enrolment is the person who enrolled.

## What would change the plan

Nothing in this file changes after Experiment H results exist. Technical failures are re-run with
identical settings and recorded in `RUN_LOG.md`.
