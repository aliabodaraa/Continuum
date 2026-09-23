# Continuum — evaluation, protocols and limits

Every figure below is stated with **what it was measured on**. That is the point of this
document: the same system can report 4.1% or 14.9% or 23.8% "error" and all three be correct,
because they answer different questions. A metric without its protocol is not a result.

---

## 1. The three levels of evaluation rigour

| level | what is kept apart | question it answers |
|---|---|---|
| 1. random split | nothing | — (leaks; see §2) |
| 2. overlap-aware | near-duplicate windows | *can it recognise patterns partly learned from these same people?* |
| 3. **subject-disjoint** | **whole people** | ***will it work for a user it has never seen?*** |

Only level 3 supports a generalisation claim. Windows overlap by 80% (stride 10 of 50), so a
random split puts near-identical copies on both sides — that is the leakage result.

---

## 2. Keystroke — base model (Buffalo)

Protocol: **level 2, overlap-aware.** `data/Rand_WS50.h5` carries **no subject labels**, so
`data_loader` groups by shared timing subsequence, not by typist. The same person can appear on
both sides. This is disclosed here because a biometric EER is normally assumed to be level 3.

| split | accuracy | note |
|---|---|---|
| random (leaky) | **> 99%** | near-duplicates cross the boundary |
| overlap-aware | **85.8%** | honest within-cohort estimate |

At the overlap-aware split: **EER 14.93%** (threshold 0.62), **AUC 0.921**, and at the
**deployed** threshold of 0.50: **FAR 20.1% / FRR 10.0%**.

> The deployed threshold is deliberately lenient — it buys FRR 10.0% at the cost of FAR 20.1%,
> rather than sitting at the 14.9% crossover.

---

## 3. Keystroke — per-user model, subject-disjoint *(new)*

Protocol: **level 3.** Genuine = 196 windows from user 1's `is_training=0` samples, never used
to fit the head. Impostors = 4,000 windows sampled from **99 KeyRecs participants** never seen
by the base model or any per-user head.

> **Superseded — kept for the record.** Every figure in this table is pre-audit: §3a corrects
> the EER to **8.42% [6.0 – 11.4%]** and §3b shows this user is the **19th percentile** of 99.
> Do not quote this table on its own.

| metric | value *(superseded)* | 95% CI (window bootstrap — wrong unit) |
|---|---|---|
| AUC | 0.979 | 0.974 – 0.984 |
| EER | 7.1% | 5.6 – 8.8% |
| TAR @ threshold 0.50 | 96.9% | — |
| FAR @ threshold 0.50 | 9.7% | — |
| TAR @ FAR = 1% | 55.6% | 49.0 – 65.8% |
| TAR @ FAR = 5% | 87.8% | 82.1 – 92.9% |
| TAR @ FAR = 10% | 96.9% | 94.4 – 99.0% |

**Personalisation quantified:** see §3b — the original "14.9% → 7.1%, roughly halving" claim is
retracted; the correct statement is chance (AUC 0.55) → AUC 0.93.

> The figures in this table are the pre-audit version. §3a corrects the EER to **8.42%
> [6.0 – 11.4%]** and §3b shows this user sits at the **19th percentile** of 99 subjects.

**"What is the maximum TAR?"** — 100%, trivially, by accepting everyone. Constrained to a real
security budget the answer is a curve, and a demanding one: holding impostors to 1% costs
nearly half of genuine windows (**TAR 55.6%**); at 5% FAR it is **87.8%**. This is the
security/usability trade the single 91.1% figure concealed.

### Impostor-set size changes the answer

The same evaluation run against only the first 34 participants gave AUC 0.992, EER 4.1%,
FAR@0.50 4.6%, TAR@FAR=1% 82.1% — substantially better across every statistic.

> **A small impostor set overestimates security.** Diversity of impostors, not their count
> alone, sets the difficulty. Any FAR quoted without stating how many distinct people it was
> measured against should be treated as provisional.

*Not domain shift:* same-app impostors score in the same range (0.004 – 0.160) as the external
set (0.106); `ahmad` scores *higher* than the KeyRecs mean. Suggestive rather than conclusive,
since those app users were training negatives.

## 3a. Auditing the held-out set itself

