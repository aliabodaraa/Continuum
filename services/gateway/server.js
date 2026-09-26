// Continuum API Gateway — the multi-tenant front door + backend for the browser SDK.
//   • serves the SDK assets (guard.js + deps),
//   • is a TENANT REGISTRY: any app self-registers (POST /v1/tenants) and gets a
//     site key (public) + signing secret (private) + allowed origins,
//   • mints a per-user Continuum identity/session (/v1/sdk/session), scoped to a tenant,
//   • exposes a CORS-enabled, TOKEN-SCOPED facade (/v1/sdk/*) that injects userId/
//     username/origin and routes to CA + passkey,
//   • RE-SIGNS each risk verdict with the TENANT's secret, so one tenant can never
//     verify (or forge) another tenant's verdicts.
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const CA_URL = process.env.CA_API_URL || "http://ca-service:4100";
const ONBOARDING_MODE = process.env.ONBOARDING_MODE === "lazy" ? "lazy" : "eager";
const PASSKEY_URL = process.env.PASSKEY_API_URL || "http://passkey-service:4000";
// Signs the gateway session token AND derives the per-deployment user-id namespace
// (continuumUserId = HMAC(SESSION_SECRET, siteKey|externalId)). A shared value makes
// session tokens forgeable and user ids identical across deployments — so any real
// deployment MUST set a unique one (enforced fail-fast in docker-compose.bundle.yml).
const SESSION_SECRET = process.env.GATEWAY_SESSION_SECRET || "dev-gateway-session-secret";
if (SESSION_SECRET === "dev-gateway-session-secret") {
  console.warn(
    "[continuum][SECURITY] GATEWAY_SESSION_SECRET is unset — using the shared DEV default. " +
      "Session tokens are forgeable and user ids are not deployment-unique. " +
      "Set a unique value for any real deployment:  openssl rand -hex 32",
  );
}
const SESSION_TTL_SEC = Number(process.env.GATEWAY_SESSION_TTL_SEC || 12 * 3600);
const RISK_TTL_SEC = Number(process.env.GATEWAY_RISK_TTL_SEC || 90);
// Admin key to gate tenant registration. If unset (dev), registration is open.
const ADMIN_KEY = process.env.GATEWAY_ADMIN_KEY || "";
// Default demo tenant's secret — must equal the demo host's CONTINUUM_SECRET.
const DEMO_SECRET = process.env.CA_SIGNING_SECRET || "dev-continuum-risk-secret";
const USER_ID_BASE = Number(process.env.GATEWAY_USER_ID_BASE || 900000);
const DATA_DIR = process.env.DATA_DIR || __dirname;
const IDENTITY_FILE = path.join(DATA_DIR, "identity.json");
const TENANTS_FILE = path.join(DATA_DIR, "tenants.json");
const SDK_PUBLIC = path.join(__dirname, "sdk-public");

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; } }
function saveJson(file, obj) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch (e) { console.error("save", file, e.message); } }

// ---- tenant registry ----
let tenants = loadJson(TENANTS_FILE, { tenants: {} });
// Seed the demo tenant so the bundled Acme app works out of the box.
if (!tenants.tenants["pk_demo"]) {
  tenants.tenants["pk_demo"] = { name: "Demo", secret: DEMO_SECRET, origins: [], webhookUrl: process.env.DEMO_WEBHOOK_URL || null, createdAt: new Date().toISOString() };
  saveJson(TENANTS_FILE, tenants);
}
// Keep the demo tenant's webhook in sync with env (so CAEP is demonstrable).
if (tenants.tenants["pk_demo"] && process.env.DEMO_WEBHOOK_URL) tenants.tenants["pk_demo"].webhookUrl = process.env.DEMO_WEBHOOK_URL;
const resolveTenant = (siteKey) => tenants.tenants[siteKey] || null;

