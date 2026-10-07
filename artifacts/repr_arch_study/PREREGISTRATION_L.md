# Pre-registration L: learned embedding + per-user linear head vs per-user fine-tuning (mouse)

**Status: FROZEN 2026-09-24.** The owner delegated the open choices to CLOUD ("choose whatever fits, on
condition that it is peer-reviewed", 23 Sep 18:00 and 24 Sep 00:06). The decisions are recorded in
section 9. `PREREGISTRATION_L.sha256` holds the SHA-256 of this file, together with those of
`SPLIT_J.json`, `SPLIT_L.json` and `analysis/phase1/eval_decision_level.py`. Every result file
carries these hashes, and the analysis refuses results produced under other hashes. This merges CLOUD's
draft with LOCAL's input (`PREREGISTRATION_L.local-input.md`): the selection on held-out base users
(section 4), the seeds, and the fixed-sequence secondary test are LOCAL's. Section 9 lists the owner's
decisions.

## 1. Development evidence so far (exploratory)

* **Phase 1.** At 20 users the prompts/min margin cannot be met (MDE80 0.23/min). The per-user AUC of
  9.9-s decisions can detect 0.011-0.021.
* **Phase 2 check** (19 development users, base-80 network):
  * frozen network + logistic head (F2) matches per-user fine-tuning (A): +0.010 [-0.003, +0.027] per-user
    AUC at 9.9 s;
  * centroid cosine (F0) is worse: -0.041 [-0.077, -0.006];
  * cohort S-norm (F1) recovers about half of that gap.
* So the scoring head is not the bottleneck; the embedding is. F2's objective is convex, so its result
  does not depend on the sample order. Method A's result does, for 19/19 users (P1).
* **A note on normalisation (from LOCAL).** Per-user AUC of the *pct* statistic cannot change under a
  monotone per-user rescaling of the scores. So enrolment-side normalisation cannot move the primary
  endpoint. Its purpose (one threshold for everyone) shows in the pooled metrics.

## 2. Two stages

| Stage | Data | What it decides |
| --- | --- | --- |
| **D (development test)** | 19 SapiMouse development targets (+ user98 as impostor only) | whether L goes on to stage C (kill criterion) |
| **C (confirmatory)** | Bogazici Mouse Dynamics Dataset, never read by any design step | Q1 and Q2 (section 6) |

SapiMouse lockbox 1 is not used at all. Lockbox 2's 20 users belong to the 80 base users, as they did for S0's base-80 network. Here they serve only as training or selection data (base-train or base-val), never as test users. Both lockboxes are spent as test sets.

## 3. Systems

All systems use A5 windows (|dx|, |dy|), 50 steps, stride 10, and the deployed step filter. Within a stage,
all systems share the same enrolment windows, test windows and impostor runs.

* **REF = S1, the recipe deployed since 23 Sep (commit 6ac5cc5).** Per-user fine-tuning of the FCN base
  on the latest 440 windows (8 samples of 55), with leave-one-sample-out threshold scores.
  * Stage D: the stored P3 streams at E = 440 (Method B, base-80). Each target's value is the mean over
    P3's three sample orders.
  * Stage C: S1 as deployed (`api.py` LOSO path, `loso.py`), on the deployed base-100.
* **Budget:** every system in both stages uses 440 enrolment windows, i.e. 8 samples of 55.
* **F2.** The same base network as REF in that stage, frozen:
  * embedding = GAP output, centred on the cohort mean embedding (40 windows from each base user, seed 7),
    then L2-normalised;
  * head = logistic regression (C = 1, lbfgs) on the enrolment windows vs 2 x budget cohort windows
    (seed 21);
  * threshold source = leave-one-sample-out scores over the enrolment samples of 55 windows, with the
    4 windows on each side of the held-out sample purged.
* **L.** An FCN backbone (B6 up to GAP) + Dense(128) + L2 normalisation, trained with the metric objective
  selected in section 4, then frozen. The head and threshold source are as in F2. It is trained with
  3 seeds (101, 102, 103), and each target's value is the mean over seeds. "L with centroid cosine" is
  reported alongside for reference.

## 4. Choosing L without reading any test user (from LOCAL)

* **Split.** Base-val = 16 users drawn with `default_rng(20260923)` from the 60 base users eligible by
  counts alone (at least 440 windows in the 3-min session and at least 150 in the 1-min session).
  Base-train = the other 64 base users. The draw is in `SPLIT_L.json`, made before any training.
* **Candidates.** Four configurations, each trained once (seed 101) on base-train only:
  * ArcFace, scale 30, margin 0.20 or 0.35;
  * supervised contrastive, temperature 0.07 or 0.10, batches of 32 users x 8 windows.
  * Common settings: temporal 80/20 split per user for early stopping (patience 8, at most 60 epochs),
    Adam 1e-3.
* **Selection.** Each candidate is scored on base-val with the stage-D protocol: 440-window enrolment,
  genuine = the whole 1-min session, impostors = the other base-val users' first 150 windows, F2-style
  head. The highest mean per-user AUC of 9.9-s decisions wins. Ties within 0.002 go to ArcFace, then to
  the smaller margin or temperature.
* **Final training.** The selected configuration is retrained on all 80 base users (stage D) with the
  3 seeds, for the epoch count of its selection run. The configuration, epochs and model hashes go to
  `SELECTION_L.json` **before any development user is scored**.
* **Stage C.** The same configuration is retrained on the 100 base users of the deployed network.
  Their hashes go to Amendment L-2 before any Bogazici score exists.

## 5. Stage C data: the Bogazici Mouse Dynamics Dataset

* **Source:** Kılıç, Yıldırım & Anarım, *Data in Brief* 36, 107094 (2021), a peer-reviewed data article
  (doi:10.1016/j.dib.2021.107094; data doi:10.17632/w6cxr8yc7p.2), CC BY 4.0. 24 users on their own
  computers (19 training users + 5 external). Chosen under the owner's rule "any peer-reviewed dataset"
  (23 Sep).
* **Fallback:** if Bogazici cannot be parsed into A5 windows, the fallback is Chao Shen's mouse dataset
  (28 users). Amendment L-1, written before any of its scores is read, must confirm its peer-reviewed
  source.
* **Per eligible user:**
  * enrolment = the first `budget` windows of their training sessions, in time order;
  * genuine test = their test sessions from later days;
  * impostor runs = the first 150 windows of each other user's test data (the 5 external users serve as
    impostors only).
  * Decisions never straddle two sessions.
