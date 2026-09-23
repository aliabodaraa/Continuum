# Pre-registration — Experiment G: the extension's on-device personalisation

Written 2026-09-13, **before any Experiment G code had run on data**. Its SHA-256 is recorded in
every Experiment G result, and `repr_device_g_analyze.py` refuses results produced under a
different hash. Protocol items not restated here are those of `PREREGISTRATION_F.md`.

## Why this experiment exists

Experiment F evaluated the pipeline the **server** runs: `model-api` fine-tunes the SapiMouse FCN
after its first conv block, with a binary head, on 330 enrolment windows. The browser extension
keeps every enrolment window on the device, so it has to personalise with TF.js in the page. Its
TF.js build has only the CPU backend, and on that backend the FCN's backward pass costs
0.93 s per window per epoch (`extension/scripts/bench_fcn_cpu.js` → `ondevice_cost.json`: 91.8 s
for one epoch over 99 windows on an i9-14900HX). The server recipe (15 epochs over ~790 training
windows) would take about 3 hours. Full fine-tuning is therefore not an option in the extension.

What the extension can afford is the design Experiment C tested as "M2": the FCN, frozen, as a
feature extractor up to its 128-d `embedding` layer, and a Dense(2, softmax) head trained on the
device. The per-user cost is one forward pass over the enrolment windows plus a few seconds for
the head. Experiment C measured M2 only for architecture B3. For the FCN the accuracy cost of
training only the head is unmeasured, and so is the operating point this head should use. The
extension cannot ship with either unknown.

## Code under test (the code that ships)

* `extension/src/mouse-model.js`: `embed`, `trainHead`, `headScores`, `train`, `load`,
  `scoreWindows`. SHA-256 at registration:
  `d8bb319e94de21cb7abda7fc091d582cbadd5d474882c118d506a84eecf2affa`
* `extension/vendor/tf-lite.js` (TF.js 4.22, CPU backend), `extension/model/mouse-fcn` (the
  production base `artifacts/mouse-fcn-a5` converted to a TF.js layers model).
* Run under Node 20 (V8, the engine Chrome uses) by `extension/scripts/eval_ondevice_g.js`, which
  loads the same bundle as the extension.

Head recipe, fixed here: genuine embeddings are repeated in order until they match the number of
negatives (never truncated); Dense(2, softmax), Glorot-uniform initialisation; Adam (lr 0.002),
categorical cross-entropy, 25 epochs, batch 32, shuffled; no validation split and no early
stopping. These are M2's settings from Experiment C, except that the ±0.006 raw-unit jitter is
dropped: on pixel-magnitude features it is below 0.001 of a standard deviation, so it amounts to
plain duplication.

## Data (identical to Experiment F)

* Targets: the 19 held-out users with ≥ 330 windows in their 3-minute session. Enrolment = the
  first 330 windows. Genuine test = the whole 1-minute session. Impostors = every other held-out
  user's 1-minute session, first 150 windows. Calibration and test halves as in Experiments A–F.
* Negatives: the 660 base-user windows `model-api` draws for a 330-window enrolment
  (`Mouse_A5_W50_base.h5`: 2,000 sampled with seed 13, then 660 with seed 21), so the device and
  the server see the same impostor windows. Their embeddings under the shipped base are bundled
  as `extension/data/mouse-impostors.json`, rounded to 5 decimals, and the experiment trains on
  the rounded values as read back from that file.
* Seeds: 3 (`Math.random` replaced by a seeded generator, seed = 1000 × {101, 102, 103} + target
  index; TF.js draws initialiser seeds and the shuffle order from it). Per-user window metrics
  are averaged over the seeds. The server side is F's single deployed run (seeded as deployed).

## Checks that must pass before the results are used

1. **Embedding parity.** TF.js embeddings of the 660 negatives vs the production Keras model's:
   max |difference| < 1e-3.
2. **Fast path = shipped path.** The heads are trained on embeddings computed once per window,
   because the extractor is frozen. For 2 targets the shipped end-to-end path (`train()` →
   save → `load()` → `scoreWindows()` on raw windows) must reproduce the fast path's scores and
   stored threshold with the same trained head: max |difference| < 1e-5.

If either check fails, all G results are produced with the end-to-end path instead.

## Endpoints

As in F: window level on the test half (per-user AUC, EER, TAR at FAR 1%); decision level with
the Experiment C-3 procedure (per-user threshold = q-th percentile of the user's enrolment scores;
k-of-n vote, mean or median over n ∈ {6, 10, 20}) pooled over (target, seed) calibration halves,
at median calibration false-lock budgets of 1%, 2% and 5%.

## Decision rules

**G-1: the cost of training on the device.** DEVICE − SERVER, paired over the 19 users (bootstrap,
10,000 resamples). If the AUC difference's 95% CI lower bound is ≥ −0.02 (δ = 0.02, as in C) **and**
TAR at FAR 1% is not significantly lower (two-sided p < 0.05), the result is "no measurable cost".
Otherwise the measured cost is reported as the price of keeping enrolment windows on the device.
In that case, offering extension users *opt-in* server training (the SDK's path) is raised with
the project owner as the alternative. That would change the extension's privacy model, so it is
not decided here. Either way the extension ships the on-device model, because full fine-tuning is
infeasible on its backend.

**G-2: the extension's operating point.** DEVICE's operating point at the 1% calibration
false-lock budget; if none meets 1%, the 2% one; then 5% (F's order and rationale). The
extension's `THRESHOLD_Q`, `VOTE_N` and `VOTE_K` in `mouse-model.js` are set to it. That is the
only change allowed to `mouse-model.js` after G, and `RUN_LOG.md` records it.

## Also reported

On-device cost, from `ondevice_cost.json`: seconds to embed 330 windows, seconds to train the head,
milliseconds to score one window, and the full-fine-tuning estimate that rules it out.

## Not tested here

Real browsers and GPUs: all timings are for the CPU backend in V8 on this machine. Throttling of
background tabs (Chrome slows timers in hidden tabs) can stretch on-device training if the user
leaves the enrolment page during training.

## What would change the plan

Nothing in this file changes after Experiment G results exist. Technical failures are re-run with
identical settings and recorded in `RUN_LOG.md`.
