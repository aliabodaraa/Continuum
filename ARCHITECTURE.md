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
| **passkey-service** | 4000 | Node | FIDO2/WebAuthn registration + assertion (step-up). Owns `passkey.db`. |
| **gateway** | 8080 | Node | Multi-tenant front door: resolves identity, signs verdicts (RS256) + exposes JWKS, pushes CAEP events, serves the SDK. The only public entry for the product bundle. |
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
  `CONTINUUM_SECRET`). Issued by `POST /v1/tenants` (admin-gated), which returns both.
  The gateway auto-seeds a `pk_demo` tenant from `CA_SIGNING_SECRET` on first boot so the
  bundled demo/acme work out of the box.
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
  windows (other users + dataset negatives) as negatives.
- **Live decision (Lu et al. packet vote, lengthened):** score the most recent
  `RECENT_WINDOW_COUNT=20` windows (Lu et al. use 6; 20 was adopted on 2026-09-23 on the
  99-user paired sweep: false lock −8.84 pts, capture +0.40 pts); a window is "low" if its
  genuine probability < `0.50`; the packet is **suspicious** when the low fraction ≥
  `PACKET_VOTE_FRACTION=0.50`, i.e. 10 of 20. Only a full packet gives a verdict (warm-up while
  `windowCount <= 20`), apart from the paste, un-verifiable and overwhelming-impostor fast paths.
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
- **Model:** SapiMouse's FCN (`artifacts/mouse-fcn-a5`, identification-trained on 100 users);
  per user, `api.py` freezes conv1+bn1 and fine-tunes the rest with a binary head
  (`arch.json`). Negatives: `data/mouse_only/Mouse_A5_W50_base.h5` (base users only).
- **Decision:** per-user threshold = 1st percentile of the user's enrolment scores; suspicious
  when 30 of the last 60 windows (~17 s of movement) are below it. Chosen by genuine passkey
  prompts per minute of movement (Experiment I: 0.29/min, 86.5% of 40-s impostor runs caught); the
  pre-registered rule required ≥ 90% capture and would have kept 5th percentile / 12 of 20
  (2.85 prompts/min) — the quieter point is the owner's policy decision. Each profile stores its
  whole enrolment-percentile table (`mouse_profiles.enrol_percentiles`), so the percentile can
  change without retraining; every scored check is logged in `mouse_decisions`.
- **Enrolment:** 6 samples × 55 windows = 330 (~90 s); each sample saves itself when complete and
  the clients show "Sample k of 6"; step-size spread ≥ 5 px per sample. Training receives one
  chronological stream, so model-api holds out its contiguous 20% tail (gap 5) as evaluated.
  ca-service refuses retired 7-column windows.
- Every client steps up on the **first** suspicious decision: gateway `MOUSE_STRIKES_TO_LOCK = 1`,
  demo 1, extension — the measured operating point counts one decision as one prompt.
- **Extension:** trains only a head on the frozen FCN on the device (`extension/src/mouse-model.js`;
  full fine-tuning on the CPU backend would take hours); its own operating point is the 2nd
  percentile and the mean of the last 60 scores (Experiment I: 0.22 prompts/min, 87.3% caught).

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

Enrollment still trains synchronously, because the user is waiting and "trained" is the
result they asked for. *Still open:* model-api runs single-threaded Flask, so a synchronous
enrollment train still blocks concurrent inference on that process — the fix is gunicorn
with separate inference and training workers (`TODO.md`).

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
- **Field policy (`MONITOR_EXCLUDE_TYPES`):** monitors all fields *including* `password`
  — but **masks** the password value before it leaves the browser; excluded types
  (default `hidden`) are ignored.
- **Onboarding modes:** `eager` (popup enrolls everything missing at load) vs `lazy`
  (passkey only; each modality enrolls when its panel toggle is turned on). Lazy is active.
- **Adaptive contribution:** after a sustained clean run, a verified submission is offered
  back as a training sample to keep the per-user model current.
- Public API: `getRiskToken`, `riskHeader`, `isLocked`, `identify`, `onReady`,
  `requireStepUp(modality, onSuccess)`, `contribute()`.

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

## 12. Publishing & CI
- **`scripts/release.sh`** — builds + pushes all five images to a registry, versioned
  (`REGISTRY=aliabodaraa TAG=0.1.0`). Published to Docker Hub `aliabodaraa/{model-api,
  ca-service, passkey-service, gateway, web-demo}`.
- **`.github/workflows/publish.yml`** — on every push to `main` touching `services/**`,
  `sdk/**`, or `apps/demo/**`, rebuilds + pushes the four Node images (`:latest` + `:<sha>`).
  Needs repo secrets `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN`. `model-api` is manual
  (its build needs the >100 MB dataset that isn't in git).

## 13. Data & migration
- **`scripts/data-export.sh` / `data-import.sh`** snapshot and restore the stateful data
  (`ca.db`, `continuum.db`, per-user models) as a tarball moved out-of-band (biometric —
  never committed). `passkey.db` is deliberately excluded: **passkeys are hardware-bound
  (Windows Hello/TPM) and cannot migrate** — users re-register on a new machine.

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
.github/workflows/publish.yml                             # CI image publishing
docker-compose{,.prod,.bundle}.yml + .env.example
DEPLOY.md · PC2_SETUP.md · PUBLISHING.md · HANDOFF.md · ARCHITECTURE.md
```
