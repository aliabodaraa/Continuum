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

| metric | value | 95% CI (bootstrap) |
|---|---|---|
| AUC | **0.979** | 0.974 – 0.984 |
| EER | **7.1%** | 5.6 – 8.8% |
| TAR @ threshold 0.50 | 96.9% | — |
| FAR @ threshold 0.50 | 9.7% | — |
| TAR @ FAR = 1% | 55.6% | 49.0 – 65.8% |
| TAR @ FAR = 5% | 87.8% | 82.1 – 92.9% |
| TAR @ FAR = 10% | 96.9% | 94.4 – 99.0% |

**Personalisation quantified:** generic base model 14.9% EER → this user's fine-tuned head
**7.1%**, roughly halving the error.

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

**Timing 78% / key identity 22%** → it behaves as a *behavioural* biometric, recognising **how**
keys are held rather than **which** were pressed. Hold time is the personal signature.

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
2. **n = 1 target user** for the subject-disjoint result. It is a case study with confidence
   intervals, not a population estimate.
3. **Impostor-set size matters**: 34 participants gave EER 4.1%, all 99 gave 7.1%. Larger
   and more diverse impostor pools would likely raise it further.
4. **KeyRecs is transcription**, matching copy-typing enrollment rather than free composition.
   Continuum's own measurements show these differ materially for the same person.
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