* **Eligibility** is decided from window counts only: at least `budget` enrolment windows and at least
  33 test windows. Excluded users are listed.
* **Amendment L-1**, written before any Bogazici score exists, fixes the parsing: field mapping, session
  boundaries, the time unit of the step filter, and the eligibility counts. It may not change a system,
  an endpoint or a margin.

## 6. Endpoints and decisions

* **Primary endpoint (both stages).** Mean over targets of the paired difference in per-user AUC of
  9.9-s decisions (N = 33, *pct* statistic, step-disjoint blocks, `eval_decision_level.py` unchanged),
  with a bootstrap over targets (10,000 resamples, seed 17).
* **Stage D (kill criterion).** L - REF: L goes to stage C only if the lower 95% bound is > 0. Stage D
  also reports F2 - REF and L - F2.
* **Stage C, confirmatory family (Holm):**
  * **Q1:** L - REF is superior if the adjusted lower 95% bound is > 0. Only tested if stage D passed.
  * **Q2:** F2 - REF is non-inferior if the adjusted lower 95% bound is > -0.010. Always tested.
* **Key secondary (fixed sequence; only after a success on Q1 or Q2):** the same system is better on
  pooled EER of 9.9-s decisions (pct) if the upper 95% bound of the difference is < 0.
* **Reported, deciding nothing:** N = 15 and 60; window AUC, EER and TAR@FAR 1%; pooled FRR at FAR 1% and
  5%; L per seed; per-user values, the worst 10% of targets, and the known weak development users
  (user91, user70, user1, user16); ties at AUC 1.0; prompts/min and runs caught at each system's own
  operating point.
* **Power.** At n = 19-20 the primary endpoint's MDE80 is 0.011-0.021 (Phase 1). It is recomputed for
  the eligible Bogazici n and reported.

## 7. Code

`services/model-api/analysis/phase2/`: `train_embedding_l.py`, `score_l.py`, `analyze_l.py`, reusing
`frozen_check.py` and the Phase 1 modules. Heavy training may run on the owner's PC (task T2.3). Results go
to `artifacts/phase2/`.

## 8. Conduct

* **Order of work.** No step reads development data before `SELECTION_L.json` exists. No step reads
  Bogazici scores before L-1 and L-2 exist. No step reads the lockboxes.
* **Failures.** Technical failures are re-run with identical settings and logged in RUN_LOG.md.
* **Changes.** No arm, seed, user or decision is dropped. Changes after freezing are amendments written
  before the affected results exist, or disclosed deviations that show both results.
* **Outcomes.** A "no" is reported as fully as a "yes". Adopting F2 or L in production is a separate,
  stated owner decision.

## 9. Decisions (made under the owner's delegation, 24 Sep)

1. **Stage C dataset: Bogazici.** The owner's rule was "any peer-reviewed dataset"; Bogazici was
   published in *Data in Brief* (2021). It is downloaded (T2.4) but not analysed before the amendments exist.
2. **The Q2 margin: -0.010 AUC.** This is CLOUD's proposal, adopted under the delegation: about the
   smallest difference these samples resolve.
3. **REF = S1.** It was adopted in Phase 0 on 23 Sep (section 3).
