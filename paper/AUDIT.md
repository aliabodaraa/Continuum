# Methodological audit — keystroke channel

Adversarial audit of the full chain: raw data → preprocessing → features → splitting →
training → validation → thresholds → aggregation → metrics → statistics → security → claims.
Written to *break* the methodology, not to confirm it. Two critical defects were found, one of
them in this project's own recently-reported numbers.

---

## 0. Reconstructed pipeline (what actually happens)

| stage | implementation | verified |
|---|---|---|
| capture | browser key events → `(keyCode, type, t_ms, field)` | code read |
| digraphs | consecutive keydown pairs → `[id1,id2,dwell1,dwell2,dd,ud]`; drop `dd<0.015`, `dwell<0.01`; drop `dd>1.0s` **without** breaking the run | `keystrokeSecurity.js:199-250` |
| windows | 50 digraphs, **stride 10 → 80% overlap** | `WINDOW_SIZE/STRIDE` |
| base model | Conv1D(32) → GRU(32) → GRU(32) → Dense(2 softmax), Buffalo | `model.py`, `train.py` |
| base scaler | `FeatureScaler.fit(X_train)` **after** the split | ✅ no leakage |
| base split | `compute_overlap_groups` — overlap-aware, **not** subject-aware | `data_loader.py:143` |
| per-user | freeze Conv1D, fine-tune GRUs + new Dense(2); positives = user's `is_training=1` windows; negatives = other app users + dataset | `api.py:290-400` |
| per-user split | **random shuffle, 80/20** over overlapping windows | `api.py:330-340` ❌ |
| early stopping | `val_loss`, `restore_best_weights` on that split | `api.py:411` |
| threshold | EER on that same `X_val`; **not used live** | `api.py:440-446` |
| live decision | window low if `<0.50`; **≥3 of last 6 windows** → step-up | `PACKET_VOTE_FRACTION` |

---

## 1. 🔴 CRITICAL — the per-user train/val split leaks

`api.py:330-340` shuffles windows randomly, then takes 80/20. But windows overlap by 80%, so
consecutive windows share 40 of their 50 rows.

**Measured on user 1's real training data (797 windows):**

- **96.2%** of validation windows have an immediate same-sample neighbour in training *(first estimate; direct row-level measurement later gave **100%** — see the resolution below)*
- those pairs share **100%** of the overlapping 40 rows — byte-identical

This is precisely the leakage the thesis's headline finding condemns (>99% → 85.8%),
reproduced inside the deployed per-user training pipeline.

**What it invalidates**

| quantity | status |
|---|---|
| `trainingAccuracy` 98.1% | ❌ meaningless as generalisation |
| `balancedAccuracy` 97.5% (dashboard "Training Fit") | ❌ meaningless |
| calibrated threshold 0.132 | ❌ chosen on near-duplicates (mitigated: not used live) |
| early-stopping epoch choice | ⚠️ optimistic — model may be overfit |
| **subject-disjoint AUC 0.979 / EER 7.1%** | ✅ unaffected *by §1* — genuine from `is_training=0`, impostors from KeyRecs (never seen). **But affected by a separate defect: §6b finds the held-out set contaminated; corrected EER 8.42%** |

**Fix:** group windows by source sample (`keystroke_text_id`) and split by group, exactly as
`compute_overlap_groups` does for the base model. Then re-fit and re-measure.

**✅ RESOLVED.** `split_no_overlap()` in `api.py` replaces the shuffle. Callers
(`keystrokeSecurity.js`, `mouse.js`) now send one group id per window — the source sample for
keystroke, the recording session for mouse — plus the overlap gap they built the windows with.
Whole groups go to one side. When no groups are supplied the fallback is contiguous-with-gap,
never a shuffle.

Measured on user 1's real training data, 3 fits per arm (`split_ab_test.py`):

| | validation leakage | reported val acc | calibrated threshold | held-out EER |
|---|---|---|---|---|
| old (random shuffle) | **100.0%** | 0.981 | **0.268** | 13.84% |
| new (group split) | **0.0%** | 0.977 | **0.541** | 12.71% |

Leakage was *total*: every validation window had a near-duplicate in training — worse than the
96.2% first estimated.

