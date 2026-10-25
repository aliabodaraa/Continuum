# Experiment PR: asking for the passkey only when the mouse suspicion persists (23 Oct 2026)

**Setup.**
- Pre-registration: `artifacts/phase7/PREREGISTRATION_PR.md` (sha f7458474, frozen before the code ran).
- Script: `services/model-api/analysis/phase7/run_pr.py`. Result: `artifacts/phase7/pr_result.json` and `.txt`.
- System: paper Table 6's own system (the FS network, F2 head, 440-window enrolment, 19 development users).
- Impostors: each contributes the whole 1-minute session (mean 224 windows, about 60 s) instead of 150 windows.
- Validity: the scores equal the stored FS units (maximum difference 6.7e-16). Rule A1 on runs cut at 150 windows gives
  0.37 requests per minute and 97.0% caught, which is Table 6's live loop.

## Result (requests are per minute of the legitimate user's movement, checks every 1.6 s)

| Rule | Requests per min | Users never asked | Impostor sessions caught | Mean time to catch | Caught vs A1, 95% interval | Acceptable |
|:--|:--:|:--:|:--:|:--:|:--:|:--:|
| A1, deployed (first suspicious check) | 0.37 | 79% | 98.1% | 18.1 s | | |
| A2 | 0.32 | 79% | 97.0% | 19.8 s | -1.1 [-2.2, -0.3] | yes |
| A3 | 0.25 | 84% | 96.7% | 21.4 s | -1.4 [-2.8, -0.3] | yes |
| A4 | 0.25 | 84% | 95.8% | 23.1 s | -2.2 [-4.4, -0.6] | yes |
| **A6** | **0.14** | **89%** | **95.3%** | **26.5 s** | **-2.8 [-5.0, -0.8]** | **yes, at the margin** |
| A8 | 0.14 | 89% | 94.5% | 30.0 s | -3.6 [-5.8, -1.7] | no |
| A11 | 0.10 | 95% | 90.0% | 34.2 s | -8.0 [-12.5, -4.2] | no |
| B2 (two independent decisions) | 0.10 | 95% | 91.1% | 34.1 s | -6.9 [-11.1, -3.3] | no |
| B3 | 0.05 | 95% | 70.1% | 49.6 s | -28.0 [-34.1, -22.4] | no |

**Pre-registered recommendation:** A6, a request after six consecutive suspicious checks, that is a suspicion that
lasts about 8 seconds.
- Requests fall from 0.37 to 0.14 per minute of movement (-0.23 [-0.50, 0.00]).
- Impostor sessions caught fall from 98.1% to 95.3%. The lower bound is -4.99 points, just inside the -5 margin.
- Impostors are caught about 8 seconds later.

## Reading

1. **Waiting for the suspicion to persist works as intended.**
   - Most of a legitimate user's suspicious moments are short.
   - An impostor's suspicion lasts, so most impostors are still caught, only later.
   - Two independent decisions (B2) wait longer than A6 and lose more capture than the margin allows.
2. **A3 is a safer middle point.** It gives a third fewer requests than A1, loses only 1.4 points of capture and adds
   3 s to the time to catch. A3 dominates A4: the same request rate, with more caught, sooner.
3. **Even A6 is not "rare" for a full day of use.** One request per 7 minutes of movement remains frequent. Making
   requests rare needs another lever:
   - learning from real-use movement, which closes the enrolment-to-use gap of RESULTS_OWNER_MOUSE.md;
   - or using the mouse as a supporting signal that raises the typing check rather than asking on its own.

## Deployment, if chosen

The rule is the live streak. The ca-service `updateMouseStreak` follows the same three rules as A_S:
- a warm-up check leaves the count unchanged;
- a non-suspicious check clears it;
- a suspicious check adds one.

The threshold is the constant `MOUSE_STRIKES_TO_LOCK = 1` in `services/gateway/server.js`, and `STRIKES_TO_LOCK` in
`apps/demo/routes/auth/mouse.js`. Changing it is a code edit plus a gateway (and demo) rebuild and rollout. Nothing was
changed. The decision is the owner's.
