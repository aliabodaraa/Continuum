/**
 * Verify the gateway's internal identity assertion.
 *
 * WHY THIS EXISTS
 * ---------------
 * ca-service used to take the user id straight from the caller:
 *
 *     const uid = (req) => Number(req.body.userId || req.params.userId);
 *
 * Nineteen of its twenty-three endpoints did that, so any caller able to reach the service
 * could read or write ANY user's biometric data in ANY tenant simply by changing a number.
 * The shared API key does not help: it answers "is this a Continuum service?", never "is this
 * service allowed to act for this person?"
 *
 * It also produced a second, quieter defect. The gateway namespaces identities per tenant
 * precisely so two customers' "user 42" cannot collide — but the first-party app bypassed
 * that and wrote raw sequential ids, re-introducing the collision the namespacing existed to
 * prevent.
 *
 * Now identity arrives ONLY as a short-lived RS256 assertion signed by the gateway, which is
 * the sole identity authority. The body is ignored.
 *
 * ASYMMETRIC ON PURPOSE
 * ---------------------
 * The gateway holds the private key; this service fetches only the public key from the
 * gateway's JWKS. With a shared HMAC secret this service could mint its own assertions —
 * the very authority the assertion exists to withhold from it.
 *
 * BACKEND-ONLY
 * ------------
 * The assertion never reaches a browser: it is created gateway-side, travels on an internal
 * hop, and this service is not published to the host. It is not a client credential and must
 * never be returned in a response body or a cookie.
 */
const crypto = require("crypto");

const GATEWAY_JWKS = process.env.GATEWAY_JWKS_URI || "http://gateway:8080/.well-known/jwks.json";
const EXPECTED_AUD = "ca-service";
const EXPECTED_ISS = "gateway";
// Refuse assertions older than this even if `exp` is generous — bounds replay on the
// internal network to a small window.
const MAX_AGE_SEC = Number(process.env.IDENTITY_MAX_AGE_SEC || 600);

let jwksCache = { keys: [], fetchedAt: 0 };
const JWKS_TTL_MS = 5 * 60 * 1000;

async function jwks() {
  if (Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS && jwksCache.keys.length) return jwksCache.keys;
  const r = await fetch(GATEWAY_JWKS);
  const d = await r.json();
  jwksCache = { keys: d.keys || [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

function verifyRS256(token, jwk) {
  const [h, p, sig] = token.split(".");
  const pub = crypto.createPublicKey({ key: { ...jwk, kty: "RSA" }, format: "jwk" });
  return crypto.createVerify("RSA-SHA256").update(h + "." + p).verify(pub, Buffer.from(sig, "base64url"));
}

/**
 * Returns { tenantId, principalId, settings } for a valid assertion, or throws.
 * Never falls back to anything the caller supplied.
 */
async function verifyIdentityAssertion(token) {
  if (!token || typeof token !== "string") throw new Error("missing identity assertion");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed assertion");

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (e) { throw new Error("unparseable assertion"); }

  if (header.alg !== "RS256") throw new Error("unexpected alg: " + header.alg);

  const keys = await jwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key: " + header.kid);
  if (!verifyRS256(token, jwk)) throw new Error("bad signature");

  // `aud` stops an assertion minted for passkey-service being replayed here.
  if (payload.iss !== EXPECTED_ISS) throw new Error("wrong issuer: " + payload.iss);
  if (payload.aud !== EXPECTED_AUD) throw new Error("wrong audience: " + payload.aud);

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || now > payload.exp) throw new Error("expired");
  if (payload.iat && now - payload.iat > MAX_AGE_SEC) throw new Error("too old");
  if (!payload.tenant_id || payload.sub == null) throw new Error("incomplete claims");

  // `cfg`: the organisation's effective app settings, signed by the gateway (lib/appSettings.js).
  return { tenantId: String(payload.tenant_id), principalId: Number(payload.sub),
           settings: payload.cfg && typeof payload.cfg === "object" ? payload.cfg : null };
}

/**
 * Express middleware. On success sets req.identity = { tenantId, principalId }.
 * On any failure: 401. There is deliberately no fallback path — a caller that cannot prove
 * who it acts for gets nothing, rather than silently acting as whoever it named.
 */
function requireIdentity(req, res, next) {
  verifyIdentityAssertion(req.get("X-Continuum-Identity"))
    .then((identity) => { req.identity = identity; next(); })
    .catch((e) => {
      console.warn(`[identity] rejected ${req.method} ${req.path}: ${e.message}`);
      res.status(401).json({ error: "identity_required", detail: e.message });
    });
}

module.exports = { requireIdentity, verifyIdentityAssertion };