**Honest reading of the accuracy column:** the held-out set is 118 windows, so EER moves in
steps of ~0.85% and the 1.1-point difference is about one step. Re-running the live retrain
end-to-end gave 8.99% [6.46–11.84] against 8.42% [6.03–11.37] before — overlapping intervals in
the other direction. **There is no measurable accuracy change.** This fix is justified on
correctness, not on a performance gain: a validation set that contains its own training data
cannot calibrate anything, and it was calibrating the per-user threshold to less than half its
proper value.

*Blast radius, stated precisely:* the calibrated threshold is **not** the live cutoff — both
modalities decide at a fixed 0.50 (`LU_WINDOW_THRESHOLD`), and the retrain rollback gate scores
`is_training=0, sample_purpose='activity'` samples, which the split never touched. So the leak
corrupted early stopping, the reported `balancedAccuracy` ("Training Fit" on the dashboard) and
the logged `profile.threshold` — not live accept/reject decisions. Severity is real but narrower
than 🔴 implied.

**Verification:** after the fix, `balancedAccuracy` should *drop* materially. If it does not,
the split is still leaking.

---

## 1b. 🔴 CRITICAL — the genuine user's own data was training their model to reject them

Found while verifying the split fix, and worse than the defect that surfaced it.

The first clean retrain of user 1 was **rolled back** by the acceptance gate: genuine mean
0.958 → 0.544, low windows 0 → 22. The cause was not the split.

`getNegativeWindows` takes every *other* `user_id` as an impostor. But one human can hold more
than one id — a demo account id and a hashed CA uid. For user 1 the negative pool contained
id `739935229538144`, which shares **71 of user 1's 71 distinct texts** (>40 chars) and whose
samples resume exactly where user 1's stop (user 1: 6 Jun – 4 Jul; the alias: 11 Jul – 25 Aug).
It is the same person. **44 of their samples were being fed in as negatives**, explicitly
teaching the model that the owner's typing is an impostor.

The leaky split had been partially masking this: overfitting near-duplicate windows let the model
satisfy contradictory labels. With an honest split the contradiction surfaces as a collapsed fit.

**Fix:** `aliasUserIds()` drops any candidate whose distinct long texts are *majority*-shared
with the target. The threshold cannot be "shares any text" — the five fixed enrolment prompts
are typed by everyone by design, so a genuine impostor legitimately shares a handful. An alias
shares nearly all. Requires ≥4 texts before the ratio is trusted.

## 1c. 🟠 Live retrains had no dataset negatives at all

`NEGATIVE_DATASET_PATH` defaulted to `BASE_DIR/data/Rand_WS50.h5` → `/app/services/model-api/
data/`, which does not exist; compose sets `DATA_DIR=/app/data`, where the file actually is.
`get_dataset_negatives` caught the failure and returned an empty array, so **every live retrain
ran on app-user negatives only** — a handful of people, one of whom was the target themselves —
falling through to synthetic noise when there were none. Default now derives from `DATA_DIR`.

### Combined effect on the live pipeline

| | before | after |
|---|---|---|
| validation leakage | 100% | 0% |
| alias in negative pool | 44 samples of the target | excluded |
| negative windows | 1424 (app-users only) | 1594, incl. real dataset impostors |
| calibrated threshold | **0.132** | **0.454** |
| retrain gate | ROLLBACK | **accept** (lows 2 vs 0) |

The threshold moving from 0.132 to 0.454 is the clearest single indicator: a per-user threshold
of 0.13 means "accept almost anything", and it was that low because it had been calibrated
against memorised windows.

---

## 1d. 🔴 Duplicate samples defeated the group split — found by validating the fix

The group split was verified first by index arithmetic, which passed. Re-verifying it at **row
level** — comparing actual window contents rather than reasoning about positions — failed:

| | validation windows overlapping training |
|---|---|
| old random shuffle | **160 / 160 (100%)** |
| group split alone | **23 / 165** |
| group split + dedupe | **0 / 156** |

The shared-row distribution was bimodal: 5 windows shared exactly 1 row (a genuine coincidence
of six float timings), and **23 shared all 50** — byte-identical windows on both sides.

The cause is not overlap. Grouping by `keystroke_text_id` stops one sample straddling the split,
but the *same content* was filed under **two different sample ids** (user 1: ids 82 and 83; the
alias account: 217 and 218), so a group split cheerfully puts one copy on each side. Four such
duplicate pairs exist in the held-out data too — 66/67, already known from §6b.

**Fix:** `dedupe_windows()` drops exact-duplicate windows before splitting, keeping the first
occurrence. Deduplication is preferable to merging the two groups: a session recorded twice is
not twice the evidence, and keeping both over-weights that content in the fit. On user 1 it
removes 41 of 797 positive windows.

