# Pre-registration L — frozen metric-learning embedding vs the deployed per-user FCN (mouse, M1–M3)

**LOCAL INPUT for CLOUD's T2.2, not the draft.** Written by LOCAL before it saw COORDINATION.md; its design (centroid cosine + AS-norm as the system under test) predates CLOUD's frozen_check.py result (F0/F1 worse than A, F2 logistic head matches A) and is superseded by it. Reusable parts: §3.2 selection on base-val before any development read, §5 frozen evaluation, §6 fixed-sequence tests, and the note on why per-user AUC of pct is invariant to per-user normalisation. Original header follows.

**DRAFT, not frozen.** Written 2026-09-23 for the recovery plan's Phase 2, before any Phase 2 code
exists. It becomes binding when the owner approves it and its SHA-256, with those of `SPLIT_J.json`
and `services/model-api/analysis/phase1/eval_decision_level.py`, is written to
`PREREGISTRATION_L.sha256`. No embedding is trained and no development user is scored before that.

## 1. Question and scope

Does one embedding trained once on the base users and then frozen, with centroid-cosine scoring and
cohort score normalisation (plan steps M1–M3), separate genuine from impostor decisions better than
the deployed per-user fine-tuned FCN (S0)?

* **Confirmatory here:** L vs S0 on the 19 development targets (section 6).
* **Not here:** time-aware input (M4), the evidence accumulator (M5), new datasets (M6), the operating
  point, and any deployment. If L succeeds, each gets its own amendment or registration. The fresh-data
  confirmation (M6) is registered separately before its data is read.
* Development results are not final results. SapiMouse's lockboxes (P6, K3) are spent and are **not
  read** by anything in this registration.

## 2. Data (unchanged from `PREREGISTRATION_J.md` §2, `SPLIT_J.json`)

* **Development:** 19 targets + user98 as impostor only, exactly as in P1.
* **Base-80:** the 80 base-training users of SPLIT_J. They alone train the embedding, fit nothing
  else and form the normalisation cohort. For the model selection of §3.2 they are split once, with
  `numpy.random.default_rng(20260923)`, into **base-train (64)** and **base-val (16)**. The draw is
  recorded in `SPLIT_L.json` before any training.
* Lockbox 1 and lockbox 2 users are excluded from every step. (Lockbox 2 users are among base-80;
  they are used here only as base training data, as they already were for S0's base-80 network.)
* Representation, windows and step filter: A5 (|dx|, |dy|), 50 steps, stride 10, as in J §3.

## 3. The system under test (L)

### 3.1 Fixed components
* **Input:** A5 windows standardised with the base-80 scaler (`artifacts/mouse-fcn-a5-j80/scaler.json`),
  the same one S0 uses.
* **Backbone:** the B6 FCN of `train_mouse_fcn.py` up to its global pooling layer, randomly
  initialised, then Dense(128) and L2 normalisation, giving a 128-d embedding.
* **Training data:** each training user's 3-min session. A temporal 80/20 split of each user's
  windows gives early stopping (patience 8 on validation loss, at most 60 epochs), Adam 1e-3.
* **M2 scoring:** enrolment = the first 330 windows of the target's 3-min session (as S0 in P1).
  Centroid = the mean of their embeddings, renormalised. Window score = cosine(embedding, centroid).
* **M3 normalisation (adaptive S-norm):** cohort = one centroid per base-80 user from all windows of
  their 1-min session. For a raw score s between enrolment centroid e and probe window t:
  s' = ½[(s − μ_e)/σ_e + (s − μ_t)/σ_t], where μ, σ are the mean and SD of the top K = 20 cosine
  scores of e (or t) against the cohort centroids.
* **Threshold source (for the pct statistic):** leave-one-sample-out centroid scores. The 330
  enrolment windows are 6 samples of 55. For each sample k, a centroid of the other five, with the
  J §3 boundary purge (4 windows on each side of sample k removed), scores the windows of sample k.
  The same normalisation is applied. The pooled scores are the target's `ref`.

### 3.2 Chosen before any development user is read
Four candidate configurations are each trained once (seed 101) on base-train (64) only:
ArcFace (scale 30) with margin 0.20 or 0.35; supervised contrastive with temperature 0.07 or 0.10
(batches of 32 users × 8 windows). Each is scored on base-val with the development protocol: enrolment
= first 330 windows of the 3-min session; genuine = whole 1-min session; impostors = the other base-val
users' first 150 windows of their 1-min session; cohort = base-train. **The configuration with the
lowest pooled window EER of normalised scores on base-val is selected.** Ties within 0.1 point go to
ArcFace, then to the smaller margin or temperature. The final embedding is then retrained on all
80 base users with the selected configuration, for the number of epochs at which its base-train run
stopped. It is trained **with 3 seeds (101, 102, 103)**. The selection, epoch count and hashes of the
three frozen models are written to `SELECTION_L.json` before development scoring starts.

## 4. The comparator (S0)

S0 = the deployed recipe of P1's Method A at 330 windows (base-80 FCN, per-user fine-tune, contiguous
20% validation tail with gap 5, threshold source = in-sample enrolment scores). Its score streams are
the stored P1 streams (`parts/J_P1/`), 10 training orders per target. They are not recomputed. Its
development numbers are **already known** from Phase 1 (per-user 9.9-s AUC 0.943). That is disclosed
here; L's are not known.

