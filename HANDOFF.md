# Continuum — full session handoff (read to continue on another machine)

Self-contained context so a fresh Claude Code session on another PC can resume as if
it had been here. On the new machine: *"Read HANDOFF.md and continue."*
(Companion docs: `PC2_SETUP.md` = how to build/run here; `DEPLOY.md` = ship to a customer.)

---

## ⚠️ URGENT — mouse session: same bug likely live in `routes/auth/mouse.js` (2026-09-07)

**Found and fixed for keystroke; NOT yet checked/fixed for mouse — please verify and apply the
same fix if it reproduces.**

> **Status 2026-09-13 (mouse session): resolved.** `apps/demo/routes/auth/mouse.js` passes
> `req.session.userId` into every `ca.*` call and documents the identity contract at the top of
> the file. `webauthn.js`'s `ca.lockClear(req.caUid)` (cross-modality) is untouched.

**The bug:** `req.caUid` (set by the global `attachContinuumId` middleware in `app.js`) is
already the *resolved* canonical Continuum principal id. But `caClient.js`'s functions
(`ca.mouseEnroll`, `ca.mouseReset`, `ca.mouseCheck`, `ca.mouseStatus`, `ca.lockSet`,
`ca.lockClear`, `ca.mouseStreakReset`, etc.) each internally mint a fresh identity token and ask
the **gateway to resolve it again**, treating whatever they're given as a **raw, unresolved** app
user id (see `caClient.js`'s own doc comment: `appUserId` is the demo's OWN user id"). Passing an
*already-resolved* canonical id back in resolves it a **second time**, landing on a brand-new,
never-used "ghost" principal with **zero data** — not an error, a silently wrong but
well-formed empty profile/status response.

**Symptom this produces:** every mouse status/check/enroll call reports "not enrolled" / zero
samples for a real user with real data, even immediately after a fresh login (ruled out stale
session cache — reproduces on a brand-new session too). No error is thrown or logged anywhere,
because the response is a valid-shaped "no data" object, not a failure.

**Confirmed present in `apps/demo/routes/auth/mouse.js`** (same call pattern found in the
keystroke file before the fix):
```
apps\demo\routes\auth\mouse.js:37:  const r = await ca.mouseEnroll(req.caUid, req.body.windows);
apps\demo\routes\auth\mouse.js:50:  const r = await ca.mouseReset(req.caUid);
apps\demo\routes\auth\mouse.js:57:  const r = await ca.mouseCheck(req.caUid, req.body.windows);
apps\demo\routes\auth\mouse.js:70:  ca.lockSet(req.caUid).catch(() => {});
apps\demo\routes\auth\mouse.js:71:  ca.mouseStreakReset(req.caUid).catch(() => {});
apps\demo\routes\auth\mouse.js:92:  const r = await ca.mouseStatus(req.caUid);
```
Also `apps\demo\routes\webauthn.js:55,110` (`ca.lockClear(req.caUid)`) — cross-modality
(passkey lock), left unfixed pending a decision on whose scope that is.

**The fix, exactly as applied to `apps/demo/routes/auth/text.js` and
`apps/demo/routes/auth/auth.js`'s login routes:** replace every `req.caUid` passed into a
`ca.*(...)` call with `req.session.userId` (the RAW id — `caClient.js` resolves it correctly
itself). `resolveContinuumId(req)` / `req.caUid` are still fine to keep for whatever else reads
them (session cache warming, display) — just don't feed the *result* of that resolution back
into `caClient.js`.

**Verified for keystroke** (real login, real HTTP, not a bypassed test):
`ca.keystrokeStatus(739935229538144)` (already-canonical id, double-resolved) →
`{sampleCount: 0, trained: false}` (wrong). After the fix, real login as `ali` →
`{sampleCount: 44, trained: true}` (correct, matches the DB). `validate_pipeline.js` still
passes clean after the fix.

---

## 📎 FYI — methodology note that may apply to mouse too (2026-09-07)

Not urgent, no action implied — just flagging in case it's useful, since the mouse channel has
an analogous window→packet decision rule (15-of-20 vote) and could have the identical gap.

**Finding:** every headline keystroke metric (EER, AUC, TAR@FAR=1%, F1) had been computed at the
**window level**, while the live system only ever accepts/rejects a **packet** (6 windows, &ge;3
vote). No decision-level EER/ROC/TAR@FAR=1% existed — only discrete false-lock/capture points at
one fixed threshold from an earlier packet-vote sweep. This meant a prominent deployment claim
("TAR@FAR=1% = 12.4%, not standalone-viable") was citing a statistic measured at a different unit
than the one the system actually decides on.

**Fix applied (keystroke only):** rebuilt EER/ROC/TAR@FAR=1% at the decision level by sliding
real six-window packets over each user's own true temporal sequence and each impostor's own
contiguous run (never a binomial independence shortcut — windows overlap 80% and are not
independent, the same principle already established for the packet-vote sweep). Result:
decision-level TAR@FAR=1% = 23.5%, EER = 13.92%, AUC = 0.933 — roughly double the window-level
TAR@FAR=1% figure, but the standalone-viability verdict itself is unchanged (23.5% is still far
from viable as a strict-budget standalone gate). Cross-checked against an independent
mean-score aggregation (13.53% / 0.936 / 24.01%) — agrees within a point, so it's a real effect
of the unit, not an artifact of the specific vote rule. Full writeup, figures, and the
window-vs-decision ROC overlay are in the "How the Keystroke Channel Works" study page (section
"EER, ROC, and TAR@FAR=1% at the level the system actually decides on") and manuscript §4-9d.

**If mouse has the same gap:** the mouse channel's own headline metrics may also be window-level
while the deployed decision is the 15-of-20 vote packet — worth checking whether an equivalent
decision-level EER/ROC/TAR@FAR=1% exists yet, using the same real-sliding-packet method (mouse's
own `mouse_decision_sweep.json` / `mouse_decision_paired.json` in `artifacts/xai/` may already
have the raw per-run scores needed, same shape as keystroke's `_genuineScores`/`_impostorRuns`).
Purely informational — this is the mouse session's call entirely.

> **Status 2026-09-13 (mouse session):** the mouse channel was rebuilt by a pre-registered study
> (`artifacts/repr_arch_study/`), and its deployed operating point is reported at decision level
> on contiguous runs, alongside the window-level AUC/EER/TAR@FAR=1%. Since Experiment I it is
> measured in genuine passkey prompts per minute of movement: deployed 30 of 60 below the 1st
> percentile, 0.29 prompts/min, 86.5% of 40-s impostor runs caught (the pre-registered 12-of-20
> point: 2.85/min, 99.4%) — an owner's comfort-first choice below the pre-registered 90% capture.

---

## 1. What Continuum is
A **continuous-authentication security layer** — keystroke dynamics + mouse dynamics +
WebAuthn passkey step-up — productized as an **embeddable service** (the Auth0 / reCAPTCHA
model). The customer runs the Continuum services and adds two things to *their own* app: a
client SDK (`guard.js`) and server middleware (`@continuum/node`, or the Python reference).
It is a master's thesis project named **Continuum** throughout (the external keystroke-dynamics
capstone by Elkoby & Gutchin, 2022 is still cited as genuine prior work).

## 2. Architecture (everything runs in Docker)
| Service | Port | Role |
|---|---|---|
| **model-api** (Python/TF) | 5000 | Keystroke + mouse model serving & per-user training. Owns model/data storage. Dev is `--profile model` |
| **ca-service** (Node) | 4100 | Behavioral continuous-auth engine → returns signed **verdicts**. Internal only |
| **passkey-service** (Node) | 4000 | FIDO2/WebAuthn passkey register + step-up. Internal only |
| **gateway** (Node) | 8080 | Tenant gateway: identity resolve, RS256 verdict signing + JWKS + discovery doc, serves `guard.js`. The only public entry for the product bundle |
| **apps/demo** (web) | 3000 | Reference integration app — the site you log into (ali/aiham) |
| **apps/acme** | 4200 | A genuinely separate consumer app (own origin), adopts Continuum via SDK + middleware only |

Client SDK: `sdk/guard.js` (+ `sdk/js/keystroke-tracker.js`, mouse capture, WebAuthn vendor).
Middleware: `packages/continuum-node/` (auto-detects the logged-in user; mints identity JWT),
`packages/continuum-python/` (stdlib-only reference verifier).

### Key concepts
- **Deterministic identity unification.** A consumer signs a standard **HS256 JWT** `{sub, exp}`
  with its tenant secret (client_secret_jwt). The gateway maps it to an opaque
  `continuumUserId = parseInt(HMAC(GATEWAY_SESSION_SECRET, "pk_demo|id:"+userId)[:13],16)` via
  `userFor` / `/v1/resolve`. So every service keys the SAME user the same way, in any language.
- **Verdicts are RS256-signed** (gateway private key) and verified via **JWKS** — no shared
  secret needed by the host app. There's a discovery doc + CAEP/SET push (RFC 8417) to receivers.
- **Onboarding modes** (`ONBOARDING_MODE`): `eager` (popup enrolls everything at load) vs `lazy`
  (passkey only; each modality enrolls when its panel toggle is turned on). **Lazy is active.**
- **Keystroke pipeline**: digraph steps `[id1,id2,dwell1,dwell2,dd,ud]`; `WINDOW_SIZE=50`,
  `STRIDE=10`, `RECENT_WINDOW_COUNT=6`, `ROLLING_WINDOW_COUNT=18`. Live verdict = Lu et al. (2020)
  packet vote at the fixed 0.50 softmax boundary (`PACKET_VOTE_FRACTION=0.50`). Model is per-user
  CNN+GRU (1D-CNN + 2×GRU) fine-tuned from a base (`artifacts/ws50-gru`).
- **Keystroke adaptive contribution** (`/v1/keystroke/contribute`): after a sustained clean run,
  the SDK offers to add the sample to the user's training pool; every `ADAPTIVE_RETRAIN_EVERY=3`
  accepted samples queues a retrain (`lib/trainingQueue.js`), which only replaces the live model
  if it out-scores the incumbent on held-out data (previous model kept for rollback). Gated
  server-side (2026-09-07) beyond the existing mean-confidence check: every window in the packet
  must clear `ADAPTIVE_WINDOW_FLOOR=0.80` (not just the mean — a high average can hide one weak
  window), the sample's `text_hash` must not match an already-enrolled sample (no repeated-phrase
  contributions), at most `ADAPTIVE_MAX_PER_DAY=1` contribution is accepted per calendar day
  (spreads the training pool across sessions, not one sitting), and `ks.checkRhythmConsistency()`
  compares the candidate's own dwell1/dwell2/dd means against this SAME user's already-enrolled
  digraph history (pooled mean/std, z-score limit 3.0) — model-INDEPENDENT, so it can catch an
  inconsistent sample even before the model itself is any good; fails open (accepts) below
  `RHYTHM_MIN_HISTORY_DIGRAPHS=100` so it never blocks a fresh enrolment. Verified with synthetic
  jittered typing data: same-rhythm sample passes (z&asymp;0.2), a plausible faster stretch passes
  (z&asymp;1.8), a genuinely different rhythm is rejected (z&asymp;43). `train_user_payload` in
  `model-api/api.py` now also calls `set_random_seed(payload.trainSeed, default 7)` before
  building/fitting — data-side sampling and splitting were already seeded
  (`np.random.default_rng`), but TF/Keras's own weight-init and batch-shuffle randomness was not,
  which is why retraining on identical data could swing genuine-user confidence from a mean of
  0.92 to 0.74 run to run. Verified directly: two retrains on identical synthetic data with the
  same seed now produce bit-identical loss/threshold/accuracy.
