// Changes to what proves the user (2026-11-08): deleting a typing or mouse profile, or adding a passkey to an account
// that already has one, need a step-up token, the proof of a passkey verified through the gateway in the last 2 minutes,
// for this user, used once. The real gateway (STORAGE=json, a temporary folder) runs against stub ca-service and
// passkey-service, on the SDK routes and on the tenant API. node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const SIGNING = "test-signing-secret";           // pk_demo's tenant secret (CA_SIGNING_SECRET)
const SITE = "http://demo.test";                 // pk_demo's website (from DEMO_SIGNIN_URL)

// ---- stub ca-service and passkey-service: one server, the paths do not overlap ----
const stub = { hasPasskey: false, lookupFails: false, calls: [] };
const stubServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    stub.calls.push(`${req.method} ${req.url.split("?")[0]}`);
    const send = (status, d) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    if (/^\/v1\/users\/\d+\/passkeys$/.test(req.url)) return stub.lookupFails ? send(500, { error: "down" }) : send(200, { hasPasskey: stub.hasPasskey });
    if (/^\/v1\/users\/\d+\/onboarding$/.test(req.url)) return send(200, {});
    if (req.url === "/v1/register/options") return send(200, { challenge: "registration-challenge" });
    if (req.url === "/v1/auth/options") return send(200, { challenge: "auth-challenge", challengeId: 1 });
    if (req.url === "/v1/auth/complete") return send(200, { verified: true });
    if (req.url === "/v1/mouse/use-anchor") return send(200, { offer: false });
    if (["/v1/keystroke/reset", "/v1/mouse/reset", "/v1/lock/clear", "/v1/keystroke/adaptive/confirm"].includes(req.url)) return send(200, { ok: true });
    send(404, { error: "not stubbed" });
  });
});
const count = (call) => stub.calls.filter((c) => c === call).length;

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let GW = "", gateway = null, log = "", dataDir = "";

