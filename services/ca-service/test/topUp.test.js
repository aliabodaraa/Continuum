// More samples for a trained profile (2026-11-25), through the real server (server.js) with synthetic data only: a stub
// for the gateway's key set, a stub model service that "trains" a mouse profile, and a throwaway SQLite database.
// The first enrolment stays in one session, and a profile from one sitting holds one pace; the user may add samples
// later, after the passkey. The gateway checks the passkey and passes `topUp`; this service only takes its word.
//   - without that word a trained profile takes no sample (as since 5 and 24 Oct)
//   - the mouse: four samples wait outside the profile, the fourth moves them in and rebuilds the model from the newest
//     eight, half new and half earlier
//   - typing: three samples wait as pending ones, the third makes them training samples and queues the rebuild
//   - a top-up is one sitting: a sample that has waited longer than it is dropped and never reaches a model
//   - a top-up sample passes the same checks as an enrolment sample
// node --test
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ca-top-up-"));
const DB_PATH = path.join(DIR, "server.db");
process.env.DB_PATH = DB_PATH;
process.env.STORAGE = "sqlite";
const db = require("../db");
const mouse = require("../lib/mouse");
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

// ---- the model service: a mouse training returns a profile at once and records the windows it was given
const trained = [];
const stub = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/jwks.json") return res.end(JSON.stringify({ keys: [JWK] }));
  if (req.method === "POST" && req.url === "/api/user/train") {
    let body = "";
    req.on("data", (c) => { body += c; }).on("end", () => {
      const b = JSON.parse(body);
      trained.push({ userId: b.userId, modality: b.modality, positiveWindows: b.positiveWindows });
      const pct = { 1: 0.01, 2: 0.02, 5: 0.05, 10: 0.1, 15: 0.15, 20: 0.3, 30: 0.4, 40: 0.5, 50: 0.6 };
      res.end(JSON.stringify({ ok: true, modelPath: `/models/user-${b.userId}/mouse_model`, balancedAccuracy: 0.9,
        losoScorePercentiles: pct, enrolScorePercentiles: pct, losoScores: b.positiveWindows.map(() => 0.5), modelSha256: "stub" }));
    });
    return;
  }
  // a trained typing model scores the sample's windows (the enrolment route stores those metrics with the sample)
  if (req.method === "POST" && req.url === "/api/user/predict") {
    let body = "";
    req.on("data", (c) => { body += c; }).on("end", () => {
      res.end(JSON.stringify({ model_loaded: true, prediction: JSON.parse(body).windows.map(() => [0.05, 0.95]) }));
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

// ---- synthetic movement, as test/mouseSamples.test.js: a sample is 55 windows of 50 steps at stride 10
function stream(n, seed) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const h = crypto.createHash("sha256").update(`${seed}:${i}`).digest();
    const mag = 2 + (h[0] % 40), a = (h[1] / 255) * (Math.PI / 2);
    out.push([Math.round(mag * Math.cos(a)), Math.round(mag * Math.sin(a))]);
  }
  return out;
}
const windowsOf = (steps) => { const w = []; for (let s = 0; s + 50 <= steps.length; s += 10) w.push(steps.slice(s, s + 50)); return w; };
const sample = (seed) => windowsOf(stream(590, seed));
// ---- plain typing, as test/contribute.test.js, with the text it would have made (letters only)
function typed(keys, seed) {
  let t = 0, s = seed, text = "";
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const events = [];
  for (let i = 0; i < keys; i++) {
    const keyCode = 65 + Math.floor(rnd() * 26), dwell = 70 + rnd() * 60;
    events.push({ keyCode, eventType: "keydown", timestampRelative: Math.round(t), fieldName: "f1", fieldType: "textarea" });
    events.push({ keyCode, eventType: "keyup", timestampRelative: Math.round(t + dwell), fieldName: "f1", fieldType: "textarea" });
    text += String.fromCharCode(keyCode + 32);
    t += dwell + 60 + rnd() * 140;
  }
  return { textContent: text, keystrokeEvents: events };
}

let server, base, log = "";
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPIST = 4101, SLOW_TYPIST = 4102;
const ago = (min) => new Date(Date.now() - min * 60000).toISOString().slice(0, 19).replace("T", " ");   // the time as the database writes it

test.before(async () => {
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  await db.open();
  // typing models trained an hour ago
  for (const id of [TYPIST, SLOW_TYPIST]) {
    await db.run("INSERT INTO user_typing_profiles (user_id, model_json, sample_count, trained_at) VALUES (?, ?, ?, ?)", id,
      JSON.stringify({ type: "per-user-cnn-lstm", version: 3, modelPath: `/models/user-${id}/final_model`, threshold: 0.5 }), 5, ago(60));
  }
  await db.close();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), STORAGE: "sqlite", DB_PATH, NODE_ENV: "test", LOG_FORMAT: "", TRAINING_POLL_MS: "200",
      GATEWAY_JWKS_URI: `${stubUrl}/jwks.json`, MODEL_INFER_URL: stubUrl, MODEL_API_URL: stubUrl },
  });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`the server did not start:\n${log}`);
});

