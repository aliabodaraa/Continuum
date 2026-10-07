// Continuum API Gateway — the multi-tenant front door + backend for the browser SDK.
//   • serves the SDK assets (guard.js + deps) and its own pages (public/: the developer
//     console and the extension's sign-in page),
//   • is a TENANT REGISTRY: an organisation signs up in the console (or the operator calls
//     POST /v1/tenants) and gets a site key (public) + signing secret (private) + allowed origins;
//     console sign-ups wait for the operator's approval,
//   • holds CONTINUUM ACCOUNTS (email + passkey) for people with no organisation (the personal
//     tenant) and for tenant developers signing in to the console,
//   • links the browser extension to a tenant user (/v1/link/*: the organisation's own sign-in,
//     then an authorization code redeemed with PKCE),
//   • mints a per-user Continuum identity/session (/v1/sdk/session), scoped to a tenant,
//   • exposes a CORS-enabled, TOKEN-SCOPED facade (/v1/sdk/*) that injects userId/
//     username/origin and routes to CA + passkey,
//   • signs each risk verdict RS256 (public keys at /.well-known/jwks.json).
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
// An unexpected rejection in a route is logged instead of ending the process: one failed request
// must not take every organisation's protection down with it.
process.on("unhandledRejection", (e) => console.error("[gateway] unhandled rejection:", e));
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const CA_URL = process.env.CA_API_URL || "http://ca-service:4100";
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
// Admin key to gate tenant registration. If unset (dev), registration is open; the bundle compose
// file requires it (TODO §2).
const ADMIN_KEY = process.env.GATEWAY_ADMIN_KEY || "";
if (!ADMIN_KEY) {
  console.warn("[gateway][SECURITY] GATEWAY_ADMIN_KEY is not set: anyone who can reach this gateway can " +
    "register a tenant (POST /v1/tenants). Fine for local development only.");
}
// Default demo tenant's secret — must equal the demo host's CONTINUUM_SECRET.
const DEMO_SECRET = process.env.CA_SIGNING_SECRET || "dev-continuum-risk-secret";
const USER_ID_BASE = Number(process.env.GATEWAY_USER_ID_BASE || 900000);
const DATA_DIR = process.env.DATA_DIR || __dirname;
const IDENTITY_FILE = path.join(DATA_DIR, "identity.json");
const TENANTS_FILE = path.join(DATA_DIR, "tenants.json");
// Operator defaults, organisation settings and server switches (settings.js has the precedence).
const settings = require("./settings")(DATA_DIR);
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const SDK_PUBLIC = path.join(__dirname, "sdk-public");
const GATEWAY_PAGES = path.join(__dirname, "public");
// Where browsers reach this gateway. Its own pages (console, extension sign-in, study) live on
// this origin, so it also fixes the relying party of every passkey made there.
const PUBLIC_URL = (process.env.GATEWAY_PUBLIC_URL || "http://localhost:8080").replace(/\/+$/, "");
const PUBLIC_ORIGIN = new URL(PUBLIC_URL).origin;
const PUBLIC_RP_ID = new URL(PUBLIC_URL).hostname;
// The Continuum Guard extension's id (chrome://extensions). A tenant that lets its users use the
// extension admits chrome-extension://<id>; unset, the console asks for the id instead.
const EXTENSION_ID = (process.env.CONTINUUM_EXTENSION_ID || "").trim();
const EXTENSION_ORIGIN = EXTENSION_ID ? "chrome-extension://" + EXTENSION_ID : "";
// People with no organisation: a built-in tenant whose users are Continuum accounts.
const PERSONAL_KEY = "pk_personal";
// Built-in tenants whose secret comes from this server's .env (pk_demo: CA_SIGNING_SECRET, which the
// bundled demo app also reads). A console owner may manage their websites, extension and alerts, but
// may not rotate the secret (the demo would stop working) or revoke them, and deleting the owner's
// account only detaches them. The operator keeps every power over them.
const SERVER_MANAGED = new Set(["pk_demo"]);
// Console sign-ups start "pending" until the operator approves them, unless this is 1.
// Console sign-ups are active at once only when the operator says so (operator page or .env).
const autoApprove = () => settings.server("autoApproveTenants");
const REFRESH_TTL_SEC = Number(process.env.GATEWAY_REFRESH_TTL_SEC || 90 * 86400);
const CONSOLE_TTL_SEC = Number(process.env.GATEWAY_CONSOLE_TTL_SEC || 3600);

// The tenant registry and the identity store are plain JSON files (TODO §1). Two rules keep them safe:
//  * a missing file starts empty, but a file that exists and cannot be read or parsed stops the
//    gateway. Reading it as empty used to re-seed pk_demo over the wreckage and re-allocate every
//    user id, orphaning their biometric profiles, with nothing in the log.
//  * a save writes a temporary file and renames it over the old one (atomic on one filesystem), so a
//    crash mid-write leaves the previous version, and a failed save throws so the caller can refuse
//    instead of answering from memory only.
function loadJson(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new Error(`[gateway] cannot read ${file}: ${e.message}`);
  }
  try { return JSON.parse(text); } catch (e) {
    throw new Error(`[gateway] ${file} is not valid JSON (${e.message}). Refusing to start rather than ` +
      `treat it as empty; restore it from a backup (a leftover ${path.basename(file)}.tmp may hold the last write).`);
  }
}
function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ---- tenant registry ----
let tenants = loadJson(TENANTS_FILE, { tenants: {} });
// Seed the demo tenant so the bundled Acme app works out of the box.
if (!tenants.tenants["pk_demo"]) {
  tenants.tenants["pk_demo"] = { name: "Demo", secret: DEMO_SECRET, origins: [], webhookUrl: process.env.DEMO_WEBHOOK_URL || null, createdAt: new Date().toISOString() };
  saveJson(TENANTS_FILE, tenants);   // throws at boot if the data directory is not writable
}
// Keep the demo tenant's webhook in sync with env (so CAEP is demonstrable).
if (tenants.tenants["pk_demo"] && process.env.DEMO_WEBHOOK_URL) tenants.tenants["pk_demo"].webhookUrl = process.env.DEMO_WEBHOOK_URL;
// The demo is an organisation whose users can sign in to the extension: its sign-in page for the
// extension (served by @continuum/node's link handler) and the extension's origin come from env.
(function syncDemoTenant() {
  const demo = tenants.tenants["pk_demo"];
  if (!demo) return;
  let changed = false;
  if (process.env.DEMO_SIGNIN_URL && demo.signInUrl !== process.env.DEMO_SIGNIN_URL) { demo.signInUrl = process.env.DEMO_SIGNIN_URL; changed = true; }
  if (EXTENSION_ORIGIN && !(demo.origins || []).includes(EXTENSION_ORIGIN)) { demo.origins = (demo.origins || []).concat(EXTENSION_ORIGIN); demo.allowExtension = true; changed = true; }
  if (changed) saveJson(TENANTS_FILE, tenants);
})();
// Seed the personal tenant. Its secret signs nothing a customer holds (its users sign in with a
// Continuum account on this gateway), so it is random; its origins follow env at every boot.
(function syncPersonalTenant() {
  let t = tenants.tenants[PERSONAL_KEY];
  if (!t) t = tenants.tenants[PERSONAL_KEY] = { name: "Continuum Personal", secret: crypto.randomBytes(24).toString("hex"), createdAt: new Date().toISOString() };
  const origins = [PUBLIC_ORIGIN, EXTENSION_ORIGIN].filter(Boolean);
  if (JSON.stringify(t.origins) !== JSON.stringify(origins) || t.status !== "active") {
    t.origins = origins; t.status = "active"; t.allowExtension = true;
    saveJson(TENANTS_FILE, tenants);
  }
})();
// A tenant signs sessions only while active. Tenants from before the status field have none and are
// active; console sign-ups are "pending" until the operator approves them; "revoked" is final.
const tenantActive = (t) => !!t && (!t.status || t.status === "active");
const resolveTenant = (siteKey) => (tenantActive(tenants.tenants[siteKey]) ? tenants.tenants[siteKey] : null);

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
const statsCache = new Map();   // the console's per-tenant user counts (tenantStats), dropped when a tenant gains a user
function userFor(siteKey, externalId) {
  const key = siteKey + "|" + externalId;
  const known = store.users[key];
  if (known) return { userId: known.userId, username: (siteKey + "-" + externalId).slice(0, 48) };

  // first sighting — allocate deterministically, then persist so it never moves again
  const h = crypto.createHmac("sha256", SESSION_SECRET).update(key).digest("hex");
  const userId = parseInt(h.slice(0, 13), 16); // stable id within JS safe-integer range
  store.users[key] = { userId, externalId, createdAt: new Date().toISOString() };
  statsCache.delete(siteKey);
  try { saveJson(IDENTITY_FILE, store); } catch (e) {
    // The id is still right for this session (it is derived from the secret), so the sign-in goes
    // ahead; the next save retries the record. Say so loudly: an unsaved record is lost on restart.
    console.error(`[gateway] could not persist the id for ${key}: ${e.message}`);
  }
  return { userId, username: (siteKey + "-" + externalId).slice(0, 48) };
}

