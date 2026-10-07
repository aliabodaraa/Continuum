# Continuum user study: protocol (draft for the ethics request, T4.1/T4.2)

**Status:** draft by CLOUD, 24 Sep 2026. Revised 25 Sep 2026 after LOCAL's review found two problems,
both settled by the OWNER (terminal, 25 Sep 23:50):
- **Client.** The extension scored on-device with its own models, not the deployed rules. The study
  therefore runs the extension in a *study mode*: it sends its data to the study server, where the
  deployed server models score it (option A).
- **Privacy.** The extension records key codes in order, so typed text could be reconstructed. The
  protocol and the consent form now say so plainly.

The OWNER fills the [bracketed] items and submits it to the ethics board. No participant is recruited
before approval.

## 1. Purpose

SapiMouse and KeyRecs each give one day of data from one task. The study answers what they cannot:

1. **Cross-day stability.** Does a profile enrolled on day 1 still recognise its owner on days 2-10,
   during ordinary browsing and typing? Bogazici showed that the mouse channel loses most of its
   accuracy across days of real use (per-user AUC about 0.74), so this is the central question.
2. **The live operating point.** How many false passkey prompts per hour does a genuine user get,
   and how fast is a colleague caught when they take over an unlocked session?
3. **Fusion.** Does combining the keystroke and mouse scores beat either channel alone? This is
   pre-registered separately, before any fusion analysis.

## 2. Design

| Item | Plan |
| --- | --- |
| Participants | 30 adults [university students/staff], own computer, Chrome, mouse or touchpad declared |
| Sessions | Day 1: enrolment (about 15 min). Days 2-10: 3-5 ordinary work sessions of at least 20 min, with the extension running in study mode |
| Client | The Continuum extension in *study mode*. It sends the derived keystroke and mouse windows to the study server (ca-service), which scores them with the deployed server models and logs everything. The extension's on-device models are switched off, so there is one system under test. A pause button lets the participant stop all recording at any time, with a visible recording indicator |
| Enrolment | On the server, through the extension. Keystroke: the existing 5 samples. Mouse: 8 samples of 55 windows |
| Impostor sessions | Each participant spends 2 x 5 min on another participant's unlocked session (a scripted browsing and typing task, with neutral texts), on a lab machine set up for that participant |
| Decision rules | The server rules deployed when the study starts, frozen for the whole study. Keystroke: Lu's model trained against the 200 Aalto typists (T3.3), 10 of 20 at 0.50. Mouse: F2 (live since 26 Sep, T3.4), with the 20th percentile of leave-one-sample-out scores and 33 of 60. The rule versions are logged |
| Passkey prompts | Shown as in production; each prompt and its outcome is logged |

**Sample size.** The Phase 1 power check shows that 20 users detect a per-user AUC difference of
about 0.02 at 80% power. Thirty participants leave room for about 30% drop-out.

## 3. What is measured (primary endpoints fixed before data collection)

- **Per channel:** per-user AUC and EER of decisions (keystroke: 20 windows; mouse: 60 windows),
  genuine days 2-10 against impostor sessions. These need no threshold.
- **Operating point:** false prompts per hour of genuine activity, share of impostor sessions
  caught, and median time to catch.
- **Drift:** per-user AUC by day since enrolment.

## 4. Data protection

- **Keystrokes.** While the study extension is recording, each key press and release is recorded with
  its key code and timing, in order. The typed text could therefore be reconstructed, apart from letter
  case. The consent form says so plainly.
  - Password fields are masked and never recorded.
  - A pause button stops all recording, for example before typing something private.
  - The key data is used only to compute timing features. It is never read as text, and it is deleted
    with the rest of the raw data.
- **Mouse.** Only step sizes are recorded: |dx| and |dy| per step.
- **Never recorded:** URLs, page titles, page content and screenshots.
- **Pseudonymous IDs.** Only pseudonymous participant IDs are stored; the key linking IDs to
  consent forms is kept offline by the OWNER.
- **Storage.** Data stays on [the OWNER's encrypted drive / university storage]. Nothing is
  committed to git.
- **Retention.** Raw data is deleted [N months] after the thesis defence; aggregated results are
  kept.
- **Withdrawal.** A participant may withdraw at any time; their data is then deleted.

## 5. Risks

Minimal. The extra passkey prompts are a small inconvenience. Impostor sessions use a prepared
test account, never the participant's real accounts.

## 6. Timeline

- Ethics approval: [date].
- Recruitment: 1 week.
- Data collection: 2-3 weeks.
- Analysis: 1 week, following a separate frozen pre-registration (PREREGISTRATION_US).
