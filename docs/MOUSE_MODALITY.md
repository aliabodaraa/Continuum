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
- Per user (server): `api.py` builds base → `embedding` → Dense(2, softmax), freezes `conv1` and
  `bn1`, fine-tunes with Adam 3e-4, 15 epochs, batch 32, early stopping 6; negatives = 2 × positives
  from `data/mouse_only/Mouse_A5_W50_base.h5` (base users only). Returns the percentiles of the
  user's enrolment scores.
- Per user (extension): head only on the frozen `embedding`, trained in the page
  (`extension/src/mouse-model.js`); negatives are the same 660 base-user windows, bundled as
  precomputed embeddings (`extension/data/mouse-impostors.json`). Experiment G: no measurable
  accuracy cost against the server.

## Decision

- Per-user threshold = q-th percentile of the user's enrolment scores; a window is low below it.
  Each profile stores the whole table q ∈ {1, 2, 5, 10, 15, 20, 30, 40, 50}.
- Server: q = 1, suspicious when 30 of the last 60 windows are low. Extension: q = 2, suspicious
  when the mean of the last 60 scores is below the threshold. Both from Experiment I (operating point
  by genuine passkey prompts per minute of movement): server 0.29 prompts/min, 86.5% of 40-s
  impostor runs caught, median 17 s to catch; extension 0.22/min, 87.3%.
- The pre-registered rule of Experiment I required ≥ 90% capture and would have kept Experiment F's
  point (q = 5, 12 of 20: 2.85 prompts/min, 99.4% caught) and G's (q = 10, 14 of 20: 1.95/min,
  100%). The deployed points are the owner's comfort-first decision, disclosed as such.
- Experiment H: the threshold stays on enrolment scores (held-out validation windows and the first
  55 windows of use both cut false locks but cost capture beyond the 5-point margin).
- 60 windows = 640 steps ≈ 17 s of movement. One suspicious decision = one passkey prompt in every
  client (gateway `MOUSE_STRIKES_TO_LOCK = 1`); the buffer restarts after a prompt.
- Every scored check is logged in ca-service `mouse_decisions` (window count, threshold, low
  windows, rule, verdict, scores) to measure prompts per minute on real users.

## Enrolment

- 6 samples × 55 windows = 330 (~90 s). A sample saves itself when complete; the SDK, demo and
  extension show "Sample k of 6" (pips and time left), and samples can be spread over visits. Each
  sample must show a step-size interquartile range ≥ 5 px. Measured plateau: AUC 0.856 at 330 vs
  0.861 at 440 (non-inferior).
- ca-service stores samples, trains once the total reaches 330 (and retrains on every extra
  sample), passes the enrolment to model-api as one chronological stream (contiguous 20%
  validation tail with gap 5, as evaluated), stores the threshold, the percentile table and the
  feature version with the profile, and refuses clients that still send 7-column windows.
  `/status` reports `sampleWindows`, `samplesRequired`, `samplesOnFile`, `voteN`, `voteK`.
- `services/ca-service/scripts/retrain_mouse_profiles.js` retrains every stored profile when the
  recipe or the operating point changes.
- Stored 7-column windows convert exactly to the current representation (|col| × 1920):
  `services/ca-service/scripts/migrate_mouse_a5.js` (server), `fromRetired7` (extension).

## Channels are not fused

Keystroke and mouse decide independently; either may request the passkey. Score-level fusion
needs a corpus in which the same people contribute both modalities.
