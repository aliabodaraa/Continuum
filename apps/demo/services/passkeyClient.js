// Thin client for the standalone passkey microservice. This is the ONLY place
// the demo app talks to FIDO2 — credentials + WebAuthn crypto live entirely in
// that service. The app keeps session/authorization; it just calls these.
const PASSKEY_API_URL = process.env.PASSKEY_API_URL || "http://localhost:4000";
const API_KEY = process.env.PASSKEY_API_KEY || "";

async function call(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-Api-Key"] = API_KEY;
  const res = await fetch(`${PASSKEY_API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `passkey-service ${path} failed`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// --- lookups ---
async function hasPasskey(userId) {
  try {
    const d = await call("GET", `/v1/users/${Number(userId)}/passkeys`);
    return !!d.hasPasskey;
  } catch (e) {
    // Fail SAFE for a gate check: if the service is unreachable we treat the
    // user as NOT having a passkey (forces setup) rather than silently granting.
    console.error("passkeyClient.hasPasskey:", e.message);
    return false;
  }
}

// Populate/read the session cache so hot paths (middleware, per-check routes)
// stay synchronous. Mutations (register/reset) update req.session.hasPasskey
// directly, keeping this fresh without a round-trip per request.
async function ensureHasPasskey(req) {
  if (typeof req.session.hasPasskey === "boolean") return req.session.hasPasskey;
  const v = await hasPasskey(req.session.userId);
  req.session.hasPasskey = v;
  return v;
}

async function reset(userId) {
  return call("POST", `/v1/users/${Number(userId)}/reset`);
}

// --- registration ---
async function registerOptions(userId, username) {
  return call("POST", "/v1/register/options", { userId, username });
}
async function registerComplete(userId, credential) {
  return call("POST", "/v1/register/complete", { userId, credential });
}

// --- authentication / step-up ---
async function authOptions(userId) {
  return call("POST", "/v1/auth/options", { userId });
}
async function authComplete(userId, challengeId, assertion) {
  return call("POST", "/v1/auth/complete", { userId, challengeId, assertion });
}

module.exports = {
  hasPasskey,
  ensureHasPasskey,
  reset,
  registerOptions,
  registerComplete,
  authOptions,
  authComplete,
};