> The lesson is methodological. A leakage check that reasons about *indices* validates the
> mental model, not the data. Only comparing the actual contents caught this, and it was caught
> solely because the fix was verified rather than assumed.

---

## 2. 🔴 CRITICAL — the packet-vote calculation assumed independence, and windows are correlated

The binomial transform `P(≥3 of 6 low)` assumes windows are independent draws. They are not:
they overlap 80% and describe adjacent moments of the same behaviour.

**Measured on user 1's held-out genuine windows (16 sessions, 179 windows, 99 packets):**

| quantity | value |
|---|---|
| per-window low rate | 3.35% |
| **lag-1 autocorrelation of consecutive scores** | **0.282** |
| packet false-lock, binomial (independent) | **0.073%** |
| **packet false-lock, empirical** | **4.04%** |

**The binomial figure is optimistic by 27–55×.** The previously reported "1 false lock per
~1,800 decisions" is closer to **1 per 25** on all held-out samples, and **1 per 13** once the
contaminated samples are removed (§6b).

*Caveat:* 99 packets is a small sample; 4.04% carries wide uncertainty. But the direction is not
in doubt — positive autocorrelation must inflate the tail of a majority vote, and the mechanism
(overlapping windows) is structural.

**Fix:** report empirical packet rates measured over real sessions; keep the binomial only as an
explicitly-labelled lower bound. Correct `EVALUATION.md` and the manuscript.

**✅ RESOLVED** — `services/model-api/packet_eval.py`, commit 0941333. Measured with a
session-level cluster bootstrap over 16 genuine / 40 impostor sessions:

| genuine set | sessions | packets | per-window | binomial | **measured** |
|---|---|---|---|---|---|
| all held-out | 16 | 99 | 3.41% | 0.073% | **4.04%**  CI 0.0 – 10.2% |
| clean (§6b) | 10 | 51 | 5.46% | 0.286% | **7.84%**  CI 0.0 – 19.4% |

Impostor capture, 40 unseen participants / 21,261 packets: per-window 94.67%, binomial 99.99%,
**measured 95.8%** CI 91.1 – 99.2%. Removing the contaminated samples raises the false-lock rate
for the same reason it raises the EER; with 51 packets the interval is too wide to pin down, so
the defensible claim is an order of magnitude (several percent), not a point estimate.

Correlation moves *both* figures in the pessimistic direction — impostor capture is also lower
than the independent model predicted, not just false locks. `EVALUATION.md` §4 and manuscript
§4-7 corrected; the docx was rebuilt.

---

## 3. Split-protocol classification

| protocol | keystroke base | keystroke per-user | keystroke subject-disjoint eval | mouse base |
|---|---|---|---|---|
| sample-disjoint | ✅ | ❌ (§1) | ✅ | ✅ |
| window-disjoint | ✅ | ❌ | ✅ | ✅ |
| session-disjoint | unknown | ❌ | ✅ *(verified §6b)* | ✅ |
| **user-disjoint** | **❌** | ❌ | **✅** | **✅** |
| time-disjoint | ❌ | ❌ | **❌ verified false (§6b)** — train window *encloses* the held-out window | ✅ |

**What each supports**

- Base model (overlap-aware only): supports *"recognises typing patterns within this cohort"*.
  **Does not support** *"works for a new user"* — `Rand_WS50.h5` has no subject labels, so this
  cannot be fixed from data on disk.
- Subject-disjoint per-user eval: supports *"this user's model rejects people it has never
  seen"* — at window level, for **one** user.
- Mouse: genuinely user-disjoint (20 held out), so keystroke 14.9% and mouse 23.8% are **not
  comparable**.

---

## 4. Biometric protocol audit

| aspect | finding |
|---|---|
| enrollment | user's `is_training=1` samples; 37 used for user 1 |
| genuine test | `is_training=0`, never used in training ✅ |
| genuine independence | ⚠️ **partly fails (§6b)**: sessions are distinct, but the training window *encloses* the held-out window in time, and 5 enrolment prompts appear on both sides. 20 of 78 samples yield windows at all; the largest 7 supply half. |
| impostors | 99 KeyRecs participants, unseen by base and head ✅ |
| impostor diversity | 99 people, 20 nationalities — reasonable, but a single collection context |
| task type | **open-set verification** (correctly described) |
| contamination | app users are training negatives, so they must **not** be used as impostors ✅ avoided |

