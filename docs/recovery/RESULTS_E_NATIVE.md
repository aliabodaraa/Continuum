# Windows against SapiMouse's blocks, with the block network trained as SapiMouse trains it (sensitivity check, 2026-10-20)

Asked by the owner on 2026-10-20, before a supervisor meeting: can we show that 50-step windows are better than
SapiMouse's 128-event blocks for Continuum? Script `services/model-api/analysis/phase6/e_native_blocks.py`, results
`artifacts/phase6/e_native_result.json` and `.txt`, one JSON per seed under `artifacts/phase6/e_native/`. Not
pre-registered: it is a sensitivity check of one protocol choice in experiment E, and it is reported as such. The
reading rule below was fixed in the script before any result existed.

## Why it was needed

Experiment E (`artifacts/repr_arch_study/PREREGISTRATION_E.md`, f410e4b0) adopted the windows because they beat
the blocks by +0.103 per-user AUC with SapiMouse's one-class SVM (Holm p 0.0004). Both segmentations had trained
their base FCN with the windows recipe (`repr_arch_study.train_base`: Adam 1e-3, batch 128, early stopping after 12
epochs without a lower validation loss, best weights restored). On the 4,351 training blocks the validation loss was
lowest after the first epoch in all three seeds, so training stopped at epoch 13 and E's block arms used the
epoch-1 network. Its identification accuracy on the validation blocks was 2.8%, 2.6% and 3.9% (chance 1.0%), against
28 to 39 training epochs for the window network. E-2 was therefore confounded with a training failure.

## What was run

E's block part line for line (`repr_arch_segm.main` with seg = K) with ONE change: the block network is trained with
SapiMouse's recipe (github.com/margitantal68/sapimouse, as transcribed in `sapimouse_oneclass_sweep.py`): Adam 1e-4,
batch 16, 100 epochs, ReduceLROnPlateau on the validation loss (factor 0.5, patience 50), and the weights with the
lowest validation loss kept. Everything else is E's: the 100 base users and their per-user 80/20 temporal split, the
scaler, the seeds (101 to 103), the 20 held-out targets, enrolment on the whole 3-minute session, genuine test on the
whole 1-minute session, the other held-out users' 1-minute sessions as impostor runs, the one-class SVM (K-OC) and the
fine-tuned binary head with 500 base-user negatives (K-BIN). Every target's blocks were checked against E's stored
counts before scoring. The window arms were not re-run: E's stored W-OC and W-BIN scores are used. Endpoint as in E:
per-user AUC at five matched lengths (1 to 5 blocks = 9, 22, 34, 47, 60 windows), averaged over the lengths and then
over seeds; paired bootstrap over users (10,000 resamples). About 25 minutes in a separate container of the
model-api image (TF 2.15.0), 12 CPUs, 6 GB; the live cluster was not touched.

**Reading rule (fixed before the run).** Primary = W-OC minus K-OC with the block network trained as SapiMouse
trains it. Windows better if > 0 with p < 0.05, blocks better if < 0 with p < 0.05, otherwise a tie.

## Result

Block network after SapiMouse's training: identification accuracy 56.7%, 58.3% and 56.0% on the validation blocks
(best epoch 100, 92 and 93 of 100).

| Arm (20 users, 3 seeds) | Primary AUC | 1 block / 9 windows | 5 blocks / 60 windows | EER at 5 blocks |
| --- | --- | --- | --- | --- |
| K-OC, E's untrained block network | 0.796 | 0.760 | 0.812 | 23.2% |
| K-OC, block network trained as SapiMouse | 0.915 | 0.880 | 0.933 | 9.9% |
| W-OC (E) | 0.900 | 0.870 | 0.919 | 13.0% |
| K-BIN, E's untrained block network | 0.818 | 0.785 | 0.834 | 20.8% |
| K-BIN, block network trained as SapiMouse | 0.918 | 0.887 | 0.924 | 10.3% |
| W-BIN (E) | 0.952 | 0.923 | 0.966 | 5.2% |

* **Primary, W-OC minus K-OC (SapiMouse training): -0.015 [-0.041, +0.012], p 0.25, windows higher for 10 of 20
  users: a TIE.** At every length the blocks were slightly ahead (-0.010 to -0.023), none significantly.
