// The adaptive popup's sample through the real server (server.js) with synthetic data only: a stub for the gateway's
// key set, a stub model service whose window scores each test sets, and a throwaway SQLite database.
// It pins the rule of 2026-10-19: a sample is the typing behind the last twenty windows of the stretch sent, all
// twenty are judged (mean at least 0.80, each of the last three at least 0.80) and only they are stored, so nothing is
// learned that was not judged; and a dry run asks the same question without storing anything. node --test
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ca-contribute-"));
const DB_PATH = path.join(DIR, "test.db");
process.env.DB_PATH = DB_PATH;
process.env.STORAGE = "sqlite";
const db = require("../db");
const Database = require("better-sqlite3");
const ks = require("../lib/keystrokeSecurity");

// ---- the gateway's key set and its assertions (RS256, as lib/identityAssertion.js verifies them)
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function assertion(sub, cfg) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u({ alg: "RS256", typ: "JWT", kid: "test-key" });
  const p = b64u({ iss: "gateway", aud: "ca-service", iat: now, exp: now + 300, tenant_id: "t-test", sub, ...(cfg ? { cfg } : {}) });
  return `${h}.${p}.${crypto.createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey).toString("base64url")}`;
}

// ---- the model service: the genuine probability of each window comes from `model.plan(n)`, the n windows asked for
const model = { plan: (n) => Array(n).fill(0.95), calls: 0 };
const stub = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/jwks.json") return res.end(JSON.stringify({ keys: [JWK] }));
  if (req.method === "POST" && req.url === "/api/user/predict") {
    let body = "";
    req.on("data", (c) => { body += c; }).on("end", () => {
      model.calls += 1;
      const n = JSON.parse(body).windows.length;
      res.end(JSON.stringify({ model_loaded: true, prediction: model.plan(n).map((p) => [1 - p, p]) }));
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

// ---- plain typing: letters, dwell 70-130 ms, 130-270 ms between presses. `keys` keystrokes make keys - 1 steps, so
// 241 keys give 20 windows, 235 give 19 and 320 give 27. The seed gives every sample its own timing.
function typing(keys, seed = 7) {
  let t = 0, s = seed;
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
const windowsOf = (events) => ks.eventsToFeatureWindows(events).length;

const USERS = Array.from({ length: 28 }, (_, i) => 2001 + i);
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

async function contribute(sub, { events, plan, dryRun = false, textLength, cfg }) {
  model.plan = plan || ((n) => Array(n).fill(0.95));
  const keydowns = events.filter((e) => e.eventType === "keydown").length;
  const r = await fetch(`${base}/v1/keystroke/contribute`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Continuum-Identity": assertion(sub, cfg) },
    body: JSON.stringify({ keystrokeEvents: events, textLength: textLength == null ? keydowns : textLength, ...(dryRun ? { dryRun: true } : {}) }),
  });
  return { status: r.status, d: await r.json() };
}
function rows(sql, ...args) {
  const ro = new Database(DB_PATH, { readonly: true });
  try { return ro.prepare(sql).all(...args); } finally { ro.close(); }
}
const samplesOf = (sub) => rows("SELECT id, char_count, sample_purpose FROM keystroke_texts WHERE user_id = ? ORDER BY id", sub);
const storedEvents = (id) => rows(
  `SELECT key_code AS keyCode, event_type AS eventType, timestamp_relative AS timestampRelative, field_name AS fieldName, field_type AS fieldType
     FROM keystroke_events WHERE keystroke_text_id = ? ORDER BY timestamp_relative ASC, id ASC`, id);

test("the server tells the SDK how long a sample is", async () => {
  const d = await (await fetch(`${base}/v1/keystroke/config`)).json();
  assert.equal(d.sampleWindowCount, 20);
  assert.equal(d.sampleFloorWindows, 3);
  assert.equal(d.rollingWindowCount, undefined, "the rolling mean over 18 windows is gone");
  assert.equal(d.contributeWindowCount, undefined);
});

test("a stretch of 27 windows is accepted on its last 20, and only those 20 are stored", async () => {
  const events = typing(320, 11);
  assert.equal(windowsOf(events), 27);
  const { status, d } = await contribute(2001, { events });
  assert.equal(status, 200, JSON.stringify(d));
  assert.equal(d.ok, true);
  assert.equal(d.pending, 1);
  const [sample] = samplesOf(2001);
  assert.equal(sample.sample_purpose, "adaptive-pending");
  const stored = storedEvents(sample.id);
  assert.equal(windowsOf(stored), 20, "the stored sample is exactly twenty windows");
  assert.ok(stored.length < events.length, "the seven earlier windows were never judged and are not kept");
  // the stored sample gives the same twenty windows, row for row, as the last twenty of the stretch sent
  assert.deepEqual(ks.eventsToFeatureWindows(stored), ks.eventsToFeatureWindows(events).slice(-20));
  assert.equal(sample.char_count, ks.printableKeyCount(stored));
});

test("the model is asked about the twenty windows of the sample, not about the whole stretch", async () => {
  let asked = 0;
  await contribute(2002, { events: typing(400, 12), plan: (n) => { asked = n; return Array(n).fill(0.95); } });
  assert.equal(asked, 20);
});

test("a stretch of 19 windows is not a sample yet, and 20 is", async () => {
  const short = typing(235, 13);
  assert.equal(windowsOf(short), 19);
  const refused = await contribute(2003, { events: short });
  assert.equal(refused.status, 422);
  assert.match(refused.d.error, /need 20 clean windows, have 19/);
  assert.equal(refused.d.windows, 19);
  assert.equal(samplesOf(2003).length, 0);
  const enough = typing(241, 14);
  assert.equal(windowsOf(enough), 20);
  const accepted = await contribute(2003, { events: enough });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.d));
  assert.equal(windowsOf(storedEvents(samplesOf(2003)[0].id)), 20);
});

test("a mean below 0.80 over the twenty windows is refused", async () => {
  const { status, d } = await contribute(2004, { events: typing(260, 15), plan: (n) => Array(n).fill(0.7) });
  assert.equal(status, 422);
  assert.match(d.error, /not clean enough.*70% < 80%/);
  assert.equal(samplesOf(2004).length, 0);
});

test("one weak window among the last three refuses the sample though the mean is high", async () => {
  const plan = (n) => Array.from({ length: n }, (_, i) => (i === n - 3 ? 0.5 : 0.97));
  const { status, d } = await contribute(2005, { events: typing(260, 16), plan });
  assert.equal(status, 422);
  assert.match(d.error, /One of the last 3 windows scored 50%/);
  assert.ok(d.sampleMean > 0.9, "the mean alone would have passed");
  assert.equal(samplesOf(2005).length, 0);
});

test("the guard covers exactly the newest three windows: a weak one at the fourth from the end is tolerated", async () => {
  const at = (k) => (n) => Array.from({ length: n }, (_, i) => (i === n - k ? 0.4 : 0.95));
  const third = await contribute(2021, { events: typing(260, 51), plan: at(3) });
  assert.equal(third.status, 422, "third from the end: refused");
  const fourth = await contribute(2021, { events: typing(260, 51), plan: at(4) });
  assert.equal(fourth.status, 200, JSON.stringify(fourth.d));
});

test("a weak window earlier in the sample is tolerated while the mean holds, as the rule has always allowed", async () => {
  const plan = (n) => Array.from({ length: n }, (_, i) => (i === 3 ? 0.4 : 0.95));
  const { status, d } = await contribute(2006, { events: typing(260, 17), plan });
  assert.equal(status, 200, JSON.stringify(d));
  assert.equal(samplesOf(2006).length, 1);
});

test("weak windows before the last twenty are outside the sample and never reach the model or the store", async () => {
  // 27 windows, the model is only asked about the last 20, whatever the first seven would have scored
  const { status } = await contribute(2007, { events: typing(320, 18), plan: (n) => Array(n).fill(0.95) });
  assert.equal(status, 200);
  assert.equal(windowsOf(storedEvents(samplesOf(2007)[0].id)), 20);
});

test("a dry run answers the same question and stores nothing", async () => {
  const events = typing(320, 19);
  const before = model.calls;
  const yes = await contribute(2008, { events, dryRun: true });
  assert.equal(yes.status, 200);
  assert.deepEqual({ ok: yes.d.ok, dryRun: yes.d.dryRun, eligible: yes.d.eligible, windows: yes.d.windows }, { ok: true, dryRun: true, eligible: true, windows: 27 });
  assert.equal(model.calls, before + 1);
  assert.equal(samplesOf(2008).length, 0, "nothing was stored");
  // the same stretch, asked for real, is accepted: the dry run did not lie
  const real = await contribute(2008, { events });
  assert.equal(real.status, 200, JSON.stringify(real.d));
});

test("a dry run that would be refused is answered 200 with the reason, so asking at every window is quiet", async () => {
  const short = await contribute(2009, { events: typing(235, 20), dryRun: true });
  assert.equal(short.status, 200);
  assert.equal(short.d.eligible, false);
  assert.match(short.d.error, /need 20 clean windows/);
  const weak = await contribute(2009, { events: typing(300, 21), plan: (n) => Array.from({ length: n }, (_, i) => (i === n - 1 ? 0.3 : 0.97)), dryRun: true });
  assert.equal(weak.status, 200);
  assert.equal(weak.d.eligible, false);
  assert.match(weak.d.error, /below the 80% floor/);
  assert.equal(samplesOf(2009).length, 0);
});

test("a pasted stretch cannot train the model", async () => {
  const events = typing(300, 22).concat([{ keyCode: 86, eventType: "paste", timestampRelative: 5, fieldName: "f1", fieldType: "textarea", pastedLength: 40 }]);
  const { status, d } = await contribute(2010, { events });
  assert.equal(status, 422);
  assert.match(d.error, /Pasted text cannot train your model/);
});

test("typing that repeats the previous sample is refused, and three samples make the cycle ready to retrain", async () => {
  const first = typing(250, 23);
  assert.equal((await contribute(2011, { events: first })).status, 200);
  const again = await contribute(2011, { events: first });
  assert.equal(again.status, 422);
  assert.equal(again.d.error, "sample_overlaps");
  assert.equal((await contribute(2011, { events: typing(250, 24) })).status, 200);
  const third = await contribute(2011, { events: typing(250, 25) });
  assert.equal(third.status, 200, JSON.stringify(third.d));
  assert.equal(third.d.pending, 3);
  assert.equal(third.d.ready, true);
  const fourth = await contribute(2011, { events: typing(250, 26) });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.d.error, "ready_to_retrain");
  const dry = await contribute(2011, { events: typing(250, 27), dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.d.eligible, false);
  assert.equal(dry.d.error, "ready_to_retrain");
});

// ---- the organisation's choices (console settings, signed into the identity assertion as `cfg`)
const statusOf = async (sub, cfg) => (await fetch(`${base}/v1/keystroke/status/${sub}`, { headers: { "X-Continuum-Identity": assertion(sub, cfg) } })).json();

test("one sample is enough for a retrain when the organisation says so, and two when it says two", async () => {
  const one = await contribute(2012, { events: typing(250, 31), cfg: { re: 1 } });
  assert.equal(one.status, 200, JSON.stringify(one.d));
  assert.equal(one.d.retrainEvery, 1);
  assert.equal(one.d.ready, true);
  assert.equal((await statusOf(2012, { re: 1 })).adaptiveReady, true);
  assert.equal((await contribute(2012, { events: typing(250, 32), cfg: { re: 1 } })).d.error, "ready_to_retrain");
  const two1 = await contribute(2013, { events: typing(250, 33), cfg: { re: 2 } });
  assert.equal(two1.d.ready, false);
  assert.match(two1.d.message, /1 of 2/);
  const two2 = await contribute(2013, { events: typing(250, 34), cfg: { re: 2 } });
  assert.equal(two2.d.ready, true);
});

test("the pending samples count against whatever the organisation sets now", async () => {
  await contribute(2014, { events: typing(250, 35), cfg: { re: 3 } });
  assert.equal((await statusOf(2014, { re: 3 })).adaptiveReady, false);
  assert.equal((await statusOf(2014, { re: 1 })).adaptiveReady, true, "lowered to 1: the one pending sample is enough");
  assert.equal((await statusOf(2014, { re: 2 })).adaptiveRetrainEvery, 2);
});

// 40 windows (441 keys): the model scores the first 20 well and the last 20 badly, however it is asked
const firstGoodLastBad = (n) => (n === 40 ? Array.from({ length: 40 }, (_, i) => (i < 20 ? 0.95 : 0.3)) : Array(n).fill(n === 20 ? 0.3 : 0.95));
// ...and once the first 20 have been cut out of it, they are scored well
const firstGoodLastBadCut = (n) => (n === 40 ? firstGoodLastBad(n) : Array(n).fill(0.95));

test("from the end, a stretch whose last 20 windows are bad gives no sample, though its first 20 were good", async () => {
  const events = typing(441, 41);
  assert.equal(windowsOf(events), 40);
  const { status, d } = await contribute(2015, { events, plan: firstGoodLastBad });
  assert.equal(status, 422);
  assert.match(d.error, /not clean enough/);
  assert.equal(samplesOf(2015).length, 0);
});

test("from anywhere, the same stretch gives its first 20 windows, and the bad rest is ignored", async () => {
  const events = typing(441, 41);
  const { status, d } = await contribute(2016, { events, plan: firstGoodLastBadCut, cfg: { sf: "any" } });
  assert.equal(status, 200, JSON.stringify(d));
  const stored = storedEvents(samplesOf(2016)[0].id);
  assert.equal(windowsOf(stored), 20);
  assert.deepEqual(ks.eventsToFeatureWindows(stored), ks.eventsToFeatureWindows(events).slice(0, 20), "the first twenty windows, row for row");
  assert.ok(stored.length < events.length * 0.6, "the second half was not kept");
});

test("from anywhere it is the NEWEST run that qualifies that is taken, not the best one", async () => {
  const events = typing(491, 42);
  assert.equal(windowsOf(events), 45);
  // windows 0-19 score 0.99, 20-24 are bad, 25-44 score 0.85
  const plan = (n) => (n === 45 ? Array.from({ length: 45 }, (_, i) => (i < 20 ? 0.99 : i < 25 ? 0.3 : 0.85)) : Array(n).fill(0.85));
  const { status, d } = await contribute(2017, { events, plan, cfg: { sf: "any" } });
  assert.equal(status, 200, JSON.stringify(d));
  const stored = storedEvents(samplesOf(2017)[0].id);
  assert.deepEqual(ks.eventsToFeatureWindows(stored), ks.eventsToFeatureWindows(events).slice(25, 45));
});

test("from anywhere, a stretch whose end already qualifies is taken from its end, as by default", async () => {
  const events = typing(441, 43);
  const { status } = await contribute(2018, { events, cfg: { sf: "any" } });
  assert.equal(status, 200);
  assert.deepEqual(ks.eventsToFeatureWindows(storedEvents(samplesOf(2018)[0].id)), ks.eventsToFeatureWindows(events).slice(-20));
});

test("from anywhere, when no run of 20 qualifies the refusal is the usual one, with the numbers of the last 20", async () => {
  const { status, d } = await contribute(2019, { events: typing(441, 44), plan: (n) => Array(n).fill(0.6), cfg: { sf: "any" } });
  assert.equal(status, 422);
  assert.match(d.error, /not clean enough.*60% < 80%/);
  assert.equal(samplesOf(2019).length, 0);
});

test("from anywhere, a dry run finds the same run and stores nothing", async () => {
  const events = typing(441, 41);
  const dry = await contribute(2020, { events, plan: firstGoodLastBadCut, cfg: { sf: "any" }, dryRun: true });
  assert.equal(dry.status, 200);
  assert.deepEqual({ eligible: dry.d.eligible, sampleFrom: dry.d.sampleFrom, windows: dry.d.windows }, { eligible: true, sampleFrom: "any", windows: 40 });
  assert.equal(samplesOf(2020).length, 0);
  const byDefault = await contribute(2020, { events, plan: firstGoodLastBad, dryRun: true });
  assert.equal(byDefault.d.eligible, false, "from the end the same stretch is not eligible");
});

// ---- the paste rule at /v1/keystroke/check: the organisation's pastes per field (claim `pa`), judged at every
// paste even when nothing was typed (the clients send a check at each paste since 2026-10-25)
async function check(sub, { events, textLength = 0, cfg }) {
  const r = await fetch(`${base}/v1/keystroke/check`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Continuum-Identity": assertion(sub, cfg) },
    body: JSON.stringify({ keystrokeEvents: events, textLength, hasPasskey: true }),
  });
  return { status: r.status, d: await r.json() };
}
const pasteInto = (field, t = 1) => ({ keyCode: 0, eventType: "paste", timestampRelative: t, fieldName: field, fieldType: "textarea", pastedLength: 5 });

