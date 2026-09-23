# Pre-registration — mouse input representation and architecture study

Written 2026-09-12, **before any result of Experiment A or B existed**. The SHA-256 of this
file is recorded inside every result file the study writes, so any later edit to the rules is
detectable. Selection rules below are applied mechanically by `repr_arch_analyze.py`.

## Question

Which per-step input representation (Experiment A) and which network architecture
(Experiment B) should Continuum's mouse channel use, judged on Continuum's own task:
per-user verification with open enrolment, producing a continuous risk signal that can trigger
a passkey challenge.

## Protocol held constant in both experiments

| Item | Setting |
|---|---|
| Dataset | SapiMouse, 120 users |
| Held-out targets | the 20 users in `artifacts/mouse-ws50-aligned/holdout_users.json` |
| Base users | the other 100; never evaluated |
| Event filtering | Continuum's step filter for **every** arm: stream break at idle > 0.5 s, non-click zero-displacement moves dropped, non-positive dt dropped (`preprocess_mouse.events_to_steps`) |
| Segmentation | 50-step windows, stride 10; a window is kept if its normalised path length ≥ 0.08. Window selection is computed once from the raw steps, so **every arm sees exactly the same windows**; only the per-step columns differ |
| Base training | 100-way identification on the base users' 3-minute sessions, temporal 80/20 train/validation; one standardising scaler fitted per arm on its base training windows |
| Enrolment | first 250 windows of the target's 3-minute session, temporal order |
| Genuine test | the target's separate 1-minute session |
| Impostors | each other held-out user's 1-minute session, first 150 windows, one contiguous run per identity |
| Negatives | base-user windows (30 users × 40, seed 21); 500 drawn per target |
| Seeds | 3 (base-training seeds 101, 102, 103) |
| Calibration / test | per target: first half of the genuine stream + even-indexed impostor identities (sorted ids) = calibration; second half + odd-indexed = test. **Every selection is made on calibration; every reported comparison is on test** |

## Experiment A — representation

**Architecture fixed** to the deployed network (Conv1D 32 k2 → GRU 32 → Dropout 0.5 → GRU 32 →
Dropout 0.5 → Flatten → Dense), base-trained as `train_mouse_base_id.py` (40 epochs, batch 128,
early stopping 12, LR plateau 5) and personalised as production does (`api.py`,
base-feature-extractor mode: copy all layers but the head, freeze the Conv1D, Adam 3e-4,
15 epochs, batch 32, early stopping 6 on a contiguous 20% validation tail with a 5-window gap,
exact duplicates removed).

**Arms — each a complete published representation, never merged:**

| Arm | Per-step input | Source |
|---|---|---|
| A1 | dx/1920, dy/1920, log(1+speed), log(1+Δspeed), turn/π, dt, click-or-drag | Continuum (deployed) |
| A2 | dx, dy, vx, vy (px, px/s) | RUMBA-Mouse [35] |
| A3 | dx/dt, dy/dt (px/s) | Antal & Fejér [37] |
| A4 | dx, dy (px) | SapiMouse [2] — its baseline "raw features" |
| A5 | \|dx\|, \|dy\| (px) | SapiMouse [2] — its best variant (Table I) |
| A6 | x/s, y/s, s = the session's largest coordinate (aspect kept) | Chong et al. [16], absolute position |
| A7 | (dx/s)/dt, (dy/s)/dt | Chong et al. [16], speed on screen-normalised coordinates |
| A8 | dx/s, dy/s | Chong et al. [16], position differences on screen-normalised coordinates |

SapiMouse records no screen resolution, so Chong's per-screen normalisation uses the session's
largest coordinate as its proxy (the same proxy Matthiesen et al. use for Balabit). Every speed
uses a 1 ms floor on dt, as A1 already does. Paper-specific event filters and segmentations are
deliberately **not** applied; they are held at Continuum's so that only the representation varies.

**A6 is reported but ineligible for adoption, decided now.** Absolute position encodes where on
the screen the pointer is, not how the person moves it. Chong et al.'s own sensitivity analysis
shows their model exploiting screen resolution and position; Matthiesen et al. remove position
deliberately; SapiMouse participants each used their own computer, so position and resolution
identify the device. Under Continuum's threat model the impostor is on the victim's device and
page, where that information carries no identity.

