// @continuum/node — server-side enforcement SDK.
//
// A host application's backend uses this to ENFORCE Continuum's behavioral
// verdict on sensitive actions, without trusting the browser. The CA service
// signs every verdict as a short-lived HS256 token (the "risk token"); this
// library verifies that signature + freshness and exposes an Express middleware
// that blocks or steps-up suspicious requests.
//
//   const { createGuard } = require("@continuum/node");
//   const guard = createGuard({ secret: process.env.CONTINUUM_SECRET });
//   app.post("/transfer", guard.requireTrusted, handler); // blocked if suspicious
//
// Dependency-free (Node crypto only).
const crypto = require("crypto");

function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function createGuard(opts) {
  opts = opts || {};
  const secret = opts.secret || process.env.CONTINUUM_SECRET;       // identity minting + HMAC fallback
  const jwksUri = opts.jwksUri || process.env.CONTINUUM_JWKS_URI;   // RS256 verdict verification (best practice)
  const clockSkewSec = opts.clockSkewSec != null ? opts.clockSkewSec : 5;
  const blockWarmup = !!opts.blockWarmup; // default: allow warm-up (insufficient evidence)

  // ---- pushed risk (CAEP) ----
  // subject (the consumer's OWN user id) -> "suspicious". Maintained by the events
  // receiver; read per-request by the identity middleware so protect() reacts to a
  // server-pushed verdict with zero extra app code.
  const pushedRisk = new Map();
  function pushedRiskFor(subject) { return pushedRisk.get(String(subject)) || null; }

  // ---- JWKS cache (public keys for asymmetric verdict verification) ----
  let jwks = {}, jwksAt = 0;
  async function refreshJwks() {
    if (!jwksUri) return;
    try {
      const d = await fetch(jwksUri).then((r) => r.json());
      const map = {};
      for (const k of (d.keys || [])) { try { map[k.kid || "_"] = crypto.createPublicKey({ key: k, format: "jwk" }); } catch (e) {} }
      jwks = map; jwksAt = Date.now();
    } catch (e) { /* keep previous keys */ }
  }
  if (jwksUri) refreshJwks(); // warm the cache
  async function jwksKey(kid) {
    if (jwks[kid]) return jwks[kid];
    if (Date.now() - jwksAt > 300000 || Object.keys(jwks).length === 0) await refreshJwks();
    return jwks[kid] || jwks["_"] || null;
  }

  function parse(token) {
    if (typeof token !== "string" || !token) return { err: "missing_token" };
    const parts = token.split("."); if (parts.length !== 3) return { err: "malformed" };
    let header, payload;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch (e) { return { err: "bad_payload" }; }
    return { parts, header, payload };
  }
  const expired = (p) => p.exp && Math.floor(Date.now() / 1000) > p.exp + clockSkewSec;
  const claims = (p) => ({ ok: true, userId: p.sub, risk: p.risk, modality: p.modality, issuedAt: p.iat, expiresAt: p.exp, issuer: p.iss });

  // Preferred: async verify — RS256 via JWKS (public key, no secret), else HMAC.
  async function verifyToken(token) {
    const t = parse(token); if (t.err) return { ok: false, error: t.err };
    const { parts, header, payload } = t;
    const data = parts[0] + "." + parts[1];
    if (header.alg === "RS256") {
      const key = await jwksKey(header.kid);
      if (!key) return { ok: false, error: "unknown_kid" };
      let ok = false; try { ok = crypto.verify("RSA-SHA256", Buffer.from(data), key, Buffer.from(parts[2], "base64url")); } catch (e) {}
      if (!ok) return { ok: false, error: "bad_signature" };
    } else {
      if (!secret) return { ok: false, error: "no_secret_for_hmac" };
      if (!timingEqual(parts[2], crypto.createHmac("sha256", secret).update(data).digest("base64url"))) return { ok: false, error: "bad_signature" };
    }
    if (expired(payload)) return { ok: false, error: "expired" };
    return claims(payload);
  }
  // Back-compat: synchronous HMAC-only verify.
  function verify(token) {
    const t = parse(token); if (t.err) return { ok: false, error: t.err };
    const { parts, payload } = t;
    if (!secret) return { ok: false, error: "no_secret" };
    if (!timingEqual(parts[2], crypto.createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest("base64url"))) return { ok: false, error: "bad_signature" };
    if (expired(payload)) return { ok: false, error: "expired" };
    return claims(payload);
  }

  function tokenFromReq(req) {
    if (req.get && req.get("X-Continuum-Risk")) return req.get("X-Continuum-Risk");
    if (req.headers && req.headers["x-continuum-risk"]) return req.headers["x-continuum-risk"];
    if (req.body && req.body.riskToken) return req.body.riskToken;
    return null;
  }

  // Express middleware (async — verifies via JWKS or HMAC).
  async function requireTrusted(req, res, next) {
    try {
      // A server-PUSHED suspicious verdict (CAEP) blocks even before the request's
      // own token — the app attached it via app.use(continuum). Zero extra code.
      if (req.continuumRisk === "suspicious") return res.status(403).json({ error: "step_up_required", risk: "suspicious", requiresStepUp: true, pushed: true });
      const v = await verifyToken(tokenFromReq(req));
      if (!v.ok) return res.status(401).json({ error: "continuum_risk_invalid", reason: v.error });
      if (v.risk === "suspicious" || (blockWarmup && v.risk === "warmup")) return res.status(403).json({ error: "step_up_required", risk: v.risk, requiresStepUp: true });
      req.continuum = v;
      next();
    } catch (e) { next(e); }
  }

  // Identity endpoint middleware. The consumer mounts this and only tells it HOW
  // to read the currently-logged-in user from their own session/framework — no
  // crypto, no hand-rolled endpoint:
  //   app.use(continuum.identity(req => req.session.userId));
  // It serves GET /continuum/identity → { token } (a signed identity the SDK
  // fetches automatically via data-identity-url). Returns 401 when not logged in.
  function identity(getUserId, opts) {
    opts = opts || {};
    const idPath = opts.path || "/continuum/identity";
    const ttl = opts.ttlSec || 300;
    return function (req, res, next) {
      if ((req.path || req.url).split("?")[0] !== idPath) return next();
      let uid = null;
      try { uid = getUserId(req); } catch (e) { uid = null; }
      if (uid == null || uid === "") return res.status(401).json({ error: "not_logged_in" });
      // Standard HS256 JWT (the documented identity contract) — identical to what
      // any other language's JWT library would produce with the tenant secret.
      const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const p = Buffer.from(JSON.stringify({ sub: String(uid), exp: Math.floor(Date.now() / 1000) + ttl })).toString("base64url");
      res.json({ token: h + "." + p + "." + crypto.createHmac("sha256", secret).update(h + "." + p).digest("base64url") });
    };
  }

  // CAEP receiver: verify a pushed risk-change SET (via JWKS, same key as verdicts).
  // It ALWAYS updates the built-in risk map (so protect() reacts on its own); the
  // handler is optional, for apps that also want to act (audit, revoke sessions):
  //   app.use(continuum.events());                 // enforcement only, no app code
  //   app.use(continuum.events(evt => { ... }));    // + custom reaction
  function events(handler, opts) {
    opts = opts || {};
    const evPath = opts.path || "/continuum/events";
    return function (req, res, next) {
      if ((req.path || req.url).split("?")[0] !== evPath || req.method !== "POST") return next();
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        let token = raw.trim();
        if (token.charAt(0) === "{") { try { const j = JSON.parse(token); token = j.set || j.token || ""; } catch (e) {} }
        const v = await verifyToken(token);
        if (!v.ok) return res.status(400).json({ error: "invalid_set", reason: v.error });
        const evt = { userId: v.userId, risk: v.risk, modality: v.modality, event: "risk-change" };
        // Built-in reaction: remember suspicious subjects, clear when they settle.
        if (evt.risk === "suspicious") pushedRisk.set(String(evt.userId), "suspicious");
        else pushedRisk.delete(String(evt.userId));
        try { if (handler) await handler(evt, req); } catch (e) {}
        res.status(202).json({ ok: true });
      });
      req.on("error", () => { try { res.status(400).end(); } catch (e) {} });
    };
  }

  return { verify, verifyToken, requireTrusted, identity, events, pushedRiskFor };
}

