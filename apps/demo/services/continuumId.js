// Resolve the logged-in user's CONTINUUM id — the single identity our solution
// keys behavioral data on. The demo's own routes call the CA directly (legacy
// path), but must use the SAME id the SDK/gateway uses, or a user would have two
// diverging profiles. So we ask the gateway to resolve it (it owns the mapping),
// exactly as an external consumer would, and cache it in the session.
//
// One gateway round-trip per session; on failure we fall back to the raw id so
// behavioral features keep working (degraded to the pre-unification identity).
const crypto = require("crypto");

const SECRET = process.env.CONTINUUM_SECRET || "dev-continuum-risk-secret"; // tenant secret
const SITE_KEY = process.env.CONTINUUM_SITE_KEY || "pk_demo";
const GATEWAY_URL = process.env.GATEWAY_URL || "http://gateway:8080";

// Standard HS256 JWT — the documented identity contract (client_secret_jwt).
function signIdentity(sub, ttlSec = 300) {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ sub: String(sub), exp: Math.floor(Date.now() / 1000) + ttlSec })).toString("base64url");
  return h + "." + p + "." + crypto.createHmac("sha256", SECRET).update(h + "." + p).digest("base64url");
}

async function resolveContinuumId(req) {
  if (!req.session || req.session.userId == null) return null;
  if (req.session.continuumUserId != null) return req.session.continuumUserId;
  try {
    const r = await fetch(`${GATEWAY_URL}/v1/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteKey: SITE_KEY, identityToken: signIdentity(req.session.userId) }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.continuumUserId != null) {
      req.session.continuumUserId = d.continuumUserId;
      return d.continuumUserId;
    }
  } catch (e) { /* gateway unreachable — fall back below */ }
  return null;
}

// Express middleware: ensures req.caUid is the Continuum id for the session (or the
// raw id as a safe fallback). Cached after the first resolve.
function attachContinuumId(req, res, next) {
  if (req.session && req.session.userId != null) {
    resolveContinuumId(req)
      .then((cid) => { req.caUid = cid != null ? cid : req.session.userId; next(); })
      .catch(() => { req.caUid = req.session.userId; next(); });
  } else {
    next();
  }
}

module.exports = { resolveContinuumId, attachContinuumId };