- **Negative-pool size matters (2026-09-07 finding).** `population_sweep.py` gained an optional
  `--neg-pool-size` flag (default 40, unchanged) that shrinks ONLY the training-negative pool —
  `imp_pool`'s offset stays fixed at the original `NEG_POOL_SIZE` regardless, so the evaluation
  impostor set never changes. Paired run, same 20 targets, 40 vs 10 training negatives: EER
  +3.97pp mean (95% CI [+1.19, +7.14], excludes zero), AUC &minus;0.041 mean (95% CI
  [&minus;0.067, &minus;0.015], excludes zero) &mdash; 14/20 users worse, 4/20 better. Unlike
  positive/enrolment volume (r=+0.04, null), negative-pool size is a real, measured effect.
  Consequence: a user enrolled early (small app-user pool at the time) and never retrained since
  is sitting on a demonstrably weaker model with no way to catch up except their own future
  adaptive activity — there is currently NO mechanism that retrains an existing user just because
  the pool has grown. Scoped as a MUST-DO roadmap item, not yet built: needs its own trigger
  design (e.g. retrain when pool has grown substantially since last training) and the same
  promote-only-if-better gate everything else uses. Raw results:
  `artifacts/xai/negpool_experiment_10.json` (10-negative run) vs.
  `artifacts/xai/population_keystroke.json` (frozen 40-negative baseline, participants 0-19).
