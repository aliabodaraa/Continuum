# Amendment L-2 to PREREGISTRATION_L: stage C systems, cohort and frozen code

**Status: FROZEN, 25 Sep 2026, together with Amendment L-1, before any Bogazici score exists.**
`AMENDMENT_L2.sha256` holds the SHA-256 of:
- both amendments;
- every file that produces stage C (`c_common.STAGE_C_FILES`);
- the deployed network folder;
- the window-building modules.

`score_c.py` and `analyze_c.py` refuse to run on any other bytes. Nothing here changes a system, an
endpoint or a margin of the frozen plan.

## 1. What stage D decided

- **L failed its kill criterion.** L − REF = −0.008 [−0.029, +0.011] (`stage_D.json`, commit 19c57b6).
- **So Q1 is not tested, and no L model is trained on the 100 base users.** Section 4's "the same
  configuration is retrained on the 100 base users" applies only when L passes.
- **The confirmatory family is Q2 alone.** Holm over one hypothesis leaves its 95% interval
  unadjusted.
- **Q2 as frozen:** F2 − REF, per-user AUC of 33-window decisions (pct). F2 is non-inferior if the
  lower 95% bound is > −0.010.
- **Key secondary, fixed sequence:** pooled pct EER of 33-window decisions, tested only if Q2
  succeeds.

## 2. The systems in stage C

**REF = S1 exactly as deployed.** `api.train_user_loso_payload` is called with the payload
`services/ca-service/lib/mouse.js` sends:
- modality `mouse`, threshold scheme `leave-one-sample-out`;
- 8 samples of 55 windows;
- overlap gap 5, 15 epochs, batch 32.

The model files come from the deployed defaults:

| Item | File |
| --- | --- |
| Network | `artifacts/mouse-fcn-a5/final_model` (base-100) |
| Scaler | `artifacts/mouse-fcn-a5/scaler.json` |
| Negatives | `data/mouse_only/Mouse_A5_W50_base.h5` |

- **Threshold source:** the 440 leave-one-sample-out scores.
- **Test scores:** from `api.predict_user_payload`.
- **Negatives check:** every REF model must report `negativeSource = "dataset"`, i.e. the deployed
  negatives file was used.

**`api.py` is frozen as it is after T3.3** (commit 74930ba, sha256 `234829611150…`), which moved live
keystroke training to Aalto negatives. It leaves the mouse path unchanged:
- the mouse negatives file holds only `X`, so no participant groups apply;
- the default of 2,000 windows gives the same `rng(13)` draw as before.

REF is therefore S1 as validated and as deployed.

**F2 = the same base-100 network, frozen.**
- Embedding: its GAP output, centred on the cohort mean and L2-normalised.
- Head: logistic regression (C = 1, lbfgs) on the 440 enrolment windows vs 880 cohort windows
  (seed 21).
- Threshold source: leave-one-sample-out over the 8 samples, with the 4 windows on each side purged.

## 3. The F2 cohort, and lockbox 1

Section 3 defines F2's cohort as "40 windows from each base user, seed 7" of the network in use. In
stage C that network is the deployed base-100. Its 100 training users are SapiMouse minus its 20
hold-out users (`artifacts/mouse-fcn-a5/holdout_users.json`, identical to SPLIT_J's development users).
They therefore include lockbox 1's 20 users.

Section 2's "SapiMouse lockbox 1 is not used at all" was written for the SapiMouse stages. Lockbox 1 is
spent (P6), and REF's own network and negatives file were built from these users. So:

- **Cohort:** in stage C, lockbox-1 users contribute cohort windows (their 3-min sessions) exactly
  like the other 80. They are never test users.
- **Development users** (the network's hold-out) are never read in stage C.

## 4. Data handling fixed with the code

- **Selection is Amendment L-1's.** L-1 fixes the enrolment, the session identity (first timestamp),
  the genuine and impostor draws, and eligibility. The unauthorised sessions of each target's test
  folders are its impostors, each session one run of at most 150 windows.
- **Sessions.** Every Bogazici session is its own stream. Windows, decisions and the live loop never
  cross a session boundary.
- **Live loop.** It is reported per 1,000 genuine windows, and per minute at L-1's measured 0.2897 s per
  window. SapiMouse's 0.269 s does not transfer.
- **Memory.** Targets are built and scored one at a time.
- **Precision.** Scores are stored at full float precision. REF's leave-one-sample-out scores are
  rounded to 6 decimals by `api.py`, as in production.

## 5. Order of work

1. Freeze L-1 + L-2 (`AMENDMENT_L2.sha256`).
2. Commit the frozen files.
3. Run `score_c.py`.
4. Run `analyze_c.py` once.

Technical failures are re-run with identical settings and logged in `RUN_LOG.md`. `score_c.py` saves
each finished target under `stageC/partial/`, together with the frozen hashes. After a crash or a
sleeping laptop, the same command reuses those targets and scores the rest. Each target is seeded on
its own, so a restart changes no score. A cloud test showed this: a run that crashed and was restarted
gave the same scores, to the bit, as a single uninterrupted run.
