# Protocol L, stage C: F2 against S1 on the Bogazici dataset (write-up)

*For the thesis manuscript.*
- **Pre-registration:** `artifacts/repr_arch_study/PREREGISTRATION_L.md`, frozen 24 Sep 2026 (sha 4264a6eb).
- **Amendments:** L-1 (parsing) and L-2 (systems and code), frozen 25 Sep and committed in 81d9b9b before any
  Bogazici score (sha d881649e and 7fde4174).
- **Result:** `artifacts/phase2/L/stageC/stage_C.json` and `.txt`, with the figure `stage_C_roc.png`. Scores are in
  `scores_C.json` (sha f648f560).
- **Code:** `services/model-api/analysis/phase2/`.

## Question

Stage D (19 SapiMouse development users) stopped the metric-learning embedding L at its kill criterion. It
left one confirmatory question for data that no design step had read (Q2):

**Is F2 at least as good as the deployed rule S1?** F2 is the deployed mouse network, frozen, with a
per-user logistic head.

| System | Per-user part | Threshold |
| --- | --- | --- |
| **S1 (REF)**, exactly as deployed | fine-tunes the network's upper layers on each user's 440 enrolment windows | 20th percentile of leave-one-sample-out scores; vote 33 of 60 |
| **F2** | keeps the whole network fixed and fits only a logistic head on its 128-d embedding: 440 enrolment windows vs 880 SapiMouse cohort windows | the same rule, with the 4 windows on each side of the held-out sample purged |

## Design

- **Data.** Bogazici Mouse Dynamics Dataset (Kılıç, Yıldırım & Anarım, *Data in Brief* 36, 107094, 2021;
  CC BY 4.0). 19 users recorded on their own computers over weeks of normal work, not a lab task.
  - **Enrolment:** the first 440 windows of each user's earliest training session, about 2 minutes of
    movement from one day.
  - **Genuine test:** up to 200 distinct sessions from later days (81-200 per user).
  - **Impostors:** up to 200 unauthorised sessions of other users (181-196 per user with at least one
    window), each cut at 150 windows.
  - **Parsing** (Amendment L-1):
    - movement events are coalesced to 60-Hz frames, which gives SapiMouse's 17-ms event rate;
    - the dataset stores each genuine session twice under different names, so a session is identified by
      its first timestamp;
    - every session is its own stream.
  - **Eligibility:** all 19 users were eligible.
- **Endpoint** (as frozen). The primary endpoint is the per-user AUC of 33-window decisions (pct score).
  - **Q2:** F2 − REF, bootstrapped over users (10,000 resamples, seed 17). F2 is non-inferior if the lower
    95% bound is above −0.010.
  - **Key secondary**, tested only after a Q2 success: pooled pct EER of 33-window decisions.
  - Everything else is reported and decides nothing.
- **Run.** One uninterrupted run of 2 h 17 min on the owner's PC (25 Sep, 17:15-19:32 UTC), then one
  analysis.

## Results

| | S1 (REF, deployed) | F2 |
| --- | --- | --- |
| **Per-user AUC, 33-window decisions (primary)** | 0.722 | **0.743** |
| Per-user AUC, 15 / 60 windows | 0.693 / 0.740 | 0.711 / 0.764 |
| **Pooled EER, 33-window decisions (key secondary)** | 40.7% | **32.9%** |
| Pooled AUC, 33 / 60 windows | 0.644 / 0.648 | 0.710 / 0.723 |
| FRR at FAR 5% / 1%, 33 windows | 81.7% / 93.4% | 78.2% / 94.0% |
| Window AUC / EER, mean over users | 0.640 / 39.7% | 0.654 / 38.8% |
| Live loop at each system's own rule: false prompts per minute of movement, mean (median) | 0.84 (0.33) | 0.98 (0.76) |
| Live loop: impostor runs caught, mean (median) | 53.3% (60.0%) | **72.4% (80.6%)** |
| Users never prompted / users with under 50% of runs caught | 4 / 8 of 19 | 0 / 2 of 19 |
| Deployed rule on 17-s decisions: FAR / FRR | 57.0% / 24.3% | 40.0% / 27.8% |

- **Q2: F2 − REF = +0.020 [+0.004, +0.038]**, better for 12 of 19 users.
  - F2 is non-inferior. The whole interval is also above zero; that part is descriptive, because the
    confirmatory claim on this endpoint is non-inferiority.
  - SE 0.009, MDE80 0.024 at n = 19.
