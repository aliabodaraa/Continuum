# Experiment SC: does the base model help the personal typing model? (23 Oct 2026)

**Setup.**
- Pre-registration: `artifacts/phase7/PREREGISTRATION_SC.md`, frozen with its scripts (prereg 179b6bd2, run_sc.py
  52114661, analyze_sc.py 088c9733) before any SC model was trained.
- Result: `artifacts/phase7/sc_result.json` and `.txt`.
- Data: 99 KeyRecs owners, experiment EC's protocol. Only the model differs between the two arms.
- FT: the deployed design. The fine-tuned Buffalo base with a frozen convolution, up to 30 epochs, patience 6. These
  are the stored EC parts.
- SC: the design of [1]. The same architecture with fresh weights, all layers trainable, up to 100 epochs, patience
  10.

## Result (per-user AUC of 20-window decisions)

| Enrolment | FT (base) | SC (scratch) | FT minus SC, 95% interval | FT higher for | Verdict |
|:--|:--:|:--:|:--:|:--:|:--|
| 130 windows (five passages, primary) | 0.9157 | 0.9142 | +0.0015 [-0.0152, +0.0169] | 41 of 99 | no measurable difference |
| All (about 300 windows) | 0.9645 | 0.9708 | -0.0063 [-0.0199, +0.0050] | 41 of 99 | no measurable difference |

| Enrolment | FAR / FRR at the deployed rule, FT | FAR / FRR, SC | Window EER, FT / SC | Epochs run, FT / SC |
|:--|:--:|:--:|:--:|:--:|
| 130 | 15.4% / 15.0% | 16.0% / 13.0% | 19.4% / 18.4% | 27.5 / 54.5 |
| All | 11.9% / 5.5% | 11.4% / 3.8% | 13.3% / 12.2% | 27.8 / 43.9 |

## Reading

1. **Pre-registered verdict: no measurable difference at either size.** The base model does not make the personal
   model more accurate than a network trained from scratch for each user, as in [1].
2. **With all the typing, scratch leans slightly ahead.** It is higher for 58 of 99 owners, and its window EER and FRR
   are lower. The interval still contains 0.
3. **The base's only measured advantage is cost.** It needs about half the training epochs. Training runs in a
   background queue, so the user does not wait either way.
4. **Caveat on the budgets:** FT was capped at 30 epochs, and 71 of 99 owners were still improving there. SC had up to
   100. The comparison is the deployed recipe against [1]'s design with a generous budget. Whether the base helps with
   the same budget is not answered here.

Nothing in the live system or the documents changed because of SC.

## Training time on the same machine (23 Oct 2026, `analysis/phase7/time_sc.py`, artifacts/phase7/sc_timing.*)

Setup: ten owners (every tenth), both models trained one after the other in the same process with 4 threads. The
timing covers model building plus fitting.

| Enrolment | FT (base) | SC (scratch) | SC / FT |
|:--|:--:|:--:|:--:|
| 130 windows | 19.1 s (27.8 epochs, 0.61 s per epoch) | 31.3 s (53.5 epochs, 0.56 s per epoch) | 1.63x |
| All | 37.1 s (27.1 epochs, 1.28 s per epoch) | 56.9 s (41.8 epochs, 1.30 s per epoch) | 1.53x |

- **What the time follows:** one epoch costs the same in both models, so the difference is the number of epochs.
  Freezing the small convolution saves nothing per epoch.
- **What it saves:** about 39% of the training time with five passages, and 35% with all the typing. My earlier "half"
  was the epoch count, not the time.
- **Validity:**
  - FT's epochs equal the stored EC runs for all 20 runs.
  - SC's differ (18 of 20), because in this script the scratch model is built after the FT training has used part of
    the random state, so it starts from different random weights than in the experiment.
  - SC's mean epochs (53.5 and 41.8) still match the experiment's 99-owner means (54.5 and 43.9), so the timing is
    representative.
  - The spread itself (for example owner 90: 100 epochs in the experiment, 30 here) shows how much the training length
    from scratch depends on the random start.
