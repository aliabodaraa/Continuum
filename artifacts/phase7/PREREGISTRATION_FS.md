# Pre-registration FS: the mouse network trained with SapiMouse's own settings (TODO.md section 9)

Written and frozen on 2026-10-21, before the network is trained. The owner wants every part of mouse training to rest
on the SapiMouse paper where possible, and asked to start the deferred tests after the supervisor meeting.
This file, `services/model-api/analysis/phase7/train_fs.py` and `services/model-api/analysis/phase7/score_fs.py` are
hashed into `PREREGISTRATION_FS.sha256`. The scripts refuse to run if any of them differs.

## 1. Question

The deployed mouse channel keeps SapiMouse's data, representation, FCN and frozen-extractor design, but trains the FCN
with our settings (Adam 1e-3, batch 128, at most 40 epochs, early stopping 12, plateau 5). SapiMouse trains it with
Adam 1e-4, batch 16, 100 epochs, a learning-rate plateau of 50 and the weights with the lowest validation loss. FS
asks whether the channel stays at least as good when the network is trained with SapiMouse's settings.

## 2. Design

- **Two networks that differ only in the training recipe.** The reference is the current base-80 network
  (`artifacts/mouse-fcn-a5-j80`, the source of paper Table 6). The new network is trained by `train_fs.py`, which
  copies `train_mouse_fcn.py` line for line:
  - the 80 base users (SPLIT_J, `exclude_j40.json` held out);
  - each user's three-minute session, the first 80% of steps for training and the last 20% for validation;
  - A5 windows of 50 steps with stride 10;
  - the scaler fitted on the training windows;
  - the FCN (arm B6) and seed 101.
  Only the optimizer, batch, epochs, schedule and weight selection change to SapiMouse's
  (`analysis/phase6/e_native_blocks.train_base_sapimouse`).
- **The same channel on top.** Protocol L stage D's F2 path, unchanged (`l_common.score_targets`):
  - the network's GAP output;
  - the cohort of the 80 base users;
  - a logistic head per user on 440 enrolment windows;
  - the threshold at the 20th percentile of the leave-one-sample-out scores;
  - the same 19 development targets, the same impostor runs and the same scaler.
- These 19 users were used before (stage D). This is a development comparison, not a fresh test, and no lockbox user
  is read.

## 3. Endpoints

- **Primary:** the paired difference (new minus reference) in per-user AUC of 60-window decisions (the paper's AUC,
  `analyze_l.per_user_auc`), with a 95% interval from a bootstrap over the 19 users (10,000 resamples, seed 17).
- **Secondary:**
  - The per-user AUC at 15 and 33 windows.
  - FAR and FRR at the deployed rule (`analyze_l.deployed_point`, 33 of 60).
  - The live loop at 60 windows (genuine requests per minute, impostor runs caught, mean time to catch).
  - Identification top-1 of each network on the base users' one-minute session.

## 4. Decision rule, fixed now

- **Non-inferior** if the lower bound of the primary interval is above −0.010, the margin protocol L used for F2.
  Then the recommendation is to adopt SapiMouse's settings. The deployed 100-user network would be retrained with them,
  the cohort, heads and thresholds rebuilt, and every mouse number in the paper and thesis re-measured. The owner
  decides.
- **Otherwise** the current settings stay, and the paper keeps describing the training settings as this work's own,
  chosen by measurement.
- Nothing deployed changes from this experiment without the owner's decision.

## 5. Checks

- The new scaler must equal the reference scaler (the same training windows). If it does not, the run stops.
- The stage D streams of the new system must match the stored F2 streams (same targets, genuine lengths and impostor
  runs). If they do not, the run stops.
- A training failure is re-run once and logged.
