# Amendment L-1 to PREREGISTRATION_L: parsing the Bogazici Mouse Dynamics Dataset

**Status: FROZEN, 25 Sep 2026, before any Bogazici window is scored.** It is frozen together with
Amendment L-2; `AMENDMENT_L2.sha256` holds both. Everything below was fixed from the archive listing,
5 sample sessions, and the structure-only inspection:
- the inspection is `bogazici_l.py --inspect` (LOCAL, 25 Sep 12:33);
- it produced `artifacts/phase2/L/stageC/bogazici_inspect.json`, sha256 `057ed4f236f66fca…`;
- it read counts, headers, first lines and window counts, and built no model and no score.

As section 5 of the pre-registration requires, this amendment fixes:
- the field mapping;
- the session boundaries;
- the time unit of the step filter;
- the eligibility counts.

It does not change a system, an endpoint or a margin. The code is `bogazici_l.py`.

## 1. Data

- **Source:** Kılıç, Yıldırım & Anarım, *Data in Brief* 36, 107094 (2021); data
  doi:10.17632/w6cxr8yc7p.2 (CC BY 4.0).
- **Integrity:** all 10 archive parts match Mendeley's SHA-256.
- **Layout:** `boun-mouse-dynamics-dataset/labels.csv` and `users/user1` … `users/user19`. Each user
  folder has three sub-folders:
  - `training/`: 10 sessions, one per day, from the user's 10 most active days;
  - `internal_tests/` and `external_tests/`: short sessions from the remaining days.
- **Labels:** `labels.csv` has no header row; each row is (index, session file, label).
  - Label 0: the session belongs to the folder's user.
  - Label 1: it belongs to another user. In `internal_tests` these are other internal users; in
    `external_tests` they are the 5 external users.
  - The inspection found 157,187 labelled test files: 94,286 with label 0 and 62,901 with label 1.
  - Every test file has exactly one label, and no label names a missing file.
  - All 157,377 file names in the dataset are unique. Training files have no label.
- **Label counts per user folder.**
  - `internal_tests` holds n label-0 and n label-1 files.
  - `external_tests` holds the same n label-0 files plus min(n, 993) label-1 files. The 993 are the
    external users' sessions.
  - For every user, n is identical in both folders (from 138 to 8,344). **The user's genuine sessions
    are therefore stored twice, once per folder, under different file names.** Section 4 counts each
    session once.
- **External users:** they have no folders and no user id in their files, so they are never targets.

## 2. Field mapping and time unit

- **Files.** The header is `client_timestamp,x,y,button,state,window`, where `window` is an
  application category.
  - **Checked on the first 20,000 events of every user's first training session:**
    - states: Move 345,761, Drag 17,829, Pressed 4,028, Released 4,027. No other value.
    - buttons: None, Left and Right. These are SapiMouse's own values; None maps to NoButton.
  - Rows are in time order within a session.
- **Fields:** each row → (t_ms, button, state, x, y).
  - t_ms: `client_timestamp` (float seconds since the epoch) × 1000. The step filter's 0.5-s idle split
    and every rule therefore run in SapiMouse's units.
  - state: kept as recorded; any other value would be read as a movement.
  - button: None or empty → "NoButton".
  - x and y: pixels as recorded, negative values included. A5 uses |dx| and |dy| only.
- **Browser emulation.** The deployed channel receives browser pointer events, which Chrome delivers
  once per display frame; SapiMouse was recorded in a browser. The Bogazici logger recorded operating
  system events, so before the step filter:
  - movement events are coalesced to the last event of each 1/60-s frame;
  - press and release events are always kept, in order.

  This maps the raw log to what the live system would receive; it does not change the system.
  **Measured on every user's first training session:**

  | Quantity | Bogazici | SapiMouse |
  | --- | --- | --- |
  | Median movement-event interval, as recorded | 8–15 ms per user | — |
  | Median movement-event interval, after coalescing | 16–18 ms | 17 ms |
  | Mean step duration after the step filter | 25.0–35.2 ms (median over users 29.0 ms) | 26.9 ms |
