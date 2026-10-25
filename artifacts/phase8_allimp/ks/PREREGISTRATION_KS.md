# Pre-registration KS: more impostor typists for Lu's per-user keystroke model

**Status: FROZEN 2026-09-24**, under the owner's delegation ("keystroke follows Lu", "any
peer-reviewed dataset", "go with the best path", 24 Sep). `PREREGISTRATION_KS.sha256` holds the
SHA-256 of this file and of every script and module that produces the result (listed in
`ks_common.FROZEN`). The scripts refuse to run on any other bytes.

## 1. Question

Lu et al. (2020) train one binary CNN+RNN per user: the user's own windows against windows from
other people. Continuum follows that recipe unchanged, with negatives from 40 KeyRecs participants.

Question: **does drawing the same number of negative windows from many more different people make
the per-user model better at rejecting people it has never seen?** Nothing else changes: not the
network, the features, the training settings, nor the live decision rule.

## 2. Data

- **Targets and impostors:** KeyRecs (Dias et al., *Data in Brief* 50, 2023; CC BY 4.0), the 99
  participants in `data/keyrecs_impostors.h5`.
  - **Targets:** every participant, split and eligible exactly as in the frozen baseline
    (`population_sweep.py`).
  - **Impostors:** participants `ids[40:80]`. Each is scored on their first 150 windows; the target
    is removed from this pool.
- **Negatives:** the Aalto 136M Keystrokes dataset (Dhakal et al., CHI 2018), used for negatives
  only. Windows are built with `aalto_to_windows.participant_windows`, which the local session has
  checked for parity with the live feature code.
- **Disclosure:** KeyRecs was used earlier in this project (the frozen baseline, packet-size
  sweeps). So this is not an untouched dataset. But nothing in this experiment is tuned on it: every
  setting is fixed here, before any KS result exists.

## 3. Arms

All four arms use population_sweep.py's per-user recipe line for line:
- temporal 70/30 split with a 5-window gap;
- validation positives from the end of the enrolment block;
- training negatives = 2 x the positive windows, at least 60, drawn at random from the pool's
  windows;
- validation negatives drawn from the first fifth of the pool's people (at least 4), training
  negatives from the rest;
- transfer from the `ws50-gru-v2` base with Conv1D frozen, Adam 3e-4, batch 16, 30 epochs,
  EarlyStopping (patience 6, best weights restored);
- seeds 1000 + target (numpy and TensorFlow; op determinism on).

| Arm | Negative people |
| --- | --- |
| **REF** | KeyRecs `ids[0:40]`: the frozen baseline |
| **A40** | the first 40 Aalto typists of the draw |
| **A200** | the first 200 (contains A40) |
| **A1000** | the first 1,000 (contains A200) |

**The Aalto draw** (`make_pool_ks.py`):
1. List every participant file in `data/Keystrokes.zip`, sorted by id.
2. Permute the list with `default_rng(20260924)`.
3. Read the files in that order and keep a participant if they yield at least 10 windows. Stop at
   1,000 kept.

If fewer than 1,000 are eligible, the largest arm uses all of them, and the shortfall is reported.
The draw is made once, before any training; its manifest (ids and hashes) is part of the result.

The arms differ **only in how many different people the negatives come from**. They do not differ
in the number of negative windows.

## 4. Decisions and scores

- **Decision** = the live packet: 20 consecutive windows of one contiguous stream, i.e. the target's
  held-out windows or one impostor's run.
- **Blocks:** step-disjoint, with a gap of 4 (`eval_decision_level.blocks`, unchanged).
- **Decision score:** the packet's mean genuine probability. It needs no threshold.
- **The live rule** (Lu et al.'s fixed 0.50 cutoff; suspicious when at least 10 of 20 windows fall
  below it) is reported as one operating point.

## 5. Endpoints

- **Primary:** A1000 - REF, the mean over targets of the paired difference in per-user AUC of
  20-window decisions. Bootstrap over targets: 10,000 resamples, seed 17 (`p1lib.boot`).
  **Superiority if the lower 95% bound is > 0.**
- **Key secondary** (fixed sequence; tested only after a primary success): A1000 - A40, the effect
  of more people with the source held fixed. Success if the lower 95% bound is > 0.
- **Reported, deciding nothing:**
  - A200 - REF and A40 - REF;
  - window-level AUC and EER per user, and the number of users above 20% EER;
  - pooled decision EER, AUC, and FRR at FAR 1% and 5%;
  - the live rule's FAR and FRR per decision;
  - per-user values;
  - the SE and MDE80 of the primary.
- **Eligible targets:** those that pass the baseline's rule (at least 40 enrolment and 20 held-out
  windows) and have at least one genuine and one impostor decision in every arm. Exclusions are
  listed.

## 6. What each outcome means

- **Primary succeeds:** more impostor typists improve Lu's per-user model on unseen people. With
  the key secondary also passing, the gain comes from the number of people, not only from the
  source.
- **Primary fails:** reported as fully as a success. If A40 < REF, the Aalto domain (short
  transcribed sentences) hurts. That is a finding about data source, not about Lu's method.
- **Deployment:** adopting a larger pool in production is a separate, stated owner decision.

## 7. Conduct

- **Order:** freeze → draw the pool → train all four arms → analyse once.
- **Technical failures** (crash, non-finite scores) are re-run with identical settings and logged
  in `RUN_LOG.md`. No target, arm or seed is dropped.
- **Changes** after freezing are amendments written before the affected results exist.
- **Code:** `services/model-api/analysis/phase3/`
  - `ks_common.py`
  - `make_pool_ks.py`
  - `run_ks.py`
  - `analyze_ks.py`

  It was smoke-tested on synthetic data only, before freezing.