test("paste rule: with no pastes allowed, the first paste asks for the passkey though nothing was typed", async () => {
  const { status, d } = await check(2025, { events: [pasteInto("f1")], cfg: { pa: "0" } });
  assert.equal(status, 200, JSON.stringify(d));
  assert.equal(d.checked, true);
  assert.equal(d.warmup, false);
  assert.equal(d.requiresPasskeyChallenge, true);
  assert.equal(d.typingEvaluation.modelType, "paste-policy");
  assert.match(d.message, /More pastes into one field than allowed/);
});

test("paste rule: one paste allowed per field passes into two fields, and a second into one field asks", async () => {
  const two = await check(2026, { events: [pasteInto("f1"), pasteInto("f2", 2)], cfg: { pa: "1" } });
  assert.equal(two.d.checked, false, "within the allowance a paste alone gives no verdict");
  const again = await check(2027, { events: [pasteInto("f1"), pasteInto("f1", 2)], cfg: { pa: "1" } });
  assert.equal(again.d.requiresPasskeyChallenge, true);
});

test("paste rule: unlimited, the default, never asks for a paste", async () => {
  const { d } = await check(2028, { events: Array.from({ length: 10 }, (_, i) => pasteInto("f1", i + 1)) });
  assert.equal(d.checked, false);
  assert.notEqual(d.requiresPasskeyChallenge, true);
});