// Verify a backend-signed IDENTITY token: `base64url({sub,exp}).hmacHex`, signed
// with the tenant's secret. This is how any backend (Python/PHP/Ruby/Go/.NET/…)
// vouches for its logged-in user without the browser being able to spoof it.
function verifyIdentity(secret, token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  let payloadB64, sig, expected;
  if (parts.length === 3) {
    // STANDARD HS256 JWT (header.payload.signature) — the documented contract:
    // any language's stock JWT library can mint this (client_secret_jwt).
    let header; try { header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch (e) { return null; }
    if (header.alg !== "HS256") return null;
    payloadB64 = parts[1]; sig = parts[2];
    expected = crypto.createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest("base64url");
  } else if (parts.length === 2) {
    // Legacy compact form (base64url(payload).hexhmac) — kept for back-compat.
    payloadB64 = parts[0]; sig = parts[1];
    expected = crypto.createHmac("sha256", secret).update(payloadB64).digest("hex");
  } else return null;
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let pl; try { pl = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")); } catch (e) { return null; }
  if (pl.exp && Math.floor(Date.now() / 1000) > pl.exp + 5) return null;
  return pl && pl.sub != null ? pl : null;
}

// ---- identity mapping (siteKey|externalId -> Continuum user) ----
// DETERMINISTIC: the Continuum userId is a stable hash of (siteKey, externalId),
// NOT an auto-increment kept in a file. So the SAME logged-in user (same signed
// `sub` from the consumer) ALWAYS resolves to the SAME Continuum userId — hence
// the SAME keystroke/mouse models — with no lookup table that could be lost. The
// consumer stores nothing about Continuum; it just re-sends its own user id.
// THE IDENTITY REGISTRY. Read-before-compute: a stored allocation always wins.
//
// This used to write the store and then return the freshly COMPUTED hash, never reading
// back — which made the file decorative and the identity ephemeral. Two consequences were
// observed in this deployment:
//   * ids 900001..900010, allocated by an earlier counter-based scheme, became unreachable:
//     userFor() returned a hash instead of the recorded value, stranding their data.
//   * rotating GATEWAY_SESSION_SECRET would silently re-map every user, orphaning every
//     biometric profile, because identity was recomputed on every call.
//
// Now the HMAC is used ONLY to allocate an id the first time a (tenant, externalId) pair is
// seen. After that the allocation is a stored fact. Rotating the secret therefore affects
// nobody already registered — it only changes the seed for principals not yet allocated.
let store = loadJson(IDENTITY_FILE, { users: {} });
function userFor(siteKey, externalId) {
  const key = siteKey + "|" + externalId;
  const known = store.users[key];
  if (known) return { userId: known.userId, username: (siteKey + "-" + externalId).slice(0, 48) };

  // first sighting — allocate deterministically, then persist so it never moves again
  const h = crypto.createHmac("sha256", SESSION_SECRET).update(key).digest("hex");
  const userId = parseInt(h.slice(0, 13), 16); // stable id within JS safe-integer range
  store.users[key] = { userId, externalId, createdAt: new Date().toISOString() };
  saveJson(IDENTITY_FILE, store);
  return { userId, username: (siteKey + "-" + externalId).slice(0, 48) };
}

// ---- tokens ----
const b64 = (s) => Buffer.from(s).toString("base64url");
function jwt(secret, payload) {
  const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64(JSON.stringify(payload));
  const d = h + "." + p;
  return d + "." + crypto.createHmac("sha256", secret).update(d).digest("base64url");
}
function unjwt(secret, t) {
  if (!t || typeof t !== "string") return null;
  const parts = t.split("."); if (parts.length !== 3) return null;
  const exp = crypto.createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest("base64url");
  const a = Buffer.from(parts[2]), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let pl; try { pl = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch (e) { return null; }
  if (pl.exp && Math.floor(Date.now() / 1000) > pl.exp) return null;
  return pl;
}
function signSession(u, siteKey, externalId) {
  const now = Math.floor(Date.now() / 1000);
  // `ext` carries the consumer's OWN user identifier (what they signed into the
  // identity token) so pushed events can name the subject in the consumer's terms.
  return jwt(SESSION_SECRET, { sub: u.userId, uname: u.username, sk: siteKey, ext: externalId, iat: now, exp: now + SESSION_TTL_SEC });
}
// The subject a CONSUMER understands: their raw id (strip our "id:" namespace on
// verified account ids); anon browser ids pass through unchanged.
const extSubject = (ext) => (typeof ext === "string" && ext.startsWith("id:") ? ext.slice(3) : ext);
// ---- verdict signing: RS256 (asymmetric) + JWKS — the framework-agnostic best
// practice. Continuum signs verdicts with a PRIVATE key; consumers verify with the
// PUBLIC key from /.well-known/jwks.json using their framework's native JWT tooling
// (no shared secret). Identity tokens (consumer→gateway) stay HMAC (client_secret).
const ISSUER = process.env.GATEWAY_PUBLIC_URL || "http://localhost:8080";
let rsaPrivateKey, verdictJwk, verdictKid;
(function loadVerdictKeys() {
  const keyFile = path.join(DATA_DIR, "gateway-verdict-key.pem");
  let pem;
  try { pem = fs.readFileSync(keyFile, "utf8"); }
  catch (e) {
    const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    pem = kp.privateKey;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(keyFile, pem); } catch (_) {}
  }
  rsaPrivateKey = crypto.createPrivateKey(pem);
  const pub = crypto.createPublicKey(rsaPrivateKey).export({ format: "jwk" }); // { kty, n, e }
  verdictKid = crypto.createHash("sha256").update(pub.n).digest("hex").slice(0, 16);
  verdictJwk = { ...pub, kid: verdictKid, use: "sig", alg: "RS256" };
})();
// ---- INTERNAL IDENTITY ASSERTIONS -----------------------------------------
// The gateway is the only identity authority. Downstream services must never take a user id
// from a request body — a caller that can name its own principal can name anyone's. Instead
// the gateway signs a short-lived assertion of WHO the request acts for, and ca-service
// trusts only that.
//
// Signed RS256 with a keypair SEPARATE from verdict signing, so the two rotate independently.
// Asymmetric rather than a shared secret on purpose: with an HMAC key, ca-service would hold
// the power to mint its own authority — the very thing the assertion exists to constrain.
// Here the gateway holds the private key; ca-service verifies with the public one and can
// forge nothing.
//
// This assertion is BACKEND-ONLY. It is never returned to a browser, never set as a cookie,
// and ca-service is not reachable from the host, so a client cannot present one directly.
let identityPrivateKey, identityJwk, identityKid;
(function loadIdentityKeys() {
  const keyFile = path.join(DATA_DIR, "gateway-identity-key.pem");
  let pem;
  try { pem = fs.readFileSync(keyFile, "utf8"); }
  catch (e) {
    const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    pem = kp.privateKey;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(keyFile, pem); } catch (_) {}
  }
  identityPrivateKey = crypto.createPrivateKey(pem);
  const pub = crypto.createPublicKey(identityPrivateKey).export({ format: "jwk" });
  identityKid = "id-" + crypto.createHash("sha256").update(pub.n).digest("hex").slice(0, 16);
  identityJwk = { ...pub, kid: identityKid, use: "sig", alg: "RS256" };
})();

const ASSERTION_TTL = Number(process.env.IDENTITY_ASSERTION_TTL || 300); // seconds

function mintAssertion(tenantId, principalId, audience) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: identityKid }));
  // `aud` matters: the gateway relays to ca-service AND passkey-service, and an assertion
  // minted for one must not be replayable at the other.
  const p = b64(JSON.stringify({
    iss: "gateway", aud: audience, sub: String(principalId),
    tenant_id: tenantId, iat: now, exp: now + ASSERTION_TTL,
  }));
  const data = h + "." + p;
  const sig = crypto.createSign("RSA-SHA256").update(data).sign(identityPrivateKey, "base64url");
  return data + "." + sig;
}

