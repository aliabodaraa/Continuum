# Continuum — Architecture & Implementation

Authoritative reference for the system as implemented. Operational guides live
alongside: `DEPLOY.md` (ship to a customer), `PC2_SETUP.md` (run on a new machine),
`PUBLISHING.md` (images + CI), `HANDOFF.md` (session/context notes).

---

## 1. What it is
Continuum is an **embeddable continuous-authentication security layer**. It keeps
verifying that the person at the keyboard/mouse is still the account owner —
*after* login — using **keystroke dynamics** and **mouse dynamics**, and escalates
to a **WebAuthn passkey** step-up when behavior stops matching. It is delivered as
a set of services plus two thin integration points (a browser SDK and server
middleware), so a host application adopts it the way it would adopt Auth0 or
reCAPTCHA — without rewriting its own auth.

**Design principle:** all the intelligence (models, decision logic, signing) lives
server-side behind a language-agnostic protocol; only a thin *capture/transport*
layer is embedded per surface. This is why the system is portable across web apps,
and extensible to a browser extension or desktop agent later.

---

## 2. Services (all containerized)
| Service | Port | Stack | Responsibility |
|---|---|---|---|
| **model-api** | 5000 | Python / TensorFlow | Serves the keystroke + mouse models; fine-tunes per-user models. Owns model/data storage (`ARTIFACTS_DIR`, `DATA_DIR`), confines every path. Reachable **only** from ca-service (the `model` Docker network) and requires `MODEL_API_KEY` on every route but `/health`. |
| **ca-service** | 4100 | Node | The continuous-auth engine. Turns raw events into signed **verdicts**. Identity comes only from the gateway's assertion, never the request body. Owns behavioral DB (`ca.db`) — samples, profiles, the decision log, **the durable escalation counters**, and **the training-job queue**. The only service that may address model-api. |
| **passkey-service** | 4000 | Node | FIDO2/WebAuthn registration + assertion (step-up). Owns its store: `passkey.db`, or its own PostgreSQL database (§13c). Not published to the host; `PASSKEY_API_KEY` on every route but `/health` (called only by the gateway and the demo). |
| **gateway** | 8080 | Node | Multi-tenant front door: resolves identity, signs verdicts (RS256) + exposes JWKS, pushes CAEP events, serves the SDK. Also the tenant registry (developer console, operator approval), Continuum accounts, and the browser extension's sign-in and step-up pages. Its records live in JSON files or PostgreSQL (`STORAGE`, §13b). The only public entry for the product bundle. |
| **apps/demo** | 3000 | Node | Reference integration app (login as `ali`/`aiham`, dashboard, "write opinion"). |
| **apps/acme** | 4200 | Node | A *separate* consumer on its own origin — adopts Continuum through nothing but the SDK + middleware. |

Boundary rationale: **polyglot forced** (TF is Python), **resource asymmetry**
(the TF process is heavy and was crashing the shared runtime — isolating it is a
model-serving pattern like TF Serving/Triton), and **security-domain partitioning**
(passkey secrets, behavioral data, and tenant signing are separated). The demo talks
to the CA **through** its layer, never to model-api directly.

### 2b. Network segmentation — the layering is enforced, not conventional
Compose used to declare no networks at all, so every container shared one default bridge.
"The demo never talks to model-api directly" was then a statement about our code, not about
what was *possible*: the demo, acme, or anything else on that bridge could call
`POST /api/user/predict` for any `userId`. That is a **biometric scoring oracle** — submit
candidate windows for a victim, read back the genuine probability, hill-climb a forgery the
real system accepts — plus `/api/user/train` (poison a model) and `/api/user/rollback`.

Three networks now make the topology match the diagram:

| Network | Members | Purpose |
|---|---|---|
| `edge` | gateway, web, acme | Browser-facing. |
| `internal` | gateway, web, ca-service, passkey-service | Identity-scoped service calls. |
| `model` | **ca-service, model-api only** | The scoring oracle. Nothing else can address it. |

The gateway is the only container on both `edge` and `internal`; **ca-service is the only
container on `model`**. Verified by attempting the connection: `web` and `acme` resolving
`model-api` fails with `ENOTFOUND`, `acme` reaching `ca-service` fails the same way, and
ca-service reaches model-api normally.

Topology is only half of it. model-api also requires **`MODEL_API_KEY`** on every route
except `/health`, so a future misconfiguration that re-attaches a container to `model`
does not silently reopen the oracle. The key is a *service* credential — it answers "is
this ca-service?" The question "may this request act for this person?" is answered one hop
earlier, by the gateway's RS256 identity assertion. Only ca-service holds both, so the two
checks compose: nothing reaches a model unless the gateway vouched for the principal.

### 2c. The ca → model hop is bounded, and "no answer" is a defined outcome
The three modules that called model-api each carried their own bare `fetch` — no
credential, no deadline. A wedged TensorFlow process therefore hung the keystroke check
*forever*, and the keystroke check is the authentication path: the failure mode of the
whole security layer under a dependency stall was undefined.

`services/ca-service/lib/modelClient.js` is now the single way across that hop. Every call
carries the key and a deadline sized to the operation (inference 5 s, training 10 min), with
one retry on connection failure only — never on a timeout (the deadline already stated how
long we were willing to wait) and never for training (expensive, not idempotent; durability
comes from the queue instead).

When the model cannot answer there are three options and two are wrong:

- *fail-open* — call it genuine. Anyone who can stall the model gets a free pass, defeating the system.
- *fail-closed* — call it suspicious. An outage steps up every legitimate user at once: self-inflicted DoS.
- **no verdict** — refuse to answer. **This is what we do.**

ca-service returns `503 model_unavailable`: no verdict, no risk token, no lock, no recorded
clean run. The caller's last known state simply stands, so nothing is granted and nothing is
revoked, and the SDK already ignores non-200 responses so no client change was needed. Every
occurrence is logged at `[SECURITY]` precisely because refusing to answer is the *quiet*
option — a rise in these is either an outage or someone arranging one.

---

## 3. Identity model (cross-language, deterministic)
- A consumer's backend signs a **standard HS256 JWT** `{sub, exp}` with its tenant
  secret (`client_secret_jwt`). Any language's stock JWT library can mint this; a
  legacy 2-part `base64url(payload).hexhmac` form is also accepted.
