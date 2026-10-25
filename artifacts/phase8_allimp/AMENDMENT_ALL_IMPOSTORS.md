# Amendment ALL-IMPOSTORS to the typing pre-registrations KS, EC, SC, AR2 and the random-split check (25 Oct 2026)

Written and hashed, with the override in `patch/sitecustomize.py`, before any re-run model is trained.

**Owner, 25 Oct 2026**, after experiment IM (`artifacts/phase7/PREREGISTRATION_IM.md`, `im_result.txt`): "there is no
reason to keep 40 to 79". IM showed that the deployed recipe's published numbers hold within its frozen rule when all
98 other participants are impostors (per-user AUC 0.9693 to 0.9645, live-rule FAR 11.9% to 13.0%), but participants 40
to 79 are slightly easier impostors than the rest. The owner decided that the typing results use every participant a
model never saw.

## The one change

The impostors at test. Everything else in each pre-registration stays as frozen: the owners, splits, negatives,
recipes, seeds, decisions, endpoints, bootstrap settings and reading rules. The frozen code runs unchanged; only the
two pool constants of `population_sweep.py` are overridden at start-up (`patch/sitecustomize.py`, `ALLIMP_POOLS`):

| Experiment | Impostors before | Impostors now | `ALLIMP_POOLS` |
| --- | --- | --- | --- |
| EC (enrolment curve), SC (scratch vs transfer), AR2 (adaptive retraining), random-split check | 40 to 79 | all 98 other participants | `0:99` |
| KS (negative sources REF / A40 / A200 / A1000) | 40 to 79 | 40 to 98 (REF learns from 0 to 39) | `40:59` |
| Paper Table 4 (packet lengths, deployed arm A200) | 40 to 79 | all 98 other participants, from IM's parts | none (IM) |

Each `run_target` already skips the owner. Outputs go to `artifacts/phase8_allimp/` (mounted over the experiment's
own folder in the container, so no original part or result is touched): `ks/`, `phase7/` (EC, SC), `phase5/` (AR2),
`phase6/` (random split). The original S40 results stay in the record and are not deleted.

## What the documents will report

After the re-runs, the paper, its Arabic copy and the thesis report the new figures for every typing result that rested
on the KeyRecs impostors, each with its experiment's own frozen endpoint and reading rule. The impostor description
becomes "all other participants" (KS: "participants 40 to 98"). Nothing else is re-decided from the new numbers.