function signRiskRS256(userId, risk, modality) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT", kid: verdictKid }));
  const body = b64(JSON.stringify({ iss: ISSUER, sub: String(userId), risk, modality, iat: now, exp: now + RISK_TTL_SEC }));
  const data = header + "." + body;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(data), rsaPrivateKey).toString("base64url");
  return data + "." + sig;
}
// Signature kept (callers pass a secret) but verdicts are now asymmetric; secret ignored.
function signRisk(_secret, userId, risk, modality) { return signRiskRS256(userId, risk, modality); }
const riskLevel = (warmup, suspicious) => (warmup ? "warmup" : suspicious ? "suspicious" : "genuine");

// ---- CAEP / Shared Signals: push a signed Security Event Token (SET) to the
// tenant's webhook the moment a user's SETTLED verdict changes (genuine<->suspicious),
// so the app can react mid-session without waiting for a sensitive action. The SET
// is RS256 (same key as verdicts) → the receiver verifies it via the SAME JWKS.
function signEvent(subject, risk, modality) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "RS256", typ: "secevent+jwt", kid: verdictKid }));
  // `sub` is the consumer's OWN user id (their terms), so their receiver can act
  // on it directly; the Continuum id stays internal.
  const body = b64(JSON.stringify({ iss: ISSUER, sub: String(subject), event: "risk-change", risk, modality, iat: now, jti: crypto.randomBytes(8).toString("hex") }));
  const data = header + "." + body;
  return data + "." + crypto.sign("RSA-SHA256", Buffer.from(data), rsaPrivateKey).toString("base64url");
}
const lastRisk = new Map(); // keyId (Continuum id) -> last SETTLED risk ("genuine" | "suspicious")
function maybeFireRiskEvent(tenant, keyId, subject, risk, modality) {
  if (!tenant || !tenant.webhookUrl) return;
  if (risk !== "genuine" && risk !== "suspicious") return; // ignore warm-up (transient)
  const prev = lastRisk.get(keyId);
  if (prev === risk) return;                 // no transition
  lastRisk.set(keyId, risk);
  if (prev === undefined && risk === "genuine") return; // first-seen-genuine isn't an event
  const set = signEvent(subject, risk, modality);
  console.log(`[caep] risk-change user=${subject} ${prev || "?"}→${risk} → ${tenant.webhookUrl}`);
  fetch(tenant.webhookUrl, { method: "POST", headers: { "Content-Type": "application/secevent+jwt" }, body: set }).catch((e) => console.error("[caep] delivery failed:", e.message));
}

