# Recovery plan: handoff (updated 2026-09-26)

Start a session with: *"Read RECOVERY_HANDOFF.md and continue."*

## Where things are

- **Plan:** "Continuum Recovery Plan: Mouse & Keystroke",
  https://claude.ai/code/artifact/83f2cea6-8e1b-4a46-9614-e12d2186ba24. Phases 0-4, targets, prompts.
- **Branch:** `experiment/recovery-plan`, pushed; see the commit list below. `experiment/ablation-timing-identity`
  stays at `e7d91f2`: all work up to 2026-09-19 in one commit, without the two `ca.db.*.bak` backups.
  `.gitignore` has `*.db.*`, `*.db-*`, `*.bak`.

## Standing rules (from HANDOFF.md, still binding)

- Commit messages never mention Anthropic, Claude or AI tooling, and carry no co-author line.
- Nothing is committed or pushed without asking the owner first.
- Never commit databases, backups, per-user models or datasets. Check with
  `git diff --cached --name-only` before any commit.
- Git Bash + Docker on Windows: prefix `docker exec` with `MSYS_NO_PATHCONV=1`.
- Pre-registration discipline: write and hash the plan before running any confirmatory code, and
  never read lockbox data outside its phase.

## Status 2026-09-26, 07:00 (LOCAL)

