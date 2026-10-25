# Pre-registration RU: does a profile that mixes real-use samples ask the owner for the passkey less? (25 Oct 2026)

Written and hashed before any RU code ran and before any test data existed (the test period starts 2026-10-25
21:00:00 UTC). Owner, 25 Oct 2026, stage 2 of learning from real use (TODO.md section 9): "yes, as you described",
test on his normal use from the next day, permission to export his recorded mouse movement (his account only).

## Question

The live mouse profile of the owner (user 739935229538144) is built from enrolment samples only. Since 25 Oct, four
real-use samples were recorded right after verified passkeys. Does a profile that mixes them in ask him for the
passkey less often during his later normal use, without catching impostors less often?

## Arms (deployed code path, nothing else changes)

- **A, current:** the live profile. Enrolment samples 32, 33, 35, 37, 136, 205, 206, 239 in time order (440 windows).
  Threshold 0.26208394455013234, trained 2026-10-24 15:08:29 UTC.
- **B, mix:** the newest 4 enrolment samples (136, 205, 206, 239) then real-use samples 1, 2, 3, 4, in time order
  (440 windows).
- Both are built exactly as `api.train_user_f2_payload`: the deployed network, scaler and cohort
  (artifacts/mouse-fcn-a5), 2 x 440 cohort negatives drawn with seed 21, logistic head, leave-one-sample-out scores
  over samples of 55 windows with 4 windows purged on each side, threshold = their 20th percentile.
- Decision as deployed: passkey when 33 or more of the last 60 windows score below the threshold.

## Test data (genuine side)

- His live checks from 2026-10-25 21:00:00 UTC (00:00 on 26 Oct, his time), from any client: each check's 60 windows
  (`mouse_live_windows`) with the live decision and scores (`mouse_decisions`).
- **Cut-off:** the end (20:59:59 UTC) of the first day on which the test period holds at least 1,125 non-warm-up checks
  (30 minutes of movement at one check per 1.6 s) from at least two sittings (sittings are separated by 60 minutes
  without checks). If this has not happened by 2026-10-28 20:59:59 UTC, the analysis runs on the data up to then and
  the verdict is "inconclusive" when the minimum is not met.
- **Excluded:** checks inside any on-demand step-up episode triggered for testing (logged in TODO.md with times before
  the analysis runs), and periods in which the owner reports that someone else used his computer (reported before the
  analysis runs). Nothing is excluded on the basis of scores.
- **Stream:** consecutive checks of one client overlap. The windows are joined into continuous segments by exact overlap
  (a check extends the open segment whose last windows equal its first windows; otherwise it starts a new segment).
- **Live loop replay, per arm:** the vote is evaluated at the recorded check positions. A check needs 60 windows since
  the segment start or since that arm's last request, as the live loop's buffer empties after a request.

## Impostor side

- The 20 SapiMouse development users, the deployed network's held-out users
  (artifacts/mouse-fcn-a5/holdout_users.json), not in its cohort: all windows of both sessions, disjoint blocks of 60.
- **Raw**, and **scaled** to his device. Every step is multiplied by his median step length (over A's 440 windows)
  divided by the user's own median, then rounded, as in the 25 Oct diagnostic. The same impostor windows go to both
  arms.

## Endpoints and reading rule

- **G (primary, genuine):** passkey requests per minute of movement in the replay, minutes = checks x 1.6 s / 60.
  Delta_G = B - A. 95% interval by block bootstrap over blocks of 75 consecutive checks (about 2 minutes of movement),
  10,000 resamples, seed 17. Each request counts in the block of its check. **G passes if the upper bound is below 0.**
- **I (safety, impostors):** the share of disjoint 60-window impostor decisions that ask for the passkey, pooled over
  users. Delta = B - A, raw and scaled. 95% interval by resampling the 20 users, 10,000 resamples, seed 17. **I passes
  if both lower bounds are at least -5 points.**
- **Verdict:**
  - G and I pass: "the mix is better", and switching training to the mix (stage 3) is proposed to the owner.
  - The minimum data are not met: "inconclusive", and A stays.
  - Otherwise: "keep A".

## Validity checks (all must pass before the endpoints are read)

- **V1:** A rebuilt offline gives the live threshold within 1e-9.
- **V2:** for every test check, A's offline scores equal the stored live scores within 1e-5, with the same low count and
  the same verdict.
- **V3:** A's impostor capture reproduces the 25 Oct diagnostic, 77.1% raw and 57.0% scaled, within 0.1 point.
- **V4:** his live profile is unchanged during the test period (same trained_at and threshold on every test check).
- **If a check fails:** nothing is read. The cause is fixed, a dated amendment is written below this text, and only then
  are the endpoints run.

## Reported, not used for the verdict

- Requests per arm, low-window share, per-check verdict share.
- B's threshold.
- B's low count at each check where A asked live. The replay cannot see what B would have done after a real request
  (the movement after a lock is new), which favours B.
- Impostor runs caught in the replay.
- A poisoning check: B with real-use sample 4 replaced by the first 55 windows (long session first) of the impostor
  whose raw windows B accepts most, and that impostor's raw capture under both, measured on its windows after the
  first 60.
- A smoke run on the checks before 2026-10-25 13:30:38 UTC (without the injected impostor checks of 09:54:33 to
  09:54:54 UTC), labelled as a pipeline check and not as evidence.

The code (analysis/phase7/run_ru.py) is written after this file is hashed. Its hash is recorded with every result.

## Scope

One person on one device, so a pass supports switching for him, not a general claim. The same-device human impostor
test is separate (TODO.md). Nothing in the live system, the paper or the thesis changes because of this experiment
without the owner's decision.
