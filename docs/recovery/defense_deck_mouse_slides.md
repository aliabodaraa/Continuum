# Defense deck: corrected mouse slides (35, 46, 47, 48)

**What changes, and why**

- **The 0.25 cutoff goes.** Slide 48 marks 0.25 as "adopted" and says it "cannot be accused of being tuned to flatter the result". 0.25 was picked after seeing the results, so that claim can't stay.
- **No single global cutoff replaces it, not even 0.50.** Mouse scores aren't comparable across users. On the 20 untouched users, S1's personal thresholds run from **0.049 to 0.983** (median 0.250).
- **The rule is out of date.** Slides 35 and 46–48 still describe S0 (1st percentile, 30 of 60, 330 windows). Since 23 Sep the deployed rule is S1.

**How every mouse number is reported now**

1. **Headline: EER and ROC AUC.** These need no threshold.
2. **The deployed rule as one operating point,** fixed in advance from enrolment data.
3. **FRR at a fixed false-accept budget** (1%, 5%, 10%) instead of a hand-picked cutoff.

All numbers below: S1 as deployed, on lockbox 1 (20 users never used for any design choice).

- **Operating point:** from the pre-registered P6 test (`analysis_J_P6.json`).
- **Everything else:** post hoc on that spent lockbox (`services/model-api/analysis/phase1/deck_mouse_s1.py` → `artifacts/phase1/deck_mouse_s1.json`), so label it exploratory.

---

## Slide 35: Enrollment, decision rule and personal threshold

**Enrollment**
- A sample is 55 windows (about 16 s) and saves itself when complete.
- **8 samples = 440 windows (about 2 min)** build the profile. It was 6 samples / 330 windows before 23 Sep.
- A sample is refused if its step-size spread (Q3 − Q1) is under 5 px.

**The live rule (S1, deployed 23 Sep 2026)**
- **Threshold** = the **20th percentile of the user's leave-one-sample-out scores**: 8 fold models each score the one sample they never saw.
- **Vote:** the session is flagged when **33 of the last 60 windows** fall below that threshold. It is re-checked every 6 new windows (about 1.6 s), and the buffer empties after a prompt.
- Code: `THRESHOLD_PERCENTILE = 20`, `THRESHOLD_SOURCE = "leave-one-sample-out"`, `VOTE_N = 60`, `VOTE_K = 33` (`services/ca-service/lib/mouse.js`).

**Why out-of-sample scores**
- The old threshold (1st percentile of the model's scores on its own training windows) collapsed to 0.009–0.054 for some users.
- It also moved with the order of the enrolment samples, for all 19 development users.
- Out-of-sample scores show what the model gives movement it has not seen, which is what live use is.

**Why a personal threshold, not one number for everyone**
- On the 20 untouched users, S1's personal thresholds span **0.049 to 0.983**. No single cutoff (0.25, 0.50 or any other) means the same thing for two users.

---

## Slide 46: mouse rows (replace the mouse table)

S1 on 20 untouched users (lockbox 1). "pct" = each window's percentile within the user's own out-of-sample scores, which puts every user on the same scale.

| Metric | Single window (1.3 s) | Decision: 60 windows (17.2 s) |
| --- | --- | --- |
| EER, pooled (pct) | 21.4% | **10.5%** |
| ROC AUC, pooled (pct) | 0.860 | **0.954** |
| ROC AUC, mean per user | 0.879 | 0.968 |
| FRR at FAR = 1% | 87.9% | 76.1% |
| FRR at FAR = 5% | 63.4% | 31.3% |

**The deployed S1 rule, fixed in advance** (pre-registered P6 test):
- **95.0%** of 40-s impostor runs caught;
- **0.33** false prompts per minute of movement;
- 16 of 20 users never prompted.

On 17.2-s decisions, the same rule sits at FAR 12.1%, FRR 4.5%.

**Footnote for the slide:**
- The decision-level figures rest on 67 genuine and 760 impostor decisions, and are post hoc on a spent lockbox.
- The pre-registered P6 test did not adopt S1: its prompt increase (+0.15/min) missed the +0.10 margin. S1 is deployed as a disclosed deviation.

---

## Slide 47: mouse ROC curves

Replace `fig19_mouse_roc.png` with **`artifacts/phase1/deck_mouse_s1_roc.png`**.

Caption: *Aggregating 60 windows into one decision lifts pooled AUC from 0.860 to 0.954 and halves EER (21.4% → 10.5%). The red point is the deployed S1 rule (20th percentile, 33 of 60), one operating point on the same axes. No global cutoff is marked, because the deployed system doesn't use one.*

---

## Slide 48: fixed false-accept budgets instead of a chosen cutoff

| False-accept budget | FRR, single window | FRR, 17.2-s decision |
| --- | --- | --- |
| FAR = 1% | 87.9% | 76.1% |
| FAR = 5% | 63.4% | 31.3% |
| FAR = 10% | 45.0% | 11.9% |
| **Deployed S1 rule** | – | FAR 12.1%, FRR 4.5% |

**Reading**
- The thresholds in this table are set by the false-accept budget, not by looking at the results. EER and AUC use no threshold at all.
- The deployed system uses none of these global cutoffs. It uses each user's own 20th percentile of out-of-sample scores, shown here as its own point.
- At a strict 1% budget, three genuine decisions in four would be refused. That is why mouse is a step-up trigger behind the passkey, not a gate.

**Speaker note, if asked "why not 0.50?"**
> Mouse scores aren't calibrated across users; personal thresholds span 0.05–0.98. Any single cutoff is arbitrary. So I report threshold-free EER and AUC, FRR at fixed false-accept budgets, and the deployed personal rule as measured on untouched users.

---

## Other places to fix

- **0.25 elsewhere.** If the manuscript (`Continuum_manuscript_ar.docx`) or an earlier deck reports the 0.25 cutoff as chosen or adopted, replace it the same way. If a version with 0.25 was already shared, add a one-line correction there.
- **Keystroke slides** (23, 25–27, 46, 49, 50, 51) still say "3 of 6". The live keystroke rule has been **10 of 20** since 23 Sep (commit d7c7682). The 0.50 window cutoff stays: that is Lu et al.'s rule.