// Zero-config user detection. The one thing only the app knows is WHERE its
// logged-in user id lives; but nearly every Node stack uses one of a few
// conventions, so we try them in order. An app with a custom session shape
// passes `user: req => ...` to override — everyone else writes nothing.
function defaultUser(req) {
  if (req.user != null) {                                   // Passport / express-jwt
    if (typeof req.user === "string" || typeof req.user === "number") return req.user;
    if (req.user.id != null) return req.user.id;
    if (req.user.sub != null) return req.user.sub;
  }
  if (req.session) {                                        // express-session conventions
    if (req.session.userId != null) return req.session.userId;
    if (req.session.user_id != null) return req.session.user_id;
    if (req.session.uid != null) return req.session.uid;
    if (req.session.user && req.session.user.id != null) return req.session.user.id;
  }
  if (req.auth && req.auth.sub != null) return req.auth.sub; // express-oauth2-jwt-bearer
  return null;
}

// One-line integration. The returned value is itself the identity middleware
// (app.use(continuum)) AND carries .protect / .verify:
//   const continuum = require("@continuum/node")({ secret: process.env.CONTINUUM_SECRET });
//   app.use(continuum);                    // serves /continuum/identity (user auto-detected)
//   app.post("/transfer", continuum.protect, handler);   // enforce on sensitive routes
// Pass `user: req => ...` only if your session shape isn't a common convention.
function continuum(opts) {
  opts = opts || {};
  const g = createGuard(opts);
  const getUser = opts.user || defaultUser;                   // auto-detect unless overridden
  const idMw = g.identity(getUser);                           // serves /continuum/identity
  const evMw = g.events(opts.onRisk || null);                 // receives /continuum/events (+ optional cb)
  const IDENTITY_PATH = "/continuum/identity";
  const EVENTS_PATH = "/continuum/events";
  // One middleware does it all: serve identity, receive pushed events, and attach
  // THIS request's pushed risk so protect() reacts to CAEP with no extra app code.
  const mw = function (req, res, next) {
    const p = (req.path || req.url).split("?")[0];
    if (req.method === "POST" && p === EVENTS_PATH) return evMw(req, res, next);
    if (p === IDENTITY_PATH) return idMw(req, res, next);
    try { const s = getUser(req); if (s != null && s !== "") req.continuumRisk = g.pushedRiskFor(s); } catch (e) {}
    next();
  };
  mw.protect = g.requireTrusted;
  mw.requireTrusted = g.requireTrusted;
  mw.verify = g.verify;
  mw.verifyToken = g.verifyToken;
  mw.identity = g.identity;
  mw.events = g.events;
  mw.riskFor = g.pushedRiskFor;
  return mw;
}

module.exports = continuum;
module.exports.continuum = continuum;
module.exports.createGuard = createGuard; // still available for the granular API