## Experiment B — architecture

**Representation fixed** to the one Experiment A adopts. Personalisation generalises production's
rule to every architecture: copy all layers except the identification head, add a binary head,
freeze the first learned layer of each input branch, fine-tune the rest (Adam 3e-4, 15 epochs,
batch 32, same validation tail and early stopping).

| Arm | Architecture | Source |
|---|---|---|
| B1 | Conv1D(32,k2) → GRU32 → GRU32 → Flatten | Lu et al. [1] (deployed) |
| B2 | Conv1D(32,k2) → LSTM32 → LSTM32 → Flatten | Lu et al. [1], its LSTM variant |
| B3 | GRU32 → GRU32 → Flatten | ablation of B1: no CNN |
| B4 | LSTM60 → LSTM60 → LSTM60, dropout 0.2 | Chong et al. [16], stacked LSTM |
| B5 | Conv1D(32,k8) → Conv1D(48,k6) → Conv1D(64,k4) → BiLSTM → BiLSTM → sum over time | RUMBA-Mouse [35]; LSTM width unreported, set to 32 |
| B6 | FCN: Conv(128,k8)+BN → Conv(256,k5)+BN → Conv(128,k3)+BN → GAP | SapiMouse [2] |
| B7 | two-tower CNN (MCDCNN) | Antal & Fejér [37] / AFE_Project |
| B8 | two towers: Conv(20,k10,s3)→Conv(60,k10,s2) and Conv(20,k15,s3)→Conv(60,k10,s2), ELU | Chong et al. [16] 1D-CNN, read from its figure |

Chong's CNN-LSTM is excluded: its strided convolutions shrink a 50-step window below its second
kernel, so it cannot run without redesign. B5 and B2 cover the CNN-LSTM family.

## Endpoints

* **Primary:** per-user window-level AUC on the **test** half, averaged over the 3 seeds.
* **Key secondary:** impostor capture at matched decision-level false-lock ≤ 5%. Each arm picks
  its own threshold (q-th percentile of its enrolment scores, q ∈ {1,2,5,10,15,20,30,40,50}) and
  its own rule (k-of-n vote for n ∈ {6,10,20}, mean or median of n) on **calibration**; the
  operating point is reported on test. The deployed 15-of-20 rule has no privileged status.
* **Other secondaries, at that operating point:** EER, TAR at FAR 1%, genuine interruption
  (share of targets whose genuine test stream fires at least once), detection latency (windows
  to the first firing packet in impostor runs, and the share never detected).
* **Cost:** input features per step, per-user model parameters, CPU inference time per 20-window
  check, base identification top-1 (diagnostic only).

Statistics: paired per-user differences, 10,000 bootstrap resamples over users, two-sided
p = 2·min(P(Δ* ≤ 0), P(Δ* ≥ 0)), Holm correction within each named family, α = 0.05.

## Decision rule — Experiment A

1. On **calibration**, rank the eligible published arms (A2, A3, A4, A5, A7, A8) by mean per-user
   AUC; the top one is **P\***.
2. Family FA = {A1 vs each eligible published arm} on the test-half primary endpoint, Holm-corrected.
   **Adopt A1 only if** A1 − P\* > 0 with Holm-adjusted p < 0.05 **and** A1's capture at
   false-lock ≤ 5% is not significantly lower than P\*'s (paired, p < 0.05).
3. Otherwise adopt a published arm: S = eligible published arms whose test AUC is not significantly
   lower than P\* (paired vs P\*, Holm across S). Choose the member of S with the **fewest input
   features**; ties go to the higher calibration AUC.

## Decision rule — Experiment B

1. On **calibration**, the architecture with the highest mean AUC is **A\***.
2. S = architectures not significantly worse than A\* on the test-half primary endpoint **and** not
   significantly worse on capture at false-lock ≤ 5% (paired vs A\*, Holm across the 7 comparisons,
   each endpoint separately).
3. From S choose the architecture with the **fewest per-user model parameters**. If the runner-up
   has at most 10% more parameters, prefer the one with published support in mouse dynamics; if
   still tied, prefer the deployed B1 (no migration).

## What would change the plan

Nothing in this file is changed after results are seen. Any extra analysis is labelled exploratory
in the results and in the thesis. If a run fails for technical reasons it is re-run with the same
settings and the failure is recorded.
