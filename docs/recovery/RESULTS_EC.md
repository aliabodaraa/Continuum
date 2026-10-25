# Experiment EC: how much typing enrolment is enough (the learning curve)

Pre-registration: `artifacts/phase7/PREREGISTRATION_EC.md` (frozen 2026-10-21 before training). Scripts:
`services/model-api/analysis/phase7/run_ec.py` and `analyze_ec.py`. Result: `artifacts/phase7/ec_result.json/.txt`
(693 trainings, 99 owners, 7 sizes).

## Design in one paragraph

The KS arm A200 protocol, unchanged, with two exceptions:
- the personal model learns from only the first M windows of the owner's enrolment block;
- validation uses the live service's split (the last 20%, gap 5).

Everything else is KS's: the same held-out last 30%, the same impostors (KeyRecs 40 to 79, first 150 windows), the same
Aalto negatives, recipe and seeds. Decisions are step-disjoint blocks of 20 windows, scored by the block mean, as in
paper Table 4.

## Results

| Enrolment windows M | Per-user AUC | FAR | FRR | Pooled EER | Owners below AUC 0.90 | M minus all, 95% interval |
|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 12 (server minimum) | 0.570 | 0.1% | 99.3% | 41.9% | 86.9% | −0.394 [−0.448, −0.342] |
| 26 (one passage) | 0.737 | 1.8% | 87.5% | 30.1% | 69.7% | −0.228 [−0.269, −0.189] |
| 52 | 0.851 | 11.2% | 41.9% | 23.2% | 51.5% | −0.113 [−0.137, −0.091] |
| 78 | 0.873 | 14.6% | 27.6% | 19.0% | 38.4% | −0.091 [−0.114, −0.069] |
| 130 (live enrolment, five passages) | 0.916 | 15.4% | 15.0% | 14.9% | 27.3% | −0.049 [−0.066, −0.035] |
| 208 | 0.938 | 15.2% | 10.1% | 13.0% | 18.2% | −0.027 [−0.035, −0.019] |
| all (mean about 300) | 0.965 | 11.9% | 5.5% | 8.3% | 6.1% | |
| KS A200, paper reference | 0.969 | 11.9% | 3.3% | 7.8% | | all minus KS −0.005 [−0.013, +0.001] |

**Saturation point:** none below "all". The curve still rises at the largest amount of typing KeyRecs gives, so no
saturation point and no optimal enrolment size can be named. More typing kept helping.

## What it means

- **The headline typing numbers are for owners whose models learnt from about 300 windows.** With a live enrolment of
  five passages (130 windows), the per-user AUC is 0.916 and FAR and FRR are about 15%. That is 0.049 lower (95% interval
  0.035 to 0.066) and agrees with AR2's "enrolment only" row (0.9186, FAR 15.0%, FRR 13.5%). The paper already states
  that its models learnt from about 300 windows, and the first row of its retraining table shows a new user.
- **Small enrolments are useless.** At 12 or 26 windows the model rejects the owner in 87% to 99% of decisions. The
  server's minimum of 12 windows only guards against an empty request. The wizard's five passages are what make a model
  usable.
- **Longer enrolment pays.** 208 windows (about eight passages) gives 0.938 and about 300 windows gives 0.965.
- **The live validation split costs about 0.005** compared with KS's own split (all versus KS, interval through zero).

## Options for the owner (nothing changed)

1. Raise the server's minimum from 12 windows to the wizard's size (about 130), so a client cannot train a useless model.
2. Lengthen the enrolment wizard (for example to eight or ten passages, about 210 to 260 windows) for about +0.02 to +0.04
   AUC, at the cost of a longer first enrolment.
3. In the paper, add one sentence or a small table with the curve, as evidence for the "about 300 windows" condition.
