// Learning from real use, stage 1 (lib/mouseUse.js), through the real server (server.js) with synthetic movement only:
// a stub for the gateway's key set, a stub model service, and a throwaway SQLite database. It pins the rules: a
// real-use sample is stored only after a passkey the gateway reported (one per passkey, within the time limit, at most one
// every few hours), it passes the enrolment's checks, it is kept with its anchor, the profile in force and that profile's
// scores, and it trains nothing; the windows of every check are kept only for the users the operator lists; a reset
// removes all of it; and since stage 2 (25 Oct 2026) all of it is off unless MOUSE_USE_SAMPLES=on. node --test
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ca-mouse-use-"));
const DB_PATH = path.join(DIR, "server.db");
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

// ---- the model service: training returns a profile at once and records what it was given; every window scores 0.6
const trained = [];
const stub = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/jwks.json") return res.end(JSON.stringify({ keys: [JWK] }));
  let body = "";
  req.on("data", (c) => { body += c; }).on("end", () => {
    const b = body ? JSON.parse(body) : {};
    if (req.url === "/api/user/train") {
      trained.push({ userId: b.userId, positiveWindows: b.positiveWindows });
      const pct = { 1: 0.01, 2: 0.02, 5: 0.05, 10: 0.1, 15: 0.15, 20: 0.3, 30: 0.4, 40: 0.5, 50: 0.6 };
      return res.end(JSON.stringify({ ok: true, modelPath: `/models/user-${b.userId}/mouse_model`, balancedAccuracy: 0.9,
        losoScorePercentiles: pct, enrolScorePercentiles: pct, losoScores: b.positiveWindows.map(() => 0.5), modelSha256: "stub" }));
    }
    if (req.url === "/api/user/predict") return res.end(JSON.stringify({ model_loaded: true, prediction: b.windows.map(() => [0.4, 0.6]) }));
    res.statusCode = 404;
    res.end("{}");
  });
});

// ---- synthetic movement, independent for every seed (as in mouseSamples.test.js)
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
const sample = (seed, windows = 55) => windowsOf(stream(40 + 10 * windows, seed));

let server, base, log = "";
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test.before(async () => {
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  await db.open();
  await db.close();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), STORAGE: "sqlite", DB_PATH, NODE_ENV: "test", LOG_FORMAT: "", TRAINING_POLL_MS: "200",
      MOUSE_USE_SAMPLES: "on", MOUSE_LIVE_CAPTURE_USERS: "5001, 5009", GATEWAY_JWKS_URI: `${stubUrl}/jwks.json`, MODEL_INFER_URL: stubUrl,
      MODEL_API_URL: stubUrl },
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

const call = async (method, p, sub, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { "Content-Type": "application/json", "X-Continuum-Identity": assertion(sub) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json() };
};
const anchor = (sub, reason = "mouse") => call("POST", "/v1/mouse/use-anchor", sub, { reason });
const useSample = (sub, windows, client) => call("POST", "/v1/mouse/use-sample", sub, { windows, ...(client ? { client } : {}) });
const status = (sub) => call("GET", `/v1/mouse/status/${sub}`, sub);
function rows(sql, ...args) {
  const ro = new Database(DB_PATH, { readonly: true });
  try { return ro.prepare(sql).all(...args); } finally { ro.close(); }
}
function write(sql, ...args) {
  const rw = new Database(DB_PATH);
  try { return rw.prepare(sql).run(...args); } finally { rw.close(); }
}
async function enrolled(sub) {
  for (let i = 0; i < 8; i++) assert.equal((await call("POST", "/v1/mouse/enroll", sub, { windows: sample(`${sub} enrol ${i}`) })).status, 202);
  for (let i = 0; i < 100; i++) {
    if ((await status(sub)).d.enrolled) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`user ${sub}: the profile was not built\n${log.slice(-2000)}`);
}

test("a passkey of a user with no mouse profile is recorded, and no sample is offered", async () => {
  const r = await anchor(5000);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual(r.d, { offer: false, why: "not_enrolled" });
  const [a] = rows("SELECT offered, not_offered, reason, expires_at FROM mouse_use_anchors WHERE user_id = 5000");
  assert.deepEqual(a, { offered: 0, not_offered: "not_enrolled", reason: "mouse", expires_at: null });
});