test.after(async () => {
  if (server) { server.kill(); await new Promise((r) => server.once("exit", r)); }
  await new Promise((r) => stub.close(r));
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* a lock on Windows: the system cleans the temp folder */ }
});

const call = async (method, p, sub, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json", "X-Continuum-Identity": assertion(sub) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json() };
};
function rows(sql, ...args) {
  const ro = new Database(DB_PATH, { readonly: true });
  try { return ro.prepare(sql).all(...args); } finally { ro.close(); }
}
function write(sql, ...args) {
  const w = new Database(DB_PATH);
  try { return w.prepare(sql).run(...args); } finally { w.close(); }
}
const count = (table, sub) => rows(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, sub)[0].n;
const mouseStatus = async (sub) => (await call("GET", `/v1/mouse/status/${sub}`, sub)).d;
async function enrolled(sub) {
  for (let i = 0; i < 8; i++) assert.equal((await call("POST", "/v1/mouse/enroll", sub, { windows: sample(`${sub} enrol ${i}`) })).status, 202);
  let st = {};
  for (let i = 0; i < 100 && !(st.enrolled && !st.training); i++) { await sleep(100); st = await mouseStatus(sub); }
  assert.equal(st.enrolled, true, `the profile was not built:\n${log.slice(-2000)}`);
  return st;
}
const trainingsOf = (sub) => trained.filter((x) => String(x.userId) === String(sub));
const topUp = (sub, seed) => call("POST", "/v1/mouse/enroll", sub, { windows: sample(seed), topUp: true });

