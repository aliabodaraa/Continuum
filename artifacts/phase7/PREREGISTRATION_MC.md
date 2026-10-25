# Pre-registration MC: how much mouse enrolment the deployed classifier needs (22 Oct 2026)

Written and hashed before any MC code ran. Owner, 22 Oct 2026: "can you try the mouse sample-entry interface and judge
whether it is enough to train the model ... we want to show why we chose a certain number of training samples for the
mouse and for typing".

## Question

Is the live enrolment of 8 samples of 55 windows (440 windows, about 2 minutes of movement) enough for the deployed
classifier, the F2 logistic head on the network trained with SapiMouse's settings? Protocol J's P3 (September 2026)
chose 440 for an earlier classifier and network. Protocol K's K2 and K3 found that the whole 3-minute session improved
that model's AUC (+0.018) without fewer prompts. Neither was run on the current system.

## Data and system (paper Table 6 and experiment FS, unchanged)

- **Network:** the base-80 FCN trained with SapiMouse's settings (`artifacts/phase7/fs/fcn_sapimouse_j80`), the
  reference scaler, and a cohort of the 80 base users (40 windows each), all as in `score_fs.py`.
- **Users:** the 19 development targets of Table 6.
  - Genuine: the whole 1-minute session.
  - Impostors: the first 150 windows of every other development user's 1-minute session.
- **Personal model:** `l_common.head_scores`.
  - A logistic head against 2 x M cohort windows.
  - Leave-one-sample-out reference scores over the M / 55 samples, with 4 windows purged on each side.
  - The threshold is the 20th percentile of the reference scores.
- **Decision:** 60 windows, with the passkey at 33 or more low.
- **Live loop:** `mouse_live_decision_length.live`, with a check every 6 windows and the buffer emptied after a prompt.
- **Validity check:** at M = 440 the scores must equal the stored FS units (`artifacts/phase7/fs/scores_FS.json`), the
  source of Table 6.

## Budgets

The first M windows of the 3-minute session:
- M = 110, 165, 220, 275, 330, 385 and 440, which is 2 to 8 samples;
- FULL, the whole 3-minute session rounded down to whole samples of 55. This is SapiMouse's own enrolment length.

## Endpoints (per user)

1. Per-user AUC of 60-window decisions (primary, as in Table 6).
2. Genuine prompts per minute of movement (live loop).
3. Share of impostor runs caught (live loop).

Also reported: FAR and FRR at the deployed rule, and the pooled EER.

## Reading rule

- **Comparison:** each budget M against FULL, as a paired difference over the 19 users. Bootstrap of 10,000 resamples,
  seed 17, 95% interval.
- **"Enough"** is the smallest M that meets all three of P3's margins, unchanged:
  - AUC lower bound >= -0.02;
  - runs-caught lower bound >= -5 points;
  - prompts-per-minute upper bound <= +0.1.
- **440** is called enough if it meets the three margins against FULL. If no M below FULL meets them, the curve is
  reported and the live enrolment is called short of SapiMouse's session.
- **Secondary, as typing EC:** saturation is the smallest M whose AUC lower bound against FULL is above -0.005.

Nothing in the live system changes because of this experiment without the owner's decision.