test("after a passkey, fresh movement is stored with its anchor, the profile in force and its scores, and trains nothing", async () => {
  await enrolled(5001);
  const firstTraining = trained.filter((t) => t.userId === 5001).pop().positiveWindows;
  const a = await anchor(5001, "keystroke");
  assert.equal(a.status, 200);
  assert.deepEqual(a.d, { offer: true, expiresInMs: 180000, sampleWindows: 55 });
  const sent = sample("5001 browsing", 60);
  const r = await useSample(5001, sent, "extension");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.stored, true);
  const [s] = rows("SELECT * FROM mouse_use_samples WHERE user_id = 5001");
  const [an] = rows("SELECT * FROM mouse_use_anchors WHERE user_id = 5001");
  assert.equal(s.source, "use-after-passkey");
  assert.equal(s.client, "extension");
  assert.equal(s.anchor_id, an.id);
  assert.equal(s.anchor_at, an.verified_at);
  assert.equal(an.reason, "keystroke");
  assert.equal(an.sample_id, s.id);
  assert.ok(an.used_at, "the anchor is used");
  assert.equal(s.window_count, 55);
  assert.deepEqual(JSON.parse(s.windows), sent.slice(0, 55), "the first 55 windows, the movement nearest the passkey");
  assert.equal(JSON.parse(s.scores).length, 55);
  assert.equal(s.low_windows, 0);
  assert.equal(s.threshold, 0.3);
  assert.ok(s.decision_version && s.profile_trained_at);

  // a rebuild of the profile still learns from the enrolment alone
  const before = trained.length;
  write("UPDATE mouse_profiles SET decision_version = NULL WHERE user_id = 5001");
  await status(5001);   // queues the rebuild
  for (let i = 0; i < 100 && trained.length === before; i++) await new Promise((res) => setTimeout(res, 100));
  for (let i = 0; i < 100 && !(await status(5001)).d.enrolled; i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal(trained.length, before + 1, "one rebuild");
  assert.deepEqual(trained[trained.length - 1].positiveWindows, firstTraining, "the same 440 enrolment windows as before");
});

test("one sample per passkey, and the pause after a sample", async () => {
  const again = await useSample(5001, sample("5001 more browsing"));
  assert.equal(again.status, 403, JSON.stringify(again.d));
  assert.equal(again.d.error, "no_anchor");
  const next = await anchor(5001);
  assert.equal(next.d.offer, false);
  assert.equal(next.d.why, "paused");
  const hours = (Date.parse(next.d.nextAt) - Date.now()) / 3600000;
  assert.ok(hours > 2.9 && hours <= 3, `next sample in ${hours} h`);
  // even an offered anchor (as from a second copy of the service) gives no sample inside the pause
  write("UPDATE mouse_use_anchors SET offered = 1, expires_at = ? WHERE id = (SELECT MAX(id) FROM mouse_use_anchors WHERE user_id = 5001)",
    new Date(Date.now() + 60000).toISOString().slice(0, 19).replace("T", " "));
  const paused = await useSample(5001, sample("5001 later browsing"));
  assert.equal(paused.status, 409, JSON.stringify(paused.d));
  assert.equal(paused.d.error, "paused");
  const st = (await status(5001)).d;
  assert.equal(st.useSamples, 1);
  assert.ok(st.lastUseSampleAt && st.nextUseSampleAt);
});

test("a sample that comes too long after the passkey is refused", async () => {
  await enrolled(5002);
  assert.equal((await anchor(5002)).d.offer, true);
  write("UPDATE mouse_use_anchors SET expires_at = ? WHERE user_id = 5002", "2026-01-01 00:00:00");
  const r = await useSample(5002, sample("5002 browsing"));
  assert.equal(r.status, 403, JSON.stringify(r.d));
  assert.equal(r.d.error, "anchor_expired");
  assert.equal(rows("SELECT COUNT(*) AS n FROM mouse_use_samples WHERE user_id = 5002")[0].n, 0);
});