// ---- Continuum accounts (email + passkey) ----
// The users of the personal tenant, and the people who sign in to the console to manage their
// organisation's tenants. An account's principal is userFor(PERSONAL_KEY, "acct:<id>"), and its
// passkey is registered there, so the same passkey signs in and answers step-ups.
// `revoked` holds the jti of refresh tokens given up at sign-out, until they would have expired.
let accounts = loadJson(ACCOUNTS_FILE, { accounts: {}, byEmail: {}, revoked: {} });
accounts.revoked = accounts.revoked || {};
function saveAccounts() {
  const now = Math.floor(Date.now() / 1000);
  for (const [jti, exp] of Object.entries(accounts.revoked)) if (exp < now) delete accounts.revoked[jti];
  saveJson(ACCOUNTS_FILE, accounts);
}
const normEmail = (e) => String(e || "").trim().toLowerCase();
const emailOk = (e) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const accountPrincipal = (id) => userFor(PERSONAL_KEY, "acct:" + id);

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
// Tokens other than the session carry a `typ`, and auth() refuses any typed token, so a long-lived
// refresh token or a console token can never be used as a session.
//
// REFRESH: what the extension keeps after signing in (see /v1/link/*). It re-mints a session for
// the same principal without the organisation's sign-in; revoked on sign-out.
function signRefresh(u, siteKey, externalId) {
  const now = Math.floor(Date.now() / 1000);
  return jwt(SESSION_SECRET, { typ: "refresh", sub: u.userId, sk: siteKey, ext: externalId, jti: crypto.randomBytes(12).toString("hex"), iat: now, exp: now + REFRESH_TTL_SEC });
}
function verifyRefresh(token, siteKey) {
  const pl = unjwt(SESSION_SECRET, token);
  if (!pl || pl.typ !== "refresh" || pl.sk !== siteKey || !pl.jti) return null;
  if (accounts.revoked[pl.jti]) return null;
  return pl;
}
// CONSOLE: a signed-in Continuum account managing its own tenants.
function signConsole(accountId) {
  const now = Math.floor(Date.now() / 1000);
  return jwt(SESSION_SECRET, { typ: "console", acct: accountId, iat: now, exp: now + CONSOLE_TTL_SEC });
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
  const claims = { iss: "gateway", aud: audience, sub: String(principalId), tenant_id: tenantId, iat: now, exp: now + ASSERTION_TTL };
  // ca-service applies the organisation's settings (channels on/off, adaptive retraining and its gap, ...)
  // from this signed claim, so it never stores them and cannot disagree with the console.
  if (audience === "ca-service") claims.cfg = settings.claim(tenants.tenants[tenantId]);
  const p = b64(JSON.stringify(claims));
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
function signEvent(subject, risk, modality, event) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "RS256", typ: "secevent+jwt", kid: verdictKid }));
  // `sub` is the consumer's OWN user id (their terms), so their receiver can act
  // on it directly; the Continuum id stays internal. `event` is "risk-change", or "test" from the console.
  const body = b64(JSON.stringify({ iss: ISSUER, sub: String(subject), event: event || "risk-change", risk, modality, iat: now, jti: crypto.randomBytes(8).toString("hex") }));
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
app.use(express.urlencoded({ extended: false, limit: "16kb" }));   // the organisation's sign-in posts a form (/v1/link/callback)
// The operator page only for this machine (see "the operator" below); everyone else gets a plain 404.
app.use((req, res, next) => (req.path === "/operator.html" && !operatorHost(req) ? res.status(404).type("text/plain").send("Not found") : next()));
app.use(express.static(GATEWAY_PAGES));
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
  // A network error (the service restarting, or a pooled keep-alive connection it has closed) is
  // retried once, then answered as 502. It used to throw: routes await fwd() without a catch, so the
  // rejection went unhandled and the whole gateway exited (found 2026-10-05: a ca-service restart
  // reset the pooled connections and the next relayed check took the gateway down).
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      return { status: r.status, ct: r.headers.get("content-type") || "application/json", text };
    } catch (e) {
      if (attempt === 0) continue;
      console.error(`[gateway] ${method} ${url} unreachable: ${(e.cause && (e.cause.code || e.cause.message)) || e.message}`);
      return { status: 502, ct: "application/json", text: JSON.stringify({ error: "upstream_unreachable" }) };
    }
  }
}
// The gateway already authenticated the session; assert that identity downstream.
const caAssert = (req) => (req && req.uid != null && req.tenantKey ? mintAssertion(req.tenantKey, req.uid, "ca-service") : undefined);
const relay = (res, r) => { res.status(r.status); res.set("Content-Type", r.ct); res.send(r.text); };
const rpFromOrigin = (req) => { try { return new URL(req.get("Origin")).hostname; } catch (e) { return "localhost"; } };
const originOf = (req) => req.get("Origin") || undefined;
function originAllowed(tenant, req) {
  if (!tenant.origins || tenant.origins.length === 0) return true; // no allowlist = allow all (dev)
  const o = req.get("Origin");
  // The gateway's own pages (the extension's enrolment and step-up) act for any tenant's users.
  return !o || o === PUBLIC_ORIGIN || tenant.origins.includes(o);
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
  // keystrokeTraining: typing enrolment is complete and its model is being built from the queue.
  return { passkey: pk, keystroke: !!ob.trained, keystrokeTraining: !!ob.keystrokeTraining, mouse: !!ob.mouseEnrolled };
}

