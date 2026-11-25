// Actions the gateway's own pages offered that the server then refused (2026-11-25). The real gateway (STORAGE=json, a
// temporary folder) runs against a stub ca-service and passkey-service: once without CONTINUUM_EXTENSION_ID, once with
// it (and restarted on the same folder). node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";   // the extension this gateway knows (gateway B)
const OTHER_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";  // one an organisation gave itself
const DEMO_SITE = "http://demo.test";
const ADMIN = "test-admin-key";
const CHALLENGE = "A".repeat(43);

// ---- stub ca-service and passkey-service: one server, the paths do not overlap ----
const calls = [];
const stubServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    calls.push(`${req.method} ${req.url.split("?")[0]}`);
    const send = (status, d) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); };
    if (/^\/v1\/users\/\d+\/passkeys$/.test(req.url)) return send(200, { hasPasskey: false });
    if (/^\/v1\/users\/\d+\/onboarding$/.test(req.url)) return send(200, {});
    if (req.url === "/v1/register/options") return send(200, { challenge: "registration-challenge" });
    if (req.url === "/v1/register/complete") return send(200, { verified: true });
    if (req.url === "/v1/auth/options") return send(200, { challenge: "auth-challenge", challengeId: 1 });
    if (req.url === "/v1/auth/complete") return send(200, { verified: true });
    send(404, { error: "not stubbed" });
  });
});
const count = (call) => calls.filter((c) => c === call).length;

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let STUB = "";
const dirs = [], procs = [];

// A gateway on its own port and folder; `env` adds to the common settings.
async function startGateway(env, dataDir, port) {
  port = port || await freePort();
  const url = `http://127.0.0.1:${port}`;
  let log = "";
  const p = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { PATH: process.env.PATH, ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
      PORT: String(port), STORAGE: "json", DATA_DIR: dataDir, CA_API_URL: STUB, PASSKEY_API_URL: STUB,
      GATEWAY_SESSION_SECRET: "test-session-secret", CA_SIGNING_SECRET: "test-signing-secret", GATEWAY_ADMIN_KEY: ADMIN,
      DEMO_SIGNIN_URL: DEMO_SITE + "/continuum/link", DEMO_WEBHOOK_URL: "http://receiver.internal/events", GATEWAY_PUBLIC_URL: url, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (c) => { log += c; });
  p.stderr.on("data", (c) => { log += c; });
  procs.push(p);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + "/health")).ok) return { url, port, proc: p }; } catch {}
    await sleep(100);
  }
  throw new Error("the gateway did not start:\n" + log);
}
const stop = async (g) => { g.proc.kill(); await new Promise((r) => (g.proc.exitCode != null ? r() : g.proc.once("exit", r))); };
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "gw-pages-")); dirs.push(d); return d; };