const app = express();

// ---- CORS ----
app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (origin) { res.set("Access-Control-Allow-Origin", origin); res.set("Vary", "Origin"); }
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Api-Key,X-Admin-Key");
  res.set("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "5mb" }));
app.use(express.static(SDK_PUBLIC));
app.get("/health", (req, res) => res.json({ ok: true, service: "gateway", tenants: Object.keys(tenants.tenants).length }));

// ---- discovery + public keys (so ANY framework verifies verdicts with config, not code) ----
app.get("/.well-known/jwks.json", (req, res) => res.json({ keys: [verdictJwk, identityJwk] }));
app.get("/.well-known/continuum-configuration", (req, res) => res.json({
  issuer: ISSUER,
  jwks_uri: ISSUER + "/.well-known/jwks.json",
  session_endpoint: ISSUER + "/v1/sdk/session",
  risk_endpoint: ISSUER + "/v1/risk",
  verdict_signing_alg: "RS256",
  verdict_claims: ["iss", "sub", "risk", "modality", "iat", "exp"],
  risk_values: ["genuine", "warmup", "suspicious"],
  // How a consumer's backend vouches for its logged-in user (client_secret_jwt):
  // a plain HS256 JWT any language's JWT library can mint — no Continuum SDK needed.
  identity_token: {
    format: "JWT",
    signing_alg: "HS256",
    key: "your tenant secret",
    claims: ["sub", "exp"],
    subject: "your own user id",
    send_via: ["SDK data-identity-url / Continuum.identify()", "POST /v1/resolve"],
  },
  // CAEP / Shared Signals push contract — everything a consumer in ANY language
  // needs to receive risk-change events without reading Continuum's SDK source:
  // expose an endpoint that verifies this token against jwks_uri and acts on { sub, risk }.
  caep: {
    delivery_method: "urn:ietf:rfc:8935",              // push (SET over HTTP POST)
    receiver_registration: "tenant.webhookUrl",         // where to register your endpoint
    content_type: "application/secevent+jwt",
    signing_alg: "RS256",                               // verify via jwks_uri (same key as verdicts)
    event_type: "risk-change",
    event_claims: ["iss", "sub", "event", "risk", "modality", "iat", "jti"],
    risk_values: ["genuine", "suspicious"],             // warm-up is transient — never pushed
    subject: "consumer_user_id",                        // `sub` is YOUR user id (from the identity token)
    fires_on: "settled_verdict_transition",             // only on genuine<->suspicious change
  },
}));

// ---- helpers ----
// Service-to-service shared secrets. ca-service and passkey-service each activate their
// key check only when their own key is set, so these stay optional in dev — but if a key
// is configured downstream and NOT sent here, every relayed SDK call fails with 401.
const CA_API_KEY = process.env.CA_API_KEY || "";
const PASSKEY_API_KEY = process.env.PASSKEY_API_KEY || "";

async function fwd(url, method, body, assertion) {
  const headers = { "Content-Type": "application/json" };
  // WHO the call acts for. ca-service takes identity from this header alone.
  if (assertion) headers["X-Continuum-Identity"] = assertion;
  // Pick the key by destination: fwd() is called with both CA_URL and PASSKEY_URL targets.
  if (url.startsWith(CA_URL) && CA_API_KEY) headers["X-Api-Key"] = CA_API_KEY;
  else if (url.startsWith(PASSKEY_URL) && PASSKEY_API_KEY) headers["X-Api-Key"] = PASSKEY_API_KEY;
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, ct: r.headers.get("content-type") || "application/json", text };
}
// The gateway already authenticated the session; assert that identity downstream.
const caAssert = (req) => (req && req.uid != null && req.tenantKey ? mintAssertion(req.tenantKey, req.uid, "ca-service") : undefined);
const relay = (res, r) => { res.status(r.status); res.set("Content-Type", r.ct); res.send(r.text); };
const rpFromOrigin = (req) => { try { return new URL(req.get("Origin")).hostname; } catch (e) { return "localhost"; } };
const originOf = (req) => req.get("Origin") || undefined;
function originAllowed(tenant, req) {
  if (!tenant.origins || tenant.origins.length === 0) return true; // no allowlist = allow all (dev)
  const o = req.get("Origin"); return !o || tenant.origins.includes(o);
}

