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
to fit the head. Impostors = 4,000 windows from **34 KeyRecs participants** never seen by the
base model or any per-user head.

| metric | value | 95% CI (bootstrap) |
|---|---|---|
| AUC | **0.992** | 0.989 – 0.995 |
| EER | **4.1%** | 3.1 – 5.6% |
| TAR @ threshold 0.50 | 96.9% | — |
| FAR @ threshold 0.50 | 4.6% | — |
| TAR @ FAR = 1% | 82.1% | 75.5 – 88.3% |
| TAR @ FAR = 5% | 96.9% | 94.4 – 99.0% |
| TAR @ FAR = 10% | 99.0% | 97.4 – 100% |

**This quantifies personalisation for the first time:** the generic base model sits at 14.9%
EER, this user's fine-tuned head at **4.1%**.

**"What is the maximum TAR?"** — 100%, trivially, by accepting everyone. The question is only
meaningful against a fixed FAR, and then the answer is a curve: **82% at 1% FAR, 97% at 5%**.

*Not domain shift:* same-app impostors score in the same range (0.004 – 0.160) as the external
set (0.059); `ahmad` scores *higher* than KeyRecs. Suggestive rather than conclusive, since
those app users were training negatives.

---

## 4. How a verdict is actually reached — the packet vote

Model outputs are **per window**; the decision is **≥3 of the last 6 windows low**. Being a
majority rule it *suppresses* error rates below 50% and amplifies above — the crossover at 50%
is the whole design.

| per-window rate | → per-decision |
|---|---|
| 3.1% (user 1 FRR) | **0.056%** — 1 false lock in ~1,800 decisions |
| 10% | 1.59% |
| 20.1% (dataset FAR) | 9.89% |
| 79.9% (impostor low-rate) | **98.3% caught** |

So the deployed system's per-window FAR of 20.1% becomes an impostor-accept of **1.7%** per
decision. **The vote is what turns a mediocre per-window model into a usable system.**

---

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

Permutation importance (Breiman 2001) on user 1's model, baseline AUC 0.9931, cross-checked
with mean-occlusion; both perturbations agree on the ranking.

| feature | ΔAUC when destroyed | kind |
|---|---|---|
| **dwell1** | **+0.0745** | timing |
| dwell2 | +0.0320 | timing |
| id1 | +0.0153 | identity |
| dd | +0.0120 | timing |
| id2 | +0.0118 | identity |
| ud | +0.0007 | timing (redundant) |

**Timing 81% / key identity 19%** → it behaves as a *behavioural* biometric, recognising **how**
keys are held rather than **which** were pressed. Hold time is the personal signature.

`ud`'s near-zero score is algebra, not noise:

```
UD = press₂ − release₁ ,  DD = press₂ − press₁ ,  dwell1 = release₁ − press₁
⇒  UD ≡ DD − dwell1
```

The published 6-feature set therefore carries only **5 independent** features.

---

## 7. Datasets

| dataset | subjects | windows | protocol used | licence / access |
|---|---|---|---|---|
| Buffalo [9] | 148 | 42,579 × 50×6 | overlap-aware (no subject labels) | request from curator |
| SapiMouse [2] | 120 | 230,564 × 50×7 | subject-disjoint, 20 held out | public |
| KeyRecs | 99 (**34 used**) | 17,336 × 50×6 | impostors, subject-disjoint | CC-BY 4.0 |

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
3. **34 of 99 KeyRecs participants** — the host truncated the transfer at ~8 MB repeatedly.
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