async function post(g, p, body, headers) {
  const r = await fetch(g.url + p, { method: "POST", headers: { "Content-Type": "application/json", Origin: g.url, ...(headers || {}) }, body: JSON.stringify(body || {}) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}
async function get(g, p, headers) {
  const r = await fetch(g.url + p, { headers: headers || {} });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}
// A Continuum account made on the gateway's own page (the stub accepts any passkey); returns its console token.
async function consoleAccount(g, email) {
  const o = await post(g, "/v1/accounts/register/options", { email, purpose: "console" });
  assert.equal(o.status, 200, JSON.stringify(o.d));
  const c = await post(g, "/v1/accounts/register/complete", { ceremonyId: o.d.ceremonyId, credential: { id: "x" } });
  assert.equal(c.status, 200, JSON.stringify(c.d));
  return { Authorization: "Bearer " + c.d.consoleToken };
}
const tenantsOf = async (g, auth) => (await get(g, "/v1/console/tenants", auth)).d.tenants;

let A, B, dirB;
test.before(async () => {
  await new Promise((r) => stubServer.listen(0, "127.0.0.1", r));
  STUB = `http://127.0.0.1:${stubServer.address().port}`;
  A = await startGateway({}, tmp());                                         // no CONTINUUM_EXTENSION_ID
  dirB = tmp();
  B = await startGateway({ CONTINUUM_EXTENSION_ID: EXT_ID }, dirB);
});
test.after(async () => {
  for (const p of procs) p.kill();
  await new Promise((r) => stubServer.close(r));
  await sleep(300);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("1. without CONTINUUM_EXTENSION_ID, an organisation that allows the extension can still save its websites and sign-in page", async () => {
  const auth = await consoleAccount(A, "one@acme.example");
  const noId = await post(A, "/v1/console/tenants", { name: "Acme", origins: ["https://app.acme.example"], allowExtension: true, signInUrl: "https://app.acme.example/continuum/link" }, auth);
  assert.equal(noId.status, 400);
  assert.equal(noId.d.error, "extension_id_required", "a new organisation must still give the id");
  const made = await post(A, "/v1/console/tenants", { name: "Acme", origins: ["https://app.acme.example"], allowExtension: true, extensionId: OTHER_ID, signInUrl: "https://app.acme.example/continuum/link" }, auth);
  assert.equal(made.status, 200, JSON.stringify(made.d));
  const k = made.d.siteKey;
  // the Websites tab sends the list and allowExtension, never an id
  const sites = await post(A, "/v1/console/tenants/" + k, { origins: ["https://app.acme.example", "https://shop.acme.example"], allowExtension: true }, auth);
  assert.equal(sites.status, 200, JSON.stringify(sites.d));
  assert.deepEqual(sites.d.origins, ["https://app.acme.example", "https://shop.acme.example", "chrome-extension://" + OTHER_ID]);
  // the Extension tab with its id field left empty
  const signIn = await post(A, "/v1/console/tenants/" + k, { allowExtension: true, origins: ["https://app.acme.example"], signInUrl: "https://app.acme.example/link2", extensionId: "" }, auth);
  assert.equal(signIn.status, 200, JSON.stringify(signIn.d));
  assert.ok(signIn.d.origins.includes("chrome-extension://" + OTHER_ID) && signIn.d.signInUrl === "https://app.acme.example/link2");
  const typo = await post(A, "/v1/console/tenants/" + k, { allowExtension: true, origins: ["https://app.acme.example"], extensionId: "abc" }, auth);
  assert.equal(typo.d.error, "extension_id_required", "a wrong id is still refused, not replaced by the stored one");
  const off = await post(A, "/v1/console/tenants/" + k, { allowExtension: false, origins: ["https://app.acme.example"], signInUrl: "" }, auth);
  assert.deepEqual([off.status, off.d.allowExtension, off.d.origins], [200, false, ["https://app.acme.example"]]);
  const on = await post(A, "/v1/console/tenants/" + k, { allowExtension: true, origins: ["https://app.acme.example"] }, auth);
  assert.equal(on.d.error, "extension_id_required", "switched off, nothing is kept: turning it on again needs the id");
  // another account's organisation is still out of reach
  const other = await consoleAccount(A, "two@acme.example");
  assert.equal((await post(A, "/v1/console/tenants/" + k, { origins: ["https://evil.example"], allowExtension: true }, other)).status, 404);
});

test("3. the personal sign-in is refused at its start when this server does not know the extension, before any account exists", async () => {
  const before = count("POST /v1/register/options");
  const r = await post(A, "/v1/link/start", { siteKey: "pk_personal", codeChallenge: CHALLENGE });
  assert.deepEqual([r.status, r.d.error], [409, "extension_not_configured"]);
  assert.equal(count("POST /v1/register/options"), before);
  const ok = await post(B, "/v1/link/start", { siteKey: "pk_personal", codeChallenge: CHALLENGE });
  assert.deepEqual([ok.status, ok.d.kind], [200, "personal"], "with the id it starts as before");
  assert.equal((await post(B, "/v1/link/start", { siteKey: "pk_personal", codeChallenge: CHALLENGE }, { Origin: "http://evil.example" })).status, 403, "still only from the gateway's own page");
});

test("6. a sign-in link that ended during the passkey ceremony: no passkey and no account are saved", async () => {
  await consoleAccount(B, "old@example.com");
  const link = await post(B, "/v1/link/start", { siteKey: "pk_personal", codeChallenge: CHALLENGE });
  const reg = await post(B, "/v1/accounts/register/options", { email: "new@example.com", purpose: "link", linkId: link.d.linkId });
  assert.equal(reg.status, 200, JSON.stringify(reg.d));
  // meanwhile the link is used (another sign-in in the same window): it is no longer pending, as after it expires
  const lo = await post(B, "/v1/accounts/login/options", { email: "old@example.com", purpose: "link", linkId: link.d.linkId });
  const li = await post(B, "/v1/accounts/login/complete", { ceremonyId: lo.d.ceremonyId, assertion: { id: "y" } });
  assert.ok(li.d.code, JSON.stringify(li.d));
  const before = count("POST /v1/register/complete");
  const done = await post(B, "/v1/accounts/register/complete", { ceremonyId: reg.d.ceremonyId, credential: { id: "z" } });
  assert.deepEqual([done.status, done.d.error], [400, "link_expired"]);
  assert.equal(count("POST /v1/register/complete"), before, "the passkey was not registered");
  assert.equal((await post(B, "/v1/accounts/login/options", { email: "new@example.com", purpose: "console" })).d.error, "no_account", "the account was not saved");
});

test("8. the console is told the organisation limit", async () => {
  const c = await get(A, "/v1/console/config");
  assert.equal(c.d.tenantLimit, 10);
});

test("9. the console is told whether a stored webhook may get a test alert", async () => {
  const auth = await consoleAccount(A, "demo-owner@example.com");
  const give = await post(A, "/v1/admin/tenants/pk_demo/owner", { email: "demo-owner@example.com" }, { "X-Admin-Key": ADMIN });
  assert.equal(give.status, 200, JSON.stringify(give.d));
  const demo = (await tenantsOf(A, auth)).find((t) => t.siteKey === "pk_demo");
  assert.deepEqual([demo.webhookUrl, demo.webhookPublic], ["http://receiver.internal/events", false]);
  assert.equal((await post(A, "/v1/console/tenants/pk_demo/test-webhook", {}, auth)).d.error, "webhook_not_public", "the server refuses it, as the page now says");
  const pub = await post(A, "/v1/console/tenants", { name: "Hooked", origins: ["https://h.example"], webhookUrl: "https://hooks.example.com/continuum" }, auth);
  assert.equal(pub.d.webhookPublic, true);
  const none = await post(A, "/v1/console/tenants", { name: "Quiet", origins: ["https://q.example"] }, auth);
  assert.equal(none.d.webhookPublic, null);
});

test("10. the demo follows .env while nobody owns it; its owner's edits survive a restart", async () => {
  const auth = await consoleAccount(B, "demo@example.com");
  const admin = { "X-Admin-Key": ADMIN };
  const seeded = (await get(B, "/v1/tenants", admin)).d.tenants.find((t) => t.siteKey === "pk_demo");
  assert.deepEqual(seeded.origins, [DEMO_SITE, "chrome-extension://" + EXT_ID], "seeded from .env");
  assert.equal(seeded.webhookUrl, "http://receiver.internal/events");
  assert.equal((await post(B, "/v1/admin/tenants/pk_demo/owner", { email: "demo@example.com" }, admin)).status, 200);
  const e1 = await post(B, "/v1/console/tenants/pk_demo", { origins: ["https://shop.example"], allowExtension: false, signInUrl: "https://shop.example/continuum/link" }, auth);
  assert.equal(e1.status, 200, JSON.stringify(e1.d));
  assert.equal((await post(B, "/v1/console/tenants/pk_demo", { webhookUrl: "https://hooks.example.com/new" }, auth)).status, 200);
  const port = B.port;
  await stop(B);
  B = await startGateway({ CONTINUUM_EXTENSION_ID: EXT_ID }, dirB, port);
  const after = (await tenantsOf(B, auth)).find((t) => t.siteKey === "pk_demo");
  assert.deepEqual([after.origins, after.allowExtension, after.signInUrl, after.webhookUrl],
    [["https://shop.example"], false, "https://shop.example/continuum/link", "https://hooks.example.com/new"]);
  // given back to the operator, .env manages it again at the next start
  assert.equal((await post(B, "/v1/admin/tenants/pk_demo/owner", { email: "" }, admin)).status, 200);
  await stop(B);
  B = await startGateway({ CONTINUUM_EXTENSION_ID: EXT_ID }, dirB, port);
  const back = (await get(B, "/v1/tenants", admin)).d.tenants.find((t) => t.siteKey === "pk_demo");
  assert.deepEqual([back.signInUrl, back.webhookUrl, back.allowExtension], [DEMO_SITE + "/continuum/link", "http://receiver.internal/events", true]);
  assert.ok(back.origins.includes(DEMO_SITE) && back.origins.includes("chrome-extension://" + EXT_ID));
});
