// Passkeys (FIDO2/WebAuthn), as this app's backend uses them: registration, verification and step-up,
// through Continuum's tenant API (services/continuumApi.js). Credentials and WebAuthn crypto live in
// Continuum; the app keeps its session and its authorisation ("may THIS session act for this user?").
//
// The relying party is this app's own website (ORIGIN, one of the organisation's registered origins), so
// the passkeys belong to its domain. `userId` is always this app's own users.id.
const { request } = require("./continuumApi");

const ORIGIN = (process.env.ORIGIN || "http://localhost:3000").replace(/\/+$/, "");

async function call(method, path, userId, body) {
  const r = await request(method, path, userId, body);
  if (!r.ok) {
    const err = new Error(r.data.error || `passkey ${path} failed`);
    err.status = r.status;
    throw err;
  }
  return r.data;
}

// --- lookups ---
async function hasPasskey(userId) {
  try {
    return !!(await call("GET", "/passkey/status", userId)).hasPasskey;
  } catch (e) {
    // Fail SAFE for a gate check: if Continuum is unreachable we treat the
    // user as NOT having a passkey (forces setup) rather than silently granting.
    console.error("passkeyClient.hasPasskey:", e.message);
    return false;
  }
}

// Populate/read the session cache so hot paths (middleware, per-check routes)
// stay synchronous. Mutations (register/reset) update req.session.hasPasskey
// directly, keeping this fresh without a round-trip per request.
// "Has none" is asked again after NO_PASSKEY_TTL_MS, as the gateway keeps its own "has none" for 5 s only (2026-11-25).
// A "no" from a failed lookup (Continuum's status also answers "no" when its own lookup fails), or from before a passkey
// was added elsewhere, used to last the whole session: the app offered "Register Passkey" and Continuum refused it 403,
// since the account had one.
const NO_PASSKEY_TTL_MS = 5000;
async function ensureHasPasskey(req) {
  if (req.session.hasPasskey === true) return true;
  if (req.session.hasPasskey === false && Date.now() - Number(req.session.hasPasskeyAt || 0) < NO_PASSKEY_TTL_MS) return false;
  const v = await hasPasskey(req.session.userId);
  req.session.hasPasskey = v;
  req.session.hasPasskeyAt = Date.now();
  return v;
}

async function reset(userId) {
  return call("POST", "/passkey/reset", userId, {});
}

// --- registration ---
async function registerOptions(userId, username) {
  return call("POST", "/passkey/register/options", userId, { username, origin: ORIGIN });
}
async function registerComplete(userId, credential) {
  return call("POST", "/passkey/register/complete", userId, { credential, origin: ORIGIN });
}

// --- authentication / step-up ---
async function authOptions(userId) {
  return call("POST", "/passkey/auth/options", userId, { origin: ORIGIN });
}
// Resolves to { ok, ..., stepUpToken }: the token proves this verification to Continuum for 2 minutes,
// once (adaptive retraining asks for it).
// `reason` (what the passkey answers: a "mouse" or "keystroke" lock) is a label Continuum keeps with the verification.
async function authComplete(userId, challengeId, assertion, reason) {
  return call("POST", "/passkey/auth/complete", userId, { challengeId, assertion, origin: ORIGIN, reason });
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
