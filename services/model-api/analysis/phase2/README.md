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