const pkCache = new Map();
// Through fwd(), which sends PASSKEY_API_KEY. This used a bare fetch: since passkey-service began
// enforcing the key (860b4d6), every lookup came back 401, `hasPasskey` read false for every user,
// and so the gateway path never raised a keystroke or mouse step-up (found 2026-09-26 by the
// user-study end-to-end test). A failed lookup is logged and not cached as "no passkey".
async function hasPasskey(uid) {
  const c = pkCache.get(uid); if (c && Date.now() - c.t < 60000) return c.v;
  try {
    const r = await fwd(`${PASSKEY_URL}/v1/users/${uid}/passkeys`, "GET");
    if (r.status !== 200) { console.error(`[gateway] passkey lookup for user ${uid} failed: HTTP ${r.status}`); return false; }
    const v = !!JSON.parse(r.text).hasPasskey; pkCache.set(uid, { v, t: Date.now() }); return v;
  } catch (e) { console.error(`[gateway] passkey lookup for user ${uid} failed: ${e.message}`); return false; }
}
// Through fwd() with an identity assertion: ca-service's route requires both the service key and
// the gateway's assertion. A bare fetch (as before) got 401, so every user read as not enrolled and
// the SDK's eager onboarding offered enrolment again (found 2026-09-26 with the hasPasskey bug above).
async function onboardingFor(uid, tenantKey) {
  const pk = await hasPasskey(uid);
  let ob = {};
  try {
    const r = await fwd(`${CA_URL}/v1/users/${uid}/onboarding`, "GET", undefined, mintAssertion(tenantKey, uid, "ca-service"));
    if (r.status === 200) ob = JSON.parse(r.text);
    else console.error(`[gateway] onboarding lookup for user ${uid} failed: HTTP ${r.status}`);
  } catch (e) { console.error(`[gateway] onboarding lookup for user ${uid} failed: ${e.message}`); }
  return { passkey: pk, keystroke: !!ob.trained, mouse: !!ob.mouseEnrolled };
}

