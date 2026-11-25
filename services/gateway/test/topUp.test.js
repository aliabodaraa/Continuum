// More samples for a trained profile (2026-11-25): a trained typing or mouse profile takes samples again only after the
// user's passkey. The proof is a step-up token (as for a reset); it buys a top-up grant for one channel, and an
// enrolment sample that carries the grant reaches ca-service with `topUp` set. Nothing else sets it: not the caller's
// body, not another user's grant, not the other channel's. The real gateway (STORAGE=json, a temporary folder) runs
// against a stub ca-service and passkey-service, on the SDK routes and on the tenant API. node --test
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

// ---- stub ca-service and passkey-service. An enrolment sample is recorded as ca-service received it; a sample that
// says refuse is answered 422, as a sample that fails ca-service's checks is.
const stub = { enrols: [] };
const stubServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const send = (status, d) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    const m = /^\/v1\/(mouse|keystroke)\/enroll$/.exec(req.url);
    if (m) {
      const b = JSON.parse(body || "{}");
      stub.enrols.push({ channel: m[1], body: b });
      return b.refuse ? send(422, { ok: false, error: "not a sample" }) : send(202, { ok: true });
    }
    if (/^\/v1\/users\/\d+\/passkeys$/.test(req.url)) return send(200, { hasPasskey: true });
    if (/^\/v1\/users\/\d+\/onboarding$/.test(req.url)) return send(200, {});
    if (req.url === "/v1/auth/complete") return send(200, { verified: true });
    if (req.url === "/v1/mouse/use-anchor") return send(200, { offer: false });
    if (req.url === "/v1/lock/clear") return send(200, { ok: true });
    send(404, { error: "not stubbed" });
  });
});
const last = () => stub.enrols[stub.enrols.length - 1];

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let GW = "", gateway = null, log = "", dataDir = "";

test.before(async () => {
  await new Promise((r) => stubServer.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stubServer.address().port}`;
  const port = await freePort();
  GW = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-top-up-"));
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
async function grant(token, channel) {
  const g = await sdk(`/v1/sdk/${channel}/topup`, { stepUpToken: (await verify(token)).d.stepUpToken }, token);
  assert.equal(g.status, 200, JSON.stringify(g.d));
  assert.ok(g.d.topUpToken);
  return g.d.topUpToken;
}

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

test("SDK: a sample reaches ca-service without the word, whatever the caller writes in its body", async () => {
  const t = await session("user-plain");
  const r = await sdk("/v1/sdk/mouse/enroll", { windows: "w1", topUp: true }, t);
  assert.equal(r.status, 202);
  assert.equal(last().body.windows, "w1");
  assert.equal("topUp" in last().body, false, "the caller's topUp is dropped");
  await sdk("/v1/sdk/keystroke/enroll", { textContent: "t1", topUp: true, topUpToken: "made-up" }, t);
  assert.equal(last().channel, "keystroke");
  assert.equal("topUp" in last().body, false, "a made-up grant sets nothing");
  assert.equal("topUpToken" in last().body, false);
});

test("SDK: the grant needs a passkey verified moments before, and its step-up token is spent on it", async () => {
  const t = await session("user-grant");
  const bare = await sdk("/v1/sdk/mouse/topup", {}, t);
  assert.equal(bare.status, 403);
  assert.equal(bare.d.error, "passkey_required");
  const forged = await sdk("/v1/sdk/mouse/topup", { stepUpToken: "made-up" }, t);
  assert.equal(forged.status, 403);
  const v = await verify(t);
  const g = await sdk("/v1/sdk/mouse/topup", { stepUpToken: v.d.stepUpToken }, t);
  assert.equal(g.status, 200, JSON.stringify(g.d));
  assert.ok(g.d.topUpToken && g.d.expiresInMs > 60000 && g.d.maxSamples >= 4);
  const again = await sdk("/v1/sdk/keystroke/topup", { stepUpToken: v.d.stepUpToken }, t);
  assert.equal(again.status, 403, "one passkey, one grant");
  const reset = await sdk("/v1/sdk/mouse/reset", { stepUpToken: v.d.stepUpToken }, t);
  assert.equal(reset.status, 403, "and no reset on the same passkey");
});

test("SDK: with the grant a sample carries the word; the grant is for its user, its channel and a few samples", async () => {
  const t = await session("user-topup"), other = await session("user-someone-else");
  const g = await grant(t, "mouse");
  const first = await sdk("/v1/sdk/mouse/enroll", { windows: "a", topUpToken: g }, t);
  assert.equal(first.status, 202);
  assert.equal(last().body.topUp, true);
  assert.equal("topUpToken" in last().body, false, "the grant itself is not passed on");

  await sdk("/v1/sdk/keystroke/enroll", { textContent: "x", topUpToken: g }, t);
  assert.equal("topUp" in last().body, false, "a mouse grant adds nothing to typing");
  await sdk("/v1/sdk/mouse/enroll", { windows: "b", topUpToken: g }, other);
  assert.equal("topUp" in last().body, false, "another user's grant sets nothing");

  // (the two refusals above took the grant out and it was not put back: a grant shown on the wrong channel or by the
  // wrong user is gone, so the user proves the passkey again)
  await sdk("/v1/sdk/mouse/enroll", { windows: "c", topUpToken: g }, t);
  assert.equal("topUp" in last().body, false, "a grant misused once is spent");
});

test("SDK: a refused sample uses none of the grant, and the grant ends after its samples", async () => {
  const t = await session("user-count");
  const g = await grant(t, "keystroke");
  for (let i = 0; i < 3; i++) {
    const bad = await sdk("/v1/sdk/keystroke/enroll", { textContent: "bad", refuse: true, topUpToken: g }, t);
    assert.equal(bad.status, 422);
    assert.equal(last().body.topUp, true);
  }
  for (let i = 0; i < 8; i++) {
    await sdk("/v1/sdk/keystroke/enroll", { textContent: "s" + i, topUpToken: g }, t);
    assert.equal(last().body.topUp, true, `sample ${i + 1} of the grant`);
  }
  await sdk("/v1/sdk/keystroke/enroll", { textContent: "s9", topUpToken: g }, t);
  assert.equal("topUp" in last().body, false, "the ninth sample is outside the grant");
});

test("tenant API: the same rules for an organisation's backend", async () => {
  const sub = "backend-user";
  await server("/mouse/enroll", sub, { windows: "p", topUp: true });
  assert.equal(last().body.windows, "p");
  assert.equal("topUp" in last().body, false, "the backend's own topUp is dropped");
  const bare = await server("/mouse/topup", sub, {});
  assert.equal(bare.status, 403);
  assert.equal(bare.d.error, "passkey_required");
  const v = await server("/passkey/auth/complete", sub, { origin: SITE, challengeId: 1, assertion: { id: "x" } });
  assert.equal(v.status, 200);
  const g = await server("/mouse/topup", sub, { stepUpToken: v.d.stepUpToken });
  assert.equal(g.status, 200, JSON.stringify(g.d));
  const r = await server("/mouse/enroll", sub, { windows: "q", topUpToken: g.d.topUpToken });
  assert.equal(r.status, 202);
  assert.equal(last().body.topUp, true);
  assert.equal(last().body.windows, "q");
  const k = await server("/keystroke/enroll", sub, { textContent: "k" });
  assert.equal(k.status, 202, "enrolment without a grant goes on as before");
  assert.equal("topUp" in last().body, false);
});
