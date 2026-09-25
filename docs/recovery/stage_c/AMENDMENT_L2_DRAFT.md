# Amendment L-2 to PREREGISTRATION_L: stage C systems, cohort and frozen code

**Status: DRAFT (CLOUD, 24 Sep 2026).** It is frozen together with Amendment L-1, before any
Bogazici score exists. `AMENDMENT_L2.sha256` holds the SHA-256 of both amendments and of every file
that produces stage C (`c_common.STAGE_C_FILES`, the deployed network folder, and the window-building
modules). `score_c.py` and `analyze_c.py` refuse to run on any other bytes. Nothing here changes a
system, an endpoint or a margin of the frozen plan.

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

- **Sessions.** Every Bogazici session file is its own stream. Windows, decisions and the live loop
  never cross a session boundary.
- **Impostor runs.** For each other user, their test sessions are taken in the order L-1 fixes and
  cut at 150 windows in total. The 150 windows may span several sessions; each session's piece stays
  a separate stream.
- **Live loop.** It is reported per 1,000 genuine windows. It is also reported per minute, using the
  seconds-per-window figure that L-1 measures from the data (SapiMouse's 0.269 s does not transfer).
- **Scores** are stored at full float precision. REF's leave-one-sample-out scores are rounded to 6
  decimals by `api.py`, as in production.

## 5. Order of work

1. Freeze L-1 + L-2 (`AMENDMENT_L2.sha256`).
2. Commit the frozen files.
3. Run `score_c.py`.
4. Run `analyze_c.py` once.

Technical failures are re-run with identical settings and logged in `RUN_LOG.md`.
