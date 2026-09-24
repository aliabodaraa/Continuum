# Phase 2, first development check: frozen embedding vs per-user fine-tuning (mouse)

**EXPLORATORY, development users only (19), decides nothing.** Run 2026-09-23 with
`frozen_check.py` (inside the model-api container, since it needs TensorFlow). Results are in
`artifacts/phase2/frozen_check.json`.

Question: does the deployed per-user network fine-tuning buy accuracy that a **frozen** base network
cannot give? All arms use the same windows (rebuilt with `repr_arch_study`, identical to the stored P1
streams), the same 330-window enrolment and the same impostor runs. The base network is base-80
(`artifacts/mouse-fcn-a5-j80`, which never saw the development users).

| Arm | What changes | Window AUC | 9.9-s per-user AUC (vs A) | 9.9-s pooled EER |
| --- | --- | --- | --- | --- |
| A | deployed: per-user fine-tuned FCN (P1 stream, order 0) | 0.854 | 0.953 | 12.6% |
| B | A's model family, leave-one-sample-out threshold source | 0.855 | 0.961 (+0.008 [-0.004, +0.023]) | 14.5% |
| F0 | frozen embedding, cosine to the enrolment centroid | 0.828 | 0.912 (**-0.041** [-0.077, -0.006]) | 17.3% |
| F1 | F0 + cohort score normalisation (S-norm, 80 base users) | 0.838 | 0.935 (-0.018 [-0.047, +0.009]) | 14.5% |
| F2 | frozen embedding + logistic-regression head | 0.865 | 0.964 (+0.010 [-0.003, +0.027]) | 11.9% |

Reading:

1. **Cosine to a centroid is not enough on the current embedding** (F0 is worse, and its CI excludes zero).
   Cohort normalisation recovers about half of that gap (F1).
2. **A frozen embedding plus a per-user linear head matches full fine-tuning** (F2 vs A: no
   significant difference at any decision length). This replicates Experiment G, where the on-device
   head-only model equalled the server model.
3. F2 has practical properties the deployed recipe lacks. Its training objective is convex, so the
   result does not depend on the order of enrolment samples (Method A depends on it for 19/19 users,
   P1). It trains in milliseconds, and the same code runs on the server and in the extension.
4. Implication for Phase 2: accuracy will not come from the scoring head. It has to come from a better
   embedding (plan item M1: metric-learning training on more users). F2 is the natural candidate to
   replace per-user network fine-tuning, and needs a pre-registered test.

Caveats: one base network (seed 101), the identity sample order, and 19 users. The 17.2-s results are
in the JSON; there, F2 vs A per-user AUC is -0.006 [-0.018, +0.005].

---

# Protocol L: learned embedding + per-user head vs S1 (task T2.3)

The frozen plan is `artifacts/repr_arch_study/PREREGISTRATION_L.md`, with its `.sha256`. Every script
refuses to run if a frozen file changed. Every result carries the five frozen hashes.

| Step | Script | Reads | Writes (under `artifacts/phase2/L/`), each once |
| --- | --- | --- | --- |
| 1 | `train_embedding_l.py` x 4 | base-train users (64) | `models/<candidate>/` |
| 2 | `select_l.py` | base-val (16), with base-train as cohort | `selection_scores.json` |
| 3 | `finalize_l.py --run` | all 80 base users | `models/<winner>-base-80-s10{1,2,3}-e<N>/`, `SELECTION_L.json` |
| 4 | `score_l.py` | development users (19 targets + user98), P3 streams, base-80 network | `scores_D.json` |
| 5 | `analyze_l.py` | `scores_D.json` | `stage_D.json`, `stage_D.txt`, `stage_D_roc.png` |

## Guards (`l_common.py`)

- Development users can't be read until a valid `SELECTION_L.json` exists, so steps 1-3 can't touch
  them.
- Lockbox-1 users can never be read.
- Smoke-test files are refused by every real step.
- A finished model isn't trained again.
- Scored candidates must still match their hashes.
- Results are written through a temporary file, so a crash never leaves a half-written result.
- **Frozen code.** `SELECTION_L.json` records the SHA-256 of the six L scripts, `p1lib.py`,
  `repr_arch_study.py` and `preprocess_mouse.py`. `score_l.py` and `analyze_l.py` refuse to run on
  different code unless given `--amended <amendment file>`, which is recorded in the result.

## Run

Run everything inside the model-api container (TensorFlow 2.15), from
`/app/services/model-api/analysis/phase2`. Set `--threads` to the number of CPU threads the container
has.

