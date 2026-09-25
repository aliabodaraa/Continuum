# TODO — known gaps, not yet fixed

Deliberately **not implemented**. Recorded so they aren't lost. Each entry says what
is wrong, why it matters, and roughly what the fix looks like — no code written yet.

Companion docs: `ARCHITECTURE.md` (system as built) · `DEPLOY.md` (ship it) · `HANDOFF.md` (session notes).

---

## 0. Recently closed (kept for the record)

Four gaps that were on this list, or should have been, are now fixed. Recorded here because
the *reasoning* is the part worth keeping.

- **model-api was unauthenticated and reachable by every container.** Compose declared no
  networks, so the demo and acme shared a bridge with it and could score, train or roll back
  any user's model — a biometric hill-climbing oracle. Fixed with three networks
  (`edge` / `internal` / `model`, ca-service the only member of the last) **and**
  `MODEL_API_KEY` on every route but `/health`. Topology alone was not enough: a future
  misconfiguration re-attaching a container would have silently reopened it.
- **The ca → model hop had no deadline.** A wedged TensorFlow process hung the keystroke
  check forever — an undefined failure mode in the authentication path. Now one bounded,
  credentialed client (`lib/modelClient.js`); a stalled model yields `503 model_unavailable`
  (*no verdict*, neither pass nor lock), logged at `[SECURITY]`.
- **Escalation evidence was in process memory.** The keystroke debounce and mouse strike
  counter lived in two `Map`s and a session field, so any restart amnestied an impostor
  mid-escalation. Now persisted in `decision_state`; callers keep their threshold, not the
  count.
- **Retrains were detached promises.** `setImmediate` guarded by an in-memory `Set` lost both
  the run and the guard on restart, with nothing recording that work had been owed. Now the
  `training_jobs` queue with boot-time recovery of interrupted runs.

Two defects were found while making those changes and fixed in passing: the gateway passed
its identity assertion to `.catch()` instead of to `fwd()` on **both** the mouse `lock/set`
and the passkey `lock/clear` calls, so each silently 401'd — the mouse step-up lock was
never actually set, and a verified passkey never actually cleared it.

---

## 1. Tenant registration is not durable (`services/gateway/server.js`)

`POST /v1/tenants` generates `siteKey` (9 random bytes) + `secret` (24 random bytes) and
persists the whole tenant registry as one JSON file. Three separate problems.

### 1a. A failed disk write still returns `200`
`saveJson()` catches the write error, logs it, and returns normally — then the handler
unconditionally sends `res.json({ siteKey, secret })`. On a read-only or full disk the
operator receives credentials that live **only in RAM** and disappear on the next restart.

*Fix:* let `saveJson` propagate failure; return `500` instead of handing out phantom keys.

### 1b. Whole-file, non-atomic write
`fs.writeFileSync(TENANTS_FILE, …)` rewrites `tenants.json` in place. A crash mid-write
truncates it; `loadJson` then falls back to `{ tenants: {} }` on the parse error, so
**corruption reads as "no tenants"** — silently — and `pk_demo` re-seeds over the wreckage.

*Fix:* write `tenants.json.tmp` then `fs.renameSync` (atomic on the same filesystem).

### 1c. Two gateway replicas would clobber each other
`tenants` is loaded into memory once at boot and each registration rewrites the entire
file from that in-memory copy. Two processes ⇒ last writer wins, the other's tenants are
lost. **This is now the *only* thing keeping the gateway single-process** — worth stating
explicitly rather than discovering it in production.

> Update: this used to be one of two blockers. The other — per-user decision counters held
> in gateway memory, which two replicas would each hold half of — is closed: the counters
> moved into `decision_state` in ca-service. The gateway's remaining in-memory maps are
> `pkCache` (a 60 s cache; a miss is a re-fetch, not a wrong answer) and `lastRisk` (CAEP
> transition dedupe; after a restart the first *suspicious* still fires an event, which is
> the safe direction — the failure mode is a redundant event, never a missed escalation).

*Fix (real one):* move the tenant registry to SQLite, like `ca.db` / `passkey.db`. The
JSON file is fine for a single-process demo and wrong for anything else.

### 1d. No uniqueness check on `siteKey` (low priority)
`tenants.tenants[siteKey] = {…}` is an unconditional assignment — a duplicate would
silently overwrite an existing tenant (new secret, old tenant instantly broken).

