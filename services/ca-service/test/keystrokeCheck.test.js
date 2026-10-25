// The typing check through the real server (server.js) with synthetic data only: a stub for the gateway's key
// set, a stub model service that scores the newest windows low on request, and a throwaway SQLite database.
// It pins the decision: a check whose last twenty windows are at least half below 0.50 asks for the passkey at
// once, and nothing is carried from one check to the next. node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ca-check-"));
const DB_PATH = path.join(DIR, "test.db");
process.env.DB_PATH = DB_PATH;
process.env.STORAGE = "sqlite";
const db = require("../db");
const Database = require("better-sqlite3");

// ---- the gateway's key set and its assertions (RS256, as lib/identityAssertion.js verifies them)
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function assertion(sub) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u({ alg: "RS256", typ: "JWT", kid: "test-key" });
  const p = b64u({ iss: "gateway", aud: "ca-service", iat: now, exp: now + 300, tenant_id: "t-test", sub });
  return `${h}.${p}.${crypto.createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey).toString("base64url")}`;
}

// ---- the model service: the newest `low` windows of each request score 0.1, the others 0.9
const model = { low: 0 };
const stub = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/jwks.json") return res.end(JSON.stringify({ keys: [JWK] }));
  if (req.method === "POST" && req.url === "/api/user/predict") {
    let body = "";
    req.on("data", (c) => { body += c; }).on("end", () => {
      const n = JSON.parse(body).windows.length;
      res.end(JSON.stringify({ model_loaded: true, prediction: Array.from({ length: n }, (_, i) => (i >= n - model.low ? [0.9, 0.1] : [0.1, 0.9])) }));
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

// ---- plain typing: letters, dwell 70-130 ms, 130-270 ms between presses; `keys` keystrokes make keys - 50 steps
// less one, so 320 keys give 27 windows and 200 keys give 15
function typing(keys) {
  let t = 0, s = 7;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const events = [];
  for (let i = 0; i < keys; i++) {
    const keyCode = 65 + Math.floor(rnd() * 26), dwell = 70 + rnd() * 60;
    events.push({ keyCode, eventType: "keydown", timestampRelative: Math.round(t), fieldName: "f1", fieldType: "textarea" });
    events.push({ keyCode, eventType: "keyup", timestampRelative: Math.round(t + dwell), fieldName: "f1", fieldType: "textarea" });
    t += dwell + 60 + rnd() * 140;
  }
  return events;
}

const USERS = [1001, 1002, 1003, 1004, 1005, 1006, 1007];
let server, base, log = "";
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test.before(async () => {
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  await db.open();
  for (const id of USERS) {
    await db.run("INSERT INTO user_typing_profiles (user_id, model_json, sample_count, trained_at) VALUES (?, ?, ?, ?)", id,
      JSON.stringify({ type: "per-user-cnn-lstm", version: 3, modelPath: `/models/user-${id}/final_model`, threshold: 0.5 }), 5, new Date().toISOString());
  }
  await db.close();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), STORAGE: "sqlite", DB_PATH, NODE_ENV: "test", LOG_FORMAT: "",
      GATEWAY_JWKS_URI: `${stubUrl}/jwks.json`, MODEL_INFER_URL: stubUrl, MODEL_API_URL: stubUrl },
  });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the server did not start:\n${log}`);
});

test.after(async () => {
  if (server) { server.kill(); await new Promise((r) => server.once("exit", r)); }
  await new Promise((r) => stub.close(r));
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* a lock on Windows: the system cleans the temp folder */ }
});

async function check(sub, { keys = 320, low, hasPasskey = true }) {
  model.low = low;
  const r = await fetch(`${base}/v1/keystroke/check`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Continuum-Identity": assertion(sub) },
    body: JSON.stringify({ textLength: keys, keystrokeEvents: typing(keys), hasPasskey }),
  });
  return { status: r.status, d: await r.json() };
}
const locked = async (sub) => (await (await fetch(`${base}/v1/lock/status/${sub}`, { headers: { "X-Continuum-Identity": assertion(sub) } })).json()).locked;

test("typing that matches the user: a full packet, no suspicion, no passkey", async () => {
  const { status, d } = await check(1001, { low: 3 });
  assert.equal(status, 200);
  assert.equal(d.checked, true);
  assert.equal(d.warmup, false, `windows scored ${d.scoredWindowCount}`);
  assert.equal(d.scoredWindowCount, 20);
  assert.equal(d.isSuspicious, false);
  assert.equal(d.requiresPasskeyChallenge, false);
  assert.equal(await locked(1001), false);
});

test("one window short of half is not suspicious", async () => {
  const { d } = await check(1003, { low: 9 });
  assert.equal(d.isSuspicious, false);
  assert.equal(d.requiresPasskeyChallenge, false);
});

test("the first check with half of its twenty windows low asks for the passkey at once", async () => {
  const { d } = await check(1002, { low: 10 });
  assert.equal(d.warmup, false);
  assert.equal(d.isSuspicious, true);
  assert.equal(d.requiresPasskeyChallenge, true, "no second suspicious check is waited for");
  assert.equal(d.ok, false);
  assert.equal(await locked(1002), true, "the session lock is set");
});

test("a user without a passkey is never asked for one, though the check is still suspicious", async () => {
  const { d } = await check(1004, { low: 12, hasPasskey: false });
  assert.equal(d.isSuspicious, true);
  assert.equal(d.requiresPasskeyChallenge, false);
});

test("before a full packet there is only warm-up, unless three quarters of the windows are low", async () => {
  const early = await check(1005, { keys: 200, low: 7 });          // 15 windows, 7 low
  assert.equal(early.d.warmup, true);
  assert.equal(early.d.requiresPasskeyChallenge, false);
  const clear = await check(1006, { keys: 200, low: 12 });         // 15 windows, 12 low: 80%
  assert.equal(clear.d.warmup, false);
  assert.equal(clear.d.requiresPasskeyChallenge, true);
});

test("nothing about the typing checks is carried from one check to the next", async () => {
  await check(1007, { low: 10, hasPasskey: false });
  await check(1007, { low: 2, hasPasskey: false });
  const ro = new Database(DB_PATH, { readonly: true });
  try { assert.equal(ro.prepare("SELECT COUNT(*) AS n FROM decision_state").get().n, 0); } finally { ro.close(); }
});