- **Pool-refresh mechanism — SHIPPED (2026-09-07), built on the finding above.** Every trained
  profile now stores `negativePoolUserCount` (distinct other users eligible as negatives at that
  training, via the new `ks.countNegativePoolUsers()`, uncapped by `MAX_TRAINING_SAMPLES` unlike
  `negativeSampleRows()`). `ks.needsPoolRefresh()` compares the CURRENT count against that stored
  baseline and returns true once it has doubled OR grown by &ge;20, whichever comes first
  (`POOL_REFRESH_GROWTH_RATIO`/`POOL_REFRESH_GROWTH_FLOOR` — a conservative starting threshold,
  not tuned from data; the experiment tested one 4x pool-size ratio, not a curve). Checked
  opportunistically inside `/v1/keystroke/submit` (no scheduler exists anywhere in this system;
  piggybacks on existing traffic instead of adding one) and queued via the same
  `trainingQueue.enqueue(userId, "keystroke", "pool-refresh")` path adaptive retrains already
  use — identical seeded, gated, rollback-protected pipeline, zero new training logic. Naturally
  self-rate-limiting: a successful refresh resets the stored baseline to the new current count, so
  the trigger only fires again after another doubling/+20 from that new baseline — no separate
  cooldown timer needed. Verified against live data: `countNegativePoolUsers` returned 90 for
  user 739935229538144 (correctly excluding alias id `1`); `needsPoolRefresh` correctly returns
  `false` for any profile trained before this shipped (no stored baseline to compare against —
  fails safe, never forces an unwanted retrain on a legacy profile).
