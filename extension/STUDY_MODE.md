# Continuum Guard: user-study mode

Operator guide for the Continuum user study (recovery plan T4.3; protocol and consent in
`docs/recovery/user_study/`, logging in `docs/recovery/user_study/LOGGING_SPEC.md`).

## What study mode does

Normally the extension scores typing and mouse movement **on the device**. In study mode it is a client
of the deployed **server** system instead, exactly like a site that embeds the SDK:

- every page visit is one study session; the content script sends the raw key-event tail (key codes and
  timings; password fields masked to key 0) and its numbered mouse windows through the service worker to
  the gateway (`/v1/sdk/keystroke/check`, `/v1/sdk/mouse/check`);
- ca-service scores them with the server models (keystroke: Lu et al.'s per-user network on the Aalto
  negatives, 10 of 20 at 0.50; mouse: S1, 33 of 60) and logs every score, decision, threshold source and
  passkey prompt (`services/ca-service/lib/studyLog.js`); on-device scoring is off;
- a server verdict locks every tab; the passkey step-up runs on the gateway's `/study.html` and clears the
  server lock; after it, probation re-challenges any scored suspicious verdict (as the SDK does);
- the typed **text** is never sent: checks carry only its length (printable keys in the tail). The order of
  key codes is sent, and text could be reconstructed from it; the consent form says so.

Settings live on the options page (experimenter only). `condition` is `genuine`, or
`impostor:<pseudonym of the person typing>` during an impostor session.

## Before the first participant

1. **Logging on.** Start ca-service with `STUDY_LOGGING=1` (set it in `.env`, or
   `STUDY_LOGGING=1 docker compose up -d --no-deps ca-service`). Without it nothing is logged.
2. **Study tenant.** Register one tenant whose origins are the gateway's own origin (the study page) and the
   extension's origin, `chrome-extension://<extension id>` (shown on `chrome://extensions`; an unpacked
   extension's id depends on its folder, so load it from the same folder on every study machine, or pack it):

   ```
   curl -s -X POST http://localhost:8080/v1/tenants -H "Content-Type: application/json" \
     -d '{"name":"continuum-study","origins":["http://localhost:8080","chrome-extension://<extension id>"]}'
   ```

   Keep the returned `siteKey`; it goes into each participant's settings. (With `GATEWAY_ADMIN_KEY` set,
   add `-H "X-Admin-Key: …"`.)
3. **Checks** (LOGGING_SPEC §5), all on this machine's stack:
   - `node extension/scripts/e2e_headless_study.mjs`: a scripted genuine and impostor session end to end,
     including the lock, the passkey step-up, the export, the privacy scan and the replay;
   - `scripts/test_study_log.js` and `scripts/test_study_export.js` in ca-service, on a copy of the database
     (commands in their headers).

## Day 1: enrolment

1. Install the extension in the participant's Chrome (the study origin must match the tenant).
2. Options page, "User study mode": study mode on, gateway URL, the study site key, the participant's
   pseudonym, condition "The participant (genuine)". Save.
3. "Open enrolment page": the participant creates the passkey, types the five texts and does the eight mouse
   samples. Training runs on the server (a few minutes).

## Impostor sessions

On the lab machine set up for participant A, with A's pseudonym saved: before B starts, set "Who is typing" to
"Another participant (impostor session)" and enter B's pseudonym; save. Set it back to genuine afterwards.
The pseudonym in the settings is always the account's owner (A).

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