---

## 5. Metric audit

| metric | level | correct? | note |
|---|---|---|---|
| AUC 0.979 | window | ✅ | Mann-Whitney with tie handling, unit-tested |
| EER 7.1% [5.6–8.8] | window | ✅ | bootstrap CI over windows |
| TAR@FAR{1,5,10}% | window | ✅ | verified the realised FAR matches the requested |
| FAR/FRR @0.50 | window | ✅ | live threshold |
| packet false-lock | **decision** | ❌ | see §2 — was binomial, must be empirical |
| `trainingAccuracy` / `balancedAccuracy` | window | ❌ | leaky split (§1) |
| dashboard accept/reject rate | decision | ✅ since relabel | usability only; no FAR |

**Bootstrap caveat:** CIs resample *windows*, which are correlated within a session. This
**understates** uncertainty. A session-level (cluster) bootstrap would be correct.

---

## 6. Generalisation across users — ✅ RESOLVED, and the headline does not generalise

Previously n = 1: only user 1 had usable held-out data, so nothing could be said about whether
7.1% (corrected: 8.42%) was typical. `services/model-api/population_sweep.py` closes this by
re-running the entire enrol-and-verify pipeline for **each of the 99 KeyRecs participants**.

**Protocol — the leakage-free version of what production does.** Positives split *temporally*
(70% enrol / 30% held out) with a **5-window gap** discarded at every boundary, because windows
overlap 80% and indices closer than 5 share rows. Training negatives come from a 40-participant
pool, evaluation impostors from a **disjoint** 40-participant pool, with the target removed from
both. Recipe copied from `api.py`: transfer from the 2-class base, Conv1D frozen, Adam 3e-4,
batch 16, 30 epochs, EarlyStopping(patience 6, restore best). The base is **reloaded per target** —
for keystroke `api.py` does `model_instance = base`, so fine-tuning mutates the loaded object and
a loop that loaded it once would have each user inherit the previous user's identity.

### Result — 99 users, 51.6 minutes

| statistic | value |
|---|---|
| EER median | **14.53%** |
| EER IQR | 9.33% – 18.27% |
| EER p10 / p90 | 6.12% / 25.90% |
| EER range | 3.80% – 38.60% |
| users above 10% EER | **68 / 99** |
| users above 20% EER | **21 / 99** |
| users below 5% EER | 5 / 99 |
| FAR @ 0.50, median | 11.13% (p90 22.73%) |
| TAR @ 0.50, median | 84.42% (p10 58.21%) |
| **TAR @ FAR = 1%, median** | **12.4%** (p10 0.6%) |

The distribution is unimodal and right-skewed — not bimodal like the mouse channel, so there is
no clean "goats" subpopulation, just a long tail of progressively harder users.

### Three consequences

**1. The published headline is a favourable case.** User 1's corrected 8.42% sits at the
**19th percentile** of this distribution (7.07% would be the 15th). Four users in five do worse.
The median deployment user faces **14.53%**, not 8%.

**2. More enrolment data is not the fix.** Correlation between enrolment size and EER across the
99 users is **r = +0.04** — indistinguishable from zero. The spread is intrinsic per-user
difficulty, not a data-volume problem, which is the same conclusion the mouse channel reached.

**3. TAR@FAR=1% collapses at the population level.** User 1's 55.6% is wildly atypical; the
median user achieves **12.4%**, and the 10th percentile **0.6%**. At a strict security budget the
system accepts almost nobody. This is the single most important number for a deployment claim and
it was never measured before.

### The "personalisation halves the error" claim is wrong — in both directions

The manuscript stated 14.9% (generic base) → 7.1% (per-user head), "roughly halving". Those two
numbers are not commensurable: the 14.9% comes from Buffalo under an overlap-aware split, and it
is not a *per-user verification* figure at all.

Tested directly — scoring 20 KeyRecs targets' held-out windows against unseen impostors with the
**generic base model**, no personalisation:

| model | AUC (verifying a specific unseen user) |
|---|---|
| generic base | **0.552 mean / 0.627 median** — chance |
| per-user heads (n=99) | **0.930 median** (p10 0.817, p90 0.986) |