test("the enrolment's checks apply, and a refused sample does not use up the passkey", async () => {
  assert.equal((await anchor(5002)).d.offer, true);
  const short = await useSample(5002, sample("5002 short", 40));
  assert.equal(short.status, 422);
  const uniform = await useSample(5002, Array.from({ length: 55 }, () => Array.from({ length: 50 }, () => [6, 6])));
  assert.equal(uniform.status, 422);
  assert.match(uniform.d.error, /too uniform/);
  const retired = await useSample(5002, sample("5002 old client").map((w) => w.map((s) => [s[0], s[1], 0, 0, 0, 0, 0])));
  assert.equal(retired.status, 400);
  const copy = await useSample(5002, sample("5002 enrol 3"));   // the movement of an enrolment sample
  assert.equal(copy.status, 422);
  assert.match(copy.d.error, /already in one of your samples/);
  const ok = await useSample(5002, sample("5002 real browsing"), "sdk");
  assert.equal(ok.status, 200, JSON.stringify(ok.d));
  assert.equal(rows("SELECT client FROM mouse_use_samples WHERE user_id = 5002")[0].client, "sdk");
});

test("the windows of every check are kept only for the users the operator lists", async () => {
  const w = sample("5001 check", 60);
  const r1 = await call("POST", "/v1/mouse/check", 5001, { windows: w });
  assert.equal(r1.status, 200, JSON.stringify(r1.d));
  const [d1] = rows("SELECT id FROM mouse_decisions WHERE user_id = 5001 ORDER BY id DESC LIMIT 1");
  const live = rows("SELECT decision_id, windows FROM mouse_live_windows WHERE user_id = 5001");
  assert.equal(live.length, 1);
  assert.equal(live[0].decision_id, d1.id);
  assert.deepEqual(JSON.parse(live[0].windows), w, "the 60 windows the check scored");
  assert.equal((await call("POST", "/v1/mouse/check", 5002, { windows: sample("5002 check", 60) })).status, 200);
  assert.equal(rows("SELECT COUNT(*) AS n FROM mouse_live_windows WHERE user_id = 5002")[0].n, 0, "5002 is not listed");
});

test("a reset removes everything kept for learning from real use", async () => {
  assert.equal((await call("POST", "/v1/mouse/reset", 5001, {})).status, 200);
  for (const t of ["mouse_use_samples", "mouse_use_anchors", "mouse_live_windows", "mouse_samples"]) {
    assert.equal(rows(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = 5001`)[0].n, 0, t);
  }
  assert.ok(rows("SELECT COUNT(*) AS n FROM mouse_use_samples WHERE user_id = 5002")[0].n > 0, "another user's are untouched");
});

test("switched off, the default since stage 2: a passkey gets no offer and records nothing, and no sample is taken", async () => {
  // A second copy of the service on the same database, started as deployed (no MOUSE_USE_SAMPLES).
  const port = await freePort(), url = `http://127.0.0.1:${port}`, env = { ...process.env };
  delete env.MOUSE_USE_SAMPLES;
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const off = spawn(process.execPath, ["server.js"], { cwd: ROOT, stdio: "ignore",
    env: { ...env, PORT: String(port), STORAGE: "sqlite", DB_PATH, NODE_ENV: "test", LOG_FORMAT: "", GATEWAY_JWKS_URI: `${stubUrl}/jwks.json`,
      MODEL_INFER_URL: stubUrl, MODEL_API_URL: stubUrl } });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${url}/health`)).ok; } catch (e) { await new Promise((r) => setTimeout(r, 200)); } }
    assert.ok(up, "the second copy started");
    const offCall = async (method, p, sub, body) => {
      const r = await fetch(`${url}${p}`, { method, headers: { "Content-Type": "application/json", "X-Continuum-Identity": assertion(sub) },
        body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, d: await r.json() };
    };
    const anchorsBefore = rows("SELECT COUNT(*) AS n FROM mouse_use_anchors")[0].n;
    const a = await offCall("POST", "/v1/mouse/use-anchor", 5002, { reason: "mouse" });
    assert.equal(a.status, 200, JSON.stringify(a.d));
    assert.deepEqual(a.d, { offer: false, why: "off" });
    assert.equal(rows("SELECT COUNT(*) AS n FROM mouse_use_anchors")[0].n, anchorsBefore, "no anchor is recorded");
    const s = await offCall("POST", "/v1/mouse/use-sample", 5002, { windows: sample("5002 browsing when off") });
    assert.equal(s.status, 403, JSON.stringify(s.d));
    assert.equal(s.d.error, "off");
    const st = (await offCall("GET", "/v1/mouse/status/5002", 5002)).d;
    assert.equal(st.useSamplesOn, false);
    assert.equal(st.nextUseSampleAt, null);
  } finally {
    off.kill();
    await new Promise((r) => off.once("exit", r));
  }
});