The numbers in §3 rest on 196 windows from user 1's held-out samples. Auditing that set rather
than the model found three defects (`holdout_audit.py`):

- **Not a temporal holdout.** Training spans 12 Jun – 4 Jul, held-out 6 – 20 Jun: the training
  window *encloses* the held-out window, so all 78 held-out samples predate the last training
  sample. No claim about behavioural drift can rest on this set.
- **Prompt reuse across the split.** The five fixed enrolment prompts were typed once into each
  side. No row is duplicated — zero exact text matches — but the model sees the same words on
  both sides, and §6 measures key identity at ~22% of discriminative weight.
- **Degenerate and duplicate samples.** Ids 66/67 are byte-identical (17% of all held-out
  windows); id 73 is `x` repeated 182 times.

**Effective sample size is 20, not 196.** Only 20 of 78 samples are long enough to yield one
50-digraph window; the largest 7 supply half. A window-level bootstrap treats ~20 correlated
clusters as 196 independent draws.

| variant | samples | windows | EER | 95% CI |
|---|---|---|---|---|
| as published (§3) | 20 | 196 | 7.07% | 5.61 – 8.67% *(window bootstrap)* |
| contamination removed | 14 | 118 | 8.42% | 6.59 – 10.05% *(window bootstrap)* |
| **+ sample-level bootstrap** | **14** | **118** | **8.42%** | **6.03 – 11.37%** |

Contamination inflated the headline by 1.35 points; the wrong bootstrap unit made the interval
1.5× too narrow. The intervals overlap, so the point shift is suggestive rather than decisive —
but the contamination is real and the unit was wrong, so the honest figure is the wider one
either way. **Corrected single-user headline: EER 8.42%, CI 6.0 – 11.4%.**

---

## 3b. Does it work for anyone else? — 99 subjects

§3 is one user. `population_sweep.py` re-runs the whole enrol-and-verify pipeline for each of
the 99 KeyRecs participants: positives split temporally 70/30 with a **5-window overlap gap**,
training negatives from a 40-participant pool, impostors from a **disjoint** 40-participant
pool, target excluded from both, recipe copied from `api.py`.

| statistic | value |
|---|---|
| EER median | **14.53%** |
| EER IQR | 9.33 – 18.27% |
| EER p10 / p90 | 6.12% / 25.90% |
| users above 10% / 20% EER | **68 / 99**  ·  **21 / 99** |
| FAR @ 0.50 median | 11.13% (p90 22.73%) |
| TAR @ 0.50 median | 84.42% (p10 58.21%) |
| **TAR @ FAR = 1% median** | **12.4%** (p10 0.6%) |

**User 1's frozen-baseline figure, 10.17%, is the 33rd percentile.** Two users in three do worse;
the median deployment user faces 14.53%. Enrolment volume does not explain the spread
(**r = +0.04**), so more data is not the remedy — the difficulty is intrinsic, the same conclusion
the mouse channel reached independently.

### Retraction: "personalisation halves the error"

§3 claimed 14.9% (base) → 7.1% (per-user), roughly halving. Those figures are not commensurable:
14.9% is a Buffalo overlap-aware number and not a per-user verification result at all. Tested
directly — the **generic base** scoring 20 KeyRecs targets against unseen impostors:

| model | AUC verifying a *specific* unseen user |
|---|---|
| generic base | **0.552** mean / 0.627 median — chance, per-target range 0.05 – 0.97 |
| per-user heads (n = 99) | **0.930** median (p10 0.817, p90 0.986) |

The base has no notion of *which* person it is looking at. Personalisation does not halve an
error — it takes verification **from chance to AUC 0.93**. That is a stronger argument for the
per-user architecture, and it simultaneously shows the final quality (median EER 14.5%) is worse
than the single-user headline implied.

## 4. How a verdict is actually reached — the packet vote

Model outputs are **per window**; the decision is **≥3 of the last 6 windows low**.

### Measured end-to-end, not derived

Decision rates were previously obtained from the per-window rate with a binomial transform,
which assumes the six windows are independent draws. **They are not:** consecutive windows
overlap by 80% and describe adjacent moments of the same behaviour — measured lag-1
autocorrelation of consecutive scores is **0.282**. Low windows therefore arrive in *runs*,
which fattens the tail of a majority vote. The rates below are measured by sliding the live
rule over real consecutive windows.

