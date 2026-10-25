# Experiment FS: the mouse FCN trained with SapiMouse's own settings

Pre-registration: `artifacts/phase7/PREREGISTRATION_FS.md` (frozen 2026-10-21 before training). Scripts:
`services/model-api/analysis/phase7/train_fs.py` and `score_fs.py`. Result: `artifacts/phase7/fs_result.json/.txt`.
Network: `artifacts/phase7/fs/fcn_sapimouse_j80`.

## What was compared

Two base-80 networks with the same data, the same 80/20 split by steps, the same scaler (checked equal), the same FCN
and the same seed 101. They differ only in the training recipe:

- **Reference (F2, deployed recipe):** Adam 1e-3, batch 128, at most 40 epochs, early stopping 12, plateau 5.
- **FS (SapiMouse's recipe):** Adam 1e-4, batch 16, 100 epochs, plateau 50, and the weights with the lowest validation
  loss. The best epoch was 18 of 100. Validation loss then rose while training accuracy reached 0.958.

Both went through protocol L stage D's F2 path, unchanged, on the same 19 development users and the same windows.

## Results

| | Reference (F2) | SapiMouse's recipe (FS) | FS minus F2, 95% interval |
|:--|:--:|:--:|:--:|
| Per-user AUC, 60-window decisions (primary) | 0.9688 | 0.9677 | −0.0012 [−0.0162, +0.0155] |
| Per-user AUC, 33-window decisions | 0.9637 | 0.9607 | −0.0030 [−0.0167, +0.0099] |
| Per-user AUC, 15-window decisions | 0.9418 | 0.9407 | −0.0010 [−0.0159, +0.0154] |
| FAR / FRR at the deployed rule (33 of 60) | 10.8% / 10.0% | 9.3% / 10.0% | |
| Live loop: genuine requests per minute | 0.48 | 0.37 | |
| Live loop: users never asked | 74% | 79% | |
| Live loop: impostor runs caught | 96.1% | 97.0% | |
| Live loop: mean time to catch | 18.1 s | 17.8 s | |
| Identification top-1 (base users' 1-min session) | 0.439 | 0.387 | |

The reference row reproduces paper Table 6 (0.969, 10.8%, 10.0%) and the recorded live loop exactly.

## Verdict under the pre-registered rule

**Not shown non-inferior.** The lower bound of the primary difference, −0.0162, is below the −0.010 margin. The point
estimate is a tie (−0.001). The FAR, the genuine requests and the impostor catch rate are slightly better with
SapiMouse's recipe, and identification is lower. With 19 users the interval is about ±0.016 wide, so the test cannot
separate a tie from a loss of 0.016.

Under section 4 the current settings stay, and the paper keeps describing the training settings as this work's own.
Whether to adopt SapiMouse's recipe anyway, to align with the paper the system follows, is the owner's decision. Adopting
it means:
- retraining the deployed 100-user network with SapiMouse's settings;
- rebuilding the cohort, the heads and the thresholds;
- re-measuring every mouse number in the paper and the thesis.

## Notes

- Training took 237 minutes, because it shared the CPU with experiment EC.
- These 19 development users were used before (stage D), so this is a development comparison. No lockbox user was read.