**Not a practical risk:** 72 bits of CSPRNG entropy ⇒ ~1e-10 collision odds at a million
tenants, 50% only at ~81 billion. But making it explicit costs one line:

```js
let siteKey;
do { siteKey = "pk_" + crypto.randomBytes(9).toString("hex"); } while (tenants.tenants[siteKey]);
```

> Framing: **collision is handled by mathematics; durability is handled by nothing.**

---

## 2. `GATEWAY_ADMIN_KEY` defaults to open

`adminGate` becomes a **no-op** when `GATEWAY_ADMIN_KEY` is unset, and the variable appears
in **no** compose file and **not** in `.env.example`. On a fresh deploy, anyone who can reach
`:8080` can register a tenant.

*Fix:* add it to `docker-compose.bundle.yml` with the same fail-fast `${VAR:?…}` treatment as
`CA_SIGNING_SECRET` / `GATEWAY_SESSION_SECRET`, or refuse registration outright when unset.

---

## 3. `pk_demo` is origin-unbound

The auto-seeded demo tenant is created with `origins: []`, and `originAllowed()` returns
`true` for an empty list — so **the demo site key is accepted from any origin**. Intentional
for the bundle (`ARCHITECTURE.md`: "only the demo tenant is left open"), but anyone who views
source on a live demo can lift `pk_demo` and register into that user namespace.

*Fix:* pin `origins` before any public demo, or gate the allow-all fallback behind `NODE_ENV`.

---

## 4. `POST /v1/tenants` is undocumented

The onboarding path for a real customer's app exists in code but appears in no operator
doc — `DEPLOY.md` never mentions it. Anyone asking "how does a second app onboard?" has to
read `server.js`.

*Fix:* a short "Register a tenant" section in `DEPLOY.md` with the `curl`, plus where each
returned value goes (`siteKey` → `<script data-site-key>`, `secret` → backend `CONTINUUM_SECRET`).

---

## 5. Same-origin co-tenancy is undefended (by design — document it)

