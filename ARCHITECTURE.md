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
| **model-api** | 5000 | Python / TensorFlow | Serves the keystroke + mouse models; fine-tunes per-user models. Owns model/data storage (`ARTIFACTS_DIR`, `DATA_DIR`), confines every path. |
| **ca-service** | 4100 | Node | The continuous-auth engine. Turns raw events into signed **verdicts**. Stateless w.r.t. the caller (every endpoint takes an explicit `userId`). Owns behavioral DB (`ca.db`). |
| **passkey-service** | 4000 | Node | FIDO2/WebAuthn registration + assertion (step-up). Owns `passkey.db`. |
| **gateway** | 8080 | Node | Multi-tenant front door: resolves identity, signs verdicts (RS256) + exposes JWKS, pushes CAEP events, serves the SDK. The only public entry for the product bundle. |
| **apps/demo** | 3000 | Node | Reference integration app (login as `ali`/`aiham`, dashboard, "write opinion"). |
| **apps/acme** | 4200 | Node | A *separate* consumer on its own origin — adopts Continuum through nothing but the SDK + middleware. |

Boundary rationale: **polyglot forced** (TF is Python), **resource asymmetry**
(the TF process is heavy and was crashing the shared runtime — isolating it is a
model-serving pattern like TF Serving/Triton), and **security-domain partitioning**
(passkey secrets, behavioral data, and tenant signing are separated). The demo talks
to the CA **through** its layer, never to model-api directly.

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

---

## 4. Keystroke dynamics engine
- **Features (per digraph step):** `[id1, id2, dwell1, dwell2, dd, ud]` — key codes
  ÷254, hold times of both keys, down-down and up-down flight times (seconds).
  Faithful to Lu et al. (2020) / the referenced BioKey capstone architecture.
- **Windows:** `WINDOW_SIZE=50`, `STRIDE=10`, stride-aligned only (no padded/tail
  windows — those are out-of-distribution and destabilize scores).
- **Model:** 1D-CNN + 2×LSTM base (`artifacts/ws50-gru`), **fine-tuned per user**
  (transfer learning) with the user's enrollment typing as positives and impostor
  windows (other users + dataset negatives) as negatives.
- **Live decision (Lu et al. packet vote):** score the most recent
  `RECENT_WINDOW_COUNT=6` windows; a window is "low" if its genuine probability
  < `0.50`; the packet is **suspicious** when the low fraction ≥ `PACKET_VOTE_FRACTION=0.50`.
  A wider `ROLLING_WINDOW_COUNT=18` mean drives adaptive-learning eligibility only.
- **Digraph hygiene:** drop event-batching artifacts (`dd < 15 ms` or `dwell < 10 ms`)
  and composition pauses (`dd > 1 s`) — timing noise, not rhythm.
- **Leak-free evaluation:** the public HDF windows overlap in shuffled order; a naive
  split leaks near-duplicates. Windows sharing timing subsequences are grouped and
  never cross the train/test boundary (`data_loader.py`). Honest metrics in
  `artifacts/ws50-gru/results.json`.

## 5. Mouse dynamics engine
- **Feature vector F=7:** `[dx, dy, v, a, dθ, dt, is_click]` — clicks are a learned
  feature, so enrollment **requires real clicks** (`MOUSE_ENROLL_CLICKS=10`), not just
  movement. Base model `artifacts/mouse-ws50-base`; SapiMouse negatives.
- Live checks use a **consecutive-strike debounce** (`MOUSE_STRIKES_TO_LOCK`) before a
  step-up, to tolerate momentary noise.
- *Known limitation:* the mouse base is weak (anchor-free labels are hard to learn);
  a v2 retrain scored worse and was not promoted. Documented for future work.

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

Verdict risk levels: `warmup` / `suspicious` / `genuine`.

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
| Secret leakage in images/repo | Runtime-generated gateway key; fail-fast env secrets; secrets git-ignored + purged from history |

## 15. Repository layout (top level)
```
services/{model-api,ca-service,passkey-service,gateway}   # the product
sdk/                     # guard.js + capture libs (served by gateway/web)
packages/{continuum-node,continuum-python}                # host middleware
apps/{demo,acme}         # reference integrations
artifacts/{ws50-gru,mouse-ws50-base}                      # pretrained base models (only these tracked)
scripts/                 # release.sh, data-export.sh, data-import.sh
.github/workflows/publish.yml                             # CI image publishing
docker-compose{,.prod,.bundle}.yml + .env.example
DEPLOY.md · PC2_SETUP.md · PUBLISHING.md · HANDOFF.md · ARCHITECTURE.md
```