| genuine set | sessions | packets | per-window low | binomial | **measured** |
|---|---|---|---|---|---|
| all held-out samples | 16 | 99 | 3.41% | 0.073% | **4.04%**  CI 0.0 – 10.2% |
| **contamination removed** (§3a) | 10 | 51 | 5.46% | 0.286% | **7.84%**  CI 0.0 – 19.4% |

| impostors | participants | packets | per-window low | binomial | **measured** |
|---|---|---|---|---|---|
| KeyRecs, unseen | 40 | 21,261 | 94.67% | 99.99% | **95.8%**  CI 91.1 – 99.2% |

**The binomial understated false locks by 27 – 55×** and overstated impostor capture.
Correlation moves both figures in the pessimistic direction. Any binomial number may only be
quoted as an explicitly-labelled independence *lower bound*.

Removing the contaminated samples raises the false-lock rate as well as the EER — the same
direction as §3a, from the same cause. The clean figure is the honest protocol, but it rests on
**51 packets from 10 sessions**, and its interval (0 – 19.4%) is too wide to pin the rate down.
The defensible statement is a bound, not a point: *the genuine user is challenged on the order
of several percent of decisions, not a fraction of one percent.*

Confidence intervals here resample **sessions**, not windows: windows within a session are
correlated, so a window-level bootstrap would understate uncertainty. Measured over 16 genuine
sessions (99 packets) and 40 impostor participants (21,261 packets) — the genuine interval is
wide because 16 sessions is a small sample, and that width is part of the result.

> Practical reading: the packet vote still converts a 3.4% per-window rejection into a
> **~96% impostor catch**, but it does **not** deliver the near-zero false-lock rate the
> independent model predicted. At ~4% per decision the legitimate user is challenged
> noticeably, and reducing that is a genuine open problem rather than a solved one.

## 5. Mouse

Protocol: **level 3 by construction** — base trains on 3-minute sessions, tests on 1-minute
sessions, with **20 users held out** entirely.

- **EER 23.8%** on unseen subjects.
- Four methods (enriched features, Dense head-swap, prototype-cosine, ArcFace) all landed at
  **22 – 28%**, with the *same* users hard each time → evidence of an **intrinsic ceiling** on
  this data, not a modelling gap.
- On-device (extension), user 1: impostors **7.5% accepted** (240 windows), live browsing
  **77.9% accepted** (746 windows), in-sample vs live gap **0.10** — generalising, not memorising.

> **Keystroke 14.9% and mouse 23.8% are not comparable**: keystroke is level 2, mouse is level 3.
> Mouse looks worse partly because it was tested more strictly.

---

## 6. Explainable AI — what drives the verdict

Permutation importance (Breiman 2001) on user 1's model against all 99 impostor participants,
baseline AUC 0.9805, cross-checked with mean-occlusion; both perturbations agree on the ranking.

| feature | ΔAUC when destroyed | kind |
|---|---|---|
| **dwell1** | **+0.0581** | timing |
| dwell2 | +0.0310 | timing |
| id1 | +0.0200 | identity |
| dd | +0.0174 | timing |
| id2 | +0.0123 | identity |
| ud | +0.0054 | timing (redundant) |

**Timing 78% / key identity 22%** of *attributed* AUC drop. This is a statement about marginal
contribution inside a model trained on everything — **it is not** a statement that key identity
carries 22% of the usable signal. §6c tests that directly by retraining, and does not support
the second reading.

`ud`'s near-zero score is algebra, not noise:

```
UD = press₂ − release₁ ,  DD = press₂ − press₁ ,  dwell1 = release₁ − press₁
⇒  UD ≡ DD − dwell1
```

The published 6-feature set therefore carries only **5 independent** features.

## 6b. How hard is a mimicry attack?

Real impostors shifted a fraction α toward user 1's timing distribution (first two moments);
key codes untouched; `ud` recomputed from the identity so every window stays physically
realisable. **α = 0 is measured reality; α > 0 is synthetic** and bounds FAR from below.

