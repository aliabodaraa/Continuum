# Pre-registration — Experiment E: copy SapiMouse's segmentation and verifier, or change them?

Written 2026-09-13, **before any Experiment E code had run on data**. Its SHA-256 is recorded in
every Experiment E result. Protocol items not restated here are those of `PREREGISTRATION.md`.

## Why

The mouse channel is to be founded on SapiMouse (Antal, Fejér & Buza, IEEE SACI 2021): its
dataset, its best input representation (|dx|, |dy|), its FCN feature extractor and its protocol
(feature learner trained on other users; per-user verifier fitted on the 3-minute session; tested
on the 1-minute session against the other users). Continuum departs from it in two places:

* **segmentation:** 50-step windows with stride 10 (Continuum) instead of non-overlapping
  128-event blocks (SapiMouse);
* **verifier:** a fine-tuned network with a supervised binary head that uses other people's data
  as negatives (Continuum) instead of a One-Class SVM on the frozen extractor's features, fitted on
  the target's data only (SapiMouse).

Neither departure has been tested on this pipeline. The blocks-versus-windows evidence so far
compared Antal & Fejér's whole method with ours, confounding segmentation with features and
architecture; the verifier evidence was measured on the retired 7-feature input.

## Rule of the decision, fixed in advance

**Copy the paper unless the change is significantly better.** Alignment with published work is
preferred over small or uncertain gains.

## Design: 2 × 2, everything else fixed

| | verifier OC (SapiMouse) | verifier BIN (Continuum) |
|---|---|---|
| **segmentation K: 128-step blocks (SapiMouse)** | **K-OC** = SapiMouse as published | K-BIN |
| **segmentation W: 50-step windows (Continuum)** | W-OC | W-BIN = current proposal |

* **Fixed:** representation A5 (|dx|, |dy|); FCN (SapiMouse code: Conv 128/k8, 256/k5, 128/k3,
  BatchNorm, ReLU, global average pooling); Continuum's step filter (idle > 0.5 s resets,
  zero-displacement non-clicks dropped, dt ≤ 0 dropped); the 100 base users and the 20 held-out
  users; base training as in Experiments A/B, fitted separately per segmentation; 3 seeds (101–103).
* **K:** consecutive, non-overlapping 128-step chunks of the step stream; no path filter
  (SapiMouse applies none). **W:** 50-step windows, stride 10, kept if normalised path ≥ 0.08.
* **OC:** scikit-learn `OneClassSVM(gamma="scale")`, other settings default (SapiMouse does not
  state its settings; this is what our earlier factorial used), fitted on the frozen base FCN's
  128-d embeddings of the target's enrolment units only. **BIN:** `repr_arch_study.personalise`
  (fine-tune after the first convolution, binary head) with 500 base-user negative units of the
  same segmentation.
* **Enrolment:** the target's **entire** 3-minute session (SapiMouse's protocol), in each arm's
  own units. **Genuine test:** the target's entire 1-minute session. **Impostors:** each other
  held-out user's entire 1-minute session, one contiguous run per identity.

## Matched observation

Arms are compared at the same number of **steps** of session: k blocks = 128·k steps; windows
k_w = round((128·k − 50)/10) + 1, i.e. 9, 22, 34, 47, 60 windows for k = 1…5 blocks (about
3.4–17.2 s at 0.0269 s per step). Scores are averaged within consecutive, non-overlapping groups
of that many units (window groups spaced k_w + 4 apart so no two groups share a step).

## Endpoints

* **Primary:** per user, the AUC averaged over the five matched observation lengths; averaged
  over seeds.
* **Secondary:** AUC and EER at each length, and at 5 blocks (SapiMouse's headline unit).

## Decisions (paired bootstrap over users, 10,000 resamples; Holm across E-1 and E-2)

* **E-1, verifier**, on SapiMouse's segmentation: adopt BIN only if K-BIN − K-OC > 0 with
  Holm-adjusted p < 0.05; otherwise copy OC.
* **E-2, segmentation**, with the verifier chosen by E-1: adopt W only if W − K > 0 with
  Holm-adjusted p < 0.05; otherwise copy K.

W-OC is reported for completeness and decides nothing.

## Afterwards

The enrolment requirement of the adopted configuration is then measured with rule C-1 of
`PREREGISTRATION_C.md` (smallest budget non-inferior to the largest within 0.02 AUC): for W with
the Experiment C protocol and budgets 55/110/220/330/440 windows; for K with budgets matched in
steps: 5/9/17/26/35 blocks.

## What would change the plan

Nothing in this file is changed after Experiment E results exist. Technical failures are re-run
with identical settings and recorded in `RUN_LOG.md`.