test("the mouse: four samples with the caller's word wait, and the fourth rebuilds the model from the newest eight", async () => {
  const sub = 4001;
  const st = await enrolled(sub);
  assert.equal(st.topUpSamples, mouse.TOPUP_SAMPLES);
  assert.equal(st.topUpSamples, 4);
  assert.equal(st.topUpAdded, 0);
  assert.equal(trainingsOf(sub).length, 1);

  const plain = await call("POST", "/v1/mouse/enroll", sub, { windows: sample(`${sub} plain`) });
  assert.equal(plain.status, 409, JSON.stringify(plain.d));
  assert.equal(plain.d.error, "already_enrolled");
  const notTheWord = await call("POST", "/v1/mouse/enroll", sub, { windows: sample(`${sub} plain`), topUp: "true" });
  assert.equal(notTheWord.status, 409, "only the boolean the gateway sets counts");

  for (let i = 0; i < 3; i++) {
    const r = await topUp(sub, `${sub} top ${i}`);
    assert.equal(r.status, 202, JSON.stringify(r.d));
    assert.deepEqual(r.d.topUp, { added: i + 1, needed: 4 });
    assert.ok(!r.d.training, "the model is not rebuilt before the last sample");
  }
  await sleep(600);
  assert.equal(trainingsOf(sub).length, 1, "three samples changed nothing yet");
  assert.equal((await mouseStatus(sub)).topUpAdded, 3);
  assert.equal(count("mouse_samples", sub), 8, "they wait outside the profile's samples");
  assert.equal(count("mouse_topup_samples", sub), 3);

  const last = await topUp(sub, `${sub} top 3`);
  assert.equal(last.status, 202, JSON.stringify(last.d));
  assert.deepEqual(last.d.topUp, { added: 4, needed: 4 });
  assert.equal(last.d.training, true);
  for (let i = 0; i < 100 && trainingsOf(sub).length < 2; i++) await sleep(100);
  assert.equal(trainingsOf(sub).length, 2, `the model was not rebuilt:\n${log.slice(-2000)}`);
  // the newest eight samples in time order: the last four of the enrolment, then the four of the top-up
  const used = trainingsOf(sub)[1].positiveWindows;
  assert.equal(used.length, 440);
  const want = [4, 5, 6, 7].map((i) => `${sub} enrol ${i}`).concat([0, 1, 2, 3].map((i) => `${sub} top ${i}`));
  want.forEach((seed, k) => assert.deepEqual(used[k * 55], sample(seed)[0], `sample ${k} of the rebuilt model is "${seed}"`));
  let after = {};
  for (let i = 0; i < 50 && !(after.enrolled && !after.training); i++) { await sleep(100); after = await mouseStatus(sub); }
  assert.equal(after.enrolled, true);
  assert.equal(after.topUpAdded, 0);
  assert.equal(count("mouse_samples", sub), 12, "the four joined the eight, nothing was deleted");
  assert.equal(count("mouse_topup_samples", sub), 0);
  assert.equal(rows("SELECT reason FROM training_jobs WHERE user_id = ? AND modality = 'mouse' ORDER BY id DESC LIMIT 1", sub)[0].reason, "top-up");
});

test("the mouse: a top-up sample passes the checks of an enrolment sample", async () => {
  const sub = 4002;
  await enrolled(sub);
  const copy = await topUp(sub, `${sub} enrol 3`);   // movement already in the profile
  assert.equal(copy.status, 422, JSON.stringify(copy.d));
  assert.match(copy.d.error, /already in one of your samples/);
  assert.equal((await topUp(sub, `${sub} top 0`)).status, 202);
  const twice = await topUp(sub, `${sub} top 0`);    // movement already in this top-up
  assert.equal(twice.status, 422, JSON.stringify(twice.d));
  const short = await call("POST", "/v1/mouse/enroll", sub, { windows: sample(`${sub} short`).slice(0, 10), topUp: true });
  assert.equal(short.status, 422, JSON.stringify(short.d));
  assert.equal((await mouseStatus(sub)).topUpAdded, 1, "a refused sample is not counted");
});

test("the mouse: a top-up is one sitting, a sample that waited longer is dropped and a reset drops the rest", async () => {
  const sub = 4004;
  await enrolled(sub);
  assert.equal((await topUp(sub, `${sub} top 0`)).d.topUp.added, 1);
  write("UPDATE mouse_topup_samples SET created_at = ? WHERE user_id = ?", ago(20), sub);
  assert.equal((await mouseStatus(sub)).topUpAdded, 0, "the unfinished top-up of 20 minutes ago is gone");
  for (let i = 1; i <= 3; i++) {
    const r = await topUp(sub, `${sub} top ${i}`);
    assert.deepEqual(r.d.topUp, { added: i, needed: 4 }, "the count starts again");
    assert.ok(!r.d.training);
  }
  assert.equal(trainingsOf(sub).length, 1, "the model was not rebuilt from three samples and a dropped one");
  assert.equal(count("mouse_samples", sub), 8);
  assert.equal((await call("POST", "/v1/mouse/reset", sub, {})).status, 200);
  assert.equal(count("mouse_topup_samples", sub), 0, "a reset drops the top-up in progress");
});

test("the mouse: before the first model the word changes nothing, enrolment goes as ever", async () => {
  const sub = 4003;
  const r = await topUp(sub, `${sub} first`);
  assert.equal(r.status, 202, JSON.stringify(r.d));
  assert.equal(r.d.samplesOnFile, 1);
  assert.equal(r.d.topUp, undefined);
  assert.equal(count("mouse_topup_samples", sub), 0);
});

