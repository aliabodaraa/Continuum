# Experiment AR: adaptive retraining (results)

Pre-registration: `artifacts/phase4/PREREGISTRATION_AR.md` (sha256 56f657c4), frozen 2026-10-03T09:44Z with
its code and data in `PREREGISTRATION_AR.sha256`, before any result. Run: 99 KeyRecs targets in the
model-api container (`run_ar.py`, batches of 10 targets per process, 09:45Z-12:25Z, no failure);
analysis once (`analyze_ar.py` -> `artifacts/phase4/ar_result.json`, `ar_result.txt`). One target was not
eligible (session 2 too short), so n = 98. Asked by the supervisor through the OWNER (3 Oct 2026).

## Question and design (short)

Does the deployed adaptive loop make a user's model better on their later typing? Each target enrols on 5
samples of 330 steps from session 1; the rest of session 1 and the first half of session 2 become "days"
of 330 steps (median 6 per user; time is compressed: one day = one chunk); the test is the second half of
session 2 against the 40 KS impostors. Models use KS's live recipe (Aalto A200 negatives).

| Arm | Learns from |
| --- | --- |
| A | nothing after enrolment |
| B | days that pass the deployed gates (rolling mean of the last 18 windows >= 0.80, each of the last 6 >= 0.80, rhythm z <= 3); retrain after 3 |
| C | days on which the live rule locks (the genuine user then passes the passkey); retrain after 3 |
| D | every day (upper bound) |
| R | nothing new, retrained with another seed (noise reference) |

## Results (98 targets, 20-window decisions on the session-2 test)

| | A | B (deployed) | C (from the lock) | D (all days) | R (noise) |
| --- | --- | --- | --- | --- | --- |
| Per-user decision AUC | 0.919 | 0.920 | 0.941 | 0.967 | 0.922 |
| Live rule FRR (per-user mean) | 13.3% | 13.7% | 6.4% | 3.7% | 12.3% |
| Live rule FAR (per-user mean) | 15.0% | 14.2% | 16.2% | 12.7% | 14.9% |
| Genuine locks per 100 test windows (lock-rule replay) | 1.23 | 1.26 | 0.58 | 0.40 | 1.21 |
| Pooled decision EER | 14.1% | 13.7% | 11.7% | 8.4% | 13.9% |

Contrasts in per-user AUC (paired bootstrap, 10,000, seed 17):

- **Primary, B - A: +0.0013 [+0.0003, +0.0025]**, better for 13/98 (SE 0.0006, MDE80 0.0016). By the
  pre-registered rule this counts as **an improvement**; its size is about one thousandth of AUC: real but
  practically negligible, and smaller than what a retrain alone moves (R - A +0.0033 [-0.0024, +0.0092]).
- C - A +0.0221 [+0.0072, +0.0403]; D - A +0.0485 [+0.0307, +0.0681]; C - B +0.0208 [+0.0058, +0.0391];
  D - B +0.0472 [+0.0294, +0.0671].
- Live-rule FRR: B - A +0.4 pts [-0.6, +1.8]; C - A -7.0 pts [-11.3, -3.3]; D - A -9.6 pts [-14.1, -5.6].
- Live-rule FAR: B - A -0.8 pts [-1.5, -0.3]; C - A **+1.2 pts [+0.3, +2.3]**; D - A -2.3 pts [-3.8, -0.8].
- Genuine locks per 100 windows: B - A +0.03 [0.00, +0.10]; C - A -0.65 [-1.06, -0.31]; D - A -0.83.

So B captures about 3% of the gain that later typing can give (D), and C about 46%.

## Applicability

- B accepted 139 of 611 days (23%), 1.4 per user; only **24 of 98 users** reached a retrain within their
  days (27 retrains). C added 98 days (16%); 18 users retrained. The first retrain came after the 4th day
  (median) in both: with one contribution per day, at least three days of real use.
- B's rejections: rolling mean below 0.80 (374), one window below 0.80 (98); **the rhythm check rejected
  nothing** (largest z 1.64 against a limit of 3: it compares a sample's mean with the spread of single key
  pairs, so it cannot bind).
- A retrain takes 15 s (median) in this setting.

## Safety

- **S1, gates against impostors** (enrolment model): 24.4% of genuine days pass, and **1.57% of impostor
  chunks (61 of 3,880)**; 25 of 98 targets had at least one impostor chunk that would be accepted.
- **S2, forced poisoning** (the most similar impostor's three chunks added regardless of the gates): that
  attacker's later decisions accepted rose from 84.8% to **94.6% (+9.8 pts [+5.6, +14.5])**; the target's
  genuine FRR moved from 13.3% to 14.4%. 37% of those poison chunks would have passed the gates.

## Exploratory (not pre-registered)

- Among the 24 users B retrained: AUC +0.005 mean (+0.002 median), 13 better, 7 worse. Among the 18 users C
  retrained: +0.120 mean (+0.050 median), 14 better, 3 worse.
- Why B adds so little: the days it accepts already score high (median rolling mean 0.907) and the days it
  rejects are the ones the model finds hard (0.679), which are exactly the typing that causes false locks.
  The loop reinforces what the model already recognises (confirmation bias), as any self-update that adds
  only what the model itself accepts must.

## Reading

1. **Benefit.** The deployed loop is safe-ish but nearly useless as built: its gates admit only typing the
   model already likes, so a retrain changes little, and most users never reach one.
2. **Learning from the lock** (C) is where the benefit is: false locks halve (FRR 13.3% -> 6.4%), at a
   small FAR cost (+1.2 pts), with each sample confirmed by the passkey. It is a design proposal, not
   deployed; it needs the OWNER's decision and a real-user test.
3. **More of the user's own typing from use helps a lot** (D: AUC +0.049, FRR 13.3% -> 3.7%). This design
   cannot separate "more data" from "later data": D adds about six days of windows to a five-sample
   enrolment. (The 13.3% FRR here is not comparable with KS's 3.3%, which enrolled on 70% of all typing.)
4. **Safety.** The gates stop 98.4% of impostor stretches, but an attacker who gets three samples in
   (37% of the most similar attacker's chunks would pass) raises their own acceptance by about 10 points.
   The one-per-day cap and the retrain-after-three rule slow this down; they do not prevent it.

## Limits

KeyRecs has two recording sessions, not daily use: days are compressed chunks and the drift is between two
sessions. The user is assumed to accept every offer (upper bound on uptake). C assumes every lock on
genuine typing ends with a passed passkey. The models start from the experiment's base (as in KS), not the
deployed weights. KeyRecs was used before (KS), but no setting here was chosen on it.