// ---- TENANT REGISTRATION (self-service) ----
function adminGate(req, res, next) { if (ADMIN_KEY && req.get("X-Admin-Key") !== ADMIN_KEY) return res.status(401).json({ error: "invalid_admin_key" }); next(); }
app.post("/v1/tenants", adminGate, (req, res) => {
  const name = String(req.body.name || "app");
  const origins = Array.isArray(req.body.origins) ? req.body.origins.map(String).filter(Boolean) : [];
  // A site key is PUBLIC (it lives in the page). Binding it to the tenant's own
  // origin(s) is what stops another app on this gateway from reusing the same key
  // (which would collide their user namespaces). So a real tenant MUST declare its
  // origin(s); the same key loaded from any other origin is then rejected (403).
  if (origins.length === 0) {
    return res.status(400).json({
      error: "origins_required",
      note: "Provide origins: [\"https://your-app.com\"] so the site key is bound to your domain(s) and can't be reused by another app.",
    });
  }
  const webhookUrl = req.body.webhookUrl ? String(req.body.webhookUrl) : null; // CAEP push target
  const siteKey = "pk_" + crypto.randomBytes(9).toString("hex");
  const secret = crypto.randomBytes(24).toString("hex");
  tenants.tenants[siteKey] = { name, secret, origins, webhookUrl, createdAt: new Date().toISOString() };
  saveJson(TENANTS_FILE, tenants);
  res.json({ siteKey, secret, name, origins, webhookUrl, note: "Put siteKey in the SDK <script data-site-key>, and secret in your backend CONTINUUM_SECRET." });
});
app.get("/v1/tenants", adminGate, (req, res) => {
  res.json({ tenants: Object.entries(tenants.tenants).map(([k, t]) => ({ siteKey: k, name: t.name, origins: t.origins, createdAt: t.createdAt })) });
});

// ---- identity: establish a tenant-scoped session ----
app.post("/v1/sdk/session", async (req, res) => {
  try {
    const siteKey = String(req.body.siteKey || "");
    const tenant = resolveTenant(siteKey);
    if (!tenant) return res.status(401).json({ error: "invalid_site_key" });
    if (!originAllowed(tenant, req)) return res.status(403).json({ error: "origin_not_allowed" });
    // Prefer a backend-signed identity (account-bound, cross-device). Fall back to
    // an anonymous, browser-bound externalId when the app hasn't identified a user.
    let externalId, verified = false;
    if (req.body.identityToken) {
      const id = verifyIdentity(tenant.secret, req.body.identityToken);
      if (!id) return res.status(401).json({ error: "invalid_identity_token" });
      externalId = "id:" + String(id.sub); verified = true; // namespaced from anon ids
    } else {
      externalId = String(req.body.externalId || "anon-" + crypto.randomUUID());
    }
    const u = userFor(siteKey, externalId);
    res.json({ token: signSession(u, siteKey, externalId), userId: u.userId, username: u.username, externalId, verified, onboarding: await onboardingFor(u.userId, siteKey), onboardingMode: ONBOARDING_MODE });
  } catch (e) { console.error("session:", e); res.status(500).json({ error: e.message }); }
});

// Server-to-server: the consumer's backend resolves the Continuum userId for one
// of its users (given a signed identity token), so it can STORE the link in its
// own database if it wishes. Deterministic — same input, same id, forever.
// Backend-to-backend ONLY. A tenant's own server proves who it is by signing an identity
// token with its tenant secret, names ONE OF ITS OWN users, and receives a signed assertion
// naming the canonical principal. The caller never chooses the principal — it names an
// external user id and the gateway resolves it through the registry.
//
// Cross-tenant is cryptographically impossible: the siteKey selects which secret verifies the
// token, so presenting another tenant's siteKey fails the signature check.
app.post("/v1/assert", (req, res) => {
  const siteKey = String(req.body.siteKey || "");
  const tenant = resolveTenant(siteKey);
  if (!tenant) return res.status(401).json({ error: "invalid_site_key" });
  if (tenant.status && tenant.status !== "active") return res.status(403).json({ error: "tenant_revoked" });
  const id = verifyIdentity(tenant.secret, req.body.identityToken);
  if (!id) return res.status(401).json({ error: "invalid_identity_token" });
  const u = userFor(siteKey, "id:" + String(id.sub));
  const audience = String(req.body.audience || "ca-service");
  res.json({
    assertion: mintAssertion(siteKey, u.userId, audience),
    expiresIn: ASSERTION_TTL,
    tenantId: siteKey,
    principalId: u.userId,   // returned for logging/debug; ca-service ignores anything but the assertion
  });
});

