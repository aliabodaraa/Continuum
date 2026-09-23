# Pre-registration — Experiment I: an operating point chosen by how often a genuine user is interrupted

Written 2026-09-13, **before any Experiment I code had run on data**. Its SHA-256 is recorded in every
Experiment I result. Protocol items not restated here are those of `PREREGISTRATION_F.md` and
`PREREGISTRATION_G.md`.

## Why this experiment exists

Experiments F and G chose the operating point with a budget on the **per-decision** false-lock rate
(median over users ≤ 1% on calibration). A decision is taken at every new window, i.e. every ~0.27 s
of movement, so a small per-decision rate still means frequent interruptions: at F's deployed point
53% of genuine users are prompted at least once within the ~30 s test half, and a user reported
being prompted repeatedly right after enrolling. What a genuine user experiences is **how many
passkey prompts per minute of mouse movement** the channel produces. This experiment measures that
directly, by replaying the live decision loop, and chooses the operating point on it.

## Simulation of the live loop (identical for every operating point)

Scores are taken in their recorded order. At each new window the rule is evaluated on the last n
windows; when it fires, a prompt is counted and the buffer is emptied (as the deployed code does when
the passkey is verified), so the next decision needs n new windows. One window = 10 steps at
0.0269 s per step = 0.269 s of movement.

* Genuine: prompts per minute of movement = prompts ÷ (windows in the stream × 0.269 s ÷ 60).
* Impostor: each other held-out user's contiguous 150-window run (~40 s); caught = at least one prompt
  in the run; time to catch = movement until the first prompt.

## Data

* Primary: `parts/F_new.json` — the deployed server model (Experiment F), 19 held-out users, with its
  per-user threshold source unchanged (q-th percentile of enrolment scores, as deployed and as kept
  by Experiment H).
* Secondary (reported, decides nothing for the server): `parts/G_device.json` — the extension's model,
  3 seeds.
* Calibration and test halves exactly as in Experiments A–G (first/second half of the genuine
  1-minute session; alternating impostor identities).

## Candidate operating points

q ∈ {1, 2, 5, 10, 15, 20, 30, 40, 50}; rules: k-of-n vote (k from ⌈n/2⌉ to n), mean, median;
n ∈ {20, 40, 60} windows (about 6, 12 and 17 s of movement).

## Selection (calibration halves, all users pooled)

Among operating points whose **mean genuine prompts per minute ≤ 0.2** (at most one false prompt per
five minutes of movement, on average), choose the one that **catches the largest share of impostor
runs**; ties broken by the shorter median time to catch, then by the smaller n. If none meets 0.2,
the budget is relaxed to 0.5, then 1.0.

## Endpoints (test halves)

Primary: mean genuine prompts per minute of movement (per user, then averaged). Also: its median,
the share of users never prompted, the share of impostor runs caught, the median time to catch, and
the share of impostor runs never caught.

## Decision rule, fixed in advance

The Experiment-I operating point replaces the deployed one (F: 5th percentile, 12 of 20) if, on the
test halves, (a) its mean genuine prompts per minute is significantly lower than the deployed point's
(paired bootstrap over users, 10,000 resamples, two-sided p < 0.05) and (b) it still catches at least
90% of impostor runs. Otherwise the deployed point stays. The extension applies the same selection to
its own model (calibration halves pooled over target and seed, as in G-2) only if (a) and (b) also
hold for it on its test halves (per-user rates averaged over its 3 seeds; its deployed point is the
10th percentile, 14 of 20).

## Limits stated in advance

Each test half holds about 100 genuine windows (~27 s), so a single prompt in a half is ~2 per minute
for that user: per-user rates are coarse, and the mean over 19 users resolves about 0.1 per minute.
The sessions are one task on one day; free-browsing movement, which is what a deployed user produces,
may be scored lower and prompt more often than measured here.

## What would change the plan

Nothing in this file changes after Experiment I results exist.
