# Verified literature evidence for the mouse representation / architecture study

Every entry below was read in the original PDF (`continuum/pdfs/Mouse Dynamics/`) or the
publisher's full text, not in an abstract or a converted copy. "Transfers" says what the evidence
can and cannot tell Continuum. Continuum's task: continuous, per-user verification with open
enrolment; impostors are people the model never saw; free browsing behaviour; decisions every
~0.27 s over a sustained vote.

## Chong, Elovici & Binder (2020) — IEEE TIFS 15:1086–1101 [16]
* **Task:** *static* authentication; one binary classifier per user trained against all other
  users' samples, so impostors are seen in training (Sec. III).
* **Data:** Balabit (10 users; official train/test sessions) and TWOS (20 of 24 users; five-fold
  cross-validation). Sequences come from a 1.0 s time-difference split with a minimum length of one
  screen width; 1D-CNN/LSTM/CNN-LSTM get fixed 130-event sequences. **Mean sequence duration is 18 s
  (Balabit) and 26 s (TWOS)** (Fig. 8 caption).
* **Representations** (Sec. VI-A): absolute (x, y) or speed (dx/dt, dy/dt) or position differences
  (dx, dy), on coordinates normalised to [0,1]×[0,α] + padding/2 (aspect ratio kept; screen
  resolution retained). **Table II: speed beats position differences** for the 1D-CNN and LSTM on
  both datasets (e.g. 1D-CNN Balabit AUC 0.904 vs 0.811; TWOS 0.828 vs 0.701). Table V:
  normalisation choice changes the 1D-CNN (dx, dy) result substantially, and in opposite directions
  on the two datasets.
* **Architectures** (Sec. IV): 1D-CNN = two first-layer convolutions (20 filters, k10/s3 and
  k15/s3, ELU) → one shared second convolution (60, k10, s2) → global max-pool → dropout 0.3 → FC.
  LSTM = 2 layers × 10 units, dropout 0.3. CNN-LSTM variant 1 = the two first-layer convolutions →
  shared 3 × LSTM60 (dropout 0.2) → concat → dropout 0.2 → FC; variant 2 stacks the convolutions
  and is worse. 2D-CNN = GoogLeNet on trajectory images, jointly trained multi-label.
* **Results, sequence-based, legal sessions** (Table IV): Balabit — SVM 0.85/0.22,
  LSTM 0.83/0.18, CNN-LSTM 0.90/0.13, 1D-CNN 0.90/0.12, 2D-CNN 0.96/0.10 (AUC/EER).
  TWOS — 0.83/0.23, 0.75/0.30, 0.85/0.22, 0.83/0.24, 0.93/0.13. Averages over users, no
  significance tests.
* **Confounds the authors measured themselves:** screen occupancy alone (16-region histogram)
  reaches AUC 0.85 on Balabit (Table VI); the 2D-CNN falls from 0.958 to 0.467 when resolution
  information is removed at test time (Table VII).
* **Their limitations** (Sec. X): device dependency untested; datasets are task-specific, so
  models may learn (user, task) pairs rather than long-term traits.
* **Transfers:** the idea that architectures must be *compared by measurement*; speed as a
  published input with within-paper evidence over position differences; aggregation of many
  sequences drives error down (15 sequences: FAR 0.342 → 0.059 at FRR 0.001). **Does not
  transfer:** its numbers (static task, closed-set impostors, 18–26 s per decision, 10–20 users).

## Antal, Fejér & Buza (2021) — SapiMouse, IEEE SACI [2]
* **Data:** 120 users, own computers and browsers, varied DPI, some touchpads; a structured game
  (click, right-click, double-click, drag-and-drop on shapes); a 3-min then a 1-min session.
* **Preprocessing:** (t, x, y) only; first differences; drop steps with dt > μ+σ per file;
  128-event blocks.
* **Representations** (Table I, 48 test users): (dx, dy) 0.87/0.18, (|dx|, |dy|) 0.88/0.17,
  (dx/dt, dy/dt) 0.84/0.19, (|dx/dt|, |dy/dt|) 0.86/0.18. Distance inputs slightly above speed;
  no significance tests.