- The gateway verifies it and maps it to an **opaque, stable** Continuum id:
  `continuumUserId = parseInt(HMAC(GATEWAY_SESSION_SECRET, "<tenant>|id:"+userId)[:13], 16)`.
- Every service keys the same user identically, in any language. Verdicts are
  verified with **public keys (JWKS)** — the host never needs a shared secret to
  *enforce* a decision. A stdlib-only Python reference (`packages/continuum-python`)
  proves the protocol end-to-end.

## 3b. Tenants, site keys & origin binding
- Each consumer app is a **tenant**: a **site key** (public — goes in the SDK
  `data-site-key`) paired with a **signing secret** (private — the backend's
  `CONTINUUM_SECRET`). Issued by `POST /v1/tenants` (operator, `X-Admin-Key`), which returns
  both, or by the **developer console** (`/console.html`): an organisation signs in with a
  Continuum account (email + passkey), registers its tenant, sees the secret once, and waits
  for the operator's approval (`status` pending → active; revoked is final). The operator
  approves and revokes on `/operator.html`, which with the admin API (`/v1/tenants`,
  `/v1/admin/*`) answers only on the gateway's own host names (`GATEWAY_OPERATOR_HOSTS`, default
  localhost; proxied requests are never local) and locks for 15 minutes after 10 wrong admin
  keys. Every change to a tenant or an account is appended to an activity log (`audit.jsonl`):
  the console shows an organisation its own entries, the operator all of them. Console webhooks
  must be public `https://` names (the gateway calls them, so a private address would be SSRF);
  the console can send a signed test event. Each organisation sets its apps' protection in the
  console (panel, typing and mouse on/off, enrolment, adaptive retraining and its pause, ignored field
  types); the operator page sets the defaults for all of them (precedence: organisation, operator,
  `.env`, built-in; `services/gateway/settings.js`); the gateway signs the effective values into its
  identity assertion (claim `cfg`), and ca-service enforces them. An owner may delete an organisation (its users are
  erased with it); the operator can give any tenant to a console account
  (`/v1/admin/tenants/:siteKey/owner`); the built-in demo can't be rotated, revoked or deleted from
  the console, since its secret is `CA_SIGNING_SECRET`. A tenant is an
  organisation or app, never a person. The gateway auto-seeds `pk_demo` from
  `CA_SIGNING_SECRET` so the bundled demo/acme work out of the box, and `pk_personal`, whose
  users are Continuum accounts (people with no organisation).
- **Browser extension sign-in** (`/v1/link/*`): OAuth 2.0 authorization code + PKCE with the
  gateway as authorization server. Personal users sign in with their Continuum account;
  an organisation's users on its own sign-in page (`@continuum/node` serves `/continuum/link`,
  which posts an identity token bound to that one sign-in). The extension keeps only a
  refresh token (typed, never accepted as a session; revoked at sign-out). Unverified
  `externalId`s in the `id:`/`acct:` namespaces are refused by `/v1/sdk/session`.
- **Self-hosted config model:** since the consumer runs the whole stack, they don't
  "register with a provider" — they set their secret in `.env`; the site key is a stable
  public label. Security lives in the **secret**, never the site key.
- **Origin-bound keys (the isolation guarantee):** because the site key is public, it must
  be bound to its tenant's `origins`. `POST /v1/tenants` **requires** `origins` (empty →
  `400 origins_required`; only the demo tenant is left open). A key loaded from a domain it
  isn't registered for → `403 origin_not_allowed`, and the SDK then **removes the guard panel
  and shows a warning popup** instead of running. This stops two apps on one gateway from
  sharing a key (which would collide their `(siteKey, externalId)` user namespaces);
  legitimate multi-domain is supported by registering several origins under one tenant.
- **Two secrets, two directions:** the **tenant HMAC secret** authenticates *inbound*
  identity (the browser can't forge it); the **gateway RS256 key** signs *outbound* verdicts
  (verified via JWKS, nothing shared). Per-deployment isolation is enforced by a **required,
  unique `GATEWAY_SESSION_SECRET`** (fail-fast in the bundle; the gateway also warns at startup
  if the dev default is in use) alongside `CA_SIGNING_SECRET`. It signs session tokens and
  seeds the `continuumUserId = HMAC(GATEWAY_SESSION_SECRET, siteKey|externalId)` namespace, so
  it must be unique per deployment and never change afterwards.

---

## 4. Keystroke dynamics engine
- **Features (per digraph step):** `[id1, id2, dwell1, dwell2, dd, ud]` — key codes
  ÷254, hold times of both keys, down-down and up-down flight times (seconds).
  Faithful to Lu et al. (2020) / the referenced keystroke-dynamics capstone architecture.
- **Windows:** `WINDOW_SIZE=50` (matches Lu et al.'s Clarkson II experiments, Table 1
  of that paper, which use sequence length 50), `STRIDE=10` (stride-aligned only, no
  padded/tail windows — those are out-of-distribution and destabilize scores).
  **STRIDE=10 is NOT from Lu et al.** — verified 2026-09-12 against the paper's own
  text: its live sliding window (§4.1, Fig. 7) explicitly advances by one keystroke
  per new key entered, and no alternate training-time stride is specified anywhere
  in the paper. STRIDE=10 is this project's own engineering choice (decision
  frequency vs. compute/training-volume tradeoff), not a literature-derived value.