app.post("/v1/resolve", (req, res) => {
  const siteKey = String(req.body.siteKey || "");
  const tenant = resolveTenant(siteKey);
  if (!tenant) return res.status(401).json({ error: "invalid_site_key" });
  const id = verifyIdentity(tenant.secret, req.body.identityToken);
  if (!id) return res.status(401).json({ error: "invalid_identity_token" });
  const u = userFor(siteKey, "id:" + String(id.sub));
  res.json({ continuumUserId: u.userId, sub: id.sub });
});

// Session auth: resolves user AND tenant (from the token's siteKey).
function auth(req, res, next) {
  const h = req.get("Authorization") || "";
  const pl = unjwt(SESSION_SECRET, h.startsWith("Bearer ") ? h.slice(7) : null);
  if (!pl) return res.status(401).json({ error: "invalid_session" });
  const tenant = resolveTenant(pl.sk);
  if (!tenant) return res.status(401).json({ error: "tenant_revoked" });
  if (!originAllowed(tenant, req)) return res.status(403).json({ error: "origin_not_allowed" });
  req.uid = pl.sub; req.uname = pl.uname; req.tenant = tenant; req.tenantKey = pl.sk; req.esub = extSubject(pl.ext); next();
}

app.get("/v1/sdk/onboarding", auth, async (req, res) => res.json(await onboardingFor(req.uid, req.tenantKey)));

// keystroke
app.get("/v1/sdk/keystroke/config", auth, async (req, res) => relay(res, await fwd(`${CA_URL}/v1/keystroke/config`, "GET", undefined, caAssert(req))));
app.get("/v1/sdk/keystroke/status", auth, async (req, res) => relay(res, await fwd(`${CA_URL}/v1/keystroke/status/${req.uid}`, "GET", undefined, caAssert(req))));
app.post("/v1/sdk/keystroke/enroll", auth, async (req, res) => relay(res, await fwd(`${CA_URL}/v1/keystroke/enroll`, "POST", { ...req.body, userId: req.uid }, caAssert(req))));
// User study (ca-service lib/studyLog.js): a passkey prompt event as the study client saw it.
app.post("/v1/sdk/study/prompt", auth, async (req, res) => relay(res, await fwd(`${CA_URL}/v1/study/prompt`, "POST", { ...req.body, userId: req.uid }, caAssert(req))));
// Adaptive learning: contribute a clean, high-confidence sample to the user's
// training set (the CA retrains every N samples, validation-gated).
app.post("/v1/sdk/keystroke/contribute", auth, async (req, res) => relay(res, await fwd(`${CA_URL}/v1/keystroke/contribute`, "POST", { ...req.body, userId: req.uid }, caAssert(req))));
app.post("/v1/sdk/keystroke/check", auth, async (req, res) => {
  const r = await fwd(`${CA_URL}/v1/keystroke/check`, "POST", { ...req.body, userId: req.uid, hasPasskey: await hasPasskey(req.uid) }, caAssert(req));
  let d; try { d = JSON.parse(r.text); } catch (e) { return relay(res, r); }
  if (d && d.checked) {
    const rk = riskLevel(d.warmup, d.isSuspicious);
    d.riskToken = signRiskRS256(req.uid, rk, "keystroke");
    maybeFireRiskEvent(req.tenant, req.uid, req.esub || req.uid, rk, "keystroke"); // push on transition
  }
  res.status(r.status).json(d);
});