* Secondary, W-BIN minus K-BIN (SapiMouse training): +0.035 [+0.001, +0.076], p 0.044, windows higher for 16 of 20.
  This is one secondary comparison without correction (with Holm over the two it would be p 0.089).
* Training effect on the blocks, K-OC SapiMouse training minus K-OC E: +0.118 [+0.066, +0.176], 19 of 20 users.

## SapiMouse's code on its own split

The 4 Sep 2026 run of SapiMouse's code (`artifacts/sapimouse-fcn/oneclass.json`) kept no scores, so it was re-run
with the same script, which has kept the scores since the evening of that day
(`sapimouse_oneclass_sweep.py --out artifacts/phase6/sapimouse_rerun/oneclass.json`), to compute the pooled ROC the
paper reports. Users 1 to 72 train the FCN, 73 to 120 are evaluated, enrolment on the 3-minute session, test
on the 1-minute session against the other 47 users. One deviation from the released code: the training blocks are
shuffled before Keras takes its 15% validation share; the 4 Sep run without the shuffle gave the same per-user AUCs.

| Blocks | Pooled AUC (re-run) | Published [Fig. 8] | Pooled EER | Per-user mean AUC (re-run / 4 Sep) |
| --- | --- | --- | --- | --- |
| 1 | 0.929 | 0.88 | 14.5% | 0.925 / 0.928 |
| 2 | 0.953 | 0.92 | 12.3% | 0.950 / 0.952 |
| 3 | 0.962 | 0.94 | 10.5% | 0.959 / 0.961 |
| 4 | 0.967 | 0.94 | 9.3% | 0.964 / 0.967 |
| 5 | 0.971 | 0.95 | 9.0% | 0.968 / 0.970 |

Their method in our hands is at least as good as published, so the comparison above does not rest on a weakened
implementation.

## Reading

E's +0.103 does not survive: it came from a block network kept at its first-epoch weights. Trained as SapiMouse
trains it, the blocks equal the windows with SapiMouse's one-class classifier. With a classifier trained against
other people's movement the windows were ahead (+0.035, secondary). The windows stay in the deployed channel for
practical reasons: a new score every ten steps instead of every 128, and about thirteen times more training units
from the same enrolment (617 windows against 48 blocks for user1), at no measurable loss of AUC. E's pre-registered
record is unchanged; this check is reported next to it. Paper and thesis wording: pending the owner's approval.

## The SapiMouse channel at the passkey decision (20 Oct 2026, later the same evening)

After the tie above, the owner decided to follow SapiMouse "unless it causes a problem for monitoring and the passkey
request". `services/model-api/analysis/phase6/sapimouse_channel.py` measured exactly that. The channel is SapiMouse
unchanged: blocks of 128, the FCN trained with SapiMouse's recipe (the three networks are stored under
`artifacts/phase6/sapimouse_channel/base_s*`), and a one-class SVM per user on the whole 3-minute session (53.6 blocks
on average). One addition was fixed before the run and carried over from the window channel: a personal threshold at
the 20th percentile of out-of-sample enrolment block scores (eight contiguous parts, each scored by an SVM fitted
without it). The passkey is requested when the mean of five consecutive blocks (about 17 s) falls below it. The
evaluation used the same 20 users, sessions and impostors as above, with disjoint five-block decisions and 3 seeds.

| | FAR | FRR |
| --- | --- | --- |
| SapiMouse channel, threshold at the 20th percentile (fixed before the run) | 4.1% | 40.3% |
| the same, 10th percentile (diagnostic) | 12.3% | 19.4% |
| the same, 5th percentile (diagnostic) | 18.9% | 14.0% |
| Deployed window channel, paper Table 6 (19 users, 440-window enrolment, 33 of 60) | 10.8% | 10.0% |

Pooled over 186 genuine and 3,534 impostor decisions. The mean over users at the 20th percentile is FAR 4.1% and FRR
44.2%. The per-user AUC and EER are unchanged from above: 0.880 and 18.9% for one block, 0.933 and 9.9% for five. The
EER uses each user's best threshold, which a live system does not know. Computation alone took 0.08 s to train a user
and 57 ms for one check.