// ---- TENANT REGISTRY ----
// Two ways in, as in Okta or Auth0. The OPERATOR (whoever runs this gateway and holds
// GATEWAY_ADMIN_KEY) registers a tenant directly and it is active at once (POST /v1/tenants; scripts
// and tests use this). An ORGANISATION signs up itself in the developer console (/console.html) with
// a Continuum account: its tenants belong to that account, which alone sees their secrets, and they
// stay "pending" until the operator approves them (/v1/tenants/:siteKey/status). End users never
// create tenants; they sign in to their organisation's (or the personal one).
// ---- the operator ----
// The operator page (/operator.html) and the operator API answer only requests whose Host names this
// machine (GATEWAY_OPERATOR_HOSTS, default localhost; "*" allows any), so a console user never sees them.
// That is a screen, not a network boundary: a non-browser client can send any Host header. The boundary
// is the admin key, compared in constant time, with a lockout after repeated wrong keys. A production
// deployment should also keep the operator page on its own network or behind single sign-on.
// With the default (local names only), a request that came through a reverse proxy is never local: a
// proxy that forwards to localhost without passing the public Host on (nginx's default) would otherwise
// make every visitor look local. Proxies that add Forwarded / X-Forwarded-* are caught here; one that
// adds neither must pass the public Host on (DEPLOY.md).
const OPERATOR_HOSTS_SET = !!process.env.GATEWAY_OPERATOR_HOSTS;
const OPERATOR_HOSTS = (process.env.GATEWAY_OPERATOR_HOSTS || "localhost,127.0.0.1,[::1]").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
function operatorHost(req) {
  if (OPERATOR_HOSTS.includes("*")) return true;
  if (!OPERATOR_HOSTS_SET && (req.get("Forwarded") || req.get("X-Forwarded-For") || req.get("X-Forwarded-Host"))) return false;
  const h = String(req.get("Host") || "").toLowerCase().replace(/:\d+$/, "");
  return OPERATOR_HOSTS.includes(h);
}
const ADMIN_FAIL_LIMIT = 10, ADMIN_LOCK_MS = 15 * 60000;
const adminFails = new Map();   // client address -> { n, first, until }
function adminGate(req, res, next) {
  if (!operatorHost(req)) return res.status(404).json({ error: "not_found" });
  if (!ADMIN_KEY) return next();   // development: open (the boot log says so)
  const who = req.ip || "?", now = Date.now(), f = adminFails.get(who);
  if (f && f.until > now) {
    const wait = Math.ceil((f.until - now) / 1000);
    res.set("Retry-After", String(wait));
    return res.status(429).json({ error: "too_many_attempts", retryAfterSec: wait });
  }
  const given = Buffer.from(String(req.get("X-Admin-Key") || "")), want = Buffer.from(ADMIN_KEY);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) { adminFails.delete(who); return next(); }
  const r = f && now - f.first < ADMIN_LOCK_MS ? f : { n: 0, first: now, until: 0 };
  r.n += 1;
  if (r.n >= ADMIN_FAIL_LIMIT) { r.until = now + ADMIN_LOCK_MS; audit({ type: "operator" }, "operator.locked_out", null, { after: r.n }); }
  adminFails.set(who, r);
  return res.status(401).json({ error: "invalid_admin_key", attemptsLeft: Math.max(0, ADMIN_FAIL_LIMIT - r.n) });
}

// ---- activity log ----
// One JSON line per change to a tenant or an account: who (the operator, or a console account), what,
// on which tenant, when. Append-only; the console shows an account its own entries, the operator all.
const AUDIT_FILE = path.join(DATA_DIR, "audit.jsonl");
function audit(actor, action, siteKey, detail) {
  const t = siteKey ? tenants.tenants[siteKey] : null;
  const e = { at: new Date().toISOString(), actor, action, siteKey: siteKey || null, name: t ? t.name : (detail && detail.name) || null };
  if (detail) e.detail = detail;
  try { fs.appendFileSync(AUDIT_FILE, JSON.stringify(e) + "\n"); } catch (err) { console.error(`[gateway] activity log not written: ${err.message}`); }
}
function readAudit(keep, limit) {
  let lines = [];
  try { lines = fs.readFileSync(AUDIT_FILE, "utf8").split("\n"); } catch (e) { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    let e; try { e = JSON.parse(lines[i]); } catch (x) { continue; }
    if (keep(e)) out.push(e);
  }
  return out;
}
const asOperator = { type: "operator" };
const asAccount = (accountId) => ({ type: "account", email: (accounts.accounts[accountId] || {}).email || null });

// ---- per-tenant counts (no personal data) ----
// How many users a tenant has and how many have enrolled each factor, cached for a minute. Anonymous SDK
// visitors ("anon-…") are counted apart. The enrolment lookups go to ca-service and passkey-service, six at
// a time, for at most the first 500 users.
async function tenantStats(siteKey) {
  const c = statsCache.get(siteKey);
  if (c && Date.now() - c.at < 60000) return c.v;
  const mine = Object.entries(store.users).filter(([k]) => k.startsWith(siteKey + "|"));
  const named = mine.filter(([k]) => !k.startsWith(siteKey + "|anon-"));
  const list = named.slice(0, 500);
  const v = { users: named.length, anonymous: mine.length - named.length, passkey: 0, typing: 0, mouse: 0, counted: list.length };
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const u = list[i++][1];
      const ob = await onboardingFor(u.userId, siteKey).catch(() => ({}));
      if (ob.passkey) v.passkey++;
      if (ob.keystroke) v.typing++;
      if (ob.mouse) v.mouse++;
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  statsCache.set(siteKey, { at: Date.now(), v });
  return v;
}

