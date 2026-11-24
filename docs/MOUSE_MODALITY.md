# Mouse Dynamics Modality — Integration Notes

Second behavioural biometric alongside keystroke dynamics. Every component below was chosen by a
pre-registered study (`artifacts/repr_arch_study/`: PREREGISTRATION*.md with SHA-256 fingerprints,
RUN_LOG.md, analysis_A … analysis_G.json). Base paper: SapiMouse.

## Dataset

- **SapiMouse** (Antal, Fejér & Buza, 2021) — 120 subjects, Apache-2.0.
  - Antal, M., Fejér, N., & Buza, K. (2021). SapiMouse: Mouse dynamics-based
    user authentication using deep feature learning. *2021 IEEE 15th Int. Symp.
    on Applied Computational Intelligence and Informatics (SACI)* (pp. 61–66).
    IEEE. https://doi.org/10.1109/SACI51354.2021.9465583
- Raw CSV columns: `client timestamp (ms), button, state, x, y`.
- Events: state ∈ {Move, Pressed, Released, Drag}; button ∈ {NoButton, Left, Right}.
- 100 base users train the shared network; 20 are held out of it entirely for evaluation
  (`artifacts/mouse-ws50-aligned/holdout_users.json`).

## Feature vector (per step) — F = 2

`[|dx|, |dy|]` — the unsigned horizontal and vertical move in pixels (SapiMouse's best raw
representation, its Table I; Experiment A found no richer representation measurably better).
`FEATURE_VERSION = "a5-absdxdy-v1"`.

- Idle gaps > 0.5 s reset the stream; zero-displacement moves (not clicks) are dropped.
- Windows: 50 steps, stride 10; a window whose normalised path (sum of hypot(|dx|/1920, |dy|/1920),
  clipped) is below 0.08 is skipped.
- Identical in `sdk/js/mouse-features.js`, `extension/src/features-mouse.js` and
  `services/model-api/preprocess_mouse.py` / `repr_arch_study.py` (value-for-value parity check).

## Model

- Shared network: SapiMouse's FCN — Conv1D 128/k8, 256/k5, 128/k3, each BatchNorm + ReLU, global
  average pooling (`embedding`, 128-d) — trained on 100-way identification
  (`train_mouse_fcn.py` → `artifacts/mouse-fcn-a5`, scaler, `arch.json`).
- Per user (server, F2, deployed 2026-09-26, recovery plan T3.4): the network stays frozen.
  `api.py` (`train_user_f2_payload`) embeds the user's 440 windows with its `embedding` layer,
  centres them on a cohort mean and L2-normalises them, and fits a logistic head (C = 1, lbfgs)
  against 880 cohort rows. The cohort is `artifacts/mouse-fcn-a5/f2_cohort.npz`: 40 windows from each
  of the network's 100 training users, seed 7, built by `build_f2_cohort.py` with stage C's own
  function. The threshold source is leave-one-sample-out: for each 55-window sample, a head fitted
  without it (and without the 4 windows on each side) scores it. A profile is one file,
  `f2_head.json`; no per-user network is trained or loaded, and an enrolment takes about 6 s through
  the training queue. `validate_f2.py` checks that serving reproduces protocol L's analysis code bit
  for bit (the cohort, the leave-one-sample-out scores and scores on held-out windows).
- Per user (server, S1, 2026-09-23 to 2026-09-26; still in `api.py`, selected by
  `MOUSE_HEAD_SCHEME = "s1"` in `lib/mouse.js`): base → `embedding` → Dense(2, softmax), `conv1` and
  `bn1` frozen, fine-tuned with Adam 3e-4, 15 epochs, batch 32, early stopping 6; negatives = 2 ×
  positives from `data/mouse_only/Mouse_A5_W50_base.h5` (base users only). One call
  (`train_user_loso_payload`) trains 8 leave-one-sample-out fold models and then the final model on
  all 8 samples (about 2.5 min). `validate_loso.py` reproduces the stored P1 Method-B scores exactly.
- Per user (extension): head only on the frozen `embedding`, trained in the page
  (`extension/src/mouse-model.js`); negatives are the same 660 base-user windows, bundled as
  precomputed embeddings (`extension/data/mouse-impostors.json`). Experiment G: no measurable
  accuracy cost against the server.

## Decision

- Server (F2 since 2026-09-26, rule `f2-loso-p20-33of60`; the same rule S1 used): per-user
  threshold = 20th percentile of the user's leave-one-sample-out scores; a window is low below it;
  suspicious when 33 of the last 60 windows are low. Each profile stores both tables (out-of-sample
  and in-sample) for q ∈ {1, 2, 5, 10, 15, 20, 30, 40, 50} and the rule it was trained for
  (`decision_version`); a profile from an earlier rule is rebuilt from its stored samples, never
  scored against this vote.