test.before(async () => {
  await new Promise((r) => stubServer.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stubServer.address().port}`;
  const port = await freePort();
  GW = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-account-"));
  gateway = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { PATH: process.env.PATH, ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
      PORT: String(port), STORAGE: "json", DATA_DIR: dataDir, CA_API_URL: stubUrl, PASSKEY_API_URL: stubUrl,
      GATEWAY_SESSION_SECRET: "test-session-secret", CA_SIGNING_SECRET: SIGNING, GATEWAY_ADMIN_KEY: "test-admin-key",
      DEMO_SIGNIN_URL: SITE + "/continuum/link", GATEWAY_PUBLIC_URL: GW },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout.on("data", (c) => { log += c; });
  gateway.stderr.on("data", (c) => { log += c; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(GW + "/health")).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error("the gateway did not start:\n" + log);
});
test.after(async () => {
  if (gateway) gateway.kill();
  await new Promise((r) => stubServer.close(r));
  await sleep(200);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---- the SDK: a session for one of pk_demo's users, from its website ----
async function sdk(p, body, token) {
  const r = await fetch(GW + p, { method: "POST", headers: { "Content-Type": "application/json", Origin: SITE, ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(body || {}) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}
async function session(externalId) {
  const r = await sdk("/v1/sdk/session", { siteKey: "pk_demo", externalId });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  return r.d.token;
}
const verify = (token) => sdk("/v1/sdk/passkey/auth/complete", { challengeId: 1, assertion: { id: "x" } }, token);

// ---- the tenant API: pk_demo's backend, acting for its user `sub` ----
function identityToken(sub) {
  const b = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const h = b({ alg: "HS256", typ: "JWT" }), p = b({ sub: String(sub), aud: "continuum-server", exp: Math.floor(Date.now() / 1000) + 120 });
  return h + "." + p + "." + crypto.createHmac("sha256", SIGNING).update(h + "." + p).digest("base64url");
}
async function server(p, sub, body) {
  const r = await fetch(GW + "/v1/server" + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Continuum-Site-Key": "pk_demo",
    Authorization: "Bearer " + identityToken(sub) }, body: JSON.stringify(body || {}) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}

test("SDK: a profile reset on the session alone is refused; a verified passkey's token deletes one profile, once", async () => {
  const t = await session("user-reset");
  const before = count("POST /v1/keystroke/reset");
  const bare = await sdk("/v1/sdk/keystroke/reset", {}, t);
  assert.equal(bare.status, 403);
  assert.equal(bare.d.error, "passkey_required");
  const forged = await sdk("/v1/sdk/keystroke/reset", { stepUpToken: "made-up" }, t);
  assert.equal(forged.status, 403);
  assert.equal(count("POST /v1/keystroke/reset"), before, "ca-service was not asked");
  const v = await verify(t);
  assert.equal(v.status, 200);
  assert.ok(v.d.stepUpToken, "a verified passkey returns a step-up token");
  const first = await sdk("/v1/sdk/keystroke/reset", { stepUpToken: v.d.stepUpToken }, t);
  assert.equal(first.status, 200);
  assert.equal(count("POST /v1/keystroke/reset"), before + 1);
  const reused = await sdk("/v1/sdk/mouse/reset", { stepUpToken: v.d.stepUpToken }, t);
  assert.equal(reused.status, 403, "the token is spent");
  const mouse = await sdk("/v1/sdk/mouse/reset", { stepUpToken: (await verify(t)).d.stepUpToken }, t);
  assert.equal(mouse.status, 200);
});

test("SDK: another user's token is refused", async () => {
  const owner = await session("user-owner"), other = await session("user-other");
  const v = await verify(owner);
  const r = await sdk("/v1/sdk/keystroke/reset", { stepUpToken: v.d.stepUpToken }, other);
  assert.equal(r.status, 403);
  assert.equal(r.d.error, "passkey_required");
});

test("SDK: an account's first passkey needs no token; a second one does", async () => {
  const t = await session("user-passkey");
  stub.hasPasskey = false;
  const first = await sdk("/v1/sdk/passkey/register/options", {}, t);
  assert.equal(first.status, 200, JSON.stringify(first.d));
  stub.hasPasskey = true;
  const bare = await sdk("/v1/sdk/passkey/register/options", {}, t);
  assert.equal(bare.status, 403);
  assert.equal(bare.d.error, "passkey_required");
  const withToken = await sdk("/v1/sdk/passkey/register/options", { stepUpToken: (await verify(t)).d.stepUpToken }, t);
  assert.equal(withToken.status, 200, JSON.stringify(withToken.d));
});

test("SDK: a failed passkey lookup stops a registration (it is not read as 'no passkey')", async () => {
  const t = await session("user-lookup");
  stub.lookupFails = true;
  try {
    const before = count("POST /v1/register/options");
    const r = await sdk("/v1/sdk/passkey/register/options", {}, t);
    assert.equal(r.status, 503);
    assert.equal(r.d.error, "passkey_lookup_failed");
    assert.equal(count("POST /v1/register/options"), before);
  } finally { stub.lookupFails = false; }
});

test("tenant API: profile resets and a second passkey need a step-up token from passkey/auth/complete, once", async () => {
  const sub = "backend-user";
  const bareReset = await server("/keystroke/reset", sub, {});
  assert.equal(bareReset.status, 403);
  assert.equal(bareReset.d.error, "passkey_required");
  stub.hasPasskey = true;
  const bareAdd = await server("/passkey/register/options", sub, { origin: SITE });
  assert.equal(bareAdd.status, 403);
  assert.equal(bareAdd.d.error, "passkey_required");
  const v = await server("/passkey/auth/complete", sub, { origin: SITE, challengeId: 1, assertion: { id: "x" } });
  assert.equal(v.status, 200);
  assert.ok(v.d.stepUpToken);
  const reset = await server("/mouse/reset", sub, { stepUpToken: v.d.stepUpToken });
  assert.equal(reset.status, 200);
  const again = await server("/keystroke/reset", sub, { stepUpToken: v.d.stepUpToken });
  assert.equal(again.status, 403, "the token is spent");
  const v2 = await server("/passkey/auth/complete", sub, { origin: SITE, challengeId: 1, assertion: { id: "x" } });
  const add = await server("/passkey/register/options", sub, { origin: SITE, stepUpToken: v2.d.stepUpToken });
  assert.equal(add.status, 200, JSON.stringify(add.d));
  const v3 = await server("/passkey/auth/complete", sub, { origin: SITE, challengeId: 1, assertion: { id: "x" } });
  const confirm = await server("/keystroke/adaptive/confirm", sub, { stepUpToken: v3.d.stepUpToken });
  assert.equal(confirm.status, 200, "adaptive retraining keeps working with its token");
});