// ---- webhooks a console user may register ----
// The gateway calls a tenant's webhook itself, so an address on its own network (a Docker service name,
// localhost, a private or link-local IP) would let a console user make the gateway reach internal
// services (SSRF). Console webhooks must therefore be public HTTPS names. This checks the name, not what
// it resolves to (DNS rebinding is not covered). Operator-registered tenants (the demo's internal
// receiver) are exempt; the operator switch "allowPrivateWebhooks" (GATEWAY_ALLOW_PRIVATE_WEBHOOKS=1) lifts
// the rule for local testing.
function publicWebhook(s) {
  let u; try { u = new URL(s); } catch (e) { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (settings.server("allowPrivateWebhooks")) return true;
  const h = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || h === "localhost" || !h.includes(".") || /\.(local|internal|localhost)$/.test(h) || h.startsWith("[")) return false;
  const ip = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip) {
    const a = +ip[1], b = +ip[2];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  return true;
}
const EXT_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;
const httpUrl = (s) => { try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u : null; } catch (e) { return null; } };
// Validate the editable fields of a tenant. With `partial`, absent fields are left out. A site key is
// PUBLIC (it lives in the page); binding it to the tenant's origin(s) is what stops another app from
// reusing it, so a tenant must declare at least one origin. `allowExtension` admits the Continuum
// Guard extension (this gateway's CONTINUUM_EXTENSION_ID, or the id given as `extensionId`).
function tenantFields(body, partial) {
  const out = {};
  if (!partial || body.name != null) {
    out.name = String(body.name || "").trim().slice(0, 80);
    if (!out.name) return { error: "name_required" };
  }
  if (!partial || body.origins != null || body.allowExtension != null) {
    const raw = Array.isArray(body.origins) ? body.origins : String(body.origins || "").split(/[\s,]+/);
    const origins = [];
    for (const o of raw.map((x) => String(x).trim().replace(/\/+$/, "")).filter(Boolean)) {
      if (EXT_ORIGIN_RE.test(o)) { origins.push(o); continue; }
      const u = httpUrl(o);
      if (!u || u.origin !== o) return { error: "bad_origin", origin: o, note: "An origin is scheme://host[:port], with no path." };
      origins.push(u.origin);
    }
    if (body.allowExtension === true) {
      const id = String(body.extensionId || EXTENSION_ID || "").trim();
      if (!/^[a-p]{32}$/.test(id)) return { error: "extension_id_required", note: "This gateway does not know the extension's id; give it as extensionId (see chrome://extensions)." };
      origins.push("chrome-extension://" + id);
    } else if (body.allowExtension === false) {
      for (let i = origins.length - 1; i >= 0; i--) if (EXT_ORIGIN_RE.test(origins[i])) origins.splice(i, 1);
    }
    out.origins = [...new Set(origins)];
    out.allowExtension = out.origins.some((o) => EXT_ORIGIN_RE.test(o));
    if (out.origins.length === 0) {
      return { error: "origins_required", note: "Provide origins: [\"https://your-app.com\"] so the site key is bound to your domain(s) and can't be reused by another app." };
    }
  }
  if (!partial || body.signInUrl != null) {
    // Where the extension sends this organisation's users to sign in (@continuum/node's link handler).
    const s = String(body.signInUrl || "").trim();
    if (s && !httpUrl(s)) return { error: "bad_sign_in_url" };
    out.signInUrl = s || null;
  }
  if (!partial || body.webhookUrl != null) {
    const w = String(body.webhookUrl || "").trim();                 // CAEP push target
    if (w && !httpUrl(w)) return { error: "bad_webhook_url" };
    out.webhookUrl = w || null;
  }
  return out;
}
function createTenant(fields, extra) {
  let siteKey;
  do { siteKey = "pk_" + crypto.randomBytes(9).toString("hex"); } while (tenants.tenants[siteKey]);
  const secret = crypto.randomBytes(24).toString("hex");
  tenants.tenants[siteKey] = { ...fields, secret, ...extra, createdAt: new Date().toISOString() };
  try { saveJson(TENANTS_FILE, tenants); } catch (e) {
    // Never hand out credentials that live only in memory and vanish on the next restart.
    delete tenants.tenants[siteKey];
    console.error(`[gateway] tenant registration not saved: ${e.message}`);
    return null;
  }
  return { siteKey, secret };
}
// What the console and the operator see of a tenant: everything but the secret.
function tenantView(siteKey, t) {
  return { siteKey, name: t.name, status: t.status || "active", origins: t.origins || [], allowExtension: (t.origins || []).some((o) => EXT_ORIGIN_RE.test(o)),
    signInUrl: t.signInUrl || null, webhookUrl: t.webhookUrl || null, owner: t.owner ? ((accounts.accounts[t.owner] || {}).email || null) : null,
    builtIn: siteKey === PERSONAL_KEY, serverManaged: SERVER_MANAGED.has(siteKey), createdAt: t.createdAt, secretRotatedAt: t.secretRotatedAt || null };
}
const NOTE_KEYS = "Put siteKey in the SDK <script data-site-key>, and secret in your backend CONTINUUM_SECRET.";
app.post("/v1/tenants", adminGate, (req, res) => {
  const f = tenantFields(req.body, false);
  if (f.error) return res.status(400).json(f);
  const k = createTenant(f, { status: "active" });
  if (!k) return res.status(500).json({ error: "tenant_registry_write_failed" });
  audit(asOperator, "organisation.created", k.siteKey);
  res.json({ ...k, ...f, status: "active", note: NOTE_KEYS });
});
app.get("/v1/tenants", adminGate, (req, res) => {
  res.json({ tenants: Object.entries(tenants.tenants).map(([k, t]) => tenantView(k, t)) });
});
// The operator approves a console sign-up, or revokes a tenant. A revoked tenant's sessions stop at
// once (auth() re-resolves the tenant on every call).
app.post("/v1/tenants/:siteKey/status", adminGate, (req, res) => {
  const t = tenants.tenants[req.params.siteKey];
  if (!t) return res.status(404).json({ error: "unknown_tenant" });
  if (req.params.siteKey === PERSONAL_KEY) return res.status(400).json({ error: "built_in_tenant" });
  const status = String(req.body.status || "");
  if (!["active", "revoked"].includes(status)) return res.status(400).json({ error: "bad_status", allowed: ["active", "revoked"] });
  const prev = t.status;
  t.status = status;
  try { saveJson(TENANTS_FILE, tenants); } catch (e) { t.status = prev; return res.status(500).json({ error: "tenant_registry_write_failed" }); }
  if (prev !== status) audit(asOperator, status === "revoked" ? "organisation.revoked" : prev === "pending" ? "organisation.approved" : "organisation.reactivated", req.params.siteKey);
  res.json(tenantView(req.params.siteKey, t));
});
// The operator's own views: every tenant's counts, and the whole activity log.
app.get("/v1/admin/tenants/:siteKey/stats", adminGate, async (req, res) => {
  if (!tenants.tenants[req.params.siteKey]) return res.status(404).json({ error: "unknown_tenant" });
  res.json(await tenantStats(req.params.siteKey));
});
app.get("/v1/admin/activity", adminGate, (req, res) => res.json({ entries: readAudit(() => true, 300) }));

// ---- settings: the operator's defaults and switches, and the whole environment read-only ----
const SECRET_ENV = new Set(["GATEWAY_SESSION_SECRET", "GATEWAY_ADMIN_KEY", "CA_SIGNING_SECRET", "CONTINUUM_SECRET", "CA_API_KEY", "PASSKEY_API_KEY"]);
const GATEWAY_ENV = ["GATEWAY_PUBLIC_URL", "PORT", "DATA_DIR", "CA_API_URL", "PASSKEY_API_URL", "GATEWAY_OPERATOR_HOSTS",
  "CONTINUUM_EXTENSION_ID", "DEMO_SIGNIN_URL", "DEMO_WEBHOOK_URL", "IDENTITY_ASSERTION_TTL", "GATEWAY_USER_ID_BASE",
  "GATEWAY_SESSION_TTL_SEC", "GATEWAY_RISK_TTL_SEC", "GATEWAY_REFRESH_TTL_SEC", "GATEWAY_CONSOLE_TTL_SEC",
  "GATEWAY_AUTO_APPROVE_TENANTS", "GATEWAY_ALLOW_PRIVATE_WEBHOOKS", "ONBOARDING_MODE", "MONITOR_EXCLUDE_TYPES", "CONTINUUM_PANEL",
  "CONTINUUM_KEYSTROKE", "CONTINUUM_MOUSE", "ADAPTIVE_RETRAINING", "ADAPTIVE_MIN_GAP_HOURS", "KEYSTROKE_DECISION_WINDOWS", ...SECRET_ENV];
const ENV_SETTING = Object.fromEntries([
  ...Object.entries(settings.APP).map(([k, d]) => [d.env, "defaults." + k]),
  ...Object.entries(settings.SERVER).map(([k, d]) => [d.env, "server." + k]),
  ["STUDY_LOGGING", "study.studyLogging"],
]);
async function caSettings(method, body) {
  const r = await fwd(`${CA_URL}/v1/admin/settings`, method, body);
  let d = {}; try { d = JSON.parse(r.text); } catch (e) {}
  return { status: r.status, d };
}
async function operatorSettings() {
  const ca = await caSettings("GET").catch(() => ({ status: 0, d: {} }));
  const env = [
    ...GATEWAY_ENV.map((name) => ({ service: "gateway", name, set: process.env[name] != null && process.env[name] !== "",
      value: SECRET_ENV.has(name) ? null : (process.env[name] ?? null), secret: SECRET_ENV.has(name) })),
    ...((ca.d.environment || []).map((e) => ({ service: "ca-service", ...e }))),
  ].map((e) => ({ ...e, setting: ENV_SETTING[e.name] || null }));
  return { defaults: settings.describe(null), server: settings.describeServer(),
           study: ca.d.settings || null, caReachable: ca.status === 200, environment: env };
}
app.get("/v1/admin/settings", adminGate, async (req, res) => res.json(await operatorSettings()));
app.put("/v1/admin/settings", adminGate, async (req, res) => {
  const body = req.body || {};
  let changed = [];
  try { changed = settings.updateOperator({ defaults: body.defaults, server: body.server }); }
  catch (e) { return res.status(e.code === "store_write_failed" ? 500 : 400).json({ error: e.code || "bad_setting", note: e.message }); }
  if (body.study && Object.keys(body.study).length) {
    const r = await caSettings("PUT", body.study).catch(() => ({ status: 0, d: {} }));
    if (r.status !== 200) return res.status(502).json({ error: "ca_settings_failed", note: r.d.note || "ca-service did not accept the setting", changed });
    changed.push(...Object.keys(body.study).map((k) => "study." + k));
  }
  if (changed.length) audit(asOperator, "settings.changed", null, { changed });
  res.json({ changed, ...(await operatorSettings()) });
});
// The operator gives an existing tenant (one registered by the operator, or the built-in demo) to a
// Continuum account, so its owner manages it in the console. An empty email takes it back.
app.post("/v1/admin/tenants/:siteKey/owner", adminGate, (req, res) => {
  const t = tenants.tenants[req.params.siteKey];
  if (!t) return res.status(404).json({ error: "unknown_tenant" });
  if (req.params.siteKey === PERSONAL_KEY) return res.status(400).json({ error: "built_in_tenant" });
  const email = normEmail(req.body.email || "");
  const accountId = email ? accounts.byEmail[email] : null;
  if (email && !accountId) return res.status(404).json({ error: "no_account" });
  const prev = t.owner;
  if (accountId) t.owner = accountId; else delete t.owner;
  try { saveJson(TENANTS_FILE, tenants); } catch (e) { if (prev) t.owner = prev; else delete t.owner; return res.status(500).json({ error: "tenant_registry_write_failed" }); }
  if (prev !== t.owner) audit(asOperator, accountId ? "organisation.owner_set" : "organisation.owner_cleared", req.params.siteKey, accountId ? { email } : null);
  res.json(tenantView(req.params.siteKey, t));
});