| α | attacker | FAR @ 0.50 | gets past the packet vote |
|---|---|---|---|
| 0.00 | real unseen person | 10.0% | 0.1% |
| 0.50 | half-matched timing | 37.5% | ~10% |
| 0.75 | well-matched | 59.2% | ~38% |
| **1.00** | **timing fully matched** | **82.1%** | **~70%** |

Two things follow. The defence degrades **gradually**, not catastrophically — there is no
cliff at which it suddenly fails. And matching the target's timing *statistics* perfectly still
does not reach 100%: **AUC remains 0.595 at α = 1**, so the model retains discriminative power
from the temporal *sequence* that first- and second-moment mimicry cannot reproduce. That is a
direct empirical argument for the recurrent architecture over summary-statistic features.

Precedent for synthetic forgery evaluation: Sun & Upadhyaya, IJCB 2018 (ref [29]).

## 6c. Ablation — is timing *sufficient*, and is identity *necessary*?

Attribution ranks features inside one trained model. It cannot say whether a representation
supports the task at all. So the whole pipeline was retrained under three input representations
across all **99 subject-disjoint users**, changing nothing but which columns carry information
(`ablation_sweep.py`). Ablated columns are filled with a corpus constant, which keeps tensor
shape, base model, frozen weights and training procedure byte-identical — slicing columns out
would have forced a different architecture and confounded representation with model.

| Metric | Full | Timing-only | Identity-only |
|---|---:|---:|---:|
| EER median | 13.89% | **12.88%** | 41.71% |
| EER IQR | 9.23 – 19.81% | 8.50 – 16.86% | 36.46 – 47.56% |
| EER mean | 14.99% | 14.04% | 41.44% |
| EER min / max | 3.73 / 40.49% | 1.97 / 37.20% | 17.15 / 64.55% |
| AUC median | 0.922 | **0.938** | 0.609 |
| TAR @ FAR = 1%, median | 12.21% | **16.55%** | 1.20% |

Paired per-user differences, bootstrapped over users (the independent unit):

| Comparison | Median Δ EER | 95% CI | Worse for |
|---|---:|---|---|
| timing-only − full | **−0.57 pp** | [−1.34, −0.10] | 35 / 99 |
| identity-only − full | **+25.92 pp** | [+23.72, +28.02] | 99 / 99 |
| identity-only − timing-only | +27.34 pp | [+24.52, +30.16] | 98 / 99 |

**Removing key identity does not cost accuracy — it slightly improves it**, and the interval
excludes zero. Timing-only was better for **63 of 99** users. **Removing timing collapses
verification toward chance**: 76/99 users above 35% EER, 67/99 below AUC 0.65, and median
TAR@FAR=1% falls from 12.21% to 1.20%.

### Disagreement with §6, reported rather than reconciled

The 78/22 split and this ablation answer different questions, and the ablation does not support
the reading the 78/22 phrasing invited. Identity's 22% share of attributed AUC drop coexists
with identity *alone* performing near chance, and with identity being mildly **harmful** when
present. The defensible claim is now:

> Timing is nearly **sufficient** for verification and key identity is nearly **unnecessary**.
> Removing key identity leaves median EER unchanged to slightly better (13.89% → 12.88%, paired
> −0.57 pp, 95% CI [−1.34, −0.10]); removing timing collapses verification toward chance
> (41.71% EER, AUC 0.609). Key identity alone does not support verification.

### Leakage control

Ablated columns have **exactly one distinct value** (the correct criterion — `var()` returns
~1e-15 for a constant float32 column of this size, so a `var()==0` assertion fails on a rounding
artefact). Every index — enrol/validation/held-out positions, sampled negatives, sampled
impostors, training shuffle — is drawn **once per target and reused by all three conditions**, so
identical populations and identical data volume are guaranteed by construction, not by matching
seeds; both are asserted per target at runtime. Windows are fixed at 50 steps, so no length or
padding signal exists. Condition A reproduces the frozen baseline (paired median −0.10 pp,
r = 0.913 across users).

### This is not a privacy result

Two claims must be kept apart:

- **No direct key-identity input** — proven; the columns are constant.
- **No possible information about typed content** — **false.**

