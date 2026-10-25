# Pre-registration AR2: adaptive retraining with the sample rule as built

**Status: FROZEN 2026-10-20**, at the owner's request ("re-run the test and show the results on the current
rule, and remove anything about the old one"). `PREREGISTRATION_AR2.sha256` holds the SHA-256 of this file,
of every script that produces the result, of the shared modules they import and of the data files
(`ar2_common.FROZEN`). The scripts refuse to run on any other bytes. The result is analysed once.

## 1. Why a second experiment, and what is disclosed

Experiment AR (`artifacts/phase4`, sealed, analysed 2026-10-03) measured the adaptive-retraining loop as it
was built then: a "day" of 330 key pairs (29 windows) was scored on its last 20 windows, accepted if the mean
of the last 18 was at least 0.80 and each of the last 6 was at least 0.80, and **the whole day** (29 windows,
9 of them never scored) was learned. On 2026-10-19 the owner changed the rule (ca-service
`lib/keystrokeSecurity.js`, `server.js`): a sample is **exactly 20 windows**, all of them scored and the only
ones learned; it is accepted if the mean of the 20 is at least 0.80 and each of the **newest 3** is at least
0.80; the organisation may choose to retrain after 1, 2 or 3 accepted samples (default 3), and to take the
sample from the end of the typing (default) or, as the newest run of 20 windows that would be accepted, from
anywhere in it. AR2 measures that rule.

Disclosures that bound what AR2 can show:
- The new rule's parameters (20 windows, mean 0.80, newest 3) were chosen on 2026-10-19 by the owner, **after
  AR's result was known**, and after sweeps of the floor's span and of takeover-at-the-end acceptance on the
  experiment KS score file (`artifacts/xai/population_scores.json`), which is built on the **same 99
  participants**. AR2 therefore re-measures on the same people with fresh training; it is not a test on new
  people and not independent of AR's effect size.
- The AR2 code was written after AR's result. It reuses AR's code (`phase4/ar_common.py`, unchanged) for the
  data, the timeline, the per-user recipe, the scoring and the rhythm check.
- Arm C of AR (learn from the typing that caused a lock) was rejected by the owner and is not repeated. Arms A,
  D and R are repeated so that every arm comes from one run.
- Smoke tests (3 targets with 3 epochs, and 1 target with the thresholds set to zero so that every offer is
  accepted, to exercise the accept and retrain paths) ran before this freeze; they are flagged in
  `artifacts/phase5/smoke` and are not results.

## 2. Question

1. **Benefit.** Does the loop, with the sample rule as built, make a user's model better on their *later*
   typing, without making impostors easier to accept?
2. **Safety.** How often would an impostor's typing, or a genuine sample whose end is an impostor's, be
   accepted? What would a few accepted impostor samples do to the model?
3. **Applicability.** How often is a sample accepted, and how do the organisation's options (retrain after 1, 2
   or 3 samples; sample from the end or from anywhere) change that?

## 3. Data and per-user timeline

Exactly AR's (`PREREGISTRATION_AR.md` sections 2 and 3): KeyRecs, 99 participants, two sessions; enrolment =
5 samples of 330 steps from session 1; every later chunk of 330 steps of session 1 and of the first half of
session 2 is one **day** (29 windows); test = the second half of session 2; impostors KeyRecs `ids[40:80]`
(first 150 windows each); negatives = the KS Aalto pool, first 200 typists; eligibility as in AR.

## 4. Arms

