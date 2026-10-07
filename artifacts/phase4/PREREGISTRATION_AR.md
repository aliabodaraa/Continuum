# Pre-registration AR: does adaptive retraining help, and is it safe?

**Status: FROZEN 2026-10-03**, at the owner's request (3 Oct 2026, relaying the supervisor: "test the
applicability of adaptive retraining, measure its benefit, write it in the paper and the slides").
`PREREGISTRATION_AR.sha256` holds the SHA-256 of this file, of every script that produces the result,
of the shared modules they import and of the data files (`ar_common.FROZEN`). The scripts refuse to run
on any other bytes. The result is analysed once.

## 1. Question

Continuum's keystroke channel can retrain a user's model on their own later typing: when a stretch of
typing scores clean, the SDK offers it as a training sample; the server accepts it only past its quality
gates and at most once per day, and retrains after every three accepted samples. Three questions:

1. **Benefit.** Does this loop, as deployed, make the model better on the user's *later* typing, without
   making impostors easier to accept?
2. **Safety.** How often would an impostor's typing pass the gates, and what would a few accepted
   impostor samples do to the model?
3. **Applicability.** How often is a sample accepted, how long until the first retrain, what does a
   retrain cost?

It also compares the deployed loop with a variant that learns from the typing that caused a lock (the
genuine user then proved who they are with the passkey) and with an upper bound that learns from all
later typing.

## 2. Data

- **KeyRecs** (Dias et al., *Data in Brief*, 2023; CC BY 4.0), `data/keyrecs/free-text.csv`: 99
  participants, two recording sessions each. Steps (key pairs) come from `keyrecs_to_windows.build_steps`,
  the port of ca-service `buildSteps` that experiment KS used; windows are 50 steps with stride 10. Each
  session is rebuilt separately; the script checks, before anything else, that the rebuilt windows equal
  `data/keyrecs_impostors.h5` (the windows KS used) for every participant.
- **Impostors:** KeyRecs `ids[40:80]` as in KS, each scored on their first 150 windows; a target is never
  its own impostor.
- **Negatives:** the KS Aalto pool, first 200 kept typists (KS arm A200 = the live negatives).
- **Disclosure:** KeyRecs was used before (the frozen baseline, KS). Its session split was not used for any
  design choice. The timeline below is fixed here, before any AR result.

## 3. Per-user timeline (in steps, after the live filters)

- **Enrolment:** session 1, steps `[0, 1650)`, as 5 samples of 330 steps (one live enrolment passage
  each), windowed per sample.
- **Days of use:** the rest of session 1 and the first half of session 2, each cut into consecutive
  330-step chunks (a session's incomplete tail is dropped). **Each chunk is one day**: one stretch of
  typing that could be contributed. So the deployed cap of one contribution per day is always met, and
  the time between days is compressed (KeyRecs has two sessions, not daily data).
- **Test:** the second half of session 2, windowed as one stream.
- **Eligible:** two sessions, session 1 >= 1650 steps, session 2 >= 1000 steps, >= 3 days.

## 4. Arms

Every model is trained with KS's live recipe (`ar_common.train` = `run_ks.run_target`): positives = the
given samples' windows in time order, validation positives from the end (15%, 5-window gap), negatives
2 x the training positives (at least 60) from 160 Aalto typists, validation negatives from the other 40,
base `ws50-gru-v2` with Conv1D frozen, Adam 3e-4, batch 16, 30 epochs, early stopping (patience 6, best
weights). Seeds: `1000 + target + arm offset + retrain number` (numpy and TensorFlow, op determinism).

| Arm | What it does |
| --- | --- |
| **A** | Enrolment model, never retrained (today without adaptation). |
| **B** | **The deployed loop.** Each day, the current model scores the day's windows; the day is accepted only if it passes the server's gates (below); three accepted days -> retrain on enrolment + every accepted day; continue with the new model. Accepted days not yet retrained on stay out of the final model, as in deployment. |
| **C** | **Learn from the lock.** Each day, the live lock rule (below) is replayed on the day's windows with the current model; if it locks at least once, the day is added (the genuine user passed the passkey). Three added -> retrain. |
| **D** | **Upper bound.** Every day added; one retrain at the end on enrolment + all days. |
| **R** | **Noise reference.** A retrained with another seed and no new data: how much a retrain alone moves the numbers. |

**B's gates**, in the server's order (ca-service `server.js` /v1/keystroke/contribute and
`lib/keystrokeSecurity.js`, as on 2026-10-03), on the day's windows scored by the current model:
1. at least 6 windows among the last 18 scored;
2. mean of the last 18 window scores >= 0.80;
3. each of the last 6 window scores >= 0.80;
4. rhythm consistency: for dwell1, dwell2 and dd, |mean over the day's steps - pooled mean over all
   training samples so far| / pooled standard deviation <= 3.0 (skipped below 100 history steps).

Not modelled, and why: the paste and key-count checks (KeyRecs is typed, and a day has ~330 keys); the
duplicate-text check (no chunk repeats); the SDK's own popup condition (three clean checks in a row,
implied by gates 2-3 in practice). The user is assumed to accept every offer: an upper bound on uptake.