- **Windows:** the deployed step filter and A5 windows (`repr_arch_study.raw_steps` and `windows`, 50
  steps, stride 10), with no resampling beyond the coalescing above.
- **Seconds per window** (`c_common.SEC_PER_WINDOW_B`) = **0.2897 s**: the median over the 19 users of
  10 × that mean step duration (SapiMouse: 0.269 s). It is used only to express the live loop per
  minute.

## 3. Sessions

- Every session file is one stream. Windows, decisions (`eval_decision_level.blocks`, gap 4) and the
  live loop never span two sessions.
- Rows whose time, x or y cannot be read are dropped. Steps with dt ≤ 0 are skipped by the step
  filter, as in production.
- A session with too few steps for a window contributes nothing. That was 4 of the 380 inspected test
  sessions.

## 4. Enrolment, genuine test and impostors (section 5 of the pre-registration)

- **Enrolment.** The training sessions are ordered by their first timestamp. Windows are built per
  session, concatenated in that order, and the first 440 are kept: 8 samples of 55. **All 19 users
  reach 440 windows within their earliest training session.**
- **Session identity.** A test session is identified by its first timestamp. Files with the same
  first timestamp are copies of one session, whether or not they are byte-identical (section 1).
- **Genuine test ("their test sessions from later days").**
  - Candidates are the target's label-0 files, in both test folders, whose first timestamp is later
    than the last step of the 440th enrolment window. No genuine event can therefore coincide with an
    enrolment event.
  - The inspection found 162–15,672 such files per user, about half as many distinct sessions.
  - Sessions are drawn by listing the candidates by (first timestamp, file name) and visiting them in
    the random order `default_rng([20260925, user number, 0]).permutation`. A file whose session is
    already drawn is skipped. The draw stops at 200 distinct sessions or when the candidates run out.
    The drawn sessions are then ordered by time.
- **Impostors ("each other user's test data; the 5 external users serve as impostors only").** The
  files carry no user id, so external users' data cannot be grouped by person. A target's impostor
  data are therefore the dataset's unauthorised sessions for that target: its label-1 files in both
  test folders.
  - This covers other internal users and the external users, in the dataset's own proportions.
  - Sessions are drawn the same way, with the candidates listed by file name and
    `default_rng([20260925, user number, 1])`, up to 200 distinct sessions. A file whose first timestamp equals any of the target's own label-0 sessions, of any
    date, is skipped.
  - Each session is its own impostor run, cut at its first 150 windows, as in SapiMouse.
- **Safety net.** Byte-identical files are still kept once (`build`).
- **The caps** of 200 sessions bound compute only: one user has 16,688 test files. Every draw is fixed
  here, before any window of a test session is scored.

## 5. Eligibility (from window counts only)

A target is eligible if all three hold:
- it has 440 enrolment windows;
- at least one drawn genuine session holds a full 33-window decision;
- at least one drawn impostor session holds a full 33-window decision.

Decisions never straddle sessions, so this is the pre-registration's "at least 33 test windows"
applied within one session. The inspection's counts make all 19 users eligible. Any exclusion is listed
with its reason in `scores_C.json`, together with each target's file and session counts.

## 6. What the inspection confirmed

| Item | Result |
| --- | --- |
| Header, states and buttons | As mapped in section 2, on every user. |
| Labels | One label per test file; unique file names; per-folder labels as in section 1. Genuine sessions appear in both folders, which led to the first-timestamp rule in section 4. |
| Event rates and step duration | As in section 2, giving SEC_PER_WINDOW_B = 0.2897 s. |
| Enrolment and genuine sessions | 440 enrolment windows for every user; every user has genuine sessions after enrolment. |

The inspection contradicted nothing in sections 1, 2 or 4. The duplication finding changed only how
sessions are counted, and it was settled before any score existed.
