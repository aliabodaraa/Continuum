# Experiment AR2: adaptive retraining with the sample rule as built (results)

Pre-registration: `artifacts/phase5/PREREGISTRATION_AR2.md` (sha256 ee106b01), frozen 2026-10-20 with its code
and data in `PREREGISTRATION_AR2.sha256` (the scripts refuse to run on other bytes). Run: 99 KeyRecs targets
in the model-api container (`run_ar2.py`), analysis once (`analyze_ar2.py` -> `artifacts/phase5/ar2_result.json`,
`ar2_result.txt`). One target was not eligible (session 2 too short), so n = 98. Asked by the OWNER on
2026-10-20: "re-run the test, show the results on the current rule, and remove anything about the old one".

## Why a second experiment, and what bounds it

Experiment AR (`docs/recovery/RESULTS_AR.md`, sealed) measured the loop as it was built on 3 October: a day of
330 key pairs scored on its last 20 windows, accepted on the mean of the last 18 and each of the last 6, and
the whole day learned. On 19 October the owner changed the rule: a sample is exactly 20 windows, all scored
and the only ones learned; accepted on the mean of the 20 >= 0.80 and each of the newest 3 >= 0.80; the
organisation chooses 1, 2 or 3 samples before a retrain and the end or anywhere as the source of the sample.
AR2 measures that rule.

- The rule's parameters were chosen **after AR's result** and after sweeps on the KS score file, which is
  built on the same 99 participants. AR2 is therefore a **repeated measurement on the same people with fresh
  training**, not a test on new people. The paper and thesis say so.
- AR2 reuses AR's code unchanged (`phase4/ar_common.py`): data, timeline, per-user recipe, scoring, rhythm
  check. Its own code is `phase5/ar2_common.py`, `run_ar2.py`, `analyze_ar2.py`. A of AR2 equals A of AR
  exactly (98 targets, largest per-user AUC difference 0.0).
- AR's arm C (learning from passkey-confirmed locks, +0.022 AUC) was rejected by the owner and is not repeated.
- Not modelled: paste and key-count checks (KeyRecs is typed), the duplicate-text check, the SDK's three clean
  live checks before the offer. The user is assumed to accept every offer (an upper bound on uptake).

## Design (short)

Each target enrols on 5 samples of 330 steps from session 1. Every later chunk of 330 steps of session 1 and of
the first half of session 2 is one day (29 windows, median 6 days per user); the test is the second half of
session 2 against the KS impostors (`ids[40:80]`). Decisions are 20-window blocks; live operating point = at
least 10 of 20 windows below 0.50.

| Arm | What it does |
| --- | --- |
| A | enrolment model, never retrained |
| B | the loop as built: the day's last 20 windows are the sample; retrain after 3 accepted samples |
| B1, B2 | as B, retrain after 1, or 2, samples |
| Bany | as B, the sample is the newest run of 20 windows of the day that passes the score checks |
| D | upper bound: every day, all windows |
| R | noise reference: A retrained with another seed, no new data |

## Results (98 targets)

| | A | B | B1 | B2 | Bany | D | R |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Per-user decision AUC | 0.9186 | 0.9195 | 0.9274 | 0.9205 | 0.9239 | 0.9671 | 0.9218 |
| FAR (pooled, live rule) | 15.0% | 13.8% | 12.0% | 13.4% | 12.8% | 12.7% | 14.8% |
| FRR (pooled, live rule) | 13.5% | 13.3% | 15.0% | 14.5% | 13.9% | 3.9% | 12.3% |
| Pooled decision EER | 14.1% | 13.3% | 13.1% | 13.9% | 13.1% | 8.4% | 13.9% |
| Genuine locks per 100 test windows | 1.29 | 1.33 | 1.44 | 1.40 | 1.38 | 0.44 | 1.28 |

Contrasts in per-user AUC (paired bootstrap over targets, 10,000, seed 17):

- **Primary, B - A: +0.0009 [+0.0001, +0.0018]**, p 0.024, better for 20/98 (SE 0.0004, MDE80 0.0012). By the
  pre-registered rule: **improves**. Its size is about one thousandth of AUC: detectable, practically
  negligible, and below what a retrain with no new data moves (R - A +0.0033 [-0.0024, +0.0092]).
