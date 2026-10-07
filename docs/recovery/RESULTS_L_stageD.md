# Protocol L, stage D: does a metric-learning embedding beat per-user fine-tuning? (write-up draft)

*For the thesis manuscript. Pre-registration: `artifacts/repr_arch_study/PREREGISTRATION_L.md` (frozen 24 Sep 2026, sha 4264a6eb). Results: `artifacts/phase2/L/stage_D.json`, `.txt`, `stage_D_roc.png`. Commits: frozen plan ac346fb; selection f1de567 (written before any development score existed); results 19c57b6.*

## Question

The deployed mouse channel (S1) fine-tunes SapiMouse's FCN for each user. Protocol L asked whether one change could separate users better at the level the system actually decides on. The change: train the same FCN once with a metric-learning objective, freeze it, and give each user only a small logistic classifier on top.

Everything else stayed fixed:
- the input (|dx|, |dy|, 50-step windows);
- the backbone (SapiMouse's FCN);
- the 440-window enrolment;
- the leave-one-sample-out threshold source.

## Design

**Selection, blind to every test user.**
- Four candidates were each trained once on 64 base users: ArcFace (margin 0.20 or 0.35) and supervised contrastive (temperature 0.07 or 0.10).
- They were scored on 16 other base users, and the pre-registered rule picked supervised contrastive at temperature 0.10 (base-val per-user AUC 0.953, versus 0.940–0.945 for the others). Its best epoch was 7.
- It was then retrained on all 80 base users with seeds 101, 102 and 103.

**Stage D.** 19 development users, with a 20th used as an impostor only.
- Enrolment: the first 440 windows of the 3-minute session.
- Genuine test: the whole 1-minute session.
- Impostors: the first 150 windows of every other development user.

**Systems.**
- **REF:** S1 as evaluated in protocol J, averaged over three sample orders.
- **F2:** the existing base network, frozen, with the same logistic head.
- **L:** the new embedding with that head, averaged over three seeds.

**Primary endpoint.** The paired difference in per-user AUC of 9.9-s decisions (33 windows). Each decision is scored by the pct statistic:
- each window's percentile within the user's own out-of-sample scores, averaged over the decision;
- it needs no threshold.

The kill criterion: L goes on to the external test only if the lower 95% bound of L − REF is above 0. The bound comes from a bootstrap over users (10,000 resamples, seed 17).

## Results

| 9.9-s decisions | REF (S1) | F2 | L |
| --- | --- | --- | --- |
| Per-user AUC (primary scale) | 0.966 | 0.964 | 0.957 |
| Pooled EER (pct score) | 13.4% | 9.1% | 11.5% |
| Pooled ROC AUC | 0.921 | 0.941 | 0.937 |
| FRR at FAR = 1% | 59.1% | 51.8% | 43.3% |
| FRR at FAR = 5% | 34.2% | 19.1% | 18.8% |
| Deployed rule (20th pct, 33 of 60): prompts/min | 0.37 | 0.48 | 0.47 |
| Deployed rule: impostor runs caught | 93.8% | 96.1% | 95.9% |

- **Primary:** L − REF = −0.008 [−0.029, +0.011] (better for 6 of 19 users). **The kill criterion was not met, so L does not go on to the external test.** The three seeds agree (−0.009, −0.006, −0.010).
- **F2 − REF:** −0.002 [−0.016, +0.013].
- **L − F2:** −0.006 [−0.020, +0.007].
- **Centroid cosine on L's embedding (reference only):** worse, −0.040 [−0.066, −0.015]. The trained head matters.
- **Reported only:** pooled EER F2 − REF = −4.3 points [−7.5, +1.1]. L − REF = −1.9 points [−6.8, +3.5].

## Interpretation

1. **Within each user, all three systems are equivalent** (per-user AUC about 0.96). The metric-learning objective does not add separability that per-user fine-tuning lacks. The Phase 2 check already pointed the same way: a frozen embedding with a linear head matched fine-tuning.
2. **The pooled numbers favour the frozen network with a head (F2).** Pooled numbers ask whether one scale works for everyone. F2 has a lower EER and fewer false rejects at a 5% false-accept budget. But these were not pre-registered as deciding, and their intervals include zero.
3. **The confirmatory question that remains is Q2:** is F2 non-inferior to S1 (margin −0.010) on the Bogazici dataset, which no design step has read? It is always tested, as the pre-registration requires. F2 would also be simpler to deploy: no per-user network training, a convex head, and no dependence on sample order.
4. **Power.** At n = 19, the primary endpoint's MDE80 is 0.029. A true gain smaller than about 0.03 per-user AUC could not have been detected; the result excludes gains larger than +0.011 (the upper bound).

## Disclosures

- **F2 was re-implemented** in `l_common.py` instead of imported from the exploratory `frozen_check.py`. The differences from that check are `max_iter` 5000 vs 2000, the solver named explicitly, and tau at the 20th percentile instead of the 1st. None affects the primary endpoint.
- **Selection cohort.** Base-val users were scored against a base-train cohort, never against themselves.
- **Epoch count.** "The epoch count of its selection run" was applied as that run's best epoch (7). A final epoch has more steps (80 users, whole sessions).
- **Lockbox 2.** Its users served only as training or selection data (section 2), never as test users. Section 8 says "no step reads the lockboxes"; the code followed section 2.
- **Run quality.** Every step ran once on the frozen code (all code hashes matched `SELECTION_L.json`), with no crashes or re-runs.
