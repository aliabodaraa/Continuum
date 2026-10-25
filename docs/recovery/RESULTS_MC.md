# Experiment MC: how much mouse enrolment the deployed classifier needs (22 Oct 2026)

**Setup.**
- Pre-registration: `artifacts/phase7/PREREGISTRATION_MC.md` (sha 58ca891f, frozen before the code ran).
- Script: `services/model-api/analysis/phase7/run_mc.py`. Result: `artifacts/phase7/mc_result.json` and `.txt`.
- System: paper Table 6's own system, that is the base-80 network trained with SapiMouse's settings, the F2 head and
  the 19 development users. The enrolment is cut to the first M windows of the 3-minute session.
- Validity check: at M = 440 the scores equal the stored FS units exactly (maximum difference 0), so the 8-sample row is
  Table 6.

## Result (60-window decisions, passkey at 33 low, live loop with a check every 6 windows)

| Samples (windows) | Movement | Per-user AUC | FAR | FRR | EER | Prompts per min | Runs caught |
|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 2 (110) | 31 s | 0.947 | 34.6% | 5.0% | 13.3% | 0.19 | 74.5% |
| 3 (165) | 45 s | 0.949 | 24.8% | 6.7% | 13.2% | 0.27 | 84.2% |
| 4 (220) | 60 s | 0.961 | 20.1% | 8.3% | 11.4% | 0.37 | 88.1% |
| 5 (275) | 75 s | 0.959 | 16.3% | 6.7% | 8.7% | 0.30 | 92.2% |
| 6 (330) | 90 s | 0.964 | 12.5% | 8.3% | 8.3% | 0.30 | 94.5% |
| 7 (385) | 105 s | 0.967 | 11.2% | 10.0% | 8.7% | 0.49 | 97.0% |
| **8 (440, live)** | **119 s** | **0.968** | **9.3%** | **10.0%** | **8.7%** | **0.37** | **97.0%** |
| Whole 3-minute session (mean 12.2 samples) | 182 s | 0.964 | 7.3% | 11.7% | 10.3% | 0.59 | 98.6% |

Against the whole session (paired bootstrap over the 19 users, P3's margins):
- 440 is the only budget that meets all three margins. Its AUC is +0.004 [-0.008, +0.018], its prompts upper bound is
  -0.05 and its runs-caught lower bound is -3.0 points.
- Every smaller budget fails on runs caught, with lower bounds of -37.1 to -7.8 points.
- 385 also fails on prompts, with an upper bound of +0.13.
- No budget passes the strict typing-style saturation test (AUC lower bound above -0.005), because the intervals are
  wide at 19 users. The AUC itself is flat from about 220 windows (0.959 to 0.968).

**Pre-registered verdict:** the live enrolment of 8 samples (440 windows, about 2 minutes of movement) is enough.

## Reading

1. **More enrolment mostly buys security, not ranking.**
   - The AUC levels off early.
   - The personal threshold keeps tightening as samples are added, so the impostors accepted fall from 34.6% (2
     samples) to 9.3% (8).
   - Impostor runs caught rise from 74.5% to 97.0%.
2. **Beyond 8 samples the legitimate user pays.** The whole 3-minute session catches 98.6% of impostor runs but asks the
   legitimate user 0.59 times per minute of movement against 0.37. This is the same direction as K2/K3 in September,
   with an older classifier.
3. **The enrolment page supplies the right amount.** What it cannot supply is real-use movement:
   - The page asks for clicks on one dot that jumps to random places in a wide pad, while the user later browses.
   - The owner's real-use windows score lower than his enrolment windows (RESULTS_OWNER_MOUSE.md).

**Stale text found:** thesis Table 11 says "improvement almost stopped after 330 windows (0.856 vs 0.861 at 440)". Those
numbers come from an early pipeline (RUN_LOG, repr_enrol_curve.py, per-window AUC of the old binary head). They should
be replaced with this result.