So the base model **cannot verify a specific user at all** — it has no notion of *which* person it
is looking at, and its per-target AUC ranges 0.05–0.97 essentially at random. Personalisation does
not halve an error; it takes verification **from chance to AUC 0.93**. That is a far stronger
argument for the per-user architecture than the one in the manuscript — while simultaneously
showing the *final* quality (median EER 14.5%) is worse than the single-user headline implied.

**Resolves item 3 in §B — the highest-priority experiment.**

---

## 6b. 🔴 The held-out set is contaminated — and it is not a temporal holdout

Item 5 below was listed as "time-disjointness unverified". It has now been checked, and it
fails on three counts. `services/model-api/holdout_audit.py` quantifies each.

**Not a temporal holdout.** The training samples span 12 Jun – 4 Jul; the held-out samples span
6 Jun – 20 Jun. The training window *encloses* the held-out window: **all 78 held-out samples
predate the last training sample.** The protocol is therefore "enrol on some sessions, verify on
others", not "enrol now, verify later" — it cannot support any claim about behavioural drift.

**Prompt reuse across the split.** The five fixed enrolment prompts were typed twice: ids 56–60
into the held-out side (8 Jun) and ids 74–78 into the training side (12 Jun). No row is
duplicated — full-text comparison finds zero exact matches — so this is not window leakage. But
the model sees the same words on both sides, and §8 measures key identity as ~22% of its
discriminative weight, so shared content is a live inflation mechanism.

**Degenerate and duplicate samples.** Ids 66 and 67 are byte-identical (together 17% of all
held-out windows). Id 73 is the letter `x` repeated 182 times.

**Effective sample size is 20, not 196.** Only 20 of the 78 held-out samples are long enough to
yield a single 50-digraph window; 58 produce none. The largest 7 supply half of all 196 windows.
A bootstrap over windows therefore treats ~20 correlated clusters as 196 independent draws.

### Measured effect

| variant | samples | windows | EER | 95% CI |
|---|---|---|---|---|
| as published | 20 | 196 | 7.07% | 5.61 – 8.67%  *(window bootstrap)* |
| contamination removed | 14 | 118 | 8.42% | 6.59 – 10.05%  *(window bootstrap)* |
| **contamination removed, sample bootstrap** | **14** | **118** | **8.42%** | **6.03 – 11.37%** |

Contamination inflated the headline by **1.35 points**; the wrong bootstrap unit made the
interval **1.5× too narrow**. The honest single-user headline is **EER 8.42%, CI 6.0 – 11.4%**.

*Stated precisely:* the two intervals overlap (5.1 – 9.0% vs 6.0 – 11.4%), so with 14 samples
the 1.35-point shift is **suggestive, not statistically decisive**. What *is* decisive is that
the contamination exists and the published interval was computed on the wrong unit; the honest
figure must therefore be the wider one regardless of whether the point estimate moved.

> This is a correction, not a collapse. The result survives the audit — which is the outcome
> worth reporting, because it is now defensible under questioning.

**Resolves items 4 and 5 in §B.**

---

## 7. Security audit

| threat model | tested? | evidence |
|---|---|---|
| zero-effort impostor | ✅ | 99 unseen people, FAR 9.7% @0.50 |
| **mimicry (statistical)** | ✅ | α-sweep; perfect moment-matching → FAR 82%, but AUC still 0.595 |
| replay of captured events | ❌ | **untested.** Would defeat any behavioural sensor; must be stated as out of scope, not as resistance |
| generative/sequence-level forgery | ❌ | untested; α-sweep matches only first two moments |
| targeted attacker with victim's data | ❌ | untested |

**Do not claim** resistance to replay or generative attacks. The α-sweep bounds FAR from below
for a *statistical* mimic only.

---

## 8. Explainability — what it does and does not establish

Permutation importance + occlusion agree: timing **78%**, key identity **22%**.

- **Supports:** the model relies mainly on timing, i.e. behaves as a behavioural biometric.
- **Does not support:** a causal claim. Permutation importance measures *predictive reliance
  under this data distribution*, not causation. Correlated features (and `ud ≡ dd − dwell1` is
  exactly dependent) make individual attributions partly interchangeable.
- **Missing:** the ablation the request asks for — retrain **timing-only** and **identity-only**
  models. Attribution on one model is weaker evidence than two trained variants.

---

## 9. Reproducibility

