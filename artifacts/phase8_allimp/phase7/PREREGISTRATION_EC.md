# Pre-registration EC: how much typing enrolment is enough (the learning curve of TODO.md section 8)

Written and frozen on 2026-10-21, before any training. The owner asked to start the deferred tests on that day.
This file, `services/model-api/analysis/phase7/run_ec.py` and `services/model-api/analysis/phase7/analyze_ec.py`
are hashed into `PREREGISTRATION_EC.sha256`. The run refuses to start if any of them differs.

## 1. Question

The headline typing results (experiment KS, arm A200, paper Tables 3 and 4) come from personal models that learn from
the first 70% of each KeyRecs owner's typing, a mean of about 300 windows. A live enrolment is five passages, about
130 windows. No test shows how performance changes with the amount of enrolment typing, so no saturation point and no
optimal number of samples has been claimed. EC measures the learning curve on the KS protocol.

## 2. Data and protocol (identical to KS arm A200 unless stated)

- **Targets:** the 99 KeyRecs participants of KS, each as the owner of an account.
- **Owner split:** the KS temporal split (`population_sweep.split_with_gap`, first 70% to enrol, last 30% held out,
  five windows dropped on each side of the boundary). The held-out windows are the same for every size.
- **Impostors at test:** KeyRecs participants 40 to 79 (the owner excluded), first 150 windows each, as in KS.
- **Training negatives:** the KS A200 Aalto pool, twice the positive training windows (at least 60), validation
  negatives from separate Aalto participants, exactly as `run_ks.run_target`.
- **Model and training:** the KS recipe. Transfer from `ws50-gru-v2` with Conv1D frozen, Adam 3e-4, batch 16, at most
  30 epochs, EarlyStopping with patience 6 and the best weights restored. Seeds `default_rng(1000 + target)` and
  `set_random_seed(1000 + target)` with op determinism, as in KS.
- **The only change: the enrolment size.** A model learns from the first M windows of the owner's enrolment block, in
  time order. M is 12, 26, 52, 78, 130, 208 or "all". Here 12 is the server's minimum, 26 is about one enrolment
  passage, 130 is a live enrolment of five passages and "all" is the whole block. An owner whose block is shorter than
  M trains on the whole block at that size, and the number of such owners is reported.
- **Validation split:** the live service's rule (`api._contiguous_split` with a validation fraction of 0.2 and a
  gap of 5). The validation positives are the last 20% of the M windows, and the five windows before them are dropped.
  KS's own rule (the last 15% with five windows dropped on each side) leaves no validation windows below about 40, so it
  cannot be used across the curve. Because of this rule, the "all" point is not KS itself. The KS A200 result
  (`artifacts/phase3/parts/A200`) is reported next to it as the paper's reference.

## 3. Endpoints

Decisions are step-disjoint blocks of 20 windows (`eval_decision_level.blocks`, gap 4), scored by the block mean, as in
paper Table 4 (`packet_length_a200.decisions`).

- **Primary:** the mean over owners of the per-user AUC of 20-window decisions, at each M.
- **Paired comparisons:** for each M, the mean paired difference (M minus "all") in per-user AUC, with a 95% interval
  from a bootstrap over owners (10,000 resamples, seed 17).
- **Secondary:**
  - FAR and FRR at the live rule (passkey when at least 10 of 20 windows are below 0.50), pooled over owners.
  - The share of owners whose per-user AUC is below 0.90.
  - The mean over owners of the single-window EER.

## 4. Decision rules, fixed now

- **Saturation point:** the smallest M whose paired difference to "all" has a lower 95% bound above −0.005. If no M
  below "all" meets it, the curve has not saturated within the KS data, and that is the result.
- **Live enrolment:** the paired difference of M = 130 to "all", with its interval, is reported as the estimate of how
  optimistic the KS numbers are for a new user. No threshold is attached to it.
- **No deployed setting changes from this experiment** without the owner's decision.

## 5. Checks and failures

- A smoke test (one target, two sizes, few epochs) runs first and writes only under `artifacts/phase7/ec/smoke`.
- A target that fails technically (non-finite scores, a crash) is re-run once and the failure is logged. It is never
  dropped silently.
- All 99 owners enter every size. None is excluded after seeing results.
