# TODO — known gaps, not yet fixed

Deliberately **not implemented**. Recorded so they aren't lost. Each entry says what
is wrong, why it matters, and roughly what the fix looks like — no code written yet.

Companion docs: `ARCHITECTURE.md` (system as built) · `DEPLOY.md` (ship it) · `HANDOFF.md` (session notes).

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
lost. **This is why the gateway cannot be horizontally scaled as written** — worth stating
explicitly rather than discovering it in production.

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

## 6. Future work already noted elsewhere

- **Mouse FAR ceiling (~24%)** — a model/biometric limit (bimodal per-user EER), confirmed by
  three sweeps; not fixable by threshold tuning. Real fix is score-level **fusion** with keystroke.
- **Desktop adoption** — the SDK+middleware mode ports to Electron/Tauri nearly unchanged
  (watch `file://` origin binding + WebAuthn RP ID); native toolkits need a capture shim.
  Idea worth developing: a **surface-portability conformance kit** — fixed event traces plus
  expected verdicts that any new capture surface must reproduce before it counts as a valid
  client, so a new shim can't silently skip the warmup-cap / paste / probation invariants.