| item | state |
|---|---|
| seeds | ✅ fixed in sweeps (`default_rng(7/11/21)`) and api.py |
| container versions | ✅ pinned images |
| dataset versions | ✅ KeyRecs DOI; ⚠️ `Rand_WS50.h5` has no provenance script in-repo |
| eval code | ✅ committed |
| **base dataset construction** | ❌ **no script builds `Rand_WS50.h5`** — its genuine/impostor labelling is not reproducible from this repo |
| TF determinism | ❌ not enforced; per-user fits are stochastic |

---

## 10. Best-practice comparison

| area | what we do | best practice | evidence | risk | action |
|---|---|---|---|---|---|
| base split | overlap-aware | subject-disjoint | groups verified | 🟠 | disclose; needs raw Buffalo |
| per-user split | random over overlapping windows | group by sample + dedupe | measured **100%** leak | ✅ fixed | done, §1 |
| scaler | fit on train only | same | code read | ✅ | — |
| enrollment/test separation | `is_training` flag | session-disjoint | flag verified | 🟡 | verify time-disjointness |
| impostors | 99 unseen | ≥50 unseen | ✅ | ✅ | — |
| threshold | EER on leaky val; live uses fixed 0.50 | calibrate on clean held-out | — | 🟠 | recalibrate after §1 fix |
| model selection | early stop on leaky val | clean val | — | 🟠 | fix with §1 |
| aggregation | binomial claim | empirical | measured 27–55× gap | ✅ fixed | done, §2 |
| metrics | window-level | window **and** decision | partly | 🟠 | add end-to-end |
| statistics | window bootstrap | cluster bootstrap | — | 🟡 | switch to session-level |
| generalisation | n=1 | many users | — | 🔴 | KeyRecs multi-user sweep |
| robustness | none | sessions/time/speed | — | 🟠 | acknowledge |
| security | zero-effort + statistical mimic | + replay/generative | partial | 🟡 | scope explicitly |
| explainability | attribution | + trained ablations | 1 method ×2 perturbations | 🟡 | add ablations |
| reproducibility | mostly | full | partial | 🟡 | document `Rand_WS50.h5` |

---

## A. What is scientifically proven now

*Updated after the population sweep, the held-out audit and the empirical packet measurement.*

**Strongly supported**
1. The base model's reported accuracy collapses from >99% to 85.8% under overlap-aware
   splitting — the leakage finding. Directly measured.
2. **Per-user personalisation is what makes verification possible at all.** The generic base
   scores AUC 0.552 (chance) when asked to verify a specific unseen user; per-user heads reach
   **median AUC 0.930** across 99 subjects. Measured on the same protocol (§6).
3. For user 1, the personal model separates genuine from unseen people at window level:
   **EER 8.42%, CI 6.0–11.4%** after removing contamination and using the correct bootstrap
   unit (§6b).
4. **The approach generalises, but far less well than the headline suggested.** Across 99
   subject-disjoint targets: median EER **14.53%** (IQR 9.3–18.3), 68/99 above 10%, 21/99
   above 20% (§6).
5. The model relies mainly on **timing** (78%) rather than key identity.
6. `ud` is algebraically redundant (`ud ≡ dd − dwell1`); the 6-feature set has 5 independent
   features.
7. Mouse: four methods plateau at 22–28% with the same users hard — an intrinsic ceiling.
8. **The packet vote does not deliver a near-zero false-lock rate.** Measured 4.04% (all
   held-out) / 7.84% (decontaminated) per decision, against 0.07% predicted binomially (§2).
9. **Enrolment volume does not explain per-user difficulty** — r = +0.04 across 99 users. The
   spread is intrinsic, so "collect more data" is not the remedy (§6).

**Partially supported**
10. Mimicry resistance — one attack family (moment-matching), one user.
11. Domain shift is not driving separation — suggestive; the same-app impostors were training
    negatives.

**NOT currently supported — do not claim**
12. ❌ **"Personalisation halves the error" (14.9% → 7.1%).** Retracted: the two figures are not
    commensurable, and the base cannot verify a specific user at all. Replace with the
    chance → AUC 0.93 statement in §6.
13. ❌ **"EER ≈ 7%" as a general result.** That is the 15th percentile of the population; the
    median is 14.53%.
14. ❌ Any packet/decision-level false-lock figure derived binomially (27–55× optimistic).
15. ❌ `trainingAccuracy`/`balancedAccuracy` as generalisation.
16. ❌ Resistance to replay or generative attacks.
17. ❌ Keystroke base generalises to unseen users (protocol cannot support it).
18. ❌ "Keystroke outperforms mouse" — different protocols.
19. ❌ Any claim about behavioural drift over time: the held-out set is not a temporal
    holdout (§6b).