* **Architecture/personalisation:** FCN (last block 128 filters, GAP) trained for identification
  on users 1–72; per-user One-Class SVM on the target's 3-min session; test = target 1-min session
  vs the other 47 users' 1-min sessions; pooled ROC. AUC 0.88 at one block → 0.95 at five.
* **Transfers:** same corpus and a closely matched protocol, so its representation ranking is the
  most directly relevant published evidence. **Caveat:** on SapiMouse each user is also a device, so
  every representation can partly identify the machine.

## Fu, Qin, Qiao & Amariucai (2020) — RUMBA-Mouse, IEEE CNS [35]
* **Task:** *static* authentication: 8 click-bounded movements toward fixed targets; one model per
  movement type, scores averaged; 15 users × 300 trials; random 80/20 trial split; all users'
  data in training (closed-set).
* **Input:** q_i = (dx_i, dy_i, vx_i, vy_i), vx_i = (x_i − x_{i−1})/(t_i − t_{i−1}) (Eq. 3).
* **Architecture:** Conv1D 32/k8 → 48/k6 → 64/k4 → 2 × BiLSTM (width not reported) → sum over
  time → FC; Adam 1e-3, batch 10, ≤ 100 epochs.
* **Results** (Table III): CNN-RNN EER 3.16% / AUC 0.994 at 8 movements (6.11 s);
  RNN-only EER 30.45% — the convolutional front end is what made the recurrent model work.
* **Transfers:** within its setting, a CNN front end before recurrent layers is essential.
  **Does not transfer:** the numbers (static, closed-set, 15 users).

## Antal & Fejér (2020) — Acta Univ. Sapientiae Informatica 12(1):39–50 [37]
* **Input:** directional velocities (dx/dt, dy/dt) over 128-event blocks; sequences split at a
  2 s gap; Balabit (10 users) for evaluation, DFL (21 users) for transfer.
* **Architecture:** two-tower 1D-CNN (released as AFE_Project `cnnModel.py`); per-user binary
  models; PLAIN / TRANSFER1 / TRANSFER2. Paper text: 16 epochs; code: 160, plus callbacks and a
  best-training-loss checkpoint.
* **Transfers:** a peer-reviewed, open-source mouse method; our reference arm.

## Matthiesen, Hastedt & Brefeld (2023) — IDA, Springer LNCS [38]
* **Input:** image "views" of the trajectory, deliberately rescaled to remove on-screen position,
  plus speed (log-normalised), pause and click views; AlexNet feature map; one-class compactness
  objective with outlier exposure (TWOS); per-user models on Balabit; impostors never seen.
* **Results** (Tables 1–2): adding click and pause views raises AUC (log-speed + pause 0.710 →
  + click 0.777); mean AUC 0.777 / EER 0.240 with outlier exposure, 0.634 without.
* **Transfers:** published support that timing, click and log-speed carry identity, and that
  screen position should be removed.

## Asgarov (2026) — Problems of Information Technology 17(2):13–27
* **Input:** 64-event windows; fixed-length features — path signatures, differential geometry,
  optimal-control residuals, and a 142-feature kinematic bank from earlier literature.
* **Classifier/protocol:** per-user one-class Mahalanobis; SapiMouse (30 users) and Balabit;
  bootstrap CIs and Wilcoxon tests.
* **Results** (Table 2): SapiMouse — kinematic bank 0.798/0.202 best; path signatures 0.538/0.462.
* **Transfers:** representation rankings do not carry across session regimes; broad kinematics held
  up on SapiMouse's short sessions.

## Khan, Devlen, Manno & Hou (2024) — ACM Computing Surveys 56 (read via arXiv 2208.09061 v2)
* "The best performing classifier varied by data collection type as well as the features extracted
  from the raw data. Unfortunately, benchmarking studies based on common datasets do not exist."
  (Sec. 6.2)
* Cites error rates rising when enrolment and verification data come from different devices.

## Not used as design sources
* **Tao et al. (2026)**, sLSTM-MixConv + isolation forest: the available copy is marked on every
  page "This preprint research paper has not been peer reviewed" (SSRN 6193851).
* **Dave et al. (2024), arXiv 2403.03828:** preprint.
* **Siddiqui et al. (2022), MAKE 4(2):** peer-reviewed, but its protocol (top-10 users, accuracy)
  cannot inform per-user verification with open enrolment.
