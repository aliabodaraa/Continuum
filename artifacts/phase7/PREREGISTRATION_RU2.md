# Pre-registration RU2: does a profile that also learns the owner's reading movement, taken right after his passkey unlocks the account, ask him for the passkey less, without catching impostors less? (22 Nov 2026)

Written and hashed before any data of this experiment existed: the capture of his check windows is switched on only
after this file is committed. The design follows RU (PREREGISTRATION_RU.md, sha256 72786bf8...d80d1d), which stays as it
was. Only the source of the real-use samples, the periods and the action after the verdict differ.

## Why

Since 14 Nov the owner (user 739935229538144) has been asked for the passkey by the mouse channel again and again,
through the extension, while he reads: he points along the line he has reached, with or without selecting the text. His
enrolment (dot targets) and his demo use score 0 to 8 low windows of 60; reading scores 15 to 37, and the vote asks at
33. The code that builds the windows is the same in the extension and the SDK, and his profile has not changed since
24 Oct. RU could not answer this: its 10-minute test period held no request under either arm. He asked for it to be
fixed with no action from him: "انا لا اريد ان افعل شي انت ان استطعت افعل واخبرني". So the real-use samples come from
his ordinary checks, not from the popup.

## Arms (deployed code path, nothing else changes)

- **A, current:** the live profile. Enrolment samples 32, 33, 35, 37, 136, 205, 206, 239 in time order (440 windows).
  Threshold 0.26208394455013234, trained 2026-10-24 15:08:29 UTC.
- **B, mix:** the newest 4 enrolment samples (136, 205, 206, 239) then post-unlock samples U1, U2, U3, U4, in time
  order (440 windows).
- Both are built exactly as `api.train_user_f2_payload`, as in RU: the deployed network, scaler and cohort
  (artifacts/mouse-fcn-a5), 2 x 440 cohort negatives drawn with seed 21, logistic head, leave-one-sample-out scores over
  samples of 55 windows with 4 windows purged on each side, threshold = their 20th percentile.
- Decision as deployed: passkey when 33 or more of the last 60 windows score below the threshold.

## Post-unlock samples

- **Source:** the 60 windows of each of his mouse checks, kept by ca-service while MOUSE_LIVE_CAPTURE_USERS holds his id
  (`mouse_live_windows` joined with `mouse_decisions`), from the moment the capture is switched on.
- **Unlock episode:** a lock is set by a check that asks for the passkey (a non-warm-up mouse check with suspicious = 1,
  or a typing decision with passkey_triggered = 1), and while the account is locked nothing is checked or stored. The
  first stored non-warm-up mouse check after such a lock therefore comes after his passkey cleared it, and both clients
  empty their buffers at that moment, so all 60 of its windows are his movement after the passkey. That check starts
  the episode.
- **Sample:** the first 55 windows, in time order, of the episode's first check.
- **Which episodes:** in time order, each at least 3 hours after the previous chosen one (the deployed real-use gap).
  A sample is also put through the enrolment's own checks (step spread of at least 5 px, repeated-movement share at
  most 5% against the other samples of B); an episode whose sample fails is skipped and the next one is taken.
- **Collection ends** when U4 exists. If U4 does not exist by 2026-11-29 20:59:59 UTC, the verdict is "inconclusive"
  and A stays.

## Test data (genuine side)

- His stored checks from 60 minutes after the start of U4's episode, from any client, each with its 60 windows and the
  live decision and scores.
- **Cut-off:** the end (20:59:59 UTC) of the first day on which the test period holds at least 1,125 non-warm-up checks
  (30 minutes of movement at one check per 1.6 s) from at least two sittings (sittings are separated by 60 minutes
  without checks). If this has not happened within 4 days of the test start, the analysis runs on the data up to then
  and the verdict is "inconclusive" when the minimum is not met.
- **Excluded:** checks inside any on-demand or injected test (logged in COORDINATION.md with times before the analysis
  runs), and periods in which the owner reports that someone else used his computer (reported before the analysis runs).
  Nothing is excluded on the basis of scores.
- **Stream and replay:** as RU. Consecutive checks of one client are joined into continuous segments by exact overlap,
  and the vote is evaluated at the recorded check positions; a check needs 60 windows since the segment start or since
  that arm's last request.

## Impostor side

As RU: the 20 SapiMouse development users held out of the deployed network (artifacts/mouse-fcn-a5/holdout_users.json),
all windows of both sessions in disjoint blocks of 60, raw and scaled to his median step over A's 440 windows. The same
impostor windows go to both arms.

## Endpoints and reading rule

- **G (primary, genuine):** passkey requests per minute of movement in the replay, minutes = checks x 1.6 s / 60.
  Delta_G = B - A. 95% interval by block bootstrap over blocks of 75 consecutive checks, 10,000 resamples, seed 17.
  **G passes if the upper bound is below 0.**
- **I (safety, impostors):** the share of disjoint 60-window impostor decisions that ask for the passkey, pooled over
  users. Delta = B - A, raw and scaled. 95% interval by resampling the 20 users, 10,000 resamples, seed 17. **I passes if
  both lower bounds are at least -5 points.**
- **Verdict and action:**
  - G and I pass: "the mix is better". B becomes his live profile: U1 to U4 are added to his mouse samples and his
    profile is rebuilt through the training queue (it is built from the newest eight samples, which are then B's).
    Undo: delete the four samples and rebuild, which gives A again.
  - The minimum data are not met: "inconclusive", and A stays.
  - Otherwise: "keep A".
- After the verdict the capture is switched off (`kubectl -n continuum set env deployment/ca-service
  MOUSE_LIVE_CAPTURE_USERS-`).

## Validity checks (all must pass before the endpoints are read)

- **V1:** A rebuilt offline gives the live threshold within 1e-9.
- **V2:** for every test check, A's offline scores equal the stored live scores within 1e-5, with the same low count and
  the same verdict.
- **V3:** A's impostor capture reproduces the 25 Oct diagnostic, 77.1% raw and 57.0% scaled, within 0.1 point.
- **V4:** his live profile is unchanged from the start of collection to the cut-off (same trained_at and threshold on
  every stored check).
- **V5:** each of U1 to U4 comes from the first stored check after a lock, its check is non-warm-up and holds 60
  windows, and no test check lies before U4's episode start plus 60 minutes.
- **If a check fails:** nothing is read. The cause is fixed, a dated amendment is written below this text, and only then
  are the endpoints run.

## Reported, not used for the verdict

- Requests per arm, low-window share, per-check verdict share.
- B's threshold.
- B's low count at each check where A asked live. The replay cannot see what B would have done after a real request
  (the movement after a lock is new), which favours B.
- A poisoning check as in RU: B with U4 replaced by the first 55 windows of the impostor whose raw windows B accepts
  most, and that impostor's raw capture under both, measured on its windows after the first 60.

## Data and code

- His windows stay in the service's database. The analysis reads an export kept outside the repository and writes
  only aggregates (ru2_result.json and .txt in artifacts/phase7).
- The analysis code (services/model-api/analysis/phase7/run_ru2.py, reusing run_ru.py's building, replay and
  intervals) is written after this file is frozen and before any test-period data is read. Its hash is reported with
  the result.
- Not in the paper or the thesis: this is the owner's own profile, as RU was.
