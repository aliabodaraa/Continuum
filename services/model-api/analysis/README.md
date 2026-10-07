# Analysis scripts — model improvement investigation (2026-09-02)

Post-processing over saved evaluation outputs. **No model is trained here**, nothing touches the
frozen baseline, and every script reads artefacts rather than the live database.

Run from the **repo root** — paths are relative to it. `numpy` and `h5py` are enough for all but
`decision_paired.py` / `session_survival.py`, which import from `services/model-api/decision_sweep.py`.
They run fine on the Windows host (numpy 2.5.0 + h5py 3.16.0 are installed); no container needed.

| Script | Answers | Reads |
|---|---|---|
| `difficulty_factors.py` | Which behavioural traits predict per-user EER | `data/keyrecs_impostors.h5`, `artifacts/xai/population_keystroke.json` |
| `difficulty_confound.py` | Is "more enrolment data hurts" real, or a confound | `artifacts/xai/part4_difficulty.json` |
| `feature_screen.py` | Which candidate features carry identity (ANOVA F) and which are redundant | `data/keyrecs_impostors.h5` |
| `decision_paired.py` | Paired per-user comparison of decision rules + latency | `artifacts/xai/population_scores.json` |
| `session_survival.py` | Can an impostor survive a whole sitting; operating profiles | `artifacts/xai/population_scores.json` |

`../decision_sweep.py` is the main one: the packet-size / decision-rule sweep and the
decision-level ROC. See its module docstring for why contiguous impostor runs are used rather
than the thinned sample.

## Porting to mouse

These are modality-agnostic apart from two things:

1. **Feature order.** `difficulty_factors.py` and `feature_screen.py` hard-code the keystroke
   column order `[id1, id2, dwell1, dwell2, DD, UD]`. Mouse windows are `(N, 50, 7)` with a
   different meaning per column — rewrite `features()` / `candidates()` before use.
2. **Score-file shape.** `decision_sweep.py` and the two scripts that import it need
   `_genuineScores` (temporal order) and `_impostorRuns` (`{participant: contiguous run}`).
   Any mouse sweep must emit the same two keys and they will work unchanged.