- **Model:** 1D-CNN + 2×GRU base (`artifacts/ws50-gru`), **fine-tuned per user**
  (transfer learning) with the user's enrollment typing as positives and impostor
  windows as negatives: max(2 × positives, 60) windows of 200 Aalto typists
  (`data/aalto_neg_A200.h5`, KS's A200 arm, adopted 2026-09-25; before that, other app
  users' samples, in practice the 40 seeded KeyRecs accounts). Validation negatives are
  split by typist.
- **Live decision (Lu et al. packet vote, lengthened):** score the most recent
  `RECENT_WINDOW_COUNT=20` windows (Lu et al. use 6; 20 was adopted on 2026-09-23 on the
  99-user paired sweep: false lock −8.84 pts, capture +0.40 pts); a window is "low" if its
  genuine probability < `0.50`; the packet is **suspicious** when the low fraction ≥
  `PACKET_VOTE_FRACTION=0.50`, i.e. 10 of 20. Only a full packet gives a verdict (warm-up while
  `windowCount <= 20`), apart from the paste, un-verifiable and overwhelming-impostor fast paths.
  **Per organisation (since 2026-10-05):** the packet may be 6 or 10 instead of 20 (console,
  Protection; operator default; `KEYSTROKE_DECISION_WINDOWS`), always a simple majority, and only
  these measured lengths (`DECISION_WINDOW_CHOICES`). It reaches ca-service in the signed claim
  (`cfg.kw`); warm-up becomes `windowCount <= packet`, the study log records the rule as
  `lu-050-3of6-warm8` etc. and `details.packetWindows`, and the replay uses it. Shorter = sooner
  first verdict, more genuine flags (FRR at 0.50: 23.6% / 18.8% / 14.8%), same capture. The
  paper's figures are for 20.
  A wider `ROLLING_WINDOW_COUNT=18` mean drives adaptive-learning eligibility only, and adaptive
  contributions are still judged on the last `CONTRIBUTE_WINDOW_COUNT=6` windows.
- **Digraph hygiene:** drop event-batching artifacts (`dd < 15 ms` or `dwell < 10 ms`)
  and composition pauses (`dd > 1 s`) — timing noise, not rhythm.
- **Leak-free evaluation:** the public HDF windows overlap in shuffled order; a naive
  split leaks near-duplicates. Windows sharing timing subsequences are grouped and
  never cross the train/test boundary (`data_loader.py`). Honest metrics in
  `artifacts/ws50-gru/results.json`.

## 5. Mouse dynamics engine
- **Chosen by a pre-registered study** (`artifacts/repr_arch_study/`, experiments A–I; base
  paper SapiMouse, Antal, Fejér & Buza, IEEE SACI 2021).
- **Feature vector F=2:** `[|dx|, |dy|]` in pixels per step (`FEATURE_VERSION a5-absdxdy-v1`),
  50-step windows, stride 10; idle > 0.5 s splits the stream, zero-displacement moves are dropped,
  near-static windows skipped. Browser and training extractors are value-identical.
- **Model (F2, protocol L; deployed 2026-09-26):** SapiMouse's FCN (`artifacts/mouse-fcn-a5`,
  identification-trained on 100 users) stays frozen; per user, `api.py` fits a logistic head on its
  `embedding` (centred on a cohort mean, L2-normalised) against 880 rows of a fixed cohort
  (`f2_cohort.npz`, 40 windows from each of the 100 training users). A profile is one
  `f2_head.json`; no per-user network. Pre-registered evidence: non-inferior to S1 on the untouched
  Bogazici users (per-user AUC of 33-window decisions +0.0203 [+0.0039, +0.0376]) and better on
  pooled EER (-7.76 points); no difference on the development users. `validate_f2.py` checks that
  serving reproduces the tested analysis code bit for bit.
- **Decision (`f2-loso-p20-33of60`; S1's rule, AMENDMENT_J1 §2):** per-user threshold = 20th
  percentile of the user's leave-one-sample-out scores (for each enrolment sample, a head fitted
  without it scores it); suspicious when 33 of the last 60 windows (~17 s of movement) are below it.
  S1 (2026-09-23 to 26) used this rule on nine fine-tuned networks per user; on the untouched first
  lockbox it caught 95.0% of 40-s impostor runs (2 of 20 users below 80%) at 0.33 genuine
  prompts/min, against 77.1% (8 users) at 0.17 for the rule before it (1st percentile of in-sample
  scores, 30 of 60). The pre-registered test did not adopt S1 (the prompt increase missed its
  margin), so S0 stands in the record and S1 was the owner's disclosed deviation.
  Each profile stores both percentile tables (`loso_percentiles`, `enrol_percentiles`) and its
  `decision_version`; an older profile is rebuilt, never scored with this vote. Every scored
  check is logged in `mouse_decisions`.