// Erase every user of a tenant the way an account deletion erases one person: passkeys, typing model,
// mouse model and samples (the same reset endpoints), then the identity records. A user whose reset
// failed keeps the identity record, so a retry can find them; the caller then keeps the tenant too.
// Note: ca-service's typing reset keeps the typed samples (marked not for training).
async function eraseTenantUsers(siteKey) {
  const keys = Object.keys(store.users).filter((k) => k.startsWith(siteKey + "|"));
  let i = 0;
  const failed = [];
  async function worker() {
    while (i < keys.length) {
      const key = keys[i++], u = store.users[key];
      try {
        const r = await Promise.all([
          fwd(`${PASSKEY_URL}/v1/users/${u.userId}/reset`, "POST"),
          fwd(`${CA_URL}/v1/keystroke/reset`, "POST", { userId: u.userId }, mintAssertion(siteKey, u.userId, "ca-service")),
          fwd(`${CA_URL}/v1/mouse/reset`, "POST", { userId: u.userId }, mintAssertion(siteKey, u.userId, "ca-service")),
        ]);
        if (r.some((x) => x.status !== 200)) { failed.push(key); continue; }
      } catch (e) { failed.push(key); continue; }
      pkCache.delete(u.userId); lastRisk.delete(u.userId);
      delete store.users[key];
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  statsCache.delete(siteKey);
  if (keys.length) saveJson(IDENTITY_FILE, store);
  return { users: keys.length, failed: failed.length };
}

// The operator deletes an account (a user's request to be forgotten, or a test's cleanup): its
// passkeys, its biometric profiles, the tenants it owns, and the account itself.
app.post("/v1/admin/accounts/delete", adminGate, async (req, res) => {
  const email = normEmail(req.body.email);
  const accountId = accounts.byEmail[email];
  if (!accountId) return res.status(404).json({ error: "no_account" });
  const u = accountPrincipal(accountId);
  const steps = {};
  steps.passkeys = (await fwd(`${PASSKEY_URL}/v1/users/${u.userId}/reset`, "POST")).status;
  for (const m of ["keystroke", "mouse"]) {
    steps[m] = (await fwd(`${CA_URL}/v1/${m}/reset`, "POST", { userId: u.userId }, mintAssertion(PERSONAL_KEY, u.userId, "ca-service"))).status;
  }
  pkCache.delete(u.userId);
  const owned = Object.keys(tenants.tenants).filter((k) => tenants.tenants[k].owner === accountId && !SERVER_MANAGED.has(k));
  for (const k of owned) { steps[k] = await eraseTenantUsers(k).catch((e) => ({ error: e.message })); delete tenants.tenants[k]; }
  for (const k of SERVER_MANAGED) if (tenants.tenants[k] && tenants.tenants[k].owner === accountId) delete tenants.tenants[k].owner;   // detached, never deleted
  delete accounts.accounts[accountId]; delete accounts.byEmail[email];
  try { saveJson(TENANTS_FILE, tenants); saveAccounts(); } catch (e) { return res.status(500).json({ error: "store_write_failed" }); }
  audit(asOperator, "account.deleted", null, { email, deletedTenants: owned });
  res.json({ ok: true, deletedTenants: owned, steps });
});

// ---- Continuum accounts: create one, or sign in, with a passkey ----
// The account pages are the gateway's own, so their passkeys belong to THIS origin: the relying party
// comes from config (never from the request), and a call from any other origin is refused.
function ownPage(req, res, next) { if (req.get("Origin") !== PUBLIC_ORIGIN) return res.status(403).json({ error: "origin_not_allowed" }); next(); }
const ceremonies = new Map();   // pending account passkey ceremonies, 5 minutes like the challenges
function putCeremony(v) { const id = crypto.randomBytes(16).toString("hex"); ceremonies.set(id, { ...v, at: Date.now() }); return id; }
function takeCeremony(id, kind) {
  const c = ceremonies.get(String(id || "")); ceremonies.delete(String(id || ""));
  return c && c.kind === kind && Date.now() - c.at < 5 * 60000 ? c : null;
}
// Why the account signs in: "console" (manage tenants) or "link" (the extension, personal tenant).
function purposeOf(body) {
  if (body.purpose === "console") return { purpose: "console" };
  const l = liveLink(body.linkId);
  if (!l || l.status !== "pending" || l.siteKey !== PERSONAL_KEY) return { error: "link_expired" };
  return { purpose: "link", linkId: String(body.linkId) };
}
function signedIn(accountId, p) {
  const email = accounts.accounts[accountId].email;
  if (p.purpose === "console") return { consoleToken: signConsole(accountId), email };
  const code = authorizeLink(p.linkId, PERSONAL_KEY, "acct:" + accountId, email);
  return code ? { linkId: p.linkId, code, email } : { error: "link_expired" };
}
app.post("/v1/accounts/register/options", ownPage, async (req, res) => {
  const email = normEmail(req.body.email);
  if (!emailOk(email)) return res.status(400).json({ error: "bad_email" });
  if (accounts.byEmail[email]) return res.status(409).json({ error: "email_taken" });
  const p = purposeOf(req.body);
  if (p.error) return res.status(400).json(p);
  // Email is the account's name only: there is no mail server, so it is not verified. The passkey is
  // what proves the account; a production deployment would add an emailed confirmation.
  const accountId = "a_" + crypto.randomBytes(8).toString("hex");
  const u = accountPrincipal(accountId);
  const r = await fwd(`${PASSKEY_URL}/v1/register/options`, "POST", { userId: u.userId, username: email, rpId: PUBLIC_RP_ID, origin: PUBLIC_ORIGIN });
  if (r.status !== 200) return relay(res, r);
  res.json({ ceremonyId: putCeremony({ kind: "register", email, accountId, userId: u.userId, ...p }), options: JSON.parse(r.text) });
});
app.post("/v1/accounts/register/complete", ownPage, async (req, res) => {
  const c = takeCeremony(req.body.ceremonyId, "register");
  if (!c) return res.status(400).json({ error: "ceremony_expired" });
  if (accounts.byEmail[c.email]) return res.status(409).json({ error: "email_taken" });
  const r = await fwd(`${PASSKEY_URL}/v1/register/complete`, "POST", { userId: c.userId, credential: req.body.credential, rpId: PUBLIC_RP_ID, origin: PUBLIC_ORIGIN });
  if (r.status !== 200) return relay(res, r);
  pkCache.delete(c.userId);
  accounts.accounts[c.accountId] = { email: c.email, createdAt: new Date().toISOString() };
  accounts.byEmail[c.email] = c.accountId;
  try { saveAccounts(); } catch (e) {
    delete accounts.accounts[c.accountId]; delete accounts.byEmail[c.email];
    console.error(`[gateway] account not saved: ${e.message}`);
    return res.status(500).json({ error: "account_store_write_failed" });
  }
  audit(asAccount(c.accountId), "account.created", null, { via: c.purpose === "console" ? "console" : "extension" });
  res.json(signedIn(c.accountId, c));
});
app.post("/v1/accounts/login/options", ownPage, async (req, res) => {
  const accountId = accounts.byEmail[normEmail(req.body.email)];
  if (!accountId) return res.status(404).json({ error: "no_account" });
  const p = purposeOf(req.body);
  if (p.error) return res.status(400).json(p);
  const u = accountPrincipal(accountId);
  const r = await fwd(`${PASSKEY_URL}/v1/auth/options`, "POST", { userId: u.userId, rpId: PUBLIC_RP_ID });
  if (r.status !== 200) return relay(res, r);
  const options = JSON.parse(r.text);
  res.json({ ceremonyId: putCeremony({ kind: "login", accountId, userId: u.userId, challengeId: options.challengeId, ...p }), options });
});
app.post("/v1/accounts/login/complete", ownPage, async (req, res) => {
  const c = takeCeremony(req.body.ceremonyId, "login");
  if (!c) return res.status(400).json({ error: "ceremony_expired" });
  const r = await fwd(`${PASSKEY_URL}/v1/auth/complete`, "POST", { userId: c.userId, challengeId: c.challengeId, assertion: req.body.assertion, rpId: PUBLIC_RP_ID, origin: PUBLIC_ORIGIN });
  if (r.status !== 200) return relay(res, r);
  res.json(signedIn(c.accountId, c));
});

// ---- developer console: an account manages its own tenants ----
function consoleAuth(req, res, next) {
  const h = req.get("Authorization") || "";
  const pl = unjwt(SESSION_SECRET, h.startsWith("Bearer ") ? h.slice(7) : null);
  if (!pl || pl.typ !== "console" || !accounts.accounts[pl.acct]) return res.status(401).json({ error: "invalid_console_session" });
  req.acct = pl.acct; next();
}
function ownTenant(req, res, next) {
  const t = tenants.tenants[req.params.siteKey];
  if (!t || t.owner !== req.acct) return res.status(404).json({ error: "unknown_tenant" });
  if (t.status === "revoked") return res.status(409).json({ error: "tenant_revoked" });
  req.t = t; next();
}
// Reading (counts, history) is allowed on a revoked tenant too.
function ownTenantRead(req, res, next) {
  const t = tenants.tenants[req.params.siteKey];
  if (!t || t.owner !== req.acct) return res.status(404).json({ error: "unknown_tenant" });
  req.t = t; next();
}
const MAX_TENANTS_PER_ACCOUNT = 10;
app.get("/v1/console/config", (req, res) => res.json({ extensionId: EXTENSION_ID || null, autoApprove: autoApprove(), operatorKeyRequired: !!ADMIN_KEY, publicUrl: PUBLIC_URL }));
app.get("/v1/console/me", consoleAuth, (req, res) => res.json({ email: accounts.accounts[req.acct].email }));
app.get("/v1/console/tenants", consoleAuth, (req, res) => {
  res.json({ tenants: Object.entries(tenants.tenants).filter(([, t]) => t.owner === req.acct).map(([k, t]) => tenantView(k, t)) });
});
app.post("/v1/console/tenants", consoleAuth, (req, res) => {
  const mine = Object.values(tenants.tenants).filter((t) => t.owner === req.acct && t.status !== "revoked").length;
  if (mine >= MAX_TENANTS_PER_ACCOUNT) return res.status(409).json({ error: "tenant_limit_reached", limit: MAX_TENANTS_PER_ACCOUNT });
  const f = tenantFields(req.body, false);
  if (f.error) return res.status(400).json(f);
  if (f.webhookUrl && !publicWebhook(f.webhookUrl)) return res.status(400).json({ error: "webhook_not_public" });
  const status = autoApprove() ? "active" : "pending";
  const k = createTenant(f, { status, owner: req.acct });
  if (!k) return res.status(500).json({ error: "tenant_registry_write_failed" });
  audit(asAccount(req.acct), "organisation.created", k.siteKey, { status });
  res.json({ ...k, ...tenantView(k.siteKey, tenants.tenants[k.siteKey]), note: NOTE_KEYS });
});
app.post("/v1/console/tenants/:siteKey", consoleAuth, ownTenant, (req, res) => {
  const f = tenantFields(req.body, true);
  if (f.error) return res.status(400).json(f);
  if (f.webhookUrl && f.webhookUrl !== req.t.webhookUrl && !publicWebhook(f.webhookUrl)) return res.status(400).json({ error: "webhook_not_public" });
  const prev = { ...req.t };
  const changed = Object.keys(f).filter((k) => JSON.stringify(f[k]) !== JSON.stringify(prev[k]));
  Object.assign(req.t, f);
  try { saveJson(TENANTS_FILE, tenants); } catch (e) { Object.assign(req.t, prev); return res.status(500).json({ error: "tenant_registry_write_failed" }); }
  if (changed.length) audit(asAccount(req.acct), "organisation.updated", req.params.siteKey, { changed });
  res.json(tenantView(req.params.siteKey, req.t));
});
app.get("/v1/console/tenants/:siteKey/stats", consoleAuth, ownTenantRead, async (req, res) => res.json(await tenantStats(req.params.siteKey)));
app.get("/v1/console/activity", consoleAuth, (req, res) => {
  const mine = new Set(Object.keys(tenants.tenants).filter((k) => tenants.tenants[k].owner === req.acct));
  const email = (accounts.accounts[req.acct] || {}).email;
  // The account's own actions, and anything done to its tenants (an approval by the operator, say).
  res.json({ entries: readAudit((e) => (e.siteKey && mine.has(e.siteKey)) || (e.actor && e.actor.type === "account" && e.actor.email === email), 200) });
});
// The organisation's own settings for its apps (each falls back to the operator's default).
app.get("/v1/console/tenants/:siteKey/settings", consoleAuth, ownTenantRead, (req, res) => {
  res.json({ settings: settings.describe(req.t), serverManaged: SERVER_MANAGED.has(req.params.siteKey) });
});
app.post("/v1/console/tenants/:siteKey/settings", consoleAuth, ownTenant, (req, res) => {
  let out;
  try { out = settings.updateTenant(req.t, req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.code || "bad_setting", note: e.message }); }
  const prev = req.t.settings;
  if (Object.keys(out.settings).length) req.t.settings = out.settings; else delete req.t.settings;
  try { saveJson(TENANTS_FILE, tenants); } catch (e) { if (prev) req.t.settings = prev; else delete req.t.settings; return res.status(500).json({ error: "tenant_registry_write_failed" }); }
  if (out.changed.length) audit(asAccount(req.acct), "organisation.settings_changed", req.params.siteKey, { changed: out.changed });
  res.json({ changed: out.changed, settings: settings.describe(req.t) });
});
// Send the tenant's webhook a signed test event (event "test") so the receiver can be checked before a
// real risk change needs it. Only the status code and the time come back, never the response body.
app.post("/v1/console/tenants/:siteKey/test-webhook", consoleAuth, ownTenant, async (req, res) => {
  const url = req.t.webhookUrl;
  if (!url) return res.status(400).json({ error: "no_webhook" });
  if (!publicWebhook(url)) return res.status(400).json({ error: "webhook_not_public" });
  const t0 = Date.now();
  let status = 0, error = null;
  try {
    const r = await fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/secevent+jwt" }, body: signEvent("continuum-test", "genuine", "test", "test") });
    status = r.status;
  } catch (e) { error = e && e.name === "TimeoutError" ? "timeout" : "unreachable"; }
  const ok = status >= 200 && status < 300;
  audit(asAccount(req.acct), "webhook.tested", req.params.siteKey, { ok, status });
  res.json({ ok, status, ms: Date.now() - t0, error });
});
// A new secret, shown once. The old one stops working at once: identity tokens the tenant's backend
// already signed fail, so it should deploy the new secret right away.
app.post("/v1/console/tenants/:siteKey/rotate", consoleAuth, ownTenant, (req, res) => {
  if (SERVER_MANAGED.has(req.params.siteKey)) return res.status(409).json({ error: "server_managed_secret" });
  const prev = req.t.secret;
  req.t.secret = crypto.randomBytes(24).toString("hex");
  req.t.secretRotatedAt = new Date().toISOString();
  try { saveJson(TENANTS_FILE, tenants); } catch (e) { req.t.secret = prev; return res.status(500).json({ error: "tenant_registry_write_failed" }); }
  audit(asAccount(req.acct), "secret.rotated", req.params.siteKey);
  res.json({ siteKey: req.params.siteKey, secret: req.t.secret });
});
// Revoking is final from the console, so the request must name the tenant exactly (the page asks the user
// to type it), as GitHub and Auth0 do before deleting.
app.post("/v1/console/tenants/:siteKey/revoke", consoleAuth, ownTenant, (req, res) => {
  if (SERVER_MANAGED.has(req.params.siteKey)) return res.status(409).json({ error: "server_managed_tenant" });
  if (String(req.body.confirm || "") !== req.t.name) return res.status(400).json({ error: "confirm_name_mismatch" });
  req.t.status = "revoked";
  try { saveJson(TENANTS_FILE, tenants); } catch (e) { return res.status(500).json({ error: "tenant_registry_write_failed" }); }
  audit(asAccount(req.acct), "organisation.revoked", req.params.siteKey);
  res.json(tenantView(req.params.siteKey, req.t));
});
// Deleting removes the organisation for good: its keys stop at once, and every one of its users is
// erased (eraseTenantUsers). Allowed in any status, revoked included; the name must be typed, as for
// revoking. Built-in tenants can't be deleted here. If some users could not be erased, the tenant is
// revoked instead of removed, so nothing is left unreachable, and the answer says so (a retry finishes).
app.post("/v1/console/tenants/:siteKey/delete", consoleAuth, ownTenantRead, async (req, res) => {
  const key = req.params.siteKey, t = req.t;
  if (SERVER_MANAGED.has(key)) return res.status(409).json({ error: "server_managed_tenant" });
  if (String(req.body.confirm || "") !== t.name) return res.status(400).json({ error: "confirm_name_mismatch" });
  const prevStatus = t.status;
  t.status = "revoked";   // stop the key first, so no new user appears while the erase runs
  try { saveJson(TENANTS_FILE, tenants); } catch (e) { t.status = prevStatus; return res.status(500).json({ error: "tenant_registry_write_failed" }); }
  const r = await eraseTenantUsers(key).catch(() => ({ users: 0, failed: 1 }));
  if (r.failed) {
    audit(asAccount(req.acct), "organisation.revoked", key, { reason: "delete_incomplete", failed: r.failed });
    return res.status(502).json({ error: "delete_incomplete", users: r.users, failed: r.failed });
  }
  const name = t.name;
  delete tenants.tenants[key];
  try { saveJson(TENANTS_FILE, tenants); } catch (e) { return res.status(500).json({ error: "tenant_registry_write_failed" }); }
  audit(asAccount(req.acct), "organisation.deleted", key, { name, users: r.users });
  res.json({ ok: true, siteKey: key, users: r.users });
});

// ---- EXTENSION SIGN-IN (/v1/link/*) ----
// The extension never sees a password or a tenant secret. This is OAuth 2.0's authorization code flow
// with PKCE (RFC 7636), the gateway being the authorization server:
//  1. the extension makes a random verifier and opens /connect.html?mode=link&k=<site key>&cc=<its
//     S256 challenge>; the page calls /v1/link/start and gets a link id;
//  2. the user signs in where their account lives: the organisation's own sign-in page
//     (tenant.signInUrl, served by @continuum/node's link handler), which form-posts an identity token
//     bound to this link id to /v1/link/callback; or, for the personal tenant, a Continuum account on
//     /connect.html itself (/v1/accounts/*);
//  3. the gateway issues a one-time code, and the page hands it to the extension (its content script
//     relays it; the service worker accepts it only from /connect.html);
//  4. the extension redeems the code with its verifier at /v1/link/token and keeps the refresh token.
// Only the extension that started the flow holds the verifier, so a code seen by anyone else is useless.
const links = new Map();   // linkId -> { siteKey, challenge, at, status: pending|authorized, code, codeAt, externalId, label }
const LINK_TTL_MS = 10 * 60000, CODE_TTL_MS = 2 * 60000;
function liveLink(id) {
  const l = links.get(String(id || ""));
  if (l && Date.now() - l.at < LINK_TTL_MS) return l;
  links.delete(String(id || ""));
  return null;
}
function authorizeLink(linkId, siteKey, externalId, label) {
  const l = liveLink(linkId);
  if (!l || l.status !== "pending" || l.siteKey !== siteKey) return null;
  Object.assign(l, { status: "authorized", externalId, label, code: crypto.randomBytes(24).toString("base64url"), codeAt: Date.now() });
  return l.code;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, l] of links) if (now - l.at >= LINK_TTL_MS) links.delete(id);
  for (const [id, c] of ceremonies) if (now - c.at >= 5 * 60000) ceremonies.delete(id);
}, 60000).unref();