- B1 - A +0.0089 [+0.0044, +0.0145]; B2 - A +0.0019 [+0.0001, +0.0037]; Bany - A +0.0054 [+0.0023, +0.0094];
  D - A +0.0485 [+0.0307, +0.0681].
- B1 - B +0.0079 [+0.0035, +0.0137]; B2 - B +0.0010 [-0.0008, +0.0026]; Bany - B +0.0044 [+0.0013, +0.0085];
  D - B +0.0476 [+0.0297, +0.0673].
- B lowers the FAR by 1.2 points [-1.8, -0.6] with the FRR unchanged (-0.1 [-1.4, +1.1]). B1 lowers the FAR by
  3.0 points [-4.2, -1.9] and raises the FRR by 1.7 points [+0.0, +3.7].

## How much of the typing the loop uses

| | days accepted | users with a retrain | retrains | first retrain (median day) |
| --- | --- | --- | --- | --- |
| B | 173/611 (28%) | 33/98 | 38 | 4.0 |
| B1 | 172/611 (28%) | 63/98 | 172 | 2.0 |
| B2 | 169/611 (28%) | 46/98 | 67 | 3.5 |
| Bany | 256/611 (42%) | 51/98 | 63 | 4.0 |

Rejections of B: mean below 0.80 in 378 days, a newest window below 0.80 in 60. Median training time 17.9 s.
The loop gives up most of what the later typing could teach: D, which learns all of it, gains 0.0485.
The AUC here (0.9186 for A) is lower than the 0.969 of the KS table because enrolment is five samples and
the test is a later session; the two are different settings and are not compared in the paper.

## Safety

- **S1, the rule against impostors (enrolment model).** From the end: 29.1% of the owner's days, **1.75%** of
  impostor chunks (68 of 3,880; 28 targets had any). From anywhere: 42.2% and 3.53% (137; 47 targets).
- **S2, forced poisoning.** The most similar impostor's first three chunks of session 2 are added to the
  target's model whether or not they pass: that attacker's later decisions accepted 84.8% -> **93.9%** (+9.1
  points [+5.1, +13.6]); the target's FRR 13.3% -> 14.4%; 42.9% of such chunks would have passed the rule.
  Accepted impostor samples still help the impostor, which is why a retrain needs the passkey.
- **S3, a takeover at the end of a sample.** The last t windows of a genuine day replaced by an impostor's:
  accepted by the rule / by the mean alone: t=1 2.1% / 30.1%, t=2 1.7% / 20.4%, t=3 1.4% / 13.4% (t=0, the
  genuine day itself: 29.1% / 38.6%). The check on the newest three windows is what stops the takeover.

## Reading (fixed in advance, applied)

B shows a detectable improvement of negligible size, so the paper keeps the claim to the loop's **safety
design** (strict gates, passkey-confirmed retrain, validation gate and rollback, pause) and states that the
accuracy gain is 0.0009. The rule admits too little of the later typing: D improves while B hardly does.
B1 and Bany are read as trade-offs only (more learned, more impostor typing accepted). Real-time pace is not
measured: one contribution per day, so the first retrain takes at least as many days as samples required.

## Run notes

Docker Desktop restarted by itself at 01:51 on 2026-10-20 (memory pressure) and killed the first three workers
after 13 targets; the run resumed with two workers capped at 2.6 GB, and seven targets killed by that cap were
rerun one process each with 6 GB. No result was discarded or selected; all 99 target files exist. Technical
reruns used identical settings.

## Where it is written

Paper: sections 3-4 (the cycle and Figure 5) and 4-3 (one Table 5 with the console settings only: off, 1, 2 and 3
samples, and 3 samples from anywhere; arms D and R are not shown, D appears once in a sentence; safety in two
sentences). Thesis: sections 3-9 (Figure 8) and 4-4 (Table 12), conclusion 6, the abstract, and the list of
decisions made after seeing results.
Study page: `paper/pages/keystroke-channel.html`, row 12 (not republishable from this session).