- **Two LOCAL sessions share this folder** (see ListAgents): "handoff notes review" does **T4.3** (user study:
  `extension/*`, `sdk/guard.js`, `sdk/study.html`, ca-service `db.js`/`server.js`/`lib/studyLog.js`/
  `lib/keystrokeSecurity.js`, `scripts/study_*`, gateway `server.js`, `.env.example`). This session ("RECOVERY_HANDOFF.md
  continuation") did T3.4 and propagate-updates. Never edit the other session's files. Message it before restarting
  model-api, ca-service or the gateway (use `docker restart`, which keeps STUDY_LOGGING=1, never `docker compose up`).
  ca-service is bind-mounted, so an edit there reaches the other session's test runs immediately.
- **Owner (via CLOUD, 25 Sep 12:26):** "whatever improves our solution, do it" — no confirmations needed. Git hygiene
  rules still apply; deletions are moves to `_to_delete/`.
- **T3.4 live** (`20deb53`, pushed): the server's mouse channel runs **F2**: the deployed FCN frozen, its 128-d embedding
  centred on `artifacts/mouse-fcn-a5/f2_cohort.npz` (sha 40b54f05) and normalised, and a per-user logistic head trained
  against 880 cohort windows. The threshold is the 20th percentile of the leave-one-sample-out scores, and the vote is 33 of 60
  (`f2-loso-p20-33of60`). `validate_f2.py` matches the stage C analysis bit for bit. S1 stays selectable
  (`MOUSE_HEAD_SCHEME = "s1"` in `lib/mouse.js`). 5 profiles rebuilt; backups `ca.db.pre-f2-2026-09-26.bak`,
  `artifacts/users-pre-f2-2026-09-26.tar.bak`. Stage C's `verify_stage_c()` refuses the new `api.py`; stage C
  reproduces from `d1d02c9`.
- **propagate-updates done** (stage D, stage C, KS, T3.3, T3.4): manuscript (§4-6-ن, §4-9g and more; docx rebuilt)
  and all 7 study pages republished. Details on the board (26 Sep 07:00). Scripts and page backups are in `_backups/`.
- **model-api memory fixed** (`d91283f`, pushed; TODO §5b): each training runs in a child process that exits
  (the server kept about 42 MB per Keras training). Scores unchanged; trainings take about 8 s longer.
  `MODEL_TRAIN_IN_CHILD=0` restores the old path. The T4.3 session has since ended.
- **Gateway hardened** (`f3a9a52`; TODO §1, §2, §4, §5): crash-safe tenant/identity files, admin key required in
  the bundle, tenant registration documented in DEPLOY.md. **Extension** timed by event.timeStamp (`f776fa3`).
- **Pre-study question on the board (CLOUD/OWNER):** the keystroke warm-up fast path (4 windows, 3 low) locked the
  genuine replay in 4 of 8 study-test runs after one long pause; its genuine false-lock rate was never measured.
- **Open:** CLOUD to fix "S1 deployed 23 to 25 Sep" → 26 Sep in `RESULTS_L_stageC.md`; the T4.3 session to update
  S1 wording in `extension/STUDY_MODE.md` and `sdk/guard.js`; owner: T4.1 ethics request.

## Status 2026-09-25, 22:50 (LOCAL)

- **T3.3 live** (`74930ba`, follow-up `2894d94`): keystroke training uses the 200 Aalto typists of KS's A200 arm
  (`data/aalto_neg_A200.h5`, sha 0b1fbd1b; build with `services/model-api/build_aalto_negatives.py`). 82 of 84
  profiles retrained on it; 2 older-scheme rows (users 2, 395763623595350) are never served. All 4 gates pass.
  Backups: `ca.db.pre-aalto-2026-09-25.bak`, `artifacts/users-pre-aalto-2026-09-25.tar.bak`.
- **Stage C done** (`81d9b9b` freeze, `d1d02c9` result): Q2 F2 - REF +0.0203 [+0.0039, +0.0376], non-inferior;
  both systems weak on Bogazici (per-user AUC ~0.72-0.74). CLOUD writes it up.
- **Branch rule (OWNER, 25 Sep 17:00):** only `experiment/recovery-plan`, main folder, no new branches or worktrees.
- **Edit guard:** this terminal's background sessions refuse file edits in the main folder unless
  `.claude/settings.json` has `{ "worktree": { "bgIsolation": "none" } }`. The file does not exist yet; the OWNER
  allowed applying reviewed patches with `git apply` instead (patch built from scratch copies).
- **model-api memory:** grows about 125 MB per training (11 GB after 84); restart it after bulk retrains, never
  during a study run. TODO §5b.

## Status 2026-09-25, 09:00 (LOCAL)

- **Keystroke study KS (T3.2) done:** `679bb18`. Primary A1000 - REF per-user AUC of 20-window decisions
  +0.0201 [+0.0101, +0.0308], better for 62/99: superiority supported. Key secondary A1000 - A40 -0.0050: not
  supported (40 or 200 Aalto typists do as well). A production change is the owner's decision. The first
  process bloated to 5.5 GB; a memory-capped supervisor (`artifacts/phase3/smoke/supervise_step2.sh`, one
  arm per process, restart above 3 GB) finished it with identical settings. The laptop also slept 01:29-05:32
  on a critical battery warning: keep it on mains power for long runs.
- **model-api cold loads (TODO 5b):** `ecbb164`. Per-model load lock, background warm-up at boot (used or
  trained in 14 days, at most 8) and after training/rollback. validate_pipeline passed after three fresh
  restarts; e2e_mouse_a5 passed. gunicorn is still open. Stage C will hash `api.py`: its current hash is on
  the board for L-2.
- **Bogazici (T2.4/T2.5):** downloaded and verified (10/10 parts), listed, extracted to
  `data/bogazici/extracted/` (157,378 files, 33.84 GB, CRC-checked); samples flat in `data/bogazici/sample/`.
  `bogazici_l.py --inspect` failed on `labels.csv` (no header, not a session); reported on the board. Waiting
  for CLOUD's fix, then re-run the inspection. The stage C smoke test runs end to end.
- **Other commits:** `9913dbe` stage D write-up and draft L-2. The corrupt download copy
  `data/bogazici/*.z07.sha-mismatch` (524 MB) can be deleted.

## Status 2026-09-24, 17:45 (LOCAL)

- **Commits and pushes:** on 24 Sep the owner left these to LOCAL ("act as you find it better"; "segregate the
  work as you see it more convenient"). One commit per topic, each pushed:
  - `bb74ee6` Aalto converter = event-level port of `eventSteps()`, `validate_aalto_parity.py`, sweep label fix.
  - `ac346fb` PREREGISTRATION_L frozen (before any Phase 2 result).
  - `654eb2b` frozen, hashed files kept byte-exact (`.gitattributes -text`): before it a fresh clone verified
    only 18 (Linux/macOS) or 3 (Windows) of the 21 recorded hashes; now 21 of 21 either way.
  - `11d4cbd` protocol L stage-D code; `f1de567` SELECTION_L.json, committed before any development score.
  - `19c57b6` **stage D result: L stops at its kill criterion** (L - S1 per-user AUC of 9.9-s decisions
    -0.0082 [-0.0285, +0.0112], better for 6/19). F2 - S1 -0.0019 [-0.0162, +0.0127]; F2's non-inferiority
    (Q2) is still tested on Bogazici in stage C.
  - `a42b186` PREREGISTRATION_KS (keystroke, T3.2) and its code frozen before any result.
  - `aab0c68` defence deck draft (T5.1, exploratory).
- **Running now:** T3.2 step 2, `run_ks.py --arm all --threads 8` in model-api (started 17:30 local, about
  3.3 h; log `artifacts/phase3/smoke/run_step2.log`). Then `python analyze_ks.py` and paste the PRIMARY and
  KEY SECONDARY lines of `artifacts/phase3/ks_result.txt` on the board. Step 1 kept 1,000 Aalto typists
  (15,452 windows) of 1,473 files read. The converter matched the live JS on 200 real participants.
- **Downloads:** Aalto complete (`data/Keystrokes.zip`). Bogazici parts z01-z07 verified by sha256, the rest
  downloading (job: scratchpad `downloads.sh`, resumable; a corrupt part is kept as `*.sha-mismatch`). Then:
  list files only; CLOUD needs a few raw files staged to write Amendment L-1 (T2.5). Nothing is parsed or
  scored before L-1 exists.
- **Machine quirks:** this terminal's low-memory guard kills background shells when the PC is short of memory
  (Ollama and Docker are the big users). Long runs therefore go through `docker exec -d`. A killed tool
  wrapper can leave its script loop running, so a real pause means killing the loop's bash too.
- **Not committed:** `COORDINATION.md`, this file (both describe the agent setup) and CLOUD's in-progress
  `docs/recovery/user_study/` (T4.2).

## Status 2026-09-23, 23:45 (LOCAL): Phase 0 done and pushed

- **Coordination:** read `COORDINATION.md` first. This terminal is LOCAL; a claude.ai session (CLOUD) owns
  `analysis/phase*`, `artifacts/phase*`, `PREREGISTRATION_L*` and `docs/recovery/`.
- **Commits on `experiment/recovery-plan`, pushed** (origin = `6ac5cc5`, checked with `git ls-remote`):
  `8fc8525` Phase 1 + the first Phase 2 check; `d7c7682` keystroke 10-of-20; `6ac5cc5` mouse S1.
  GitHub says the repository moved to `aliabodaraa/Continuum.git`; the old remote URL still redirects.
- **Keystroke:** the live decision is 10 of the last 20 windows at 0.50 (server, SDK, lab page, extension).
  Adaptive learning still contributes the last 6 windows. Takeover detection is slower (about 42 s instead
  of 18 s), and a user whose genuine windows are mostly below 0.50 gets more false locks, not fewer
  (hard user 84.3% -> 91.7%). Both are recorded in the RUN_LOG and in manuscript §4-9e.
- **Mouse S1:** 440 windows (8 samples), threshold at the 20th percentile of eight leave-one-sample-out
  models' scores, 33 of the last 60. `validate_loso.py` reproduces the stored P1 scores exactly. Training runs
  in the durable queue (enrolment returns 202; one build takes 145-158 s). The two live profiles were
  retrained after backups (`services/ca-service/ca.db.pre-s1-2026-09-23.bak`,
  `artifacts/users/user-*/mouse_model*_pre-s1-2026-09-23`). The extension's on-device model is unchanged
  (disclosed). The RUN_LOG records S1 as the owner's deviation from the pre-registered verdict (S0 stands).
- **Gates:** all four pass. Known issues: `validate_pipeline` check 5 can time out on a cold model load right
  after a restart (TODO §5b); `validate_endtoend` retrains, so its numbers move between runs (two runs are
  saved in `artifacts/xai/`).
- **propagate-updates done:** manuscript and docx (outside git, in `../paper/`); 7 study pages republished.
- **Not committed:** `COORDINATION.md` and this file (they describe the agent setup; the owner decides
  whether they go into git), CLOUD's `PREREGISTRATION_L_DRAFT.md` and LOCAL's `.local-input.md`.

## Phase 0: ship the measured fixes (done 2026-09-23; kept for the record)

1. **Keystroke:** in `services/ca-service/lib/keystrokeSecurity.js`, make the live packet the last 20
   windows at the unchanged 0.50 vote fraction (`RECENT_WINDOW_COUNT` 6 -> 20). First list every other
   place that assumes 6 windows. Evidence: `artifacts/xai/decision_sweep.json` (vote 10/20 vs 3-of-6
   over 99 users: false lock -8.84 pts, capture +0.40 pts).
2. **Mouse:** adopt S1 from `artifacts/repr_arch_study/AMENDMENT_J1.md` as an owner decision:
   440-window enrolment (8 samples of 55), threshold at the 20th percentile of leave-one-sample-out
   enrolment scores, vote 33 of the last 60. Reuse the LOSO logic in `protocol_j_p1.py`. **Plan the
   change across model-api, ca-service, SDK, demo and extension, and get the owner's OK before editing.**
3. Run `validate_split.py`, `validate_pipeline.js`, `validate_endtoend.py` and `e2e_mouse_a5.js`.
   Append a RUN_LOG entry recording the S1 adoption as a deviation from the pre-registered verdict
   (S0 stands), with the lockbox numbers. Then run the propagate-updates skill.

## Phase 1 (done 2026-09-23): decision-level evaluation and power

Code is in `services/model-api/analysis/phase1/`, results in `artifacts/phase1/`. The README there has
the full numbers; its RUN_LOG entry is appended.

- 46/46 published P0/P6/K3 numbers reproduce exactly.
- The deployed mouse system at 17 s of movement has pooled EER 14.8% / 6.0% on the two lockboxes
  (window level: 20.7% / 16.8%). The old 1.6% figure was wrong.
- Method B improves per-user separation in every data set; pooled operation does not improve
  consistently.
- At n=20, the prompts/min margin cannot be met. The Phase 2 primary endpoint is **per-user AUC of
  9.9-s decisions** (MDE80 0.011-0.021).

## Next

- Phases 2 and 3 are done and deployed (F2 for mouse, Aalto A200 negatives for keystroke).
- **Phase 4 (user study):** T4.3 tooling is with the other LOCAL session; the study freezes whatever rules are live
  at the first participant. **Owner:** T4.1, the ethics request.
- **Phase 5:** the defence deck (T5.1, CLOUD's draft in `docs/recovery/`) still describes S1; it needs the F2 and KS
  results.