- **Mouse (since 2026-09-13)**: feature vector F=2, `[|dx|, |dy|]` in pixels (SapiMouse's
  representation; `FEATURE_VERSION a5-absdxdy-v1`), SapiMouse's FCN as the base
  (`artifacts/mouse-fcn-a5`), per-user threshold (1st percentile of enrolment scores) and a
  30-of-60 vote (Experiment I, owner's comfort-first choice); enrolment is 6 self-saving samples of
  55 windows (330). Clicks are no longer a feature or a gate. Old 7-column windows are refused by
  ca-service and were migrated (`scripts/migrate_mouse_a5.js`). The extension trains a head on the
  device (mean of 60, 2nd pct). Gateway mouse strikes: 1. Live decisions: `mouse_decisions`.
- **Post-step-up probation**: after a passkey step-up, any *scored* suspicious verdict
  re-challenges immediately (no grace), cleared by a genuine verdict.
- **Persisted shared step-up lock** (`session_locks` table in ca-service): a server-side
  "step-up pending" flag keyed by userId, so ANY app's SDK — not just apps/demo's own
  Express session — logs the user out on reload/navigation during a pending challenge.
- **Origin-bound site keys**: a tenant's public site key is bound to its `origins`; the same
  key loaded from another domain → `403 origin_not_allowed`, and the SDK removes the panel +
  shows a warning popup. `POST /v1/tenants` requires `origins` (only the demo tenant stays open).

## 3. Standing constraints / working style
- **Fully autonomous** — the user said "never ask me, it's on you." Act with best judgment; don't
  stall on routine choices.
- **Docker only** — never install/run services on the host.
- **Windows + Git Bash** — prefix `docker exec` with `MSYS_NO_PATHCONV=1` when passing container
  paths. Docker Desktop crashes under memory pressure; relaunch:
  `powershell -Command "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"` then wait for the engine.
- **Accuracy-first.** The project is named Continuum throughout.

---

## 4. What we did in THIS conversation (the full arc)

### 4a. A 5-item UX/behavior batch (SDK + services) — completed & deployed
1. **Lazy onboarding honored end-to-end** — gateway reads `ONBOARDING_MODE`, returns it at session
   bootstrap; SDK `needOnboarding` skips modality popups in lazy (passkey only). No more forced
   mouse popup on the sdk-demo page.
2. **"analyzing…"** shown on the keystroke row while actively typing (instead of a stale "verified ✓").
3. **`MONITOR_EXCLUDE_TYPES`** Docker config → CA `/v1/keystroke/config` exposes `excludeFieldTypes`
   (default `hidden`). SDK now monitors ALL fields including `password` — but **masks** the password
   value (`xxxx`) before it leaves the browser, so rhythm is captured without exposing the secret.
4. **Panel is collapsible + draggable**, position/collapsed state persisted in `localStorage`.
5. **Mouse enrollment requires clicks** (both the wizard and the reinforcement popup gate on
   movement AND ≥`MOUSE_ENROLL_CLICKS`=10 clicks) because `is_click` is a model feature.

### 4b. The keystroke impostor-evasion chain — root-caused with live data, fixed, VERIFIED
The user (as "ali") kept slipping past detection. Diagnosed three stacked holes in the check
pipeline (`services/ca-service/lib/keystrokeSecurity.js` + `server.js` + `sdk/guard.js`):
1. **Infinite warmup = free pass.** A full window needs 50 clean digraph steps (~60 keystrokes);
   fast/rollover/held-key input drops most digraphs (`tooFast` when `dd<15ms`, `noKeyUp`), so
   windows may never form → the check sat in `warmup:true` forever → model never consulted → passkey
   could never fire. **Fix:** `UNVERIFIABLE_KEY_COUNT=120` — past that many keys with 0 windows,
   mark `unverifiable` → escape warmup → challenge.
2. **Typing misclassified as "paste."** Step-up resets the tracker but the textarea keeps its text,
   so `coverage = fewKeys / fullText` fell below 0.6 → verdict `paste`, `win=0` → read as warmup →
   impostor free-passed ~10 checks. **Fix:** paste detection now uses **actual paste events**
   (`pastedLength>80`), not the coverage ratio; and a paste verdict now **escapes warmup**
   (it carried no `windowCount`, so it defaulted to warmup and suppressed its own passkey).
3. **Probation looped genuine users / grace for impostors.** After step-up the tracker re-enters
   warmup, where the check returns `isSuspicious:true` as a *placeholder* (no scored window). The
   SDK probation path fired on that → re-locked a genuine user forever; meanwhile the impostor got
   a 2–3-window grace. **Fix:** server returns `scoredWindowCount`; SDK probation fires only on
   `isSuspicious && scoredWindowCount>0`. Genuine's first scored window is HIGH → clears probation;
   impostor's is ~0.00 → re-challenges instantly.
- **Verified** with synthetic POSTs to `/v1/keystroke/check` (uid = `req.body.userId`, `CA_API_KEY`
  empty in dev): low-coverage typing is no longer "paste"; a real paste escapes warmup + fires the
  passkey. Plus real decision-log evidence (impostor windows scoring 0.00 → `passkey=1`).
- Conceptual point reinforced to the user: keystroke auth models the **person's motor rhythm**, not
  the text/speed. "Ali typing fast gibberish in ali's account" stays genuine (correct) — impostor
  detection needs a *different person* (the ali-in-aiham's-account test), which works.
- SDK cache bumped (now `guard.js?v=21`). Details captured in memory `ca-check-pipeline-invariants`.

### 4c. Deploy kit (make it shippable / portable)
- Three compose files: `docker-compose.yml` (dev, bind mounts), `docker-compose.prod.yml` (demo
  stack, baked), `docker-compose.bundle.yml` (**the product** — gateway + services, no demo).
- Parametrized image coordinates `${REGISTRY}/<svc>:${TAG}` for push/pull.
- **Hardened secrets**: `CA_SIGNING_SECRET` + `SESSION_SECRET` now **fail-fast** (`${VAR:?…}`) and
  are blanked in `.env.example` (a shared default would let anyone forge verdicts).
- **Baked the SDK into the gateway/web prod images** via a named build context (`additional_contexts:
  sdk`). This was a real bug — `services/gateway/sdk-public/` was empty, so prod served **no**
  `guard.js`; verified the built image now contains the current SDK.
- `model-api` prod image (`Dockerfile.model.prod`) **bakes the base models** + mouse negative set;
  `.dockerignore`/`.gitignore` keep per-user models and dead variants out.
- `scripts/release.sh` (build + push all images, versioned). `DEPLOY.md` + `PC2_SETUP.md` written.

### 4d. Naming: Continuum throughout
All internal references use the Continuum name (code identifiers, package names, docs,
`results.json`, README defaults; stale buildx cache removed). Kept the genuine external citation
(raf545 GitHub URL + Elkoby & Gutchin attribution). **Caution learned:** a bulk `sed` accidentally
hit the binary SQLite DBs and corrupted them — recovered from the snapshot. **Never `sed` binaries.**
Legacy typed-text paragraphs also survive inside `ca.db.text_content` — that's training data,
byte-aligned with timings, and must stay untouched.

### 4e. Fresh git repo + organized history
User **deleted the old `.git` deliberately**. Re-initialized at **`continuum/`** (branch `main`,
author Ali Abodaraa, **no Anthropic/Claude co-author trailer** — user requested). **11 organized
commits**, ~15 MB. Single consolidated `.gitignore` excludes `node_modules`, `data/*.h5` (555 MB
public training sets, some >100 MB = GitHub-blocked), `artifacts/users/` + stray nested copies,
`*.db`, `_backups/`, snapshots, `*.exe`, dead model variants. Kept only the two base models
(`ws50-gru`, `mouse-ws50-base`). `.gitattributes` marks model binaries `binary` (CRLF-safe).

### 4f. Shared step-up lock — cross-app enforcement (commits `c50ef05`, `c45b96b`)
Added after the initial commits. `apps/demo` logged out on a locked reload via its own
Express session, but a customer app (acme, or any SDK+middleware integration) had no such
gate — and guard.js's `locked` flag is in-memory, so a reload/navigation during a pending
step-up would silently resume. **Fix:** a persisted lock in ca-service (`session_locks`
table + `lib/lock.js`): **set** when `passkeyTriggered` fires (keystroke sets it directly;
mouse sets it from the gateway/demo after the strike debounce), **cleared** on a verified
passkey (`submit` with `passkeyVerified`, gateway `/v1/sdk/passkey/auth/complete` 200, demo
`auth/complete` + `register/reset`), and **checked** by guard.js `gatewayFlow()` on load via
`GET /v1/sdk/lock/status/:userId` → `doLogout()` if locked. Endpoints: ca `/v1/lock/{set,
clear,status}`, gateway `/v1/sdk/lock/status`. Complements probation (in-session re-challenge)
by covering the reload/navigation/cross-app gap. Verified: table auto-creates, lock lifecycle
works, gateway serves the updated SDK. `guard.js?v=21`.

### 4g. Data migration kit
`scripts/data-export.sh` (consistent snapshot: `ca.db` + `continuum.db` + `artifacts/users/`;
excludes hardware-bound `passkey.db`) and `scripts/data-import.sh`. Produced
`continuum-data-20260717-132050.tgz` (~18 MB) — contains both DBs + all 6 user model dirs (ali =
`user-739935229538144`, aiham = `user-4263859618856479`, plus user-1/4/5 + one more).

---

## 5. CURRENT BLOCKER (where we are)
Migrated to PC #2 and built the containers, but **login `ali/1212` fails**. Cause: the `ali`
account lives in `continuum.db` (bcrypt `password_hash`, user id 1), which is git-ignored and only
travels via the **snapshot** — so PC #2's DB is empty.
**Fix (dev stack):** copy `continuum-data-*.tgz` to PC #2 → `docker compose down` →
`./scripts/data-import.sh continuum-data-*.tgz` → `ONBOARDING_MODE=lazy docker compose --profile model up -d`.
(Prod stack stores DBs on named volumes, so you must `docker run … cp` the DBs into the volumes —
see `PC2_SETUP.md`.) After login, **passkeys must be re-registered** (bound to PC #1 hardware).
Diagnostic — list the users the container actually sees:
`docker compose exec -T web node -e "const D=require('better-sqlite3');const db=new D(process.env.DB_PATH||'/app/db/continuum.db');console.log(db.prepare('SELECT id,username FROM users').all());"`

## 6. Open decisions / pending / deferred
- **Committed secrets**: `services/gateway/gateway-verdict-key.pem` (RS256 private key) + `tenants.json`
  (tenant secrets) are tracked. OK for a **private** repo; if going **public**, untrack them
  (`git rm --cached` + `.gitignore` + `.example` templates) BEFORE pushing.
- Optionally regenerate the snapshot post-rename (DBs barely changed).
- Deferred: **Tests + CI**; and the **Chrome-extension / desktop** expansion (identity from the
  browser profile via `chrome.identity`, verified server-side → mint Continuum identity; per-account
  data already works because the CA partitions by `continuumUserId`; the backend/protocol are
  already surface-agnostic — only the thin capture layer is re-implemented per surface).

## 7. Gotchas / memory notes (things easy to re-break)
- `ca-check-pipeline-invariants`: the three fixes in §4b — don't reintroduce infinite warmup,
  coverage-based paste detection, or raw-`isSuspicious` probation.
- `mouse-base-model-flaw`: the mouse base is effectively random (anchor-free labels unlearnable);
  needs a user-ID feature-extractor transfer. A v2 retrain scored worse (0.447) and was NOT promoted.
- Passkeys never migrate between machines (WebAuthn hardware binding) — always re-register.
- ca-service has NO host port; query it via `docker compose exec gateway node -e "fetch('http://ca-service:4100/…')"`.

## 8. How to resume on PC #2
Follow `PC2_SETUP.md`. TL;DR: `git clone` → copy + `data-import.sh` the snapshot → set `.env`
secrets (`openssl rand -hex 32`) → `ONBOARDING_MODE=lazy docker compose --profile model up -d --build`
→ log in `ali/1212` → register a fresh passkey.