```sh
# 0. check the frozen files inside the container (a line-ending conversion would show here)
python -c "import l_common as LC; print(LC.verify_frozen())"
# 1. four candidates: seed 101, early stopping on a temporal 80/20 split, at most 60 epochs
python train_embedding_l.py --objective arcface --param 0.20 --users base-train --seed 101 --threads 8
python train_embedding_l.py --objective arcface --param 0.35 --users base-train --seed 101 --threads 8
python train_embedding_l.py --objective supcon  --param 0.07 --users base-train --seed 101 --threads 8
python train_embedding_l.py --objective supcon  --param 0.10 --users base-train --seed 101 --threads 8
# 2. pick one on base-val
python select_l.py
# 3. retrain the winner on all 80 base users, seeds 101-103, for its best epoch count; writes SELECTION_L.json
python finalize_l.py                    # shows status and the three commands
python finalize_l.py --run --threads 8
# 4-5. stage D (development users are read only from here on)
python score_l.py --threads 8
python analyze_l.py
```

**Cost.** In the cloud (2 CPU threads), one training step of 48 windows took about 0.2 s. On a laptop
CPU, expect:

| Step | Time per epoch | Total |
| --- | --- | --- |
| 1: four candidates, 64 users each | about 1 min | 1-3 h with early stopping at 15-40 epochs |
| 3: three final models, 80 users each | about 2 min | 1-2 h |
| 2, 4 and 5 | – | minutes |

`analyze_l.py` runs 10,000 cluster resamples for the pooled contrasts, which takes a few minutes.

**Failures.** A technical failure (a crash, or a non-finite loss, which stops the run) is re-run with
identical settings and logged in `artifacts/repr_arch_study/RUN_LOG.md` (section 8). A crashed training
leaves no `meta.json`, so it can simply be started again. Nothing is re-run because of its result.

**Smoke test.** It uses 6 users and 2-3 epochs, reads base users only, writes only under
`L/smoke/`, and can be repeated:

```sh
for c in "arcface 0.20" "arcface 0.35" "supcon 0.07" "supcon 0.10"; do set -- $c
  python train_embedding_l.py --objective $1 --param $2 --users base-train --seed 101 --limit-users 6 --max-epochs 3; done
python select_l.py --limit-targets 4 && python finalize_l.py --smoke --run && python score_l.py --smoke \
  && B_POOLED=300 python analyze_l.py --smoke
```

## Thresholds and the endpoints

- **EER and ROC AUC** need a continuous score but no threshold. For each decision, that score is the
  *pct* statistic: each window's percentile within the target's own leave-one-sample-out scores,
  averaged over the decision's windows. Every threshold is swept.
- **The deployed rule** (20th percentile, 33 of the last 60 windows below it) is a fixed threshold.
  It is reported separately, as one operating point:
  - prompts per minute;
  - impostor runs caught;
  - FAR and FRR of 17.2-s decisions.

  `stage_D_roc.png` marks this point on the same axes as the ROC curves.

## Implementation choices and disclosures

These were fixed before any L result existed. None of them changes a system, an endpoint or a margin.

- **F2.** `l_common.py` re-implements F2 instead of importing `frozen_check.py`, because importing
  that file would read every SapiMouse user, lockbox 1 included. Differences from the exploratory
  check:
  - `max_iter` is 5000 instead of 2000; this affects convergence only;
  - the head's solver is named explicitly (lbfgs);
  - tau is the 20th percentile (S1's rule) instead of the 1st.

  Tau affects only the reported vote and operating-point numbers, not the primary endpoint.
- **Cohorts.** The selection cohort is base-train, so that base-val targets are never their own
  negatives. The stage-D cohort is all 80 base users, as for F2.
- **Epoch count.** "The epoch count of its selection run" is the winner's best epoch under early
  stopping. A final epoch covers more steps (80 users, whole sessions); `SELECTION_L.json` states
  this.
- **Score precision.** REF's stored streams are rounded to 6 decimals (protocol J), and some of its
  probabilities tie at exactly 1.0; `stage_D.json` reports the share. F2 and L scores are stored at
  full precision.
- **Lockbox 2.** Section 2 of the pre-registration uses lockbox-2 users as base-train/base-val
  (training, selection and cohort data, never test users). Section 8 says "no step reads the
  lockboxes". The code follows section 2, the specific rule. The write-up must say this.
- **Stage C is not coded yet.** Stage C (Bogazici, base-100, Q1/Q2 with Holm) follows after
  Amendment L-1 (parsing) and Amendment L-2 (model hashes), as the pre-registration requires.
