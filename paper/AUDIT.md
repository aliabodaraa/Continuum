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

- **96.2%** of validation windows have an immediate same-sample neighbour in training
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
| **subject-disjoint AUC 0.979 / EER 7.1%** | ✅ **unaffected** — genuine from `is_training=0` (never trained on), impostors from KeyRecs (never seen) |

**Fix:** group windows by source sample (`keystroke_text_id`) and split by group, exactly as
`compute_overlap_groups` does for the base model. Then re-fit and re-measure.

**Verification:** after the fix, `balancedAccuracy` should *drop* materially. If it does not,
the split is still leaking.

---

## 2. 🔴 CRITICAL — the packet-vote calculation assumed independence, and windows are correlated

The binomial transform `P(≥3 of 6 low)` assumes windows are independent draws. They are not:
they overlap 80% and describe adjacent moments of the same behaviour.

**Measured on user 1's held-out genuine windows (16 sessions, 179 windows, 99 packets):**

| quantity | value |
|---|---|
| per-window low rate | 3.35% |
| **lag-1 autocorrelation of consecutive scores** | **0.282** |
| packet false-lock, binomial (independent) | **0.070%** |
| **packet false-lock, empirical** | **4.04%** |

**The binomial figure is optimistic by roughly 58×.** The previously reported "1 false lock per
~1,800 decisions" should be closer to **1 per 25**.

*Caveat:* 99 packets is a small sample; 4.04% carries wide uncertainty. But the direction is not
in doubt — positive autocorrelation must inflate the tail of a majority vote, and the mechanism
(overlapping windows) is structural.

**Fix:** report empirical packet rates measured over real sessions; keep the binomial only as an
explicitly-labelled lower bound. Correct `EVALUATION.md` and the manuscript.

---

## 3. Split-protocol classification

| protocol | keystroke base | keystroke per-user | keystroke subject-disjoint eval | mouse base |
|---|---|---|---|---|
| sample-disjoint | ✅ | ❌ (§1) | ✅ | ✅ |
| window-disjoint | ✅ | ❌ | ✅ | ✅ |
| session-disjoint | unknown | ❌ | ⚠️ unverified | ✅ |
| **user-disjoint** | **❌** | ❌ | **✅** | **✅** |
| time-disjoint | ❌ | ❌ | ⚠️ unverified | ✅ |

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
| genuine independence | ⚠️ **unverified** whether held-out samples are from *different sessions/days* — only that they were not trained on. Time-disjointness is not established. |
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

## 6. Generalisation across users — the largest gap

Only **user 1** has usable held-out data (78 samples). Every other enrolled user has 0–1.
So the headline result is **n = 1**.

The mouse channel is the cautionary precedent: per-user EER there ranged **0%–47%**. A single
user's 7.1% cannot be assumed representative.

**Feasible fix with data already on disk:** treat each KeyRecs participant as a target — train a
per-user head on their windows, evaluate against the other 98 as impostors. That yields a
distribution (median, IQR, min, max) across ~99 users. This is the single most valuable
outstanding experiment.

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
| per-user split | random over overlapping windows | group by sample | measured 96.2% leak | 🔴 | fix + re-measure |
| scaler | fit on train only | same | code read | ✅ | — |
| enrollment/test separation | `is_training` flag | session-disjoint | flag verified | 🟡 | verify time-disjointness |
| impostors | 99 unseen | ≥50 unseen | ✅ | ✅ | — |
| threshold | EER on leaky val; live uses fixed 0.50 | calibrate on clean held-out | — | 🟠 | recalibrate after §1 fix |
| model selection | early stop on leaky val | clean val | — | 🟠 | fix with §1 |
| aggregation | binomial claim | empirical | measured 58× gap | 🔴 | report empirical |
| metrics | window-level | window **and** decision | partly | 🟠 | add end-to-end |
| statistics | window bootstrap | cluster bootstrap | — | 🟡 | switch to session-level |
| generalisation | n=1 | many users | — | 🔴 | KeyRecs multi-user sweep |
| robustness | none | sessions/time/speed | — | 🟠 | acknowledge |
| security | zero-effort + statistical mimic | + replay/generative | partial | 🟡 | scope explicitly |
| explainability | attribution | + trained ablations | 1 method ×2 perturbations | 🟡 | add ablations |
| reproducibility | mostly | full | partial | 🟡 | document `Rand_WS50.h5` |