Probed on the same corpus (`ablation_privacy.py`): word boundaries are recoverable from timing
alone at **AUC 0.681** (spaces are 16.6% of digraphs), and per-key one-vs-rest averages **AUC
0.603**. Recovering spaces yields word lengths, which is most of the way to fingerprinting a
phrase. MI(id1; timing) is 1.65% of H(id1) — small, not zero. Within-window ordering added
nothing beyond the multiset (ordered 0.427 vs shuffled 0.435).

## 7. Datasets

| dataset | subjects | windows | protocol used | licence / access |
|---|---|---|---|---|
| Buffalo [9] | 148 | 42,579 × 50×6 | overlap-aware (no subject labels) | request from curator |
| SapiMouse [2] | 120 | 230,564 × 50×7 | subject-disjoint, 20 held out | public |
| KeyRecs | 99 | 52,234 × 50×6 | impostors, subject-disjoint | CC-BY 4.0 |

- **[9]** Sun, Çeker & Upadhyaya, *Shared keystroke dataset for continuous authentication*, WIFS 2016.
- **[2]** Antal, Fejér & Buza, *SapiMouse*, SACI 2021.
- **KeyRecs** — Dias, Vitorino, Maia, Sousa & Praça, *KeyRecs*, Data in Brief 2023.
  [doi:10.5281/zenodo.7886742](https://doi.org/10.5281/zenodo.7886742)

Converters (`keyrecs_to_windows.py`, `aalto_to_windows.py`) are ports of `buildSteps()` in
`ca-service/lib/keystrokeSecurity.js` and must stay identical to it — windows built by another
rule are out-of-distribution for the trained head, and the resulting FAR would measure that
mismatch rather than the impostor. The KeyRecs `dwell2 = UU − UD` derivation was verified
against the dataset's own identity `DD + dwell2 == DU.key1.key2` (19,995 rows, zero mismatches).

---

## 8. Limitations — state these before being asked

1. **Keystroke base is level 2, not level 3.** Cannot be fixed from data on disk: `Rand_WS50.h5`
   has no subject labels. Fixing it requires the raw Buffalo release.
2. ~~n = 1 target user~~ — **resolved (§3b)**: 99 subject-disjoint targets. The remaining limit
   is that only *one* of them is a real Continuum user; the other 98 are KeyRecs transcription
   sessions, so the population estimate and the in-app estimate are not the same measurement.
3. **Impostor-set size matters**: 34 participants gave EER 4.1%, all 99 gave 7.1%. Larger
   and more diverse impostor pools would likely raise it further.
4. **KeyRecs is transcription**, matching copy-typing enrollment rather than free composition.
   Continuum's own measurements show these differ materially for the same person. This cuts both
   ways in §3b: KeyRecs targets have *different* text in train and test (187 distinct opening
   sequences across 198 participant-sessions), so unlike user 1 they gain nothing from shared
   content — making the population figure the more conservative one.
7. **The held-out set is not a temporal holdout** (§3a), so nothing here speaks to behavioural
   drift over weeks or months — the question a deployment cares most about.
8. **At a 1% FAR budget the median user is accepted 12.4% of the time** (§3b). As a step-up
   trigger backed by a passkey this is defensible; as a standalone authenticator it is not.
5. **`key1`/`key2` are `event.key` names** mapped to keyCodes — exact for letters and digits,
   approximate for a few punctuation keys.
6. **App users cannot be impostors**: every per-user profile records
   `negativeSource="app-users+dataset"`, so they are already training negatives; and several
   "users" are one human under both a demo id and a hashed CA uid.

## 9. Reproducing

```bash
# impostor windows from KeyRecs
python services/model-api/keyrecs_to_windows.py \
    --src /app/data/keyrecs/free-text.csv --out /app/data/keyrecs_impostors.h5

# subject-disjoint ROC / EER / TAR@FAR with bootstrap CIs
python services/model-api/keystroke_user_sweep.py --user-id 1 \
    --impostors /app/data/keyrecs_impostors.h5 --out artifacts/xai/sweep_user1.json

# feature attribution
python services/model-api/explain.py --user-id 1 \
    --impostors /app/data/keyrecs_impostors.h5 --out artifacts/xai/explain_user1.json
```

Sanity anchor: the sweep must reproduce `far_at_0_5 ≈ 0.20` / `frr_at_0_5 ≈ 0.10` from
`artifacts/ws50-gru-v2/results.json` when run against the base model, before any new figure
from it is trusted.