Origin binding cannot separate two apps on the **same** origin sharing a site key: identical
`Origin` headers, and `signSession` carries no path. Their `continuumUserId` namespaces then
collide, which cross-wires trained models, passkeys, locks, **and verdicts** (a verdict earned
in app B verifies at app A's `protect()`).

Correct today for one product across several surfaces (microfrontends, SPA + admin panel).
Wrong for two unrelated co-hosted products — those need **separate site keys**; overlapping
origins are fine, since the namespace keys on `siteKey`.

*Not a bug — a deployment rule.* Needs to be written down: **origin binding is a defense
against site-key theft, not a tenancy boundary. The tenancy boundary is the secret.**

---

## 5b. Training shares a process with inference inside model-api

The queue (§0) made retraining *durable*; it did not isolate it. model-api runs Flask's
development server (`app.run(...)`), which is threaded by default, so a training run does not
block `/api/user/predict` outright. Measured 2026-09-23 during an S1 mouse enrolment (nine fits,
about 2.5 min): 60-window mouse checks took about 150 ms, against about 115 ms idle, far inside
the 5 s inference deadline. What remains is CPU contention, which grows with concurrent training.

A related gap: the **first inference after a model-api restart** loads the user's model from
disk, and one such cold load exceeded the 5 s deadline (validate_pipeline check 5,
2026-09-23: model-api loaded the same model twice, i.e. ca-service had abandoned the first
request). The caller then gets "model temporarily unavailable" for that one check.

> **Cold loads addressed 2026-09-25** (`api.py`). One load runs per model: a caller that times
> out and retries now waits for the load already in progress instead of starting a second one
> (three simultaneous first requests: one load, all 200 in about 2.2 s). At boot the server loads,
> in the background, the live models used or trained in the last 14 days (`MODEL_WARM_DAYS`),
> newest first, at most 8 (`MODEL_WARM_MAX`); use is recorded in
> `artifacts/users/.last_used.json` by the server only. A model is loaded again as soon as
> training or a rollback replaces it. Checked: `validate_pipeline.js` passed right after three
> fresh restarts, and `e2e_mouse_a5.js` passed with warm-after-train visible in the log.

*Still open:* run model-api under gunicorn with more than one worker, and ideally a separate
worker class or process for `/api/user/train`, so training never competes with an inference slot.
Mind the memory: each worker loads TensorFlow and its own model cache.

**Memory grows with every training (found 2026-09-25).** Retraining the 84 keystroke profiles
for T3.3 in one model-api process took it from about 1 GB to about 11 GB resident, roughly
125 MB kept per training, and the PC ran short of memory. Experiment KS showed the same growth
in a plain training loop despite `clear_session()` per target (5.5 GB during one arm). A restart
frees it. Until the cause is found, restart model-api after a bulk retrain, and run training in
a worker process that exits (or is recycled) after each job. The gunicorn item above would do
this with `max_requests` on the training worker.

## 6. Future work already noted elsewhere

- **Mouse FAR ceiling (~24%)** — a model/biometric limit (bimodal per-user EER), confirmed by
  three sweeps; not fixable by threshold tuning. Real fix is score-level **fusion** with keystroke.
- **Desktop adoption** — the SDK+middleware mode ports to Electron/Tauri nearly unchanged
  (watch `file://` origin binding + WebAuthn RP ID); native toolkits need a capture shim.
  Idea worth developing: a **surface-portability conformance kit** — fixed event traces plus
  expected verdicts that any new capture surface must reproduce before it counts as a valid
  client, so a new shim can't silently skip the warmup-cap / paste / probation invariants.

---

## 7. Mouse: a user's threshold can collapse, and with it their protection

> **Server side addressed 2026-09-23 (recovery plan Phase 0):** S1 is deployed as the owner's
> disclosed deviation from the P6 verdict. The line is now the 20th percentile of the user's
> leave-one-sample-out scores (Method B, 440 windows, 33 of 60), which is item 1's candidate as
> measured, prompt cost included; see RUN_LOG 2026-09-23. The numbers below stay as the "before"
> (item 4). Still open: item 3 (validation on data SapiMouse cannot provide) and the browser
> extension, which keeps its in-sample line.

The per-user line is the **1st percentile of that user's 330 enrolment window scores**, so in
practice it is set by their **three lowest enrolment windows**. A user who produced a few odd
windows while enrolling gets a line near zero — after which almost nothing ever falls below it
and an impostor is never flagged.

Measured on the first untouched group of twenty (P6, `analysis_J_P6.json`), deployed rule:

| user | impostor runs caught | per-window AUC | their line |
|---|---|---|---|
| user92 | 5% | 0.723 | 0.009 |
| user103 | 16% | 0.616 | 0.029 |
| user60 | 21% | 0.723 | 0.013 |
| user61 | 26% | 0.859 | 0.054 |
| other 16 | 63–100% | | |

Those four carry the whole gap between the two untouched groups: 77.1% (group 1, 20 users) vs
91.8% (group 2, 20 users); group 1 without those four averages 92%. Two causes stack — the user
is genuinely less distinctive (low AUC), *and* their line collapsed. Over all 40 untouched users
the deployed rule catches **84.4%** of impostor runs.

*Fix — none of it may be selected on the untouched groups, which are spent:*

1. **Pre-register the new threshold rule before running anything.** Candidate: score each
   enrolment sample with a model that did not train on it (Method B). Already measured on both
   untouched groups — it works (AUC +0.018 to +0.025, better for 18 of 20 users, capture +17.9
   points on group 1) but roughly doubles genuine prompts, so the pre-registered margin rejected
   it. What is needed is a variant that keeps the capture gain without the prompt cost.
2. **A floor under the personal line.** Tested as a candidate in P5 and never adopted; re-open
   only with a stated justification, since a floor trades one user's comfort for another's safety.
3. **Validate on data SapiMouse cannot provide.** All 120 of its users are spent (60 base, 20
   development, 20 + 20 untouched), so any new rule must be proven on a second public dataset or
   on the user study — not on SapiMouse again.
4. **Keep 77.1 / 91.8 / 84.4 in the record as the "before" numbers**, whichever way the fix goes.

*Why it is not simply "raise the percentile":* the percentile and the vote were chosen together
against a measured interruption budget (Experiment I). Moving either one alone re-opens that
trade-off, which is why this needs a pre-registered experiment rather than a tuning pass.