- **Key secondary: F2 − REF = −7.8 points of pooled EER [−10.9, −3.2]. F2 is better.**
- **The same direction holds at the other decision lengths:** +0.018 [+0.004, +0.032] at 15 windows and
  +0.024 [+0.005, +0.045] at 60 windows.
- **Per-user AUC at 33 windows spreads widely:**
  - S1 from 0.42 to 0.96, with 2 users below 0.5;
  - F2 from 0.49 to 0.97, with 1 user below 0.5.

## Interpretation

1. **F2 passed its pre-registered external test.**
   - The confirmatory claim is non-inferiority on per-user AUC.
   - Superiority on pooled EER was the pre-registered key secondary, and it also passed.

   Across the two independent datasets:
   - On SapiMouse development users (stage D), F2 tied S1 on per-user AUC (−0.002) and had a lower pooled
     EER (9.1% vs 13.4%).
   - On Bogazici it is better on both measures.

   The frozen network with a linear head is therefore the stronger way to personalise the deployed
   network. It is also cheaper and simpler:
   - it trains in seconds instead of nine network fits;
   - no per-user network is stored;
   - its result does not depend on the order of the enrolment samples, a known weakness of S1 (D4).
2. **Both systems lose most of their accuracy on real, multi-week use. This is the main external-validity
   finding for the mouse channel.**

   | Measure | SapiMouse | Bogazici |
   | --- | --- | --- |
   | Per-user AUC of 10-s decisions (S1, F2) | 0.966, 0.964 | 0.722, 0.743 |
   | S1's live rule: impostor runs caught | 93.8% | 53.3% |
   | S1's live rule: false prompts per minute | 0.37 | 0.84 |

   SapiMouse is one short game recorded on one day. Bogazici enrols on 2 minutes of one working day and
   tests on other days, other applications and other tasks. The earlier single live account pointed the
   same way (29% of windows below threshold in real use vs 1% in enrolment). Bogazici now measures it on
   19 users.
3. **Why F2 transfers better is a hypothesis, not a result.** Fine-tuning convolutional layers on 2 minutes
   of one session can fit that session's habits. A frozen embedding with a linear head has far fewer free
   parameters.
4. **The operating point does not transfer either.** At the same 20th-percentile rule, F2 catches more
   impostor runs than S1 but prompts more often (median 0.76 vs 0.33 per minute). The pooled ROC of F2 lies
   above S1's everywhere, so at an equal prompt rate F2 would catch more. The rule itself, though, was set
   on SapiMouse. In real use both rules prompt far more than their SapiMouse estimates.

   The fixes are more enrolment data across days, and an operating point set on real-world data. That is
   the purpose of the user study (T4). Choosing a new percentile on Bogazici would be tuning on the test
   set, so it was not done.
5. **For the thesis claims:**
   - The mouse channel stays a weak step-up signal behind the passkey, and Bogazici strengthens that
     framing.
   - It is not a standalone authenticator, and in the wild it is weaker than the SapiMouse numbers suggest.
   - The confirmatory design showed which personalisation method generalises better, before any deployment
     decision rested on it.

## Decision

- **F2 adopted.** Section 8 of the pre-registration leaves adoption to the owner, who delegated such calls
  on 25 Sep ("do what improves the solution"). F2 is adopted as the server-side mouse personalisation,
  keeping the tested rule (20th percentile of leave-one-sample-out scores, 33 of 60). Implementation is
  task T3.4 on the board. S1 stays in the record as the rule deployed from 23 to 25 Sep.
- **Disclosed with the adoption:** in the wild, at that rule, F2 prompts more than S1 (mean +0.14/min,
  median +0.43/min) while catching more impostor runs (+19 points mean).

## Disclosures

- **Bogazici is now spent** as a confirmatory set. Any further Bogazici analysis is exploratory.
- **Browser-emulation step.** Bogazici logs operating-system events rather than browser pointer events.
  The 60-Hz coalescing that bridges this was fixed in Amendment L-1 before any score. The mean step
  duration after coalescing (29 ms) is close to SapiMouse's (27 ms).
- **Short enrolment.** Enrolment is 2 minutes from one session, as in production. The test sessions
  (30-100 actions each) come from other days and applications. This matches the deployed enrolment, not a
  best case.
- **Impostor mix.** Most impostor sessions come from the other 18 internal users, in the dataset's own
  proportions. The 5 external users cannot be told apart in the files.
- **No restarts** were needed. The restart files existed only during the run and were removed when
  `scores_C.json` was written.
- **The REF path is unchanged by T3.3.** Every REF model used the deployed negatives file. The
  post-T3.3 `api.py` was shown bit-identical for mouse training before the run.