---

## B. Critical problems, ranked

| # | problem | severity | effect | fix | time |
|---|---|---|---|---|---|
| 1 | ~~per-user split leakage~~ | ✅ | leakage was **100%**; threshold calibrated at 0.132 instead of ~0.45 | **done** — `split_no_overlap()`, §1 | — |
| 1b | ~~target's own data used as negatives~~ | ✅ | alias id contributed 44 negative samples; retrain collapsed | **done** — `aliasUserIds()`, §1b | — |
| 1c | ~~dataset negatives never loaded~~ | ✅ | wrong default path; live retrains had app-user negatives only | **done** — derive from `DATA_DIR` + preflight, §1c | — |
| 1d | ~~duplicate samples defeated grouping~~ | ✅ | same content under two sample ids; 23/165 val windows were exact copies | **done** — `dedupe_windows()`, §1d | — |
| 2 | ~~binomial packet claim~~ | ✅ | understated false-lock 55× | **done** — `packet_eval.py`, §2 | — |
| 3 | ~~n = 1~~ | ✅ | headline was the 19th percentile; median user EER **14.53%** | **done** — `population_sweep.py`, §6 | — |
| 4 | ~~window-level bootstrap~~ | ✅ | CIs 1.5× too narrow | **done** — cluster bootstrap, §6b | — |
| 5 | held-out set contaminated | ✅→🔴 | **verified and it failed**: prompt reuse + duplicate + not temporal; EER 7.07% → **8.42%** | **measured** — `holdout_audit.py`, §6b | — |
| 6 | no trained ablations | 🟡 | attribution alone is weaker | timing-only / id-only models | 3 h |

---

## C. Priority experiments

| experiment | proves | risk addressed | time | priority |
|---|---|---|---|---|
| KeyRecs multi-user sweep (~99 targets) | per-user distribution of EER | generalisation (n=1) | 4 h | **1** |
| ~~Empirical packet rates over sessions~~ | true decision-level FAR/FRR | 27–55× error | done | ✅ |
| Group-by-sample per-user split | honest training metrics + threshold | leakage | 2 h | **3** |
| Session-level bootstrap | correct CIs | correlated resampling | 1 h | 4 |
| Timing-only vs identity-only retrain | what carries the signal | causal-ish evidence | 3 h | 5 |
| Time-disjoint check on held-out set | genuine independence | hidden session leakage | 30 m | 6 |

---

## D. Final verdict

### 2 — Sound method, corrected results, honest limits

*Revised upward from category 3 after four of the six defects were measured and fixed, and
downward in the claims those measurements support.*

**What changed.** Three quantities that had been published were wrong and are now measured:
the decision-level false-lock rate (0.07% → **4.04%/7.84%**), the confidence interval unit
(1.5× too narrow), and the generalisation claim (n=1 at the 19th percentile → **median EER
14.53%** across 99 subjects). A fourth, "personalisation halves the error", was retracted and
replaced by a stronger and better-supported statement: personalisation moves verification from
chance to median AUC 0.93.

**Why category 2 rather than 3.** The defects were in the *reporting*, not the science. Every
corrected number was obtained under a clean protocol — subject-disjoint, temporally split with
an overlap gap, disjoint negative and impostor pools, cluster bootstraps on the correct unit —
and the system still works: median AUC 0.930, 95.8% impostor capture per decision. The results
survived the audit with corrections rather than retractions.

**Why not category 1.** The honest headline is uncomfortable: at a 1% FAR budget the median
user is accepted **12.4%** of the time. As a step-up trigger fused with a passkey that is
defensible; as a standalone authenticator it is not, and the thesis should say so plainly. The
population result also rests on 98 KeyRecs transcription subjects and one real in-app user, and
the held-out set is not a temporal holdout — so nothing here speaks to drift over time, the
question a deployment cares most about.

**Fixed since the first pass:** the per-user split (§1), the target's own data appearing in its
negative pool (§1b), and dataset negatives never loading (§1c). The last two were found *by*
fixing the first — the honest split turned a silent contradiction into a visible training
collapse, which is the argument for clean protocols in miniature.

**Remaining work:** #6 (timing-only vs identity-only retrains, 3 h), which upgrades the
attribution from correlational to causal. Nothing else is outstanding.