// mouse
app.post("/v1/sdk/mouse/enroll", auth, async (req, res) => relay(res, await fwd(`${CA_URL}/v1/mouse/enroll`, "POST", { ...req.body, userId: req.uid }, caAssert(req))));
// THRESHOLD, not state. The count is persisted by ca-service (lib/decisionState.js) and
// comes back as `suspiciousStreak`. It used to be a `Map` here, with two consequences: a
// gateway restart amnestied an impostor mid-escalation, and a second gateway replica was
// impossible because two processes would each hold half the evidence.
// 1 = no extra debounce, the same as the demo (apps/demo/routes/auth/mouse.js). ca-service's
// sustained vote (12 of the last 20 windows below the user's own threshold) already is the
// debounce, and it is the rule whose false-lock and capture rates were measured
// (artifacts/repr_arch_study, Experiment F). This was 3, which stacked three full buffers on
// top of that rule and moved the SDK away from the measured operating point.
const MOUSE_STRIKES_TO_LOCK = 1;
app.post("/v1/sdk/mouse/check", auth, async (req, res) => {
  const r = await fwd(`${CA_URL}/v1/mouse/check`, "POST", { ...req.body, userId: req.uid }, caAssert(req));
  let d; try { d = JSON.parse(r.text); } catch (e) { return relay(res, r); }
  if (!d || !d.checked) return res.status(r.status).json(d);
  const streak = Number(d.suspiciousStreak || 0);
  const passkeyTriggered = streak >= MOUSE_STRIKES_TO_LOCK && (await hasPasskey(req.uid));
  if (passkeyTriggered) {
    // The assertion was being passed as a second argument to `.catch()` instead of to
    // `fwd()`, so this call reached ca-service with no X-Continuum-Identity header, was
    // rejected 401 by requireIdentity, and the rejection was swallowed by the empty catch.
    // The mouse step-up lock was therefore never actually set on the gateway path — the
    // SDK challenged, but a reload found no lock and resumed the session.
    await fwd(`${CA_URL}/v1/lock/set`, "POST", { userId: req.uid }, caAssert(req)).catch(() => {});
    await fwd(`${CA_URL}/v1/mouse/streak/reset`, "POST", { userId: req.uid }, caAssert(req)).catch(() => {});
  }
  const mrk = riskLevel(d.warmup, d.isSuspicious);
  d.riskToken = signRiskRS256(req.uid, mrk, "mouse");
  maybeFireRiskEvent(req.tenant, req.uid, req.esub || req.uid, mrk, "mouse"); // push on transition
  res.status(r.status).json({ ...d, ok: !passkeyTriggered, suspiciousStreak: streak, strikesToLock: MOUSE_STRIKES_TO_LOCK, requiresPasskeyChallenge: passkeyTriggered });
});
app.get("/v1/sdk/mouse/status", auth, async (req, res) => relay(res, await fwd(`${CA_URL}/v1/mouse/status/${req.uid}`, "GET", undefined, caAssert(req))));

// passkey (origin/rpId bind to the HOST app's origin)
app.post("/v1/sdk/passkey/register/options", auth, async (req, res) => relay(res, await fwd(`${PASSKEY_URL}/v1/register/options`, "POST", { userId: req.uid, username: req.uname, rpId: rpFromOrigin(req), origin: originOf(req) })));
app.post("/v1/sdk/passkey/register/complete", auth, async (req, res) => { const r = await fwd(`${PASSKEY_URL}/v1/register/complete`, "POST", { userId: req.uid, credential: req.body.credential, rpId: rpFromOrigin(req), origin: originOf(req) }); pkCache.delete(req.uid); relay(res, r); });
app.post("/v1/sdk/passkey/auth/options", auth, async (req, res) => relay(res, await fwd(`${PASSKEY_URL}/v1/auth/options`, "POST", { userId: req.uid, rpId: rpFromOrigin(req) })));
app.post("/v1/sdk/passkey/auth/complete", auth, async (req, res) => {
  const r = await fwd(`${PASSKEY_URL}/v1/auth/complete`, "POST", { userId: req.uid, challengeId: req.body.challengeId, assertion: req.body.assertion, rpId: rpFromOrigin(req), origin: originOf(req) });
  // Same misplaced-argument bug as the lock/set call above: the assertion went to `.catch`
  // rather than to `fwd`, so a verified passkey never cleared the persisted lock and the
  // user stayed locked out on their next page load.
  if (r.status === 200) await fwd(`${CA_URL}/v1/lock/clear`, "POST", { userId: req.uid }, caAssert(req)).catch(() => {});
  relay(res, r);
});

// Shared step-up lock (see ca-service/lib/lock.js) — lets the SDK log out on
// page load for ANY app, not just apps/demo's own session-based gate.
app.get("/v1/sdk/lock/status", auth, async (req, res) => relay(res, await fwd(`${CA_URL}/v1/lock/status/${req.uid}`, "GET", undefined, caAssert(req))));
app.get("/v1/sdk/passkey/status", auth, async (req, res) => res.json({ hasPasskey: await hasPasskey(req.uid) }));

app.listen(PORT, () => console.log(`Continuum gateway on :${PORT} (tenants=${Object.keys(tenants.tenants).length})`));