- **Enrolment:** 8 samples × 55 windows = 440 (~2 min); each sample saves itself when complete and
  the clients show "Sample k of 8"; step-size spread ≥ 5 px per sample. The model is trained on
  the user's latest 440 windows by ca-service's durable training queue (nine logistic fits on one
  embedding pass, about 6 s; S1's nine networks took 2–3 min); the enrolment reply is 202
  `training: true` and clients poll `/status`.
  ca-service refuses retired 7-column windows.
- Every client steps up on the **first** suspicious decision: gateway `MOUSE_STRIKES_TO_LOCK = 1`,
  demo 1, extension — the measured operating point counts one decision as one prompt.
- **Extension:** since 2026-09-29 a server client like the SDK: it sends its windows to the gateway
  and is judged by this same model and rule. Its earlier on-device version (git tag
  `extension-on-device-v1`) trained only a head on the frozen FCN in the browser, with its own
  operating point (2nd percentile, mean of the last 60; Experiment I: 0.22 prompts/min, 87.3% caught).

## 6. The continuous-auth decision pipeline (`ca-service`)
Every keystroke `check` computes `passkeyTriggered = !isWarmup && isSuspicious && hasPasskey`,
guarded by three invariants that each closed a real evasion hole:
1. **Warmup can't be infinite.** A window needs 50 clean steps (~60 keys); fast/rollover/
   held-key input can starve windows forever. `UNVERIFIABLE_KEY_COUNT=120` — past that
   many keys with zero scorable windows, the input is *un-modelable* → challenge, not free pass.
2. **Paste detection uses real paste events** (`pastedLength > 80`), **not** a
   keystroke-coverage ratio (which false-flagged post-step-up typing as "paste" because
   the tracker resets while the textarea keeps its text). A paste verdict also escapes warmup.
3. **Post-step-up probation keys on *scored* windows.** The server returns
   `scoredWindowCount`; the SDK re-challenges only on `isSuspicious && scoredWindowCount>0`.
   A genuine user's first scored window is high (clears probation); an impostor's is ~0.00
   (re-challenges immediately, no grace).

Verdict risk levels: `warmup` / `suspicious` / `genuine`. A model outage produces no
verdict at all (503, §2c) rather than a fourth level — an absent decision is not a decision.

### 6b. Escalation evidence is durable
The keystroke debounce (2 suspicious of the last 3 checks) and the mouse strike counter are
**evidence accumulated across checks**. Both used to live in process memory — a `Map` in
ca-service, another `Map` in the gateway, and `req.session.mouseSuspiciousStreak` in the
demo: three copies of one fact, none of which survived a restart.

The problem is not the lost counter, it is *who benefits from losing it*. An impostor one
check short of a step-up got a clean slate from any deploy, crash or OOM kill. A debounce
whose evidence cannot outlive a restart is a debounce with a reset button. Three owners also
meant the SDK and the demo could disagree about how suspicious the same person just was.

Both counters now live in `decision_state` (`lib/decisionState.js`), owned by the service
that owns the behavioral data they are derived from. Callers keep their **threshold** — for
the mouse channel both the gateway and the demo step up at 1 strike, the point that was measured
— and no longer keep the **count**; ca-service returns it as `suspiciousStreak`. Both are cleared when spent on a
step-up, and when the profile they were measured against is deleted.

This is also what unblocks a second gateway replica: two processes each holding half the
evidence would never reach a threshold. (The tenant registry is still a JSON file, so
replication remains blocked on that — see `TODO.md` §1c.)

### 6c. Long-running model work is queued, not detached
Retraining was `setImmediate(...)` guarded by an in-memory `Set`. Both halves died on
restart: the in-flight run vanished mid-training, and so did the guard preventing a
duplicate. Nothing recorded that training had been *owed*, so the work was simply lost and
the user's model quietly stopped keeping up with them.

`training_jobs` is now the durable record of owed work (`lib/trainingQueue.js`):

- **Enqueue is a write.** `enqueue(userId, modality, reason)` is idempotent — a job already
  `queued` or `running` for that pair is returned instead of duplicated. That is the durable
  replacement for the `Set`, and callers can enqueue freely without tracking pending work.
- **Crash recovery.** On boot the worker returns anything still marked `running` to
  `queued`: a process that no longer exists cannot be running anything, so such rows are
  always debris. `attempts` bounds the retry, so a permanently unsatisfiable job fails
  loudly instead of crash-looping the worker on every restart.
- **One job at a time**, deliberately: training is CPU-bound TF work sharing a host with
  live inference, and the authentication path is the thing that must stay fast.
- `GET /v1/training/jobs` exposes the lifecycle. Previously a lost job was indistinguishable
  from one that had never been scheduled.

**Why not Redis + Bull** (the reflex, and the reference architecture's choice): this is one
producer, one consumer, one machine, a handful of jobs a day. A table and a loop give the
same durability, dedupe and crash recovery with no new stateful service to deploy, back up
or fail — and inherit `ca.db`'s existing volume and export scripts. The *pattern* is worth
borrowing; the infrastructure is not.

Typing enrolment trains from the queue too, since 2026-10-06. It used to train inside the 5th
`/v1/keystroke/enroll` request, so the enrolment window held the user for the whole run (~45 s,
up to ~2 min) and the demo blocked its pages meanwhile. Now `/enroll` enqueues once the samples
suffice and returns at once; `/v1/keystroke/status` reports `training` / `trainingError` and
`/v1/users/:id/onboarding` `keystrokeTraining`. The SDK, the demo's gate and the extension treat
"being built" as enrolled and say so, and a page reload picks the state up from the server.
*Still open:* model-api runs single-threaded Flask, so a training run still blocks concurrent
inference on that process — the fix is gunicorn with separate inference and training workers
(`TODO.md`).

## 7. Passkey step-up + shared lock
- **Step-up:** on a suspicious verdict the SDK opens a WebAuthn assertion modal; a
  successful passkey clears the suspicion and starts a probation window.
- **Persisted shared lock** (`session_locks` table + `ca-service/lib/lock.js`): a
  server-side "step-up pending" flag keyed by userId. **Set** when `passkeyTriggered`
  fires, **cleared** on a verified passkey, and **checked by `guard.js` on page load**
  (`GET /v1/sdk/lock/status/:userId` → log out if locked). This enforces the step-up for
  **any** app — not just apps/demo's own Express session — closing the reload/navigation gap.
- Onboarding order: passkey → keystroke → mouse.

## 8. Verdict signing, JWKS, and CAEP
- Verdicts are short-lived **RS256** JWTs signed by the gateway; consumers verify via
  `GET /.well-known/jwks.json` using native JWT tooling (no shared secret).
- A discovery document advertises the identity-token contract + JWKS + CAEP config.
- **CAEP/SET push (RFC 8417):** on a risk transition the gateway pushes a signed event
  to the tenant's receiver, so a server-side "suspicious" can block a request with no
  client round-trip.

## 9. The browser SDK (`sdk/guard.js`, cache `v=20`)
- **Two modes:** *gateway* (cross-origin, `data-site-key`, talks to the gateway) and
  *demo* (same-origin, talks to the app's own CA routes).
- **Capture:** keystroke tracker on `document.documentElement`; mouse tracker; a
  Shadow-DOM guard panel that is **collapsible + draggable** (persisted in `localStorage`).
- **Field policy ("fields never watched"):** inputs, textareas and rich-text editors
  (`contenteditable`, as one field) are watched, *including* `password` (timing only,
  key code 0). The organisation's excluded types (console, Protection; operator default;
  `MONITOR_EXCLUDE_TYPES`; built-in `hidden`) leave no event at all, and ca-service drops
  events of those types from `/check` and `/contribute` whatever a client sends.
- **What a check sends:** the key-event tail and the typed **length** (`textLength`), never
  the text (since 2026-10-05; before, `textContent` went with every check). Enrolment still
  sends the passage typed in Continuum's own wizard.
- **Onboarding modes:** `eager` (popup enrolls everything missing at load) vs `lazy`
  (passkey only; each modality enrolls when its panel toggle is turned on). Lazy is active.
- **Adaptive retraining, popup only (since 2026-10-05):** after a sustained clean run the
  popup offers the typing as a sample; three samples, then the retrain with the passkey. No other
  path adds typing samples: the public `contribute()` and ca-service `/v1/keystroke/submit` are
  gone, and `/v1/keystroke/enroll` answers 409 `already_enrolled` once the model exists (it used
  to take samples and retrain at any time, with no passkey). The panel's "+ train" then offers
  only the profile reset (passkey). Nothing is called at a page's submit or save.
- Public API: `getRiskToken`, `riskHeader`, `isLocked`, `identify`, `onReady`,
  `requireStepUp(modality, onSuccess)`.

## 10. Server middleware
- **`@continuum/node`** — one line: serves `/continuum/identity` (mints the HS256
  identity for the logged-in user, auto-detected from `req.user`/`req.session`/…),
  receives CAEP events, and `protect()`s routes by verifying verdicts via JWKS.
- **`packages/continuum-python`** — stdlib-only reference verifier (sign identity,
  verify RS256 via JWKS, `require_trusted`). Any language can follow the same contract.

---

## 11. Deployment
Three compose stacks:
- **`docker-compose.yml`** — dev (bind mounts, hot reload).
- **`docker-compose.prod.yml`** — the reference demo, fully baked.
- **`docker-compose.bundle.yml`** — **the product**: gateway + ca + passkey + model-api.

Implementation details:
- Image coordinates are parametrized `${REGISTRY}/<svc>:${TAG}` for push/pull.
- **Secrets fail-fast:** `CA_SIGNING_SECRET` and `SESSION_SECRET` are required
  (`${VAR:?…}`), blanked in `.env.example` — no shared defaults that could forge verdicts.
- **model-api prod image bakes the base models** + the mouse negative dataset, so a fresh
  install works out of the box; per-user models are written to a named volume.
- **gateway/web images bake the SDK** via a named build context (`additional_contexts: sdk`).
- **gateway carries no secrets:** it **generates** its RS256 signing key and **seeds** the
  demo tenant on first run, onto the `continuum_gateway_data` volume (key persists across
  restarts). Safe to publish as a public image.
- Persistent state on named volumes: `continuum_user_models`, `continuum_ca_db`,
  `continuum_passkey_db`, `continuum_gateway_data`, (demo) `continuum_db`.
- **Health-gated startup.** All four services expose `/health`, and nothing used them:
  `depends_on` said `condition: service_started`, which for model-api is actively
  misleading — TensorFlow takes tens of seconds to load, so the container is "up" long
  before it can score anything, and ca-service would accept traffic it could not serve.
  Every service now has a `healthcheck:` and every `depends_on` waits for
  `condition: service_healthy`. `/health` is deliberately the one route model-api leaves
  unauthenticated: gating it would mean handing the orchestrator a credential, and it
  reveals nothing beyond whether the model loaded.
- **Three networks** (`edge` / `internal` / `model`) in all three stacks — see §2b.
- **Node images (since 2026-10-07, branch `cloud-native`):** Node 24 LTS (Node 20 reached end of
  life on 2026-04-30); one Dockerfile per service with three stages: `deps` (`npm ci` from the
  committed `package-lock.json`; the compiler for better-sqlite3 stays here), `dev` (the dev Compose
  stack and Tilt; source mounted, `node --watch`) and `runtime` (the default: what CI, the bundle and
  Kubernetes run). The runtime stage has no compiler and no npm in front of the process, runs as
  **uid 1000** (numeric, so Kubernetes `runAsNonRoot` can verify it), keeps its data in `/app/data`
  by default, and sets `NODE_ENV=production`, which makes the gateway and ca-service **refuse to
  start** without their secrets or with a development default. Sizes: ca-service 525 → 245 MB,
  passkey-service 534 → 249 MB, demo 538 → 262 MB. Dev volumes for `node_modules` are new
  (`*_node24`), since the old ones hold Node 20 builds of native modules.
- **Every Node service** answers `/ready` (its own storage reachable; ca-service deliberately not the
  model, which it degrades around) next to `/health`, stops cleanly on SIGTERM (finishes requests,
  closes its database; an interrupted training job is recovered at the next start), and with
  `LOG_FORMAT=json` writes one JSON object per log line. An install whose volumes were created by the
  older, root-run images needs a one-time `chown` (DEPLOY.md).

## 12. Publishing & CI
- **`scripts/release.sh`** — builds + pushes all five images to a registry, versioned
  (`REGISTRY=aliabodaraa TAG=0.1.0`). Published to Docker Hub `aliabodaraa/{model-api,
  ca-service, passkey-service, gateway, web-demo}`.
- **`.github/workflows/ci.yml`** (since 2026-10-06) — every push and pull request: syntax of
  every JS/Python/shell file, compose files valid, unit tests (`services/*/test/*.test.js`,
  `scripts/test_*.py`), and per image: hadolint, build, no secret or runtime file inside
  the image, Trivy scan (report only for now).
- **`.github/workflows/publish.yml`** — only after CI succeeded on a push to `main` (never a
  pull request or a fork), rebuilds the commit CI tested and pushes the four Node images
  (`:latest` + `:<sha>`, plus an optional version tag when run by hand). Needs repo secrets
  `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN`. `model-api` is manual (its production build
  needs the >100 MB dataset that isn't in git).
- **`.dockerignore`** in each service keeps keys, databases, registries and logs out of the
  image (an image built from the working tree before 2026-10-06 could carry them).

## 13. Data & migration
- **`scripts/data-export.sh`** backs up everything git does not hold, without stopping the
  stack (since 2026-10-06): `ca.db`, `passkey.db`, the demo databases (each copied with SQLite's
  backup API *inside* its own container, the writer's locking domain), the gateway's registry,
  `identity.json` (pins every user's id to their data) and both signing keys, the per-user models,
  `.env`, and `../paper` (manuscript, thesis and paper sources, in no git repository). A
  `MANIFEST.json` (`scripts/backup_manifest.py`) records every file's SHA-256, each database's
  `integrity_check` and per-table row counts, and the code commit. `BACKUP_PASSPHRASE` encrypts
  the archive (AES-256, PBKDF2); biometric data and secrets leave the machine only that way.
- **`scripts/data-import.sh <archive> --verify-only`** is the restore drill: unpack, check every
  file, database, JSON file and key against the manifest, discard. Without it, a verified backup
  is restored in place (stack stopped) or into `--target <dir>`, and each replaced file is moved
  aside first, so a restore can be undone. Checked 2026-10-06: 1,594 files restored, databases
  identical by content table for table, models and paper sources identical, an encrypted backup
  verifies with its passphrase and is refused with a wrong one.
- `passkey.db` is now included: the server keeps only public keys, which move with the server.
  A passkey is bound to its domain (RP ID), so moving to a **new domain** still means users
  register again; on the same domain they keep working.

## 13b. Gateway storage: JSON files or PostgreSQL (since 2026-10-07, branch `cloud-native`)
- **`services/gateway/storage.js`**, chosen by `STORAGE`: `json` (default, unchanged: `tenants.json`,
  `identity.json`, `accounts.json`, `settings.json`, `audit.jsonl` in `DATA_DIR`) or `postgres`
  (`DATABASE_URL`; tables `gw_tenants`, `gw_identities`, `gw_accounts`, `gw_revoked_tokens`,
  `gw_settings`, `gw_audit`, created on start).
- **Reads stay in memory**, so a check costs no database round trip. Every change is written through
  before the request answers; a failed write is refused and undone in memory (never "saved in memory
  only"). With postgres each write also sends `NOTIFY gw_change`; the other gateway copies reload that
  one record (measured ~0.1 s for a new organisation, a revocation, an operator setting). A copy that
  loses the database keeps serving from memory, reports `/ready` 503 (`/health` stays 200), refuses
  changes, reconnects with backoff and reloads everything; a user first seen during the outage is
  saved once the database answers (the id is the same HMAC either way).
- **The database settles races between copies:** a user first seen by two copies at once gets one
  stored record (both answer with it); two users can never share a user id (`UNIQUE`, refused); one
  email cannot make two accounts (`UNIQUE`, 409 `email_taken`).
- **Signing keys stay files** (a mounted secret). With `STORAGE=postgres` a missing key stops the
  start instead of each copy making its own.
- **Migration:** `node services/gateway/migrate.js --from <data dir> --to <url> [--replace]` copies
  everything in one transaction, refuses a database that already holds records, then reads it all
  back and compares record by record. On a copy of the real data (2026-10-07): 9 tenants, 344
  identities (every user id equal), 3 accounts, 116 revocations, settings, 257 activity entries:
  identical. The files are only read, so going back is `STORAGE=json`.
- **Proven side by side** (`docker-compose.side-by-side.yml`: a second full stack, project
  `continuum-next`, gateway :18080, demo :13000, on a restored copy of the data): the extension's
  end-to-end test (92 checks) passes with the new code on PostgreSQL and on JSON files; the gateway's
  store checks (11) pass on JSON; storage contract tests run on both backends (`ci-local.sh` starts a
  throwaway PostgreSQL).
- **Short-lived state (step 3):** the extension's sign-in links, account passkey ceremonies, the
  operator lockout and each user's last settled risk are kept by `storage.js` too: in memory with json
  (one gateway, as before), in tables with an expiry with postgres, changed in single atomic statements
  (a link is authorized once and redeemed once whichever copies the requests reach; wrong admin keys
  sent to several copies are all counted). No Redis was needed. Per-copy caches remain where they are
  safe: console counts (60 s), and the passkey lookup ("yes" 60 s, "no" 5 s), which a copy that sees a
  passkey registered or removed also clears on every other copy through the change feed
  (`storage.forget`; found by the study suite through two copies: a copy that had cached "no passkey"
  kept saying so right after the participant registered one, which would have skipped a step-up).
- **Risk-change webhooks (CAEP) with postgres:** the risk change and its signed event are written in one
  transaction (`gw_risk_state`, `gw_webhook_outbox`); `webhooks.js` in every copy claims due events
  (`SKIP LOCKED` with a 30 s lease), posts them with a 5 s timeout, retries with exponential backoff and
  jitter (5 s doubling to an hour), and after 8 attempts marks them dead and writes
  `webhook.undeliverable` to the tenant's activity log (console and operator pages show it). Delivery is
  at least once; receivers drop repeats by `jti`. With json, events are sent at once, as before.
- **Proven with two copies** (`docker-compose.two-gateways.yml`: two gateway replicas behind a
  balancer that sends each request to the other copy): the extension's e2e suite 92/92 (88 requests to
  each copy); a tenant changed directly in the database was taken over by both copies within a second.
- **The tenant API (`/v1/server/*`, step 3b):** what an organisation's own backend calls, acting for one
  of its users: its site key plus an identity token (HS256, its tenant secret, at most 10 minutes, made
  for this API: `aud` "continuum-server"). The audience and a refusal of every browser request (an
  `Origin` header) keep the identity tokens that browsers get for the SDK out of it: found in review,
  before commit, an impostor at an unlocked session could otherwise have fetched one and cleared the
  lock or replaced the passkey. The
  gateway resolves the user and passes a whitelisted operation to ca-service or passkey-service with its
  own assertion and keys (ca-service's operator routes are not reachable). Checks return a signed
  `riskToken` and push risk changes (CAEP); passkey calls are limited to the organisation's own websites;
  adaptive retraining needs a `stepUpToken` from a passkey verified through Continuum within 2 minutes,
  used once. Policy (locks, gates) stays with the tenant's backend. The demo app is the reference: its
  backend uses this API only (`apps/demo/services/continuumApi.js`), has no address or key for an
  internal service, and sits on `edge` only; `docker-compose.prod.yml` is now the bundle plus the demo as
  a tenant. Its passkeys, once stored under the demo's own user numbers, move to the Continuum ids with
  `apps/demo/scripts/continuum-ids.js` + `services/passkey-service/scripts/rekey-users.js` (dry run first;
  the move and its proof in one transaction).
- **Not yet:** the running stack still uses JSON files; switching it needs the backup script to dump
  PostgreSQL first.

## 13c. Passkey service storage: SQLite or PostgreSQL (since 2026-10-08, branch `cloud-native`)
- **`services/passkey-service/store.js`**, chosen by `STORAGE`: `sqlite` (default, the file in `DB_PATH`, as
  before) or `postgres` (`DATABASE_URL`; the same two tables). The service is otherwise unchanged: same
  routes, same answers.
- **A challenge is taken in one atomic statement** (marked used as it is read, only while unused and
  unexpired). It used to be read, verified, then marked used, so two requests carrying one challenge (a
  replayed answer, or the same answer sent to two copies) could both pass; many synced passkeys keep their
  signature counter at 0, so the counter would not have stopped it. **Registration challenges now expire**
  (5 minutes, as sign-in challenges always did; they never expired). A credential registered twice → 409.
- **Migration:** `node services/passkey-service/migrate.js --from <passkey.db> --to <url> [--replace]`: one
  transaction, refuses a database that already has credentials, reads everything back and compares user,
  credential id, public key, counter and transports. On the copy of the real data: 28 credentials of 22
  users, identical. Challenges are not copied (five minutes).
- **A database and a login per service:** the compose variables are per service
  (`GATEWAY_STORAGE`/`GATEWAY_DATABASE_URL`, `PASSKEY_STORAGE`/`PASSKEY_DATABASE_URL`); locally one
  PostgreSQL holds databases `gateway` and `passkey` with logins of the same names
  (`deploy/postgres/init-local.sql`), CONNECT revoked from PUBLIC: checked that each login can open only
  its own database.
- **Proven:** unit tests on both backends (10 parallel takes of one challenge from two copies: one
  succeeds; the migration run for real); end-to-end suites on PostgreSQL, on SQLite, and with two passkey
  copies behind the alternating balancer (`docker-compose.two-passkeys.yml`).
- **Order at the switch-over of the running stack:** the demo's passkey re-key (step 3b) runs on the SQLite
  file first, then `migrate.js` copies the re-keyed credentials.

## 13d. CA service storage: SQLite or PostgreSQL (since 2026-10-09, branch `cloud-native`)
- **`services/ca-service/db.js`**, chosen by `STORAGE`: `sqlite` (default, the file in `DB_PATH`, as before)
  or `postgres` (`DATABASE_URL`). One asynchronous interface for both (`get`, `all`, `run`, `insert`,
  `tx`); every module of the service uses it (keystroke, mouse, decision state, locks, adaptive cycle,
  training queue, study log, settings). The SQL is written once; on PostgreSQL the few differences are
  translated (placeholders, the time functions, camelCase result names), and every value keeps SQLite's
  form: timestamps as UTC text `YYYY-MM-DD HH:MM:SS`, JSON as text, 0/1 flags, user ids up to 2^52 exact.
  So stored data reads back unchanged and past decisions replay identically.
- **Transactions hold what is inside them and nothing else.** A call made inside `db.tx` by any module
  runs on the transaction's connection (AsyncLocalStorage); a call from another request never joins it
  (on SQLite it waits for the transaction to end). The decision history's read-modify-write takes a row
  lock, so two checks of one user at once cannot lose an update.
- **Several copies can run side by side:** the training queue has leases (`locked_by`, `lease_until`,
  renewed while a job trains); a job is recovered only when its lease has run out; at most one pending job
  per user and kind (a unique index); the operator's run-time settings are re-read every 10 s.
- **Same results, by construction and by test:** sorts that could tie now say how ties break (`id`, the
  order rows were written in), which is the order SQLite already returned: checked on the real data, no
  result changes (2,540 samples, 160 users, the decision lists, the metrics). The `ca` database sorts text
  byte by byte (`LC_COLLATE 'C'`), as SQLite compares.
- **The identity seed tables** (`tenants`, `principals`, `principal_aliases`, `retired_identities`, written
  once in 2026-09) are part of the schema, because the tenant-wide reports still read
  `principal_aliases`. Known gap, unchanged here: nothing has added to it since, so those two reports miss
  every user who arrived later.
- **Migration:** stop the service, then `node services/ca-service/migrate.js --from <ca.db> --to <url>
  [--replace]`: one transaction; every table and column as stored, ids included, each id counter continuing
  where SQLite's did (an id of a deleted row is never given again); a table or column it does not know is
  refused, not skipped; then every table is read back and compared row by row (count and checksum). On the
  copy of the real data: 23 tables, 911,431 rows, identical, in about 20 s.
- **Proven:** 35 node tests (the data layer's 9 and the queue's 7 cases on each backend, the migration's 3); the study export from
  PostgreSQL identical to the one from SQLite, and that from the code before this change; the decision
  replay reproduces all 243 logged verdicts; end-to-end suites (connect, study, enrol-reload, demo-backend)
  with the service on PostgreSQL, on SQLite, and with two copies behind the alternating balancer
  (`docker-compose.two-cas.yml`).
- **Not yet (step 6):** the study log still hashes model folders through the read-only `/model-store`
  mount; it goes when the model service keeps versioned models and returns their hash.

## 13e. Model service: versions, object storage, two roles (since 2026-10-09, branch `cloud-native`)
- **Versions** (`services/model-api/model_store.py`): every training writes a new folder,
  `users/user-<id>/<kind>-<UTC time>-<6 hex>`, and never changes it. ca-service already stored the model
  path each training returned and now passes it with every scoring request (the mouse and mouse-action
  checks did not, and relied on one fixed folder per user). A retrain therefore never changes what another
  copy is serving, and the in-memory model cache needs no invalidation. The validation gate compares the
  new version with the one the profile points at, and a rejected version is discarded
  (`/api/user/rollback` with its path); the newest three per user and kind are kept, plus the current one.
  Folders made before versions keep working as they are. **A model the caller names but that is missing is
  now an error (404); it used to be scored silently with the shared base model**: on the copy of the real
  data two old keystroke profiles (format 2, never served, no decisions) point at folders that do not exist.
- **Object storage** (`MODEL_STORE=s3`, any S3 API; SeaweedFS locally): after a training the trainer uploads
  the version, then a marker with its file list and fingerprint; a copy asked for a version it lacks
  downloads it, checks the fingerprint and only then moves it into place. `fs` (default) keeps the
  versions in the model folder. `model_store.py publish-all` uploads the models made before.
- **Two roles from one image** (`MODEL_ROLE`): `inference` scores, `trainer` trains and discards, `all` (default,
  one container) does both; ca-service sends each to its URL (`MODEL_INFER_URL`, `MODEL_TRAIN_URL`, both
  defaulting to `MODEL_API_URL`). A 503 from the model service is "no verdict", like a timeout.
- **The fingerprint comes from the trainer** (`modelSha256`, the same definition the study log always
  used: checked equal on 5 real model folders and pinned by a unit test), so ca-service no longer mounts
  or reads the model folder.
- **gunicorn** (`wsgi.py`, one process with threads: its model cache serves every request), instead of
  Flask's development server, whose debugger was on by default in the dev stack (now only with
  `MODEL_DEBUG=1`). The production image copies only the 7 serving files and the two base models (no
  research scripts, ~170 MB of research outputs no longer baked), runs as user 1000, and sets its own
  storage folders: the bundle never set them, so per-user models went inside the container instead of the
  volume and the mouse base model was not found (the running stack, on the dev compose, was not affected).
  The trainer's start-up check reads the two negatives files the live recipes use (it checked a file none
  reads, and the production image reported a false failure at every start).
- **Proven:** every model in use scores the same fixed windows **bit-identically** before and after (89
  models, 2,136 scores), also through two scoring copies that started empty and fetched every model from
  object storage; the F2 mouse serving code still reproduces the frozen analysis exactly
  (`validate_f2.py`, max difference 0); the end-to-end suites and `e2e_mouse_a5` with one trainer and two
  scoring copies behind the alternating balancer (`docker-compose.split-models.yml`), and in the default
  single container. The feed of new versions took the first check after a retrain from no verdict (five
  5-second timeouts across two copies) to none.

## 13f. Kubernetes on this PC (since 2026-10-10, branch `cloud-native`)
- **Where:** Docker Desktop's own cluster, three namespaces of Continuum's own (`continuum`, `continuum-storage`,
  `continuum-demo`), nothing else touched; no tool installed on the PC (OWNER): `kubectl` (with Kustomize) and
  `scripts/k8s-local.sh` (`platform`, `secrets`, `build`, `deploy`, `up`, `seed-ca`, `status`, `logs`, `down`).
- **Platform** (`deploy/platform/install.sh`, pinned): metrics-server 0.9.0, CloudNativePG 1.30.1 (PostgreSQL 16.15),
  Envoy Gateway 1.9.2 with the GatewayClass `envoy`.
- **Manifests** (`deploy/k8s`): `base/continuum` (the five services as Deployments with probes, a graceful stop, HPA
  and PDB; one PostgreSQL cluster with a database and login per service, each login limited to its own database;
  NetworkPolicies; the Gateway and the API route), `base/storage` (SeaweedFS), `base/demo` (the reference tenant and
  its route), `overlays/local` (one copy each, images `:local`, the API on `localhost:28080` and the demo on
  `localhost:23000`, secrets from a git-ignored folder). Every namespace enforces Pod Security `restricted`: no pod
  runs as root, escalates privileges, keeps a capability or writes its root filesystem.
- **Found on the way:** a fresh gateway seeded the demo tenant with no website, so passkeys from the demo were refused
  (`origin_not_allowed`); the gateway now adds the site of `DEMO_SIGNIN_URL` (its sign-in page is on it). Kustomize's
  `images:` cannot be used next to CloudNativePG's `Database` (its text field `template`), so the overlay tags the
  images with explicit transformers.
- **NetworkPolicies are not enforced by Docker Desktop's Kubernetes** (measured: the demo pod reaches ca-service and
  passkey-service). Every internal route still needs its service key (measured from the demo pod: 401 from
  ca-service, passkey-service and the model). The demo suite reports the reach as a note when
  `CONTINUUM_NETPOL_UNENFORCED=1` and checks the refusal everywhere; the policies are proven on an enforcing cluster.
- **A slow, unstable connection** (5 to 140 KB/s that night): images were fetched with a resumable downloader, loaded
  with `docker load`, and the registry digest recorded with a `docker pull` by digest that fetched only the index.

## 14. Security model (summary)
| Threat | Mitigation |
|---|---|
| Impostor after login | Continuous keystroke/mouse scoring → passkey step-up |
| Evasion via un-modelable typing | Warmup cap (`UNVERIFIABLE_KEY_COUNT`) → challenge |
| Paste to bypass rhythm | Paste-event policy → challenge, escapes warmup |
| Grace after a step-up | Probation on scored windows; persisted cross-app lock on reload |
| Forged verdicts | RS256 signing, verified via JWKS (asymmetric) |
| Spoofed identity from the browser | Backend-signed HS256 identity token; browser can't mint it |
| Site-key reuse by another app | Origin-bound keys → `403 origin_not_allowed`; SDK hides panel + warns |
| Forged gateway session tokens | Signed with a required, per-deployment `GATEWAY_SESSION_SECRET` (fail-fast + startup warning) |
| Secret leakage in images/repo | Runtime-generated gateway key; fail-fast env secrets; secrets git-ignored + purged from history |
| Biometric scoring oracle (hill-climb a forgery) | model-api on an isolated `model` network reachable only from ca-service, **and** `MODEL_API_KEY` on every route but `/health` |
| Model poisoning / rollback by a co-located container | Same two controls; `/api/user/train` and `/api/user/rollback` are unreachable and credentialed |
| Stalled model hangs the auth path | Deadline on every model call; `503 model_unavailable` = no verdict issued, logged at `[SECURITY]` |
| Restart amnesty mid-escalation | Debounce + strike counters persisted in `decision_state`, cleared only when spent |
| Retrain lost to a crash | `training_jobs` queue; `running` rows requeued on boot, bounded attempts |

## 15. Repository layout (top level)
```
services/{model-api,ca-service,passkey-service,gateway}   # the product
  ca-service/lib/modelClient.js     # the ONE authenticated, deadline-bounded hop to model-api
  ca-service/lib/decisionState.js   # durable escalation counters (debounce, mouse strikes)
  ca-service/lib/trainingQueue.js   # durable training jobs + crash-recovering worker
sdk/                     # guard.js + capture libs (served by gateway/web)
packages/{continuum-node,continuum-python}                # host middleware
apps/{demo,acme}         # reference integrations
artifacts/{ws50-gru,mouse-fcn-a5}                         # pretrained base models (only these tracked)
scripts/                 # release.sh, data-export.sh, data-import.sh
.github/workflows/{ci,publish}.yml                        # tests on every push; publish after CI on main
docker-compose{,.prod,.bundle}.yml + .env.example
DEPLOY.md · PC2_SETUP.md · PUBLISHING.md · HANDOFF.md · ARCHITECTURE.md
```
