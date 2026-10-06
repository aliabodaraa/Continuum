# User study: logging specification (for LOCAL to implement before the study starts)

**Principle:** log **continuous scores**, not only yes/no decisions. EER and ROC AUC need a
continuous score, while the deployed rules output only decisions. So every score and every
threshold source must be recoverable offline.

## 1. Per profile (at enrolment and at every retrain)

| Field | Keystroke | Mouse |
| --- | --- | --- |
| participant pseudonym, profile version, trained_at | yes | yes |
| model file hash | yes | yes |
| enrolment window count | yes | yes (440) |
| **threshold-source scores, all of them** | per-user validation scores | **all 440 leave-one-sample-out scores** (today only a percentile table is stored: extend `mouse_profiles`) |
| live threshold and rule version | 0.50, `10of20`, negatives `aalto-A200` | 20th percentile, `f2-loso-p20-33of60` (or `s1-loso-p20-33of60` if T3.4 is not live) |

## 2. Per scored window (both channels)

| Field | Notes |
| --- | --- |
| participant, session id, window index, client timestamp | a session = one continuous page visit; decisions never cross sessions |
| client | `extension-study` (both channels); `lab` for the impostor sessions |
| channel | `keystroke` or `mouse` |
| **score** (genuine probability, full float precision) | not rounded; round only for display |
| condition | `genuine` or `impostor:<other participant>` (set by the study app, never inferred) |
| day since enrolment | for the drift analysis |

The live tables already hold most of this: `keystroke_checks.per_window_scores` and
`mouse_decisions.scores`. Two things need adding:
- the **condition** and **session** fields;
- the full-precision **scores**. `mouse_decisions` currently rounds them to 4 decimals (LOCAL, 25 Sep).

## 3. Per decision and prompt

- The decision (window range, low-window count, verdict).
- Whether a passkey prompt was shown, and its outcome (`passed`, `failed` or `dismissed`), with
  timestamps.

## 4. Export

The study export writes one JSON Lines file per participant:
- the profile record (section 1);
- the windows (section 2);
- the decisions (section 3).

Offline, `eval_decision_level.py` can then rebuild the decisions without any threshold, using the
pct score from section 1's threshold-source scores, and report the deployed rule as one operating
point, as in phases 1-3.

## 5. Checks before the first participant

- **Integrity:** run a scripted genuine session and a scripted impostor session. The export must
  reproduce the live verdicts exactly when replayed.
- **Privacy:**
  - no URL or page title appears anywhere in the export (grep test);
  - no key event exists for a password field;
  - no event of either channel exists while the participant's pause is on (test: pause, type and move,
    resume, then check the export).
