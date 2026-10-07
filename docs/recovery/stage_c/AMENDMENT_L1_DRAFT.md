# Amendment L-1 to PREREGISTRATION_L: parsing the Bogazici Mouse Dynamics Dataset

**Status: DRAFT (CLOUD, 25 Sep 2026).** It is written before any Bogazici window is scored.
Section 6 lists what the structure-only inspection (`bogazici_l.py --inspect`: counts, headers, window
counts; no model, no score) must confirm before it is frozen together with Amendment L-2. As section 5
of the pre-registration requires, this amendment fixes:
- the field mapping;
- the session boundaries;
- the time unit of the step filter;
- the eligibility counts.

It does not change a system, an endpoint or a margin. The code is `bogazici_l.py`.

## 1. Data

- **Source:** Kılıç, Yıldırım & Anarım, *Data in Brief* 36, 107094 (2021); data
  doi:10.17632/w6cxr8yc7p.2 (CC BY 4.0).
- **Integrity:** all 10 archive parts match Mendeley's SHA-256.
- **Layout** (archive listing, 24 Sep): `boun-mouse-dynamics-dataset/labels.csv` and
  `users/user1` … `users/user19`. Each user folder has three sub-folders:
  - `training/`: 10 sessions, one per day, from the user's 10 most active days;
  - `internal_tests/` and `external_tests/`: sessions of 30–100 actions from the remaining days.
- **Labels:** `labels.csv` has no header row; its first line is a data row. Each row is
  (index, session file, label). From the data article:
  - label 0: the session belongs to the folder's user (authorised);
  - label 1: it belongs to another user (unauthorised). Those are other internal users in
    `internal_tests`, and the 5 external users in `external_tests`.
- **External users:** the 5 external users have no folders and no user id in their files. They
  are never targets.

## 2. Field mapping and time unit

- **Files (checked on 5 sample sessions of user1, 25 Sep).** Header
  `client_timestamp,x,y,button,state,window` (the window column is an application category such as
  "browsing"). States are Move, Drag, Pressed and Released, SapiMouse's own vocabulary. Buttons are
  None and Left. Rows are in time order within a session, and each sample session lies within one day
  (2-10 minutes long).
- **Fields:** each row → (t_ms, button, state, x, y).
  - t_ms: `client_timestamp` (float seconds since the epoch, UTC) × 1000. The step filter's idle split
    (0.5 s) and all rules then run in the same units as SapiMouse.
  - state: kept as recorded (Move, Drag, Pressed, Released); any other value is read as a movement.
  - button: None or empty → "NoButton", as in SapiMouse.
  - x and y: used as recorded, in pixels. A5 uses |dx| and |dy|, so screen offsets do not matter.
- **Browser emulation.** The deployed channel receives browser pointer events, which Chrome delivers
  once per display frame. SapiMouse was recorded in a browser. The Bogazici logger recorded operating
  system events, so before the step filter:
  - movement events are coalesced to the last event of each 1/60-s frame;
  - press and release events are always kept, in order.

  This maps the raw log to what the live system would receive. It does not change the system.
  - **Measured on the 4 sample test sessions:** movement events arrive every 2-10 ms (median) as
    recorded, and every 16-17 ms after coalescing. SapiMouse's median is 17 ms.
  - **Mean step duration** after the step filter: 28-31 ms, against SapiMouse's 26.9 ms.
  - **Windows per sample session:** 106-298.
  - The inspection repeats this on every user's first training session.
- **Windows:** the deployed step filter and A5 windows (`repr_arch_study.raw_steps` and `windows`,
  50 steps, stride 10), with no resampling beyond the coalescing above.

## 3. Sessions

- Every session file is one stream. Windows, decisions (`eval_decision_level.blocks`, gap 4) and the
  live loop never span two sessions.
- Rows whose time, x or y cannot be read are dropped. Steps with dt ≤ 0 are skipped by the step
  filter, as in production.

## 4. Enrolment, genuine test and impostors (section 5 of the pre-registration)

- **Enrolment.** The training sessions are ordered by their first timestamp. Windows are built per
  session, concatenated in that order, and the first 440 are kept: 8 samples of 55.
- **Genuine test ("their test sessions from later days").** The target's label-0 sessions in both
  test folders whose first timestamp is later than the last step of the 440th enrolment window.
  - From these, up to 200 sessions are drawn with `default_rng([20260925, user number, 0])`, then
    ordered by time.
  - Byte-identical files are kept once.
- **Impostors ("each other user's test data; the 5 external users serve as impostors only").** The
  files carry no user id, so external users' data cannot be grouped by person. The impostor data of a
  target are therefore the dataset's unauthorised sessions for that target: its label-1 sessions in
  both test folders.
  - This covers other internal users and the external users, in the dataset's own proportions.
  - Up to 200 sessions are drawn with `default_rng([20260925, user number, 1])`.
  - Each session is its own impostor run, cut at its first 150 windows, as in SapiMouse.
  - Byte-identical files are kept once, including files identical to one of the target's genuine
    files.
- **Why the caps.** The caps of 200 bound compute only (one user has 16,688 test files). Each user
  keeps hundreds of genuine and impostor decisions. The draws are fixed before any window is scored.

## 5. Eligibility (from window counts only)

A target is eligible if all three hold:
- it has 440 enrolment windows;
- at least one genuine session holds a full 33-window decision;
- at least one impostor session holds a full 33-window decision.

Decisions never straddle sessions, so this is the pre-registration's "at least 33 test windows"
applied within one session. Excluded users are listed with the reason in `scores_C.json`.

## 6. To confirm from the inspection before freezing (structure only)

1. The header names and values match the mapping. **Confirmed on the samples**; the inspection
   checks the vocabulary on every user's first training session.
2. Every test file has exactly one label, and file names are unique across the dataset.
3. The labels by folder agree with section 1. If `internal_tests` turns out to hold only label 0 and
   `external_tests` only label 1, the rules above still apply unchanged, since they use the label,
   not the folder.
4. The median movement-event interval before and after coalescing, and the mean step duration.
   **Seconds per window** (`c_common.SEC_PER_WINDOW_B`) = the median over users of 10 × the mean step
   duration of the first training session. It is used only to express the live loop per minute.
5. Every user has 440 enrolment windows, and the number of genuine sessions after enrolment per user.

If the inspection contradicts section 1, 2 or 4, this draft is revised before freezing. That is still
before any score exists.