app.post("/v1/link/start", ownPage, (req, res) => {
  const siteKey = String(req.body.siteKey || "").trim();
  const t = tenants.tenants[siteKey];
  if (!t) return res.status(404).json({ error: "unknown_organisation" });
  if (!tenantActive(t)) return res.status(403).json({ error: t.status === "pending" ? "organisation_pending_approval" : "organisation_revoked" });
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(req.body.codeChallenge || ""))) return res.status(400).json({ error: "bad_code_challenge" });
  const personal = siteKey === PERSONAL_KEY;
  if (!personal && !t.signInUrl) return res.status(409).json({ error: "no_extension_sign_in", note: "This organisation has not set up sign-in for the browser extension." });
  if (!personal && (t.origins || []).length && !(t.origins || []).some((o) => EXT_ORIGIN_RE.test(o))) {
    return res.status(409).json({ error: "extension_not_allowed", note: "This organisation does not allow the browser extension." });
  }
  const linkId = crypto.randomBytes(16).toString("hex");
  links.set(linkId, { siteKey, challenge: String(req.body.codeChallenge), at: Date.now(), status: "pending" });
  const signInUrl = personal ? null : t.signInUrl + (t.signInUrl.includes("?") ? "&" : "?") + "continuum_link=" + linkId;
  res.json({ linkId, kind: personal ? "personal" : "organisation", tenantName: t.name, signInUrl });
});
// The organisation's sign-in form-posts here: the link id and an identity token signed with its tenant
// secret, carrying `link` (this link id, so it cannot be replayed on another) and a short expiry.
app.post("/v1/link/callback", (req, res) => {
  const linkId = String(req.body.link || "");
  const fail = (why) => res.redirect(303, "/connect.html?mode=error&why=" + encodeURIComponent(why));
  const l = liveLink(linkId);
  if (!l || l.status !== "pending" || l.siteKey === PERSONAL_KEY) return fail("link_expired");
  const t = resolveTenant(l.siteKey);
  if (!t) return fail("organisation_not_active");
  const tok = verifyIdentity(t.secret, String(req.body.identity_token || ""));
  const now = Math.floor(Date.now() / 1000);
  if (!tok || tok.link !== linkId || !tok.exp || tok.exp - now > 600) return fail("invalid_identity_token");
  const label = tok.name ? String(tok.name).slice(0, 80) : String(tok.sub);
  const code = authorizeLink(linkId, l.siteKey, "id:" + String(tok.sub), label);
  if (!code) return fail("link_expired");
  res.redirect(303, "/connect.html?mode=done&link=" + linkId + "&code=" + code);
});
app.post("/v1/link/token", async (req, res) => {
  try {
    const linkId = String(req.body.linkId || "");
    const l = liveLink(linkId);
    const code = String(req.body.code || ""), verifier = String(req.body.codeVerifier || "");
    const good = l && l.status === "authorized" && Date.now() - l.codeAt < CODE_TTL_MS && code.length === l.code.length
      && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(l.code))
      && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && crypto.createHash("sha256").update(verifier).digest("base64url") === l.challenge;
    links.delete(linkId);   // one attempt: a wrong verifier burns the code
    if (!good) return res.status(400).json({ error: "invalid_grant" });
    const t = resolveTenant(l.siteKey);
    if (!t) return res.status(403).json({ error: "organisation_not_active" });
    if (!originAllowed(t, req)) return res.status(403).json({ error: "origin_not_allowed" });
    const u = userFor(l.siteKey, l.externalId);
    res.json({ token: signSession(u, l.siteKey, l.externalId), refreshToken: signRefresh(u, l.siteKey, l.externalId), userId: u.userId,
      siteKey: l.siteKey, kind: l.siteKey === PERSONAL_KEY ? "personal" : "organisation", tenantName: t.name, label: l.label,
      onboarding: await onboardingFor(u.userId, l.siteKey) });
  } catch (e) { console.error("link/token:", e); res.status(500).json({ error: e.message }); }
});
// Sign-out: the refresh token stops working (until it would have expired anyway).
app.post("/v1/link/revoke", (req, res) => {
  const pl = unjwt(SESSION_SECRET, String(req.body.refreshToken || ""));
  if (pl && pl.typ === "refresh" && pl.jti) {
    accounts.revoked[pl.jti] = pl.exp;
    try { saveAccounts(); } catch (e) { return res.status(500).json({ error: "account_store_write_failed" }); }
  }
  res.json({ ok: true });
});