**The live lock rule** (rule `lu-050-10of20-warm8` with the 2-of-3 debounce, ca-service `server.js`),
replayed with one check per new window: a window is low below 0.50; warm-up while the stream has <= 20
windows, unless overwhelming (>= 8 windows and >= 75% of the last <= 20 low); a check is suspicious when
>= 10 of the last 20 are low; it locks when suspicious and (overwhelming or >= 2 of the last 3 checks
suspicious); after a lock the stream restarts at the next window and the debounce history clears.

## 5. Safety tests

- **S1, the gates against impostors.** On each target's enrolment model (A) with the enrolment as
  history, the gates are applied to (a) each of the target's days and (b) each impostor's first 330
  steps. Reported: the share of genuine days and of impostor chunks that pass.
- **S2, forced poisoning (worst case).** The attacker is the impostor whose 150-window run has the
  highest mean score under A (the most similar typist; with >= 1490 session-2 steps). Their first three
  330-step chunks of session 2 are added as positives *whether or not they pass the gates* (an attacker
  who got three samples in), and one model is trained. Reported: the share of the attacker's later
  decisions (their session-2 steps after the poison) accepted at the live rule before (A) and after,
  the target's genuine FRR after, and how many poison chunks would have passed the gates.

## 6. Outcomes and analysis (`analyze_ar.py`)

Decisions as KS: step-disjoint blocks of 20 windows (`eval_decision_level.blocks`, gap 4); decision
score = block mean; the live rule's operating point = >= 10 of 20 below 0.50.

- **Primary:** B - A in per-user AUC of 20-window decisions (target's test decisions vs the impostors'),
  paired bootstrap over targets (10,000 resamples, seed 17). **B improves on A** if the lower 95% bound
  > 0; **harms** if the upper bound < 0; otherwise **no detectable difference**, with the SE and the
  minimum detectable effect at 80% power reported.
- **Secondary (descriptive, 95% intervals):** C - A, D - A, C - B, D - B, R - A in per-user AUC; per-user
  live-rule FRR and FAR and genuine locks per 100 test windows (the lock-rule replay), B - A, C - A,
  D - A, R - A; pooled decision EER; window AUC and EER.
- **Applicability:** days accepted (share, per user), users with a retrain, the day of the first
  retrain, B's rejection reasons, median training time.
- **Safety:** S1 and S2 as in section 5.

**Reading fixed in advance.** If B shows no detectable difference while D improves, the deployed loop
does not deliver the benefit that later data could give (too few accepted days, or the accepted ones add
little). C's result decides whether learning from passkey-confirmed typing is worth proposing. Real-time
pace is not measured here: with one contribution per day and a retrain every three, the first retrain
takes at least three days of use by construction.

## 7. Procedure and disclosures

- Smoke tests (3 targets, 3 epochs, `artifacts/phase4/smoke`, flagged and not a result) ran before this
  freeze to check the code. Arm R and clearer report labels were added after the first smoke run; no
  other setting was chosen after seeing any output.
- Runs: `run_ar.py` in the model-api container, in batches (a fresh process per batch, as KS's memory
  cap); a finished target is never rerun. A technical failure is rerun with identical settings and logged.
- Write-up: `docs/recovery/RESULTS_AR.md`, the manuscript (sections 3-8 and a results section) and the
  seminar slides.
