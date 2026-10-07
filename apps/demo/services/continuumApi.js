// How this app's BACKEND calls Continuum — the way any organisation's server does. Everything goes to
// the Continuum gateway's tenant API (/v1/server/*), the one public entry: this app never reaches an
// internal service (ca-service, passkey-service) and holds no credential for one.
//
// Each call proves who is asking and for whom with what the organisation already has: its site key, and
// an identity token, a standard HS256 JWT signed with its tenant secret, naming one of its OWN users (the
// gateway maps that to the Continuum user) and made for the tenant API (aud "continuum-server"; the tokens
// this app gives its users' browsers for the SDK have no such audience, so a browser can never use one
// here). The token lives two minutes and is made per call, so nothing here is cached or shared.
const crypto = require("crypto");

const GATEWAY_URL = process.env.GATEWAY_URL || "http://gateway:8080";
const SITE_KEY = process.env.CONTINUUM_SITE_KEY || "pk_demo";
const TENANT_SECRET = process.env.CONTINUUM_SECRET || "dev-continuum-risk-secret";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Sign an identity token for one of OUR OWN users, with OUR tenant secret, for the tenant API. */
function identityToken(appUserId) {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ sub: String(appUserId), aud: "continuum-server", exp: Math.floor(Date.now() / 1000) + 120 });
  const d = `${h}.${p}`;
  return `${d}.${crypto.createHmac("sha256", TENANT_SECRET).update(d).digest("base64url")}`;
}

/** Call the tenant API for `appUserId` (this app's own users.id). Resolves to { status, ok, data }. */
async function request(method, path, appUserId, body) {
  const res = await fetch(`${GATEWAY_URL}/v1/server${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Continuum-Site-Key": SITE_KEY, Authorization: "Bearer " + identityToken(appUserId) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

module.exports = { request, identityToken, GATEWAY_URL, SITE_KEY };