## 5. Evaluation (frozen code: `analysis/phase1/eval_decision_level.py`, unchanged)

* **Genuine:** the target's whole 1-min session. **Impostors:** the same 19 development impostor runs
  per target as the P1 streams (the first 150 windows of each other development user's 1-min session,
  shorter if the session is: user98 gives 126).
* **Decisions:** non-overlapping, step-disjoint blocks of N windows from one contiguous stream, N = 15,
  33, 60 (5.1, 9.9, 17.2 s). **Primary length: N = 33.**
* **Statistic:** `pct` (mean percentile of the block's window scores within the target's `ref`).
  S0: ref = its enrolment scores. L: ref = §3.1 leave-one-sample-out scores.
* **Aggregation:** S0 per target = mean over its 10 training orders. L per target = mean over its
  3 seeds. (L has no order dependence: a centroid ignores order.)

## 6. Hypotheses and tests

Paired bootstrap over the 19 targets, 10,000 resamples, seed 17, 95% percentile intervals
(`p1lib.boot`, as in Phase 1).

1. **Primary.** Δ = mean over targets of [per-user AUC(L) − per-user AUC(S0)], pct statistic, N = 33.
   **L is superior if the lower 95% bound of Δ is > 0.** Phase 1 puts the smallest effect detectable
   with 80% power at 0.011–0.021.
2. **Key secondary (fixed sequence, tested only if 1 succeeds):** pooled EER of 9.9-s decisions, pct
   statistic (cluster bootstrap over users). Superior if the upper 95% bound of L − S0 is < 0.
3. **Reported for every result, deciding nothing:** the same at N = 15 and 60; window-level AUC, EER and
   TAR@FAR 1% (literature comparison); pooled FRR at FAR 1% and 5%; L without normalisation (M1+M2
   only) and L's per-seed results; the per-user distribution, the worst 10% of targets and the known
   weak users (user91, user70, user1, user16); ties at AUC 1.0.

**Why normalisation is judged on the pooled metric:** per-user AUC of `pct` does not change under any
monotone per-user rescaling of the scores. So enrolment-side (Z-) normalisation cannot change the
primary endpoint. Only the probe-side term of S-norm can. M3's purpose (one threshold for everyone,
D5) therefore shows in the key secondary and in the M1+M2-only comparison.

## 7. Decision

* **Primary superior:** Phase 2 continues. M4 (time-aware input) and M5 (accumulator) are
  pre-registered as amendments on the development users. M6 (a dataset never used for design) is the
  single confirmatory test. Nothing is deployed from this registration alone.
* **Primary not superior (kill criterion):** Phase 2 stops. The result is written up as "on
  SapiMouse, a frozen metric-learning embedding does not beat the per-user fine-tuned FCN", and the
  effort goes to Phase 4. This replaces the plan's wording ("decision-level EER") with the primary
  endpoint Phase 1 recommended, because pooled EER cannot detect differences below 5–8 points with
  20 users.

## 8. Rules

* No step reads development data before `SELECTION_L.json` exists. No step reads lockbox data.
* Technical failures are re-run with identical settings and logged in RUN_LOG.md. No arm, seed, user or
  decision is dropped. Changes after freezing are amendments, written before the affected results
  exist, or disclosed deviations with both results.
* Code: `services/model-api/analysis/phase2/` (`train_embedding_l.py`, `score_l.py`, `analyze_l.py`).
  Every result file carries the three hashes. The analysis refuses results produced under other hashes.