**Reading.** The ranking is good, but a threshold set from the user's own enrolment session does not carry over to
the next session. The one-class SVM's scores fall in the new session, so the genuine user would be asked for the
passkey in about 40% of decisions. No percentile reaches the deployed window channel's balance. The two evaluations
differ in users (20 against 19), enrolment (3 minutes against about 2) and seeds, and the blocks had the larger
enrolment. A likely reason is that the one-class SVM scores only against the user's own data, while the logistic head
is anchored by a fixed cohort of other people. This was not tested directly. The paper and thesis are unchanged. The
wording for "SapiMouse only" is prepared in the session scratchpad (`sapimouse_paper.py`, `sapimouse_thesis.py`,
figures) in case the owner still chooses it.

## A fixed 50% threshold, as in Lu et al., with the blocks (20 Oct 2026, night)

Owner: "fix the threshold at 50% like Lu and keep the blocks". Same 20 users, 3 seeds, decisions of about 17 s, pooled
(`analysis/phase6/fixed_threshold.py` on the stored scores, `blocks_lu_threshold.py` for the balanced head; results in
`artifacts/phase6/fixed_threshold_result.*` and `blocks_lu_result.*`):

| Blocks or windows, classifier, fixed threshold | Vote: FAR / FRR | Mean: FAR / FRR |
| --- | --- | --- |
| Blocks, one-class SVM, its own boundary (0; with nu = 0.5 about half the training blocks fall outside) | 0.1% / 78.5% | 0.0% / 83.9% |
| Blocks, binary head with 500 negatives, 0.50 | 1.7% / 56.5% | 1.6% / 57.5% |
| Blocks, binary head with as many negatives as positives (Lu), 0.50 | 22.8% / 35.5% | 22.6% / 37.1% |
| Windows, binary head (E's W-BIN), 0.50, 30 of 60 | 8.7% / 13.4% | 8.8% / 14.0% |

The vote rule is at least 3 of 5 blocks, or 30 of 60 windows, below the threshold. With the balanced head the per-user
AUC fell to 0.827 for one block and 0.865 for five, because 50 negatives teach it less than 500. **A fixed threshold
does not work with the blocks for any classifier tried.** Three minutes of movement give each user about 50 blocks,
against about 600 windows. With so few units the classifier is either biased (500 negatives) or weak (50 negatives).
With the windows the same fixed 0.50 works (8.7% / 13.4%), close to the deployed personal threshold (10.8% / 10.0%).
That variant uses the fine-tuned head and a 3-minute enrolment, not the deployed frozen head with 440 windows. It was
not tested on the deployed head.

## Lu's fixed 0.50 on the deployed mouse head (20 Oct 2026, night)

Owner: "test this check now". `analysis/phase6/f2_fixed_threshold.py` used protocol L stage D's stored F2 scores. That
is the deployed head type, a frozen network with a logistic head against the cohort, on 19 development users with
the base-80 network and a 440-window enrolment, the source of the paper's Table 6. Only the threshold was changed.
Step-disjoint 60-window decisions (17.2 s) are pooled, and the live loop is that of analyze_l.

| Rule | FAR | FRR | Live loop: genuine prompts per minute of movement / users never prompted / impostor runs caught |
| --- | --- | --- | --- |
| Personal threshold, 20th percentile, 33 of 60 (deployed, reproduces Table 6) | 10.8% | 10.0% | 0.48 / 73.7% / 96.1% |
| Fixed 0.50, 30 of 60 (Lu) | 1.2% | 36.7% | 1.53 / 36.8% / 99.7% |
| Fixed 0.50, 33 of 60 | 2.8% | 30.0% | 1.42 / 36.8% / 99.4% |

The personal thresholds run from 0.207 to 0.741 (mean 0.429). Mouse scores differ so much between people that one
fixed threshold rejects the users whose normal scores sit below 0.50. The head is also trained against twice as many
cohort windows as the user's own, which lowers its probabilities. A fixed 0.50 therefore catches more impostors but
asks the legitimate user about three times as often, and the personal threshold stays. E's fine-tuned head with
balanced classes did work at 0.50 (8.7% / 13.4%, see above), but it is not the deployed head.
