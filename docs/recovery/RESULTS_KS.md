# Experiment KS: more impostor typists for Lu's per-user keystroke model (write-up draft)

*For the thesis manuscript. Pre-registration: `artifacts/phase3/PREREGISTRATION_KS.md` (frozen 24 Sep 2026, committed a42b186 before any result). Result: `artifacts/phase3/ks_result.json` and `.txt`. Code: `services/model-api/analysis/phase3/`.*

## Question

Lu et al. (2020) train one binary CNN+RNN per user: the user's own windows against windows from other
people. Continuum follows that recipe unchanged, with negatives from 40 KeyRecs participants. KS asked
whether drawing the negatives from many more different people makes the per-user model better at
rejecting people it has never seen. Everything else is Lu's recipe as deployed:
- the network;
- the features;
- the training settings;
- the number of negative windows (2 × the positive windows);
- the decision rule (a window is "low" below 0.50; a packet of 20 is suspicious when 10 or more are low).

## Design

**Targets and impostors.** All 99 KeyRecs participants (Dias et al., *Data in Brief*, 2023) were
targets:
- temporal 70/30 split with a 5-window gap, as in the frozen baseline;
- impostors: KeyRecs participants 40-79 (first 150 windows each), never used as negatives.

**Arms.** Only the negative pool differs:

| Arm | Negative pool |
| --- | --- |
| REF | KeyRecs participants 0-39 (the baseline) |
| A40 | 40 typists from Aalto 136M Keystrokes (Dhakal et al., CHI 2018) |
| A200 | 200 Aalto typists; contains A40 |
| A1000 | 1,000 Aalto typists; contains A200 |

The Aalto typists were drawn once with a fixed seed: 1,000 kept of 1,473 files read, 15,452 windows,
median 14 windows per typist. They were converted by a port of the live feature code that matched it
exactly on 200 real participants.

**Endpoint.** Per-user AUC of 20-window decisions, scored by the packet's mean probability. This
needs no threshold.
- **Primary:** A1000 − REF, bootstrap over targets (10,000 resamples, seed 17); superiority if the
  lower 95% bound is above 0.
- **Key secondary:** A1000 − A40, tested only after a primary success.

## Results

All 99 targets were eligible in all four arms.

| | REF (KeyRecs 40) | A40 | A200 | A1000 |
| --- | --- | --- | --- | --- |
| Per-user AUC, 20-window decisions (primary scale) | 0.942 | 0.967 | **0.969** | 0.962 |
| Window AUC, mean over users | 0.909 | 0.932 | 0.932 | 0.921 |
| Window EER, mean (median) | 15.2% (13.0%) | 12.9% (11.3%) | 12.9% (11.0%) | 14.2% (12.0%) |
| Users above 20% window EER | 23 | 13 | **12** | 17 |
| Pooled decision EER | 11.2% | 8.5% | **7.8%** | 9.2% |
| FRR at FAR = 5% (decisions) | 35.6% | 21.3% | **16.1%** | 25.8% |
| FRR at FAR = 1% (decisions) | 72.4% | 57.9% | 58.9% | 68.6% |
| Live rule (0.50, ≥ 10 of 20): FAR | 10.3% | 13.8% | 11.9% | 12.9% |
| Live rule: FRR | 15.1% | 2.8% | 3.3% | 3.7% |

- **Primary:** A1000 − REF = **+0.020 [+0.010, +0.031]**, better for 62 of 99 users. **Superiority
  shown.** The MDE80 at n = 99 is 0.015.
- **Key secondary:** A1000 − A40 = −0.005 [−0.009, −0.001], better for 40/99. **Not passed**: 1,000
  typists are slightly *worse* than 40.
- **Reported:** A40 − REF = +0.025 [+0.015, +0.036] (66/99); A200 − REF = +0.027 [+0.017, +0.039]
  (69/99).

## Interpretation

1. **The gain comes from the source of the negatives, not their number.** With the same 40 people,
   Aalto negatives already give almost all of the improvement: +0.025 per-user AUC, pooled EER −2.7
   points, 10 fewer users above 20% EER. Going to 1,000 people does not add to it. The number of
   negative windows is fixed, so with 1,000 people each contributes about half a window per target.
   One untested explanation is that the negatives become too thin per person to shape the boundary
   near the target.
2. **Why Aalto beats KeyRecs' own participants is not established.** Possible reasons are the
   variety of typists, keyboards and texts in Aalto. It is reported as a finding about the negative
   source, not as an explanation.
3. **At the fixed threshold, most of the gain goes to fewer false prompts.** Lu's fixed 0.50 cutoff
   and the 10-of-20 vote convert the improvement mostly into convenience: FRR falls from 15.1% to
   about 3% of decisions, while FAR rises from 10.3% to 12–14%. The threshold-free measures (AUC,
   EER, FRR at a fixed FAR) all improve, so the models are better, not only more lenient.
4. **This supports keeping Lu's method and changing only the data.** The owner's constraint (follow
   Lu; peer-reviewed datasets) is met. Adopting Aalto negatives in production is a separate owner
   decision. Aalto's licence (research use with attribution) should be checked for anything beyond
   the thesis prototype.

## Disclosures

- **KeyRecs was used before** (the frozen baseline and packet-size sweeps), so it is not an untouched
  dataset. Every KS setting was frozen before any KS result existed.
- **Technical restarts.** The single training process grew in memory and slowed down, so it was
  restarted as one process per arm under a memory supervisor. The laptop also slept for about four
  hours on low battery. Each target is seeded on its own (1000 + target, op determinism on), so no
  result depends on where a restart fell. No target, arm or setting was dropped or changed; all
  restarts are in RUN_LOG.
