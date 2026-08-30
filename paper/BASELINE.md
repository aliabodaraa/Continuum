# Frozen baseline — keystroke channel

Everything experiment #6 (timing-only vs identity-only ablations) will be compared against.
Frozen after the validation pass of 2026-08-29. **Nothing listed here may change while #6 runs**;
if any of it must change, #6 is re-run from scratch rather than compared across versions.

## Code

| | |
|---|---|
| commit | tag `baseline-keystroke-v1` = `d0a3ba20009c` (authoritative). Content landed in `d0a3f46c2db4`; the tag additionally carries this hash pin. |
| split | `api.py::split_no_overlap` + `api.py::dedupe_windows` |
| negatives | `keystrokeSecurity.js::negativeSampleRows` (alias-filtered) |
| decision rule | `keystrokeSecurity.js::LU_WINDOW_THRESHOLD` = 0.50, ≥3 of last 6 |

## Data — checksums (sha256, first 16 hex)

| artefact | digest |
|---|---|
| `data/Rand_WS50.h5` (training negatives) | `614e9ae2b2086822` |
| `data/keyrecs_impostors.h5` (99 subjects, 52,234 windows) | `d925a18ab426a0c7` |
| `artifacts/ws50-gru/final_model` (live base) | `614a568eb2ddfc49` |
| `artifacts/ws50-gru-v2/final_model` (sweep base) | `8cf3b5ce58b7c882` |
| `scaler.json` (identical for both bases) | `94a30fd6a4cae196` |

## Split protocol

- Positives grouped by source sample (`keystroke_text_id`); mouse by recording session.
- **Exact-duplicate windows dropped before splitting** (`dedupe_windows`) — grouping alone is
  insufficient because identical content exists under two sample ids.
- Whole groups assigned to one side; validation capped at 50% of windows.
- No groups supplied → contiguous split with a **5-window gap** (`ceil(50/10)`), never a shuffle.
- Validation fraction 0.2.

## Negative-pool protocol

- Candidates: all `user_id <> target`, `is_training=1`, `is_suspicious=0`, newest first.
- **Alias exclusion:** drop a candidate when >50% of its distinct >40-char texts also belong to
  the target, requiring ≥4 such texts. Measured margin on live data: legitimate pairs 0%,
  aliases ≥98.6% — a 99-point gap.
- Dataset top-up from `Rand_WS50.h5` to `max(2 × positives, 60)`; failure to load is reported
  via `datasetNegativeError` and a startup preflight, never silent.

## Evaluation protocol

- **Population:** 99 KeyRecs targets; positives temporal 70/30 with a 5-window gap; training
  negatives from participants `[0:40]`, evaluation impostors from `[40:80]`, disjoint, target
  removed from both.
- **Window level:** EER, AUC, TAR/FAR at the fixed 0.50.
- **Decision level:** ≥3 of last 6, slid over real consecutive windows. Never binomially derived.
- **Uncertainty:** cluster bootstrap resampling *sessions/samples*, never windows.

## Frozen reference results

| measure | value |
|---|---|
| population EER, median | **14.53%** (IQR 9.33 – 18.27) |
| population EER, p10 / p90 | 6.12% / 25.90% |
| users above 10% / 20% EER | 68 / 99 · 21 / 99 |
| TAR @ FAR=1%, median | **12.4%** (p10 0.6%) |
| personalised AUC, median | **0.930** (generic base: 0.552 — chance) |
| user 1, clean held-out EER | **10.17%** CI 8.41 – 13.87 *(59 unseen impostors; see note)* |
| decision false-lock, user 1 | 4.04% all held-out · 7.84% decontaminated |
| impostor caught per decision | 95.8% CI 91.1 – 99.2 |

Easy / median / hard reference users (KeyRecs 78 / 41 / 76):

| | EER | AUC | false-lock per decision | impostor caught |
|---|---|---|---|---|
| easy (78) | 4.09% | 0.987 | 0.0% | 100.0% |
| median (41) | 13.85% | 0.932 | **28.6%** | 99.8% |
| hard (76) | 30.44% | 0.763 | **68.6%** | 97.8% |

## Validation gates (must stay green)

```bash
docker exec -w /app/services/model-api continuum-model-api-1 python validate_split.py
docker exec continuum-ca-service-1 node /app/validate_pipeline.js
docker exec -w /app/services/model-api continuum-model-api-1 python validate_endtoend.py
```

## Post-freeze amendment (2026-08-30)

Forty KeyRecs participants (**p001–p040**, the frozen *negative* pool) were seeded as demo
accounts. Because app users become training negatives, those participants are no longer unseen
by any Continuum account, so `holdout_audit.py` and `packet_eval.py` now sample impostors from
**participants ≥ 40 only** (59 people still unseen).

Under that restriction user 1's clean held-out EER reads **10.17% CI [8.41, 13.87]**, against
8.42% [6.03, 11.37] measured earlier on the full 99-participant pool. The model is unchanged —
this is an impostor-composition effect, the same phenomenon already documented in
`EVALUATION.md` §3 (34 participants gave 4.1%, 99 gave 7.1%). Quote the 10.17% figure.

The evaluation impostor pool `[40:80]` and reserve `[80:99]` were deliberately left unseeded, so
**the population results (median EER 14.53%) and experiment #6 are unaffected**.

## Known limits carried into #6

1. The held-out set is **not** a temporal holdout — no claim about drift may rest on it.
2. 98 of 99 population subjects are KeyRecs transcription, not in-app free composition.
3. Only one real Continuum user has enough held-out data.
4. At a 1% FAR budget the median user is accepted 12.4% of the time — defensible as a step-up
   trigger behind a passkey, not as a standalone authenticator.