const typingRows = (sub) => rows("SELECT sample_purpose, is_training FROM keystroke_texts WHERE user_id = ? ORDER BY id", sub);

test("typing: without the word a trained model takes no sample; with it three wait and the third queues the rebuild", async () => {
  const plain = await call("POST", "/v1/keystroke/enroll", TYPIST, typed(200, 11));
  assert.equal(plain.status, 409, JSON.stringify(plain.d));
  assert.equal(plain.d.error, "already_enrolled");
  const st = (await call("GET", `/v1/keystroke/status/${TYPIST}`, TYPIST)).d;
  assert.equal(st.trained, true);
  assert.equal(st.topUpSamples, 3);
  assert.equal(st.topUpAdded, 0);

  for (let i = 0; i < 3; i++) {
    const r = await call("POST", "/v1/keystroke/enroll", TYPIST, { ...typed(200, 21 + i), topUp: true });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    assert.deepEqual(r.d.topUp, { added: i + 1, needed: 3 });
    assert.equal(r.d.training, i === 2, "the rebuild is queued by the third sample only");
    if (i < 2) assert.deepEqual(typingRows(TYPIST), Array(i + 1).fill({ sample_purpose: "top-up-pending", is_training: 0 }), "until then they wait and train nothing");
  }
  assert.deepEqual(typingRows(TYPIST), Array(3).fill({ sample_purpose: "top-up", is_training: 1 }), "the third made all three training samples");
  const jobs = rows("SELECT reason FROM training_jobs WHERE user_id = ? AND modality = 'keystroke' ORDER BY id", TYPIST);
  assert.deepEqual(jobs.map((j) => j.reason), ["top-up"]);
});

test("typing: a top-up sample passes the checks of an enrolment sample", async () => {
  const short = await call("POST", "/v1/keystroke/enroll", TYPIST, { textContent: "too short", keystrokeEvents: typed(9, 5).keystrokeEvents, topUp: true });
  assert.equal(short.status, 400, JSON.stringify(short.d));
  const pasted = typed(200, 31);
  const noKeys = await call("POST", "/v1/keystroke/enroll", TYPIST, { textContent: pasted.textContent, keystrokeEvents: pasted.keystrokeEvents.slice(0, 20), topUp: true });
  assert.equal(noKeys.status, 400, JSON.stringify(noKeys.d));
});

test("typing: a top-up is one sitting, a sample that waited longer is dropped with its key events", async () => {
  const first = await call("POST", "/v1/keystroke/enroll", SLOW_TYPIST, { ...typed(200, 41), topUp: true });
  assert.deepEqual(first.d.topUp, { added: 1, needed: 3 }, JSON.stringify(first.d));
  write("UPDATE keystroke_texts SET submitted_at = ? WHERE user_id = ?", ago(20), SLOW_TYPIST);
  assert.equal((await call("GET", `/v1/keystroke/status/${SLOW_TYPIST}`, SLOW_TYPIST)).d.topUpAdded, 0, "the unfinished top-up of 20 minutes ago is gone");
  assert.equal(count("keystroke_texts", SLOW_TYPIST), 0);
  assert.equal(rows("SELECT COUNT(*) AS n FROM keystroke_events").length && rows("SELECT COUNT(*) AS n FROM keystroke_events e WHERE NOT EXISTS (SELECT 1 FROM keystroke_texts t WHERE t.id = e.keystroke_text_id)")[0].n, 0, "no key event is left without its sample");
  for (let i = 0; i < 2; i++) {
    const r = await call("POST", "/v1/keystroke/enroll", SLOW_TYPIST, { ...typed(200, 51 + i), topUp: true });
    assert.deepEqual(r.d.topUp, { added: i + 1, needed: 3 }, "the count starts again");
    assert.equal(r.d.training, false);
  }
  assert.equal(count("training_jobs", SLOW_TYPIST), 0, "no rebuild from two samples and a dropped one");
  assert.equal((await call("POST", "/v1/keystroke/reset", SLOW_TYPIST, {})).status, 200);
  assert.equal(count("keystroke_texts", SLOW_TYPIST), 0, "a reset drops the top-up in progress");
});
