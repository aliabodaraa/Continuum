# The personal typing models under a random split (sensitivity check, 2026-10-20)

Asked by the owner on 2026-10-20, after the question "how do we compare with Lu et al.?": what do the deployed
personal models score under the literature's kind of split? Script `services/model-api/analysis/phase6/leaky_split.py`,
results `artifacts/phase6/leaky_result.json` and `.txt`, one JSON per target under `artifacts/phase6/leaky/`.
Not pre-registered: it is a sensitivity check of one protocol choice, and it is reported as such.

## What was run

Experiment KS's deployed arm (A200), line for line (`phase3/run_ks.py`), with ONE change: the owner's windows are
shuffled before the 70/30 split and no gap is dropped (the 15% validation share is a random part of the 70%).
Same base model, scaler, negatives (200 Aalto typists, 160 for training and 40 for validation, twice the positives),
same impostors (KeyRecs ids 40 to 79, first 150 windows each), same seeds and op determinism. 99 targets, all
eligible, 58.7 minutes in one model-api container (12 threads, 6 GB cap). Metric: per-user window-level EER and AUC
of the held-out windows against the impostor windows, computed with the same code as KS (`p1lib.eer_of`, `auc_of`).
Decision-level rates were not computed: a random held-out set is not a time stream.

## Result

| | window EER, mean over users | window AUC, mean |
| --- | --- | --- |
| Temporal split with a 5-window gap (KS, the paper's protocol) | 12.9% | 0.932 |
| Random split of the owner's windows (this check) | 12.0% | 0.939 |

Random minus temporal: -0.9 points, 95% CI [-1.6, -0.2] (paired bootstrap over users, 10,000 resamples); lower
under the random split for 61 of 99 users.

## Reading

The random split inflates the personal models only a little, because their impostors never enter training: the
overlap between the owner's training and test windows raises the owner's scores, but the impostor scores, which
decide the other half of the EER, are untouched. The large inflation of the base model (85.8% to 99.57% accuracy on
Buffalo, paper 4-1) comes from a split in which both classes leak. Published free-text results such as Lu et al.
2020 (EER 2.36% on Buffalo, 5.97% on Clarkson II) draw their negatives from the same people who serve as test
impostors and split the sequences at random with 10-fold cross-validation, so both classes leak there too. The gap
between those figures and the 12.9% here is therefore a matter of protocol (which people the model sees in training,
and how the sequences are split), not of the model, and no number-to-number comparison is valid. Written into
paper 4-1 and thesis 4-1 as two sentences.
