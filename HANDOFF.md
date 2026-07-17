# Continuum — full session handoff (read to continue on another machine)

Self-contained context so a fresh Claude Code session on another PC can resume as if
it had been here. On the new machine: *"Read HANDOFF.md and continue."*
(Companion docs: `PC2_SETUP.md` = how to build/run here; `DEPLOY.md` = ship to a customer.)

---

## 1. What Continuum is
A **continuous-authentication security layer** — keystroke dynamics + mouse dynamics +
WebAuthn passkey step-up — productized as an **embeddable service** (the Auth0 / reCAPTCHA
model). The customer runs the Continuum services and adds two things to *their own* app: a
client SDK (`guard.js`) and server middleware (`@continuum/node`, or the Python reference).
It is a master's thesis project. **The committee must never see the old name "BioKey"** — it
was renamed to Continuum everywhere (the external BioKey capstone by Elkoby & Gutchin, 2022 is
still cited as genuine prior work).

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
  CNN+LSTM fine-tuned from a base (`artifacts/ws50-gru`).
- **Mouse feature vector F=7**: `[dx, dy, v, a, dtheta, dt, is_click]` — clicks ARE a learned
  feature, so mouse enrollment requires real clicks (≥10), not just movement.
- **Post-step-up probation**: after a passkey step-up, any *scored* suspicious verdict
  re-challenges immediately (no grace), cleared by a genuine verdict.
- **Persisted shared step-up lock** (`session_locks` table in ca-service): a server-side
  "step-up pending" flag keyed by userId, so ANY app's SDK — not just apps/demo's own
  Express session — logs the user out on reload/navigation during a pending challenge.

## 3. Standing constraints / working style
- **Fully autonomous** — the user said "never ask me, it's on you." Act with best judgment; don't
  stall on routine choices.
- **Docker only** — never install/run services on the host.
- **Windows + Git Bash** — prefix `docker exec` with `MSYS_NO_PATHCONV=1` when passing container
  paths. Docker Desktop crashes under memory pressure; relaunch:
  `powershell -Command "Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'"` then wait for the engine.
- **Accuracy-first.** Never expose "BioKey" to the committee.

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
- SDK cache bumped (now `guard.js?v=20`). Details captured in memory `ca-check-pipeline-invariants`.

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

### 4d. Rename BioKey → Continuum
All internal references renamed (code identifiers like `BioKeyHandler`→`ContinuumHandler`, package
names, docs, `results.json`, stale README defaults, removed stale buildx cache). Kept the genuine
external citation (raf545 GitHub URL + Elkoby & Gutchin attribution). **Caution learned:** a bulk
`sed` accidentally hit the binary SQLite DBs and corrupted them — recovered from the snapshot.
**Never `sed` binaries.** The word "biokey" also survives inside `ca.db.text_content` (paragraphs
users actually typed) — that's training data, byte-aligned with timings, and must stay.

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
works, gateway serves the updated SDK. `guard.js?v=20`.

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