// ---- identity: establish a tenant-scoped session ----
app.post("/v1/sdk/session", async (req, res) => {
  try {
    const siteKey = String(req.body.siteKey || "");
    const known = tenants.tenants[siteKey];
    if (known && !tenantActive(known)) return res.status(403).json({ error: known.status === "pending" ? "tenant_pending_approval" : "tenant_revoked" });
    const tenant = resolveTenant(siteKey);
    if (!tenant) return res.status(401).json({ error: "invalid_site_key" });
    if (!originAllowed(tenant, req)) return res.status(403).json({ error: "origin_not_allowed" });
    // Prefer a backend-signed identity (account-bound, cross-device). Fall back to
    // an anonymous, browser-bound externalId when the app hasn't identified a user.
    let externalId, verified = false;
    if (req.body.identityToken) {
      const id = verifyIdentity(tenant.secret, req.body.identityToken);
      // A token bound to an extension sign-in (/v1/link/callback) is for that alone.
      if (!id || id.link) return res.status(401).json({ error: "invalid_identity_token" });
      externalId = "id:" + String(id.sub); verified = true; // namespaced from anon ids
    } else if (req.body.refreshToken) {
      // The extension after signing in (/v1/link/*): the same principal it signed in as.
      const rt = verifyRefresh(String(req.body.refreshToken), siteKey);
      if (!rt) return res.status(401).json({ error: "invalid_refresh_token" });
      externalId = rt.ext; verified = true;
    } else {
      externalId = String(req.body.externalId || "anon-" + crypto.randomUUID()).slice(0, 200);
      // "id:" and "acct:" name VERIFIED users (a tenant-signed identity, a Continuum account). This path
      // used to accept them from the request, so anyone could open a session as any signed-in user (for
      // example externalId "id:42" on pk_demo) and read, reset or re-enrol their profile.
      if (/^(id|acct):/i.test(externalId)) return res.status(400).json({ error: "reserved_external_id" });
    }
    const u = userFor(siteKey, externalId);
    res.json({ token: signSession(u, siteKey, externalId), userId: u.userId, username: u.username, externalId, verified, onboarding: await onboardingFor(u.userId, siteKey), onboardingMode: settings.effective(tenants.tenants[siteKey]).values.onboarding });
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
  // A typed token (refresh, console) is never a session: a refresh token lives 90 days.
  if (!pl || pl.typ) return res.status(401).json({ error: "invalid_session" });
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
// Enrolment resets. sdk/guard.js (resetProfile) has called these since the reset button existed, but
// the gateway never had them, so a reset through the gateway got 404 and changed nothing.
app.post("/v1/sdk/keystroke/reset", auth, async (req, res) => relay(res, await fwd(`${CA_URL}/v1/keystroke/reset`, "POST", { userId: req.uid }, caAssert(req))));
app.post("/v1/sdk/mouse/reset", auth, async (req, res) => relay(res, await fwd(`${CA_URL}/v1/mouse/reset`, "POST", { userId: req.uid }, caAssert(req))));
// User study (ca-service lib/studyLog.js): bind the session's user to its participant pseudonym.
app.post("/v1/sdk/study/register", auth, async (req, res) => relay(res, await fwd(`${CA_URL}/v1/study/register`, "POST", { ...req.body, userId: req.uid }, caAssert(req))));
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

// Adaptive retraining: the user retrains with the samples collected so far, and must pass the passkey
// in this very request (a WebAuthn assertion for a challenge from /v1/sdk/passkey/auth/options). Only
// then does ca-service turn the pending samples into training samples (lib/adaptive.js there).
app.post("/v1/sdk/keystroke/adaptive/retrain", auth, async (req, res) => {
  if (!req.body || !req.body.challengeId || !req.body.assertion) return res.status(400).json({ error: "passkey_required" });
  const pk = await fwd(`${PASSKEY_URL}/v1/auth/complete`, "POST", { userId: req.uid, challengeId: req.body.challengeId, assertion: req.body.assertion, rpId: rpFromOrigin(req), origin: originOf(req) });
  if (pk.status !== 200) return relay(res, pk);
  relay(res, await fwd(`${CA_URL}/v1/keystroke/adaptive/confirm`, "POST", {}, caAssert(req)));
});

// Shared step-up lock (see ca-service/lib/lock.js) — lets the SDK log out on
// page load for ANY app, not just apps/demo's own session-based gate.
app.get("/v1/sdk/lock/status", auth, async (req, res) => relay(res, await fwd(`${CA_URL}/v1/lock/status/${req.uid}`, "GET", undefined, caAssert(req))));
app.get("/v1/sdk/passkey/status", auth, async (req, res) => res.json({ hasPasskey: await hasPasskey(req.uid) }));

app.listen(PORT, () => console.log(`Continuum gateway on :${PORT} (tenants=${Object.keys(tenants.tenants).length})`));
