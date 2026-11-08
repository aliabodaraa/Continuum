// @continuum/node: only verdicts pass, warm-up waits under requireVerified, and pushed events cannot be replayed or
// applied out of order (2026-11-08). A throwaway RSA key and a local JWKS stand in for the gateway. node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { createGuard } = require("..");

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "verdict", alg: "RS256", use: "sig" };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
function sign(payload, typ = "JWT") {
  const data = `${b64u({ alg: "RS256", typ, kid: "verdict" })}.${b64u(payload)}`;
  return `${data}.${crypto.sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
}
const verdict = (risk, extra = {}) => sign({ iss: "gateway", sub: "u1", risk, modality: "keystroke", iat: now(), exp: now() + 90, ...extra });
const event = (risk, extra = {}) => sign({ iss: "gateway", sub: "ext-1", event: "risk-change", risk, modality: "keystroke", iat: now(), jti: crypto.randomBytes(8).toString("hex"), ...extra }, "secevent+jwt");

let server, guard;
test.before(async () => {
  server = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [JWK] })); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  guard = createGuard({ jwksUri: `http://127.0.0.1:${server.address().port}/jwks.json` });
});
test.after(() => new Promise((r) => server.close(r)));

test("a verdict passes; an identity assertion, an event and a token without expiry do not", async () => {
  assert.equal((await guard.verifyToken(verdict("genuine"))).ok, true);
  const identity = sign({ iss: "gateway", aud: "ca-service", sub: "u1", tenant_id: "pk_x", iat: now(), exp: now() + 300 });
  assert.deepEqual(await guard.verifyToken(identity), { ok: false, error: "not_a_verdict" });
  assert.deepEqual(await guard.verifyToken(event("genuine")), { ok: false, error: "not_a_verdict" });
  assert.deepEqual(await guard.verifyToken(sign({ sub: "u1", risk: "genuine", iat: now() })), { ok: false, error: "no_expiry" });
  assert.deepEqual(await guard.verifyToken(verdict("genuine", { exp: now() - 60 })), { ok: false, error: "expired" });
});

// a minimal Express-like request and response
function call(mw, token) {
  return new Promise((resolve) => {
    const req = { get: (h) => (h === "X-Continuum-Risk" ? token : undefined), headers: {} };
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    mw(req, res, () => resolve({ code: 200, body: { next: true } }));
  });
}

test("requireTrusted lets a warm-up through; requireVerified answers verdict_pending without a step-up", async () => {
  assert.equal((await call(guard.requireTrusted, verdict("warmup"))).code, 200);
  const r = await call(guard.requireVerified, verdict("warmup"));
  assert.equal(r.code, 403);
  assert.equal(r.body.error, "verdict_pending");
  assert.equal(r.body.requiresStepUp, false);
  assert.equal((await call(guard.requireVerified, verdict("genuine"))).code, 200);
  assert.equal((await call(guard.requireVerified, verdict("suspicious"))).body.error, "step_up_required");
});

function post(mw, body) {
  return new Promise((resolve) => {
    const listeners = {};
    const req = { path: "/continuum/events", method: "POST", setEncoding() {}, on(ev, fn) { listeners[ev] = fn; return req; } };
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); }, end() { resolve({ code: this.code }); } };
    mw(req, res, () => resolve({ code: 404 }));
    listeners.data(body);
    listeners.end();
  });
}

test("events: applied once, never after a newer one for the same user, and not when stale", async () => {
  const receiver = guard.events();
  const suspicious = event("suspicious");
  assert.equal((await post(receiver, suspicious)).code, 202);
  assert.equal(guard.pushedRiskFor("ext-1"), "suspicious");
  assert.equal((await post(receiver, suspicious)).body.ignored, "duplicate");
  const older = event("genuine", { iat: now() - 120 });
  assert.equal((await post(receiver, older)).body.ignored, "older than the last event");
  assert.equal(guard.pushedRiskFor("ext-1"), "suspicious", "a replayed older genuine event does not clear it");
  assert.equal((await post(receiver, event("genuine", { iat: now() - 2 * 86400 }))).body.ignored, "stale");
  assert.equal((await post(receiver, event("genuine", { iat: now() + 1 }))).code, 202);
  assert.equal(guard.pushedRiskFor("ext-1"), null, "a newer genuine event settles the user");
  assert.equal((await post(receiver, verdict("genuine"))).code, 400, "a verdict is not an event");
});
