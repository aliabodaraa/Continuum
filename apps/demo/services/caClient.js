// Thin client for the standalone CA (continuous-auth) service. This is the ONLY place the
// demo talks to the behavioral engine — keystroke/mouse models + data live entirely there.
//
// IDENTITY. The demo no longer tells ca-service who the user is. It cannot: ca-service now
// takes identity solely from an RS256 assertion signed by the gateway, the single identity
// authority. Previously this client sent a raw `userId` (the demo's own sequential
// users.id), which both let any caller name any user and defeated the per-tenant namespacing
// that stops two customers' "user 42" colliding.
//
// The demo authenticates to the gateway exactly as any third-party tenant does — by signing
// an identity token with its own tenant secret. No new credential was needed; `pk_demo` has
// had one all along. First-party and third-party are now the same code path.
const crypto = require("crypto");

const CA_API_URL = process.env.CA_API_URL || "http://localhost:4100";
const API_KEY = process.env.CA_API_KEY || "";
const GATEWAY_URL = process.env.GATEWAY_URL || "http://gateway:8080";
const SITE_KEY = process.env.CONTINUUM_SITE_KEY || "pk_demo";
const TENANT_SECRET = process.env.CONTINUUM_SECRET || "dev-continuum-risk-secret";

// Two caches with deliberately different lifetimes.
//   assertions — signed and time-bound, so refreshed shortly before they expire.
// Keyed by `${SITE_KEY}:${appUserId}` so an entry can never be served across tenants.
const assertionCache = new Map();
const REFRESH_MARGIN_MS = 15_000;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Sign an identity token for one of OUR OWN users, with OUR tenant secret. */
function mintIdentityToken(appUserId) {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ sub: String(appUserId), exp: Math.floor(Date.now() / 1000) + 120 });
  const d = `${h}.${p}`;
  return `${d}.${crypto.createHmac("sha256", TENANT_SECRET).update(d).digest("base64url")}`;
}

/**
 * Obtain a gateway assertion naming the canonical principal for one of our users.
 *
 * FAILS CLOSED. If the gateway cannot be reached or refuses, this throws. It must never fall
 * back to sending a locally-chosen id — that fallback is precisely the defect being removed.
 */
async function assertionFor(appUserId) {
  const key = `${SITE_KEY}:${appUserId}`;
  const hit = assertionCache.get(key);
  if (hit && Date.now() < hit.expiresAt - REFRESH_MARGIN_MS) return hit.assertion;

  const res = await fetch(`${GATEWAY_URL}/v1/assert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteKey: SITE_KEY, identityToken: mintIdentityToken(appUserId), audience: "ca-service" }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(`identity assertion refused (${res.status}): ${d.error || "unknown"}`);
  }
  const d = await res.json();
  assertionCache.set(key, { assertion: d.assertion, expiresAt: Date.now() + d.expiresIn * 1000 });
  return d.assertion;
}

/**
 * `appUserId` is the demo's OWN user id. It is used only to obtain an assertion — it is never
 * sent to ca-service, which would ignore it anyway.
 */
async function call(method, path, appUserId, body) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-Api-Key"] = API_KEY;
  if (appUserId != null) headers["X-Continuum-Identity"] = await assertionFor(appUserId);
  const res = await fetch(`${CA_API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

module.exports = {
  // `userId` below is the DEMO's own users.id. It is used solely to obtain a gateway
  // assertion for the matching canonical principal — it is never sent to ca-service, which
  // reads identity only from the verified X-Continuum-Identity header.
  //
  // The path segments that still contain a user id are there because the routes are declared
  // as /:userId; ca-service ignores them for identity purposes.

  // config is the one unauthenticated read (no user, no tenant)
  config: () => call("GET", "/v1/keystroke/config"),

  onboarding: (userId) => call("GET", `/v1/users/${Number(userId)}/onboarding`, userId),
  keystrokeStatus: (userId) => call("GET", `/v1/keystroke/status/${Number(userId)}`, userId),

  // keystroke operations
  keystrokeEnroll: (userId, body) => call("POST", "/v1/keystroke/enroll", userId, body),
  keystrokeCheck: (userId, body) => call("POST", "/v1/keystroke/check", userId, body),
  keystrokeSubmit: (userId, body) => call("POST", "/v1/keystroke/submit", userId, body),
  keystrokeContribute: (userId, body) => call("POST", "/v1/keystroke/contribute", userId, body),
  keystrokeReset: (userId) => call("POST", "/v1/keystroke/reset", userId, {}),
  keystrokeRetrain: (userId) => call("POST", "/v1/keystroke/retrain", userId, {}),
  maybeRetrainImpostors: (userId) => call("POST", "/v1/keystroke/maybe-retrain-impostors", userId, {}),

  // reads
  keystrokeHistory: (userId) => call("GET", `/v1/keystroke/history/${Number(userId)}`, userId),
  keystrokeStats: (userId) => call("GET", `/v1/keystroke/stats/${Number(userId)}`, userId),
  keystrokeDecisions: (userId) => call("GET", `/v1/keystroke/decisions/${Number(userId)}`, userId),
  // Tenant-wide reads. They now need an identity too — not to select a user, but so
  // ca-service can scope the result to the caller's TENANT.
  keystrokeDecisionsAll: (userId) => call("GET", "/v1/keystroke/decisions-all", userId),
  keystrokeMetrics: (userId) => call("GET", "/v1/keystroke/metrics", userId),

  // mouse
  mouseEnroll: (userId, windows) => call("POST", "/v1/mouse/enroll", userId, { windows }),
  mouseCheck: (userId, windows) => call("POST", "/v1/mouse/check", userId, { windows }),
  mouseStatus: (userId) => call("GET", `/v1/mouse/status/${Number(userId)}`, userId),
  // Destructive — the route that calls this must verify a passkey first.
  mouseReset: (userId) => call("POST", "/v1/mouse/reset", userId, {}),

  // Shared step-up lock (see ca-service/lib/lock.js) — set from here when the
  // mouse strike debounce fires (keystroke sets it directly inside ca-service),
  // cleared on a successful passkey verification.
  lockSet: (userId) => call("POST", "/v1/lock/set", userId, {}),
  lockClear: (userId) => call("POST", "/v1/lock/clear", userId, {}),
};