- Evidence for F2 (protocol L, pre-registered; `docs/recovery/RESULTS_L_stageC.md`): on the untouched
  Bogazici users it was non-inferior to S1 (per-user AUC of 33-window decisions +0.0203 [+0.0039,
  +0.0376], better for 12 of 19) and better on pooled EER (-7.76 points [-10.93, -3.19]); on the 19
  development users no difference was detected (-0.0019 [-0.0162, +0.0127]). At this rule on Bogazici
  it prompted more than S1 (median 0.76 against 0.33 prompts per minute of movement) and caught more
  impostor runs (72% against 53%). Both are weak there (per-user AUC about 0.72-0.74, against about
  0.96 on SapiMouse): the SapiMouse-trained network transfers poorly to other hardware and tasks.
- S1 (2026-09-23 to 2026-09-26): on the untouched first lockbox (P6, 20 users) it caught 95.0% of
  40-s impostor runs (2 users below 80%) at 0.33 genuine prompts per minute of movement, against
  77.1% (8 users below 80%) at 0.17 for the rule it replaced (q = 1 of the in-sample scores, 30 of
  60, from Experiment I). The pre-registered P6 test did not adopt S1 (prompt increase +0.15 [0.00,
  +0.31] against a +0.10 margin): S0 stands in the record and S1 was deployed as the owner's
  disclosed deviation (RUN_LOG).
- Extension (unchanged): q = 2 of its in-sample scores, suspicious when the mean of the last 60
  scores is below the threshold (Experiment I: 0.22 prompts/min, 87.3% caught).
- History of the server point: the pre-registered rule of Experiment I required ≥ 90% capture and
  would have kept Experiment F's point (q = 5, 12 of 20: 2.85 prompts/min, 99.4% caught); the
  owner chose the comfort-first q = 1, 30 of 60 (0.29/min, 86.5%), which S1 replaced. Experiment H
  kept that recipe's threshold on in-sample enrolment scores (held-out validation windows and the
  first 55 windows of use cost capture beyond the 5-point margin); protocol J's P1 then measured the
  leave-one-sample-out source that S1 uses. The extension's point (q = 2, mean of 60) is also a
  comfort-first owner decision (G's pre-registered point: q = 10, 14 of 20: 1.95/min, 100%).
- 60 windows = 640 steps ≈ 17 s of movement. One suspicious decision = one passkey prompt in every
  client (gateway `MOUSE_STRIKES_TO_LOCK = 1`); the buffer restarts after a prompt.
- Every scored check is logged in ca-service `mouse_decisions` (window count, threshold, low
  windows, rule, verdict, scores) to measure prompts per minute on real users.

## Enrolment

- Server: 8 samples × 55 windows = 440 (about 4 min of the pad's tasks). A sample saves itself when complete; the SDK and
  demo show "Sample k of 8" (pips and time left), and samples can be spread over visits. Each
  sample must show a step-size interquartile range ≥ 5 px. (The extension keeps its own 6 × 55.)
- The pad (`sdk/guard.js` `mouseTasks`, 2026-11-24) asks for short tasks in place of one dot to chase, in shuffled
  rounds of nine kinds: click a dot near or far, click numbers in a row, double-click a word, select words by
  dragging, drag a handle along a bar (across or down), click a thin bar at a mark, follow a text with the pointer,
  pick from a menu, drag a card into a box. A sample is saved once it holds 55 windows and four finished tasks, as
  its last 55 windows, so movement without the tasks saves nothing; a task still open after 18 s can be skipped and
  then does not count. Why: the dot taught long, fast hops only. In the owner's browsing of 22-24 Nov the median
  step was 5.4 px against 10.6 px in his dot samples, a window covered half the path, and his own profile turned
  31% of those windows down (2% once rescaled to his enrolment's size). Recording, windows and the server's checks
  are unchanged. Test: `extension/scripts/e2e_headless_sdk_mouse.mjs`, where a robot does every kind of task with
  real mouse input, in English and Arabic.
- ca-service stores samples; once the total reaches 440 it queues training in its durable training
  queue (`training_jobs`, one job at a time) instead of training inside the request, and every
  extra sample queues a rebuild. The model is always trained on the user's latest 440 windows, in
  time order. The enrolment reply is 202 with `training: true`; clients poll `/status`, which
  reports `training`, `trainingError`, `sampleWindows`, `samplesRequired`, `samplesOnFile`,
  `voteN`, `voteK`, `thresholdPercentile`, `thresholdSource`. The profile stores the threshold,
  both percentile tables, the feature version and the decision rule; 7-column clients are refused.
- `services/ca-service/scripts/retrain_mouse_profiles.js` retrains every stored profile when the
  recipe or the operating point changes; a profile it misses is rebuilt from the queue the next
  time its status or a check is read.
- Stored 7-column windows convert exactly to the current representation (|col| × 1920):
  `services/ca-service/scripts/migrate_mouse_a5.js` (server), `fromRetired7` (extension).

## Channels are not fused

Keystroke and mouse decide independently; either may request the passkey. Score-level fusion
needs a corpus in which the same people contribute both modalities.
