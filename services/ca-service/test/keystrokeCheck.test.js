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

// ---- the model service: the newest `low` windows of each request score 0.1, the others 0.9; `fail` answers that
// HTTP status instead (503: unavailable, 500 or 404: an error such as a lost model version)
const model = { low: 0, fail: 0 };
const stub = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/jwks.json") return res.end(JSON.stringify({ keys: [JWK] }));
  if (req.method === "POST" && req.url === "/api/user/predict") {
    let body = "";
    req.on("data", (c) => { body += c; }).on("end", () => {
      if (model.fail) { res.statusCode = model.fail; return res.end(JSON.stringify({ error: "stub failure" })); }
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

// Typing at about one key a second: of every three gaps between presses, two are over a second, so their digraphs are
// dropped (the pause rule) and windows build three times slower.
function sparseTyping(keys) {
  let t = 0, s = 11;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const events = [];
  for (let i = 0; i < keys; i++) {
    const keyCode = 65 + Math.floor(rnd() * 26), dwell = 70 + rnd() * 60;
    events.push({ keyCode, eventType: "keydown", timestampRelative: Math.round(t), fieldName: "f1", fieldType: "textarea" });
    events.push({ keyCode, eventType: "keyup", timestampRelative: Math.round(t + dwell), fieldName: "f1", fieldType: "textarea" });
    t += dwell + (i % 3 === 0 ? 60 + rnd() * 140 : 1100 + rnd() * 300);
  }
  return events;
}

const USERS = [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1009, 1010, 1011, 1012, 1013, 1014];   // 1008 has no typing profile
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

async function check(sub, { keys = 320, low, hasPasskey = true, events = null, textLength = null }) {
  model.low = low;
  const r = await fetch(`${base}/v1/keystroke/check`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Continuum-Identity": assertion(sub) },
    body: JSON.stringify({ textLength: textLength ?? keys, keystrokeEvents: events || typing(keys), hasPasskey }),
  });
  return { status: r.status, d: await r.json() };
}
const tokenRisk = (t) => JSON.parse(Buffer.from(String(t).split(".")[1], "base64url").toString("utf8")).risk;
const post = (path, sub, body = {}) => fetch(`${base}${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Continuum-Identity": assertion(sub) }, body: JSON.stringify(body),
});
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

// ---- evasions closed on 2026-11-08: a field kept short, typing at about one key a second

test("the text minimum counts the keys typed, not only what is left in the field (a chat box emptied at each send)", async () => {
  const { d } = await check(1012, { low: 10, textLength: 5 });   // 320 printable keys typed, 5 characters left in the field
  assert.equal(d.checked, true, d.message);
  assert.equal(d.isSuspicious, true);
  assert.equal(d.requiresPasskeyChallenge, true);
  await post("/v1/lock/clear", 1012);
  const short = await check(1012, { keys: 40, low: 0, textLength: 5 });   // too little typed either way
  assert.equal(short.d.checked, false);
});

test("typing at about one key a second, which never fills a packet, is unverifiable and asks for the passkey", async () => {
  const { d } = await check(1013, { keys: 520, low: 0, events: sparseTyping(520) });
  assert.ok(d.typingEvaluation.windowCount <= 20, `${d.typingEvaluation.windowCount} windows from 520 keys`);
  assert.equal(d.warmup, false, "not a warm-up that never ends");
  assert.equal(d.isSuspicious, true);
  assert.equal(d.requiresPasskeyChallenge, true);
  assert.equal(tokenRisk(d.riskToken), "suspicious");
  await post("/v1/lock/clear", 1013);
});

test("the same slow typing below twice the keys a packet needs is still warm-up", async () => {
  const { d } = await check(1014, { keys: 300, low: 0, events: sparseTyping(300) });
  assert.equal(d.warmup, true);
  assert.equal(d.requiresPasskeyChallenge, false);
});

// ---- fail closed (2026-11-08): no score, no verdict; a locked account gets "locked" from every check

test("the model service is unavailable: no verdict and no token, not a 'verified' check", async () => {
  model.fail = 503;
  try {
    const { status, d } = await check(1009, { low: 0 });
    assert.equal(status, 503);
    assert.equal(d.checked, false);
    assert.equal(d.error, "model_unavailable");
    assert.equal(d.riskToken, undefined, "no token is signed without a score");
  } finally { model.fail = 0; }
});

test("the model service answers an error (a lost model version): no verdict either", async () => {
  model.fail = 404;
  try {
    const { status, d } = await check(1009, { low: 0 });
    assert.equal(status, 503);
    assert.equal(d.checked, false);
    assert.equal(d.riskToken, undefined);
  } finally { model.fail = 0; }
});

test("a user with no typing profile gets no verdict and no token, but the windows are still reported", async () => {
  const { status, d } = await check(1008, { low: 0 });
  assert.equal(status, 200);
  assert.equal(d.checked, false);
  assert.equal(d.rhythmEnrollmentRequired, true);
  assert.equal(d.riskToken, undefined);
  assert.equal(d.typingEvaluation.windowCount, 27, "320 keys make 27 windows");
  assert.equal(d.packetWindows, 20);
  assert.equal(d.warmup, false, "the packet is full, though nothing is judged");
});

test("degenerate typing asks for the passkey and its token says suspicious", async () => {
  // 60 presses of two keys, 150 ms apart: low key diversity, which the model may well score as genuine
  const events = [];
  for (let i = 0, t = 0; i < 60; i++, t += 150) {
    const keyCode = i % 2 ? 74 : 75;
    events.push({ keyCode, eventType: "keydown", timestampRelative: t, fieldName: "f1", fieldType: "textarea" });
    events.push({ keyCode, eventType: "keyup", timestampRelative: t + 80, fieldName: "f1", fieldType: "textarea" });
  }
  const { d } = await check(1010, { keys: 90, low: 0, events });
  assert.equal(d.requiresPasskeyChallenge, true);
  assert.equal(d.isSuspicious, true);
  assert.equal(tokenRisk(d.riskToken), "suspicious");
  await post("/v1/lock/clear", 1010);
});

test("a locked account: typing and mouse checks answer 423 'locked', signed suspicious, until the lock is cleared", async () => {
  assert.equal((await post("/v1/lock/set", 1011)).status, 200);
  const ks = await check(1011, { low: 0 });
  assert.equal(ks.status, 423);
  assert.equal(ks.d.locked, true);
  assert.equal(ks.d.requiresPasskeyChallenge, true);
  assert.equal(tokenRisk(ks.d.riskToken), "suspicious");
  const m = await post("/v1/mouse/check", 1011, { windows: [] });
  assert.equal(m.status, 423);
  const md = await m.json();
  assert.equal(md.locked, true);
  assert.equal(tokenRisk(md.riskToken), "suspicious");
  assert.equal((await post("/v1/lock/clear", 1011)).status, 200);
  const after = await check(1011, { low: 0 });
  assert.equal(after.status, 200);
  assert.equal(after.d.isSuspicious, false);
  assert.equal(tokenRisk(after.d.riskToken), "genuine");
});

test("a locked account adds nothing to its profile: enrolment, samples and real-use samples answer 423 until the lock is cleared", async () => {
  const routes = ["/v1/keystroke/enroll", "/v1/keystroke/contribute", "/v1/mouse/enroll", "/v1/mouse/actions/enroll", "/v1/mouse/use-anchor", "/v1/mouse/use-sample"];
  assert.equal((await post("/v1/lock/set", 1012)).status, 200);
  for (const p of routes) {
    const r = await post(p, 1012, {});
    assert.equal(r.status, 423, p);
    const d = await r.json();
    assert.equal(d.error, "account_locked", p);
    assert.equal(d.requiresPasskeyChallenge, true, p);
  }
  assert.equal((await post("/v1/lock/clear", 1012)).status, 200);
  for (const p of routes) assert.notEqual((await post(p, 1012, {})).status, 423, p);
});
