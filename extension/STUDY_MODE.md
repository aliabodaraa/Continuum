# Continuum Guard: user-study mode

Operator guide for the Continuum user study (recovery plan T4.3; protocol and consent in
`docs/recovery/user_study/`, logging in `docs/recovery/user_study/LOGGING_SPEC.md`).

## What study mode does

The extension is always a client of the deployed **server** system, exactly like a site that embeds the SDK
(it has had no on-device scoring since 2026-09-29; see `README.md`). Study mode makes this browser a
participant's account and logs everything for the study:

- every page visit is one study session; the content script sends the raw key-event tail (key codes and
  timings) and its numbered mouse windows through the service worker to the gateway
  (`/v1/sdk/keystroke/check`, `/v1/sdk/mouse/check`); a password field produces no event at all;
- ca-service scores them with the server models (keystroke: Lu et al.'s per-user network on the Aalto
  negatives, 10 of 20 at 0.50; mouse: F2, the frozen deployed network with a per-user logistic head,
  threshold at the 20th percentile of leave-one-sample-out scores, 33 of 60) and logs every score, decision, threshold source and
  passkey prompt (`services/ca-service/lib/studyLog.js`);
- a server verdict locks every tab; the passkey step-up runs on the gateway's `/study.html` and clears the
  server lock; after it, probation re-challenges any scored suspicious verdict (as the SDK does);
- the typed **text** is never sent: checks carry only its length (printable keys in the tail). The order of
  key codes is sent, and text could be reconstructed from it; the consent form says so.

Settings live on the extension's settings page, in the "Research study (experimenter only)" section; while
study mode is on it wins over any account signed in on the same page. Participants never see their scores:
the popup and the badge show only that recording is on, unless the experimenter ticks "Show verdicts while
testing" (never during a participant's session). `condition` is `genuine`, or
`impostor:<pseudonym of the person typing>` during an impostor session; `client` ("Machine") is
`extension-study` on the participant's own computer and `lab` on a lab machine.

## The participant's pause

The toolbar badge shows **REC** while recording and **II** while paused. The popup's "Pause recording"
button, or **Alt+Shift+P**, pauses capture on every page: while paused nothing of either channel is
captured or sent, and the buffers are emptied when the pause starts and again when it ends. The pause is
never lifted automatically; tell participants to resume after typing something private.

## Before the first participant

1. **Logging on.** Start ca-service with `STUDY_LOGGING=1` (set it in `.env`, or
   in the cluster it is `STUDY_LOGGING: "1"` in `deploy/k8s/overlays/local/local-urls.yaml`, and the operator page can
   switch it at run time; under Compose `STUDY_LOGGING=1 docker compose up -d --no-deps ca-service`). Without it nothing is logged.
2. **Study tenant.** Register one tenant whose origins are the gateway's own origin (the study page) and the
   extension's origin, `chrome-extension://<extension id>` (shown on `chrome://extensions` and on the
   extension's settings page; an unpacked extension's id depends on its folder, so load it from the same
   folder on every study machine, or pack it). As the operator, with the admin key from `continuum/.env`:

   ```
   curl -s -X POST http://localhost:8080/v1/tenants -H "Content-Type: application/json" \
     -H "X-Admin-Key: <GATEWAY_ADMIN_KEY>" \
     -d '{"name":"continuum-study","origins":["http://localhost:8080","chrome-extension://<extension id>"]}'
   ```

   Keep the returned `siteKey`; it goes into each participant's settings. (Or register it in the developer
   console, `http://localhost:8080/console.html`, and approve it on `http://localhost:8080/operator.html`.)
3. **Checks** (LOGGING_SPEC §5), all on this machine's stack:
   - `node extension/scripts/e2e_headless_study.mjs`: a scripted genuine and impostor session end to end,
     including the lock, the passkey step-up, the pause and password-field checks, the export, the
     privacy scan and the replay;
   - `scripts/test_study_log.js` and `scripts/test_study_export.js` in ca-service, on a copy of the database
     (commands in their headers).

## Day 1: enrolment

1. Install the extension in the participant's Chrome (the study origin must match the tenant).
2. Settings page, "Research study (experimenter only)": study mode on, gateway URL, the study site key, the participant's
   pseudonym, condition "The participant (genuine)". Save. If an account is signed in on this browser and it is locked,
   "Save" is off until its owner verifies with the passkey (since 2026-11-26: the study's settings change who the user
   is, and saving them lifted that account's lock). A participant's own lock does not stop the next "Save".
3. "Open enrolment page": the participant creates the passkey, types the five texts and does the eight mouse
   samples. Training runs on the server (a few minutes).

## Impostor sessions

On the lab machine set up for participant A, with A's pseudonym saved and "Machine" set to "Lab machine":
before B starts, set "Who is typing" to "Another participant (impostor session)" and enter B's pseudonym;
save. Set it back to genuine afterwards. The pseudonym in the settings is always the account's owner (A).

## Export

```
docker exec -w /app continuum-ca-service-1 node scripts/study_export.js --out /tmp/study_export
docker exec -w /app continuum-ca-service-1 node scripts/study_replay.js --in /tmp/study_export
docker cp continuum-ca-service-1:/tmp/study_export <encrypted storage>
```

One JSON Lines file per participant. The export refuses to write inside the repository, and scans its own
output for text, URLs and page titles before it reports success. Study data never goes into git.

## Known limits

- If Chrome restarts the extension's service worker during a step-up, the lock survives, but the `passed`
  prompt event of that step-up is not logged.
- Closing the step-up window while locked is logged as `dismissed`; the lock stays until a step-up passes.
