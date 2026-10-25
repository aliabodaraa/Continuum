# Pre-registration IM: do the published typing results depend on which KeyRecs people are the impostors? (25 Oct 2026)

Written and hashed, together with `run_im.py` and `analyze_im.py`, before any IM model is trained.

**Owner, 25 Oct 2026:** "start please", after asking why only KeyRecs participants 40 to 79 are impostors at test.

## Why the question

The impostor set was fixed in the frozen baseline (`population_sweep.py`), when the training negatives were KeyRecs
participants 0 to 39: the impostors had to be other people, so participants 40 to 79 were taken, and every later
experiment (KS, EC, AR2, SC) kept them so that its arms stay comparable. The deployed recipe (KS arm A200) takes its
negatives from 200 Aalto typists and has never seen a KeyRecs participant, so all 98 other participants could serve
as impostors. This checks whether the published numbers (paper Table 4, 20-window row: per-user AUC 0.969, FAR 11.9%,
FRR 3.3%, pooled EER 7.8%) hold with them.

## Protocol (experiment KS, arm A200, unchanged)

`run_ks.run_target`, line for line, for the 99 KeyRecs owners: the temporal 70/30 split with a 5-window gap,
validation from the end of the enrolment block, negatives from the first 200 typists of the KS Aalto draw
(`artifacts/phase3/aalto_pool_ks.json`, twice the positive windows, at least 60), transfer from `ws50-gru-v2` with
Conv1D frozen, Adam 3e-4, batch 16, 30 epochs, early stopping (patience 6, best weights restored), seeds 1000 + owner,
TensorFlow op determinism. The ONLY change: each owner's model is also scored on the first 150 windows of every other
KeyRecs participant (98 people, the owner excluded), not only of participants 40 to 79.

Decisions: step-disjoint blocks of 20 windows (`eval_decision_level.blocks`, gap 4), scored by their mean; the live
rule (a block is suspicious when at least 10 of its 20 windows are below 0.50); exactly `analyze_ks.per_target`.

## Impostor sets, all scored by the same models

- **S40:** participants 40 to 79 (the published set);
- **ALL:** all 98 other participants;
- **NEW:** the 58 or 59 participants that S40 leaves out (0 to 39 and 80 to 98).

## Endpoints

- **Primary:** mean per-user AUC of 20-window decisions, ALL minus S40, paired over owners; bootstrap of 10,000
  resamples, seed 17, 95% interval (`analyze_ks.boot`).
- **Secondary:** the same for NEW minus S40; pooled live-rule FAR and FRR, pooled decision EER, for each set.

## Reading rule (fixed now)

The published numbers are **robust to the choice of impostors** if both hold: the mean per-user AUC with ALL is within
0.01 of S40, and the pooled live-rule FAR with ALL is within 2 percentage points of S40. Otherwise they are **not**,
and the thesis reports the ALL figures next to the published ones. FRR does not depend on the impostors and must be
identical across sets (a check of the code, not a result).

## Reproduction check

The same seeds and recipe should give the KS A200 models again. The genuine scores and the S40 impostor runs of the IM
run are compared with `artifacts/phase3/parts/A200/<owner>.json`; the largest absolute difference is reported. The
comparison of the sets does not depend on it, since all three sets are scored by the IM run's own models.

## Outputs

`artifacts/phase7/im/parts/<owner>.json`, `artifacts/phase7/im_result.json` and `im_result.txt`.