Every model is trained with AR's recipe (`ar_common.train`; seeds `1000 + target + arm offset + retrain
number`; the offsets of B1, B2 and Bany are 600000, 700000 and 800000; op determinism on).

| Arm | What it does |
| --- | --- |
| **A** | Enrolment model, never retrained. |
| **B** | **The loop as built, default settings.** Each day, the current model scores the day's 29 windows; the sample is the last 20; it is accepted by the rule of section 5; only those 20 windows join the training pool; three accepted samples -> retrain on enrolment + every accepted sample. Accepted samples not yet retrained on stay out of the final model, as in deployment. |
| **B1, B2** | As B, retrain after one, or two, accepted samples. |
| **Bany** | As B, with the sample taken from anywhere: the newest run of 20 windows of the day (10 candidate runs) that passes the score checks of section 5; the rhythm check is applied to the run picked; if no run passes, the last 20 are judged and refused. |
| **D** | Upper bound: every day added with all its windows, one retrain at the end. |
| **R** | Noise reference: A retrained with another seed and no new data. |

## 5. The sample rule as built

On the 20 windows of the sample, scored by the current model, in the server's order:
1. mean of the 20 scores >= 0.80;
2. each of the newest 3 scores >= 0.80;
3. rhythm: for dwell1, dwell2 and dd, |mean over the sample's 240 steps - pooled mean over all training samples
   so far| / pooled standard deviation <= 3.0 (skipped below 100 history steps; AR found it never refuses).

Not modelled, and why: the paste and key-count checks (KeyRecs is typed); the duplicate-text check (no chunk
repeats); the SDK's condition of three clean live checks before the offer, and the popup's dry run (the dry
run is the same question as the acceptance). The user is assumed to accept every offer: an upper bound on
uptake. The live lock rule used for the lock counts is the packet vote of 10 of the last 20 windows below 0.50
(warm-up unless overwhelming), without the confirmation by a second check that was removed on 2026-10-19.

## 6. Safety tests

- **S1, the rule against impostors.** On each target's enrolment model (A), the rule (end and any) is applied
  to each of the target's days and to each impostor's first 330 steps. Reported: the share accepted.
- **S2, forced poisoning (worst case).** As AR: the most similar impostor (highest mean A score on their
  150-window run; with >= 1490 session-2 steps); their first three 330-step chunks of session 2 are added as
  positives **whether or not they pass**, each as its last 20 windows (the sample as built), and one model is
  trained. Reported: the share of the attacker's later decisions accepted before and after, the target's FRR
  after, and how many of the three samples would have passed the rule.
- **S3, a takeover at the end of a sample.** For each genuine day and each impostor, the last t windows of the
  genuine day's 29 scores (t = 1, 2, 3) are replaced by the last t scores of the impostor's first chunk, both
  scored by A; the end sample is then judged by the score checks (1 and 2 of section 5), and, as a
  comparison, by the mean check alone. t = 0 is the genuine day itself. Reported: the share accepted.

## 7. Outcomes and analysis (`analyze_ar2.py`)

Decisions as AR and KS: step-disjoint blocks of 20 windows (`eval_decision_level.blocks`, gap 4); decision
score = block mean; the live rule's operating point = >= 10 of 20 below 0.50, reported as FAR and FRR.

- **Primary:** B - A in per-user AUC of 20-window decisions (the target's test decisions against the
  impostors'), paired bootstrap over targets (10,000 resamples, seed 17). **B improves on A** if the lower 95%
  bound > 0; **harms** if the upper bound < 0; otherwise **no detectable difference**, with the SE and the
  minimum detectable effect at 80% power reported.
- **Secondary (descriptive, 95% intervals):** B1, B2, Bany, D, R against A in per-user AUC, FAR, FRR and
  genuine locks per 100 test windows; B1, B2, Bany and D against B in per-user AUC; pooled decision EER and
  AUC; window AUC and EER.
- **Applicability:** days accepted (share, per user), users with a retrain, retrains, the day of the first
  retrain, rejection reasons, median training time.
- **Reproducibility:** A of AR2 against A of AR (same seeds and data): the largest difference in per-user AUC.
- **Safety:** S1, S2 and S3 as in section 6.

**Reading fixed in advance.** The result is reported whatever it is. If B shows no detectable difference, the
paper says that the loop does not measurably change accuracy and keeps the claim to its safety design. If D
improves while B does not, the rule admits too little of the later typing to deliver what that data could give.
The options B1, B2 and Bany are read only as trade-offs between how much is learned and how much an impostor's
typing is accepted. Real-time pace is not measured: with one contribution per day, the first retrain takes at
least as many days of use as accepted samples are required.

## 8. Procedure

`run_ar2.py` in the model-api image, in batches (a fresh process per batch, as KS and AR, for memory); a
finished target is never rerun; a technical failure is rerun with identical settings and logged. Analysis once.
Write-up: the paper (sections 3-4 and 4-2), the thesis and `docs/recovery/RESULTS_AR2.md`.