---

## A. What is scientifically proven now

**Strongly supported**
1. The base model's reported accuracy collapses from >99% to 85.8% under overlap-aware
   splitting — the leakage finding. Directly measured.
2. For user 1, the personal model separates genuine from 99 unseen people at **window level**:
   AUC 0.979 [0.974–0.984], EER 7.1% [5.6–8.8]. Clean protocol on both sides.
3. The model relies mainly on **timing** (78%) rather than key identity.
4. `ud` is algebraically redundant (`ud ≡ dd − dwell1`); the 6-feature set has 5 independent
   features.
5. Mouse: four methods plateau at 22–28% with the same users hard — an intrinsic ceiling.

**Partially supported**
6. "Personalisation halves the error" — compares a level-2 base (14.9%) with a level-3 per-user
   result (7.1%). Different protocols; directionally sound, not a clean comparison.
7. Mimicry resistance — one attack family (moment-matching), one user.
8. Domain shift is not driving separation — suggestive; the same-app impostors were training
   negatives.

**NOT currently supported — do not claim**
9. ❌ "Works for users in general." n = 1.
10. ❌ Any packet/decision-level false-lock figure derived binomially (58× optimistic).
11. ❌ `trainingAccuracy`/`balancedAccuracy` as generalisation.
12. ❌ Resistance to replay or generative attacks.
13. ❌ Keystroke base generalises to unseen users (protocol cannot support it).
14. ❌ "Keystroke outperforms mouse" — different protocols.

---

## B. Critical problems, ranked

| # | problem | severity | effect | fix | time |
|---|---|---|---|---|---|
| 1 | per-user split leakage | 🔴 | inflates training metrics, corrupts threshold + early stopping | group-by-sample split | 2 h |
| 2 | binomial packet claim | 🔴 | understates false-lock 58× | report empirical | 1 h |
| 3 | n = 1 | 🔴 | no generalisation evidence | KeyRecs multi-user sweep | 4 h |
| 4 | window-level bootstrap | 🟠 | CIs too narrow | cluster bootstrap | 1 h |
| 5 | time-disjointness unverified | 🟠 | genuine set may be same-session | check timestamps | 30 m |
| 6 | no trained ablations | 🟡 | attribution alone is weaker | timing-only / id-only models | 3 h |

---

## C. Priority experiments

| experiment | proves | risk addressed | time | priority |
|---|---|---|---|---|
| KeyRecs multi-user sweep (~99 targets) | per-user distribution of EER | generalisation (n=1) | 4 h | **1** |
| Empirical packet rates over sessions | true decision-level FAR/FRR | 58× error | 1 h | **2** |
| Group-by-sample per-user split | honest training metrics + threshold | leakage | 2 h | **3** |
| Session-level bootstrap | correct CIs | correlated resampling | 1 h | 4 |
| Timing-only vs identity-only retrain | what carries the signal | causal-ish evidence | 3 h | 5 |
| Time-disjoint check on held-out set | genuine independence | hidden session leakage | 30 m | 6 |

---

## D. Final verdict

### 3 — Promising results but methodology must be corrected

**Why not "strong and defensible":** two reported quantities are wrong. The per-user training
pipeline leaks (96.2% of validation windows are near-duplicates of training windows), and the
decision-level false-lock rate — the metric that describes what the system actually does — was
computed under an independence assumption the data violates by a factor of ~58.

**Why not "cannot be trusted":** the core window-level result is measured under a clean
subject-disjoint protocol with genuine data never used in training and impostors never seen by
any model, with confidence intervals and unit-tested metric code. It survives this audit intact.
The leakage affects *training-time reporting*, not that measurement.

**What must happen before presenting:** fix #1 and #2 (3 hours), run the multi-user sweep (#3),
and restate every claim in section A's "not supported" list as future work. With those done, the
work moves to category 2 and plausibly 1 for the keystroke channel.
