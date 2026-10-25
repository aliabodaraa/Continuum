// Mouse enrolment samples through the real server (server.js), with synthetic movement only: a stub for the
// gateway's key set, a stub model service that "trains" a profile, and throwaway SQLite databases.
// It pins the rules of 2026-10-24 (the owner's step 0): a sample that repeats movement already on file is refused,
// independent movement and the pieces either side of a cut in one recording are not; once the profile exists the
// enrolment is closed until a reset; and the one-off cleanup removes, of two copies, the older one and rebuilds the
// profile from the samples that are left. node --test
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
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ca-mouse-samples-"));
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

// ---- the model service: training returns a profile at once and records the windows it was given
const trained = [];
const stub = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url === "/jwks.json") return res.end(JSON.stringify({ keys: [JWK] }));
  if (req.method === "POST" && req.url === "/api/user/train") {
    let body = "";
    req.on("data", (c) => { body += c; }).on("end", () => {
      const b = JSON.parse(body);
      trained.push({ userId: b.userId, positiveWindows: b.positiveWindows });
      const pct = { 1: 0.01, 2: 0.02, 5: 0.05, 10: 0.1, 15: 0.15, 20: 0.3, 30: 0.4, 40: 0.5, 50: 0.6 };
      res.end(JSON.stringify({ ok: true, modelPath: `/models/user-${b.userId}/mouse_model`, balancedAccuracy: 0.9,
        losoScorePercentiles: pct, enrolScorePercentiles: pct, losoScores: b.positiveWindows.map(() => 0.5), modelSha256: "stub" }));
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

// ---- synthetic movement: |dx|, |dy| steps of 2-41 px in all directions, independent for every seed. A sample is
// 55 windows of 50 steps at stride 10, 590 steps, built the way the clients build them.
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
const sample = (seed, from = 0, s = stream(from + 590, seed)) => windowsOf(s.slice(from, from + 590));

let server, base, log = "";
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
let stubUrl;

test.before(async () => {
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  stubUrl = `http://127.0.0.1:${stub.address().port}`;
  await db.open();
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
const enrol = (sub, windows) => call("POST", "/v1/mouse/enroll", sub, { windows });
function rows(file, sql, ...args) {
  const ro = new Database(file, { readonly: true });
  try { return ro.prepare(sql).all(...args); } finally { ro.close(); }
}
const samplesOf = (sub) => rows(DB_PATH, "SELECT id FROM mouse_samples WHERE user_id = ? ORDER BY id", sub);

test("a sample that repeats movement already on file is refused; independent movement is accepted", async () => {
  const s = stream(700, "repeat");
  const first = await enrol(3001, windowsOf(s.slice(0, 590)));
  assert.equal(first.status, 202, JSON.stringify(first.d));
  const copy = await enrol(3001, windowsOf(s.slice(11, 601)));   // the same movement, recorded 11 steps later
  assert.equal(copy.status, 422, JSON.stringify(copy.d));
  assert.match(copy.d.error, /already in one of your samples/);
  assert.ok(copy.d.repeatedShare > 0.9, `shared ${copy.d.repeatedShare}`);
  const other = await enrol(3001, sample("other movement"));
  assert.equal(other.status, 202, JSON.stringify(other.d));
  assert.equal(samplesOf(3001).length, 2, "the copy was not stored");
});

test("the pieces either side of a cut in one recording are accepted (they share 40 boundary steps, 3.7% of the runs)", async () => {
  const s = stream(1140, "one recording");
  assert.equal((await enrol(3002, windowsOf(s.slice(0, 590)))).status, 202);
  const next = await enrol(3002, windowsOf(s.slice(550, 1140)));
  assert.equal(next.status, 202, JSON.stringify(next.d));
  const share = mouse.repeatShare(mouse.stepRuns(windowsOf(s.slice(550, 1140))), mouse.stepRuns(windowsOf(s.slice(0, 590))));
  assert.ok(share > 0.03 && share < mouse.REPEAT_LIMIT, `share ${share}`);
});

test("once the profile exists, enrolment is closed until a reset", async () => {
  for (let i = 0; i < 8; i++) {
    const r = await enrol(3003, sample(`enrol ${i}`));
    assert.equal(r.status, 202, JSON.stringify(r.d));
  }
  let st = {};
  for (let i = 0; i < 100 && !st.enrolled; i++) {
    await new Promise((r) => setTimeout(r, 100));
    st = (await call("GET", "/v1/mouse/status/3003", 3003)).d;
  }
  assert.equal(st.enrolled, true, `the profile was not built:\n${log.slice(-2000)}`);
  const more = await enrol(3003, sample("enrol 8"));
  assert.equal(more.status, 409, JSON.stringify(more.d));
  assert.equal(more.d.error, "already_enrolled");
  assert.equal(samplesOf(3003).length, 8, "nothing was added to the profile's samples");
  assert.equal((await call("POST", "/v1/mouse/reset", 3003, {})).status, 200);
  const again = await enrol(3003, sample("enrol again"));
  assert.equal(again.status, 202, JSON.stringify(again.d));
  assert.equal(again.d.samplesOnFile, 1);
});

// The owner's samples of 2026-09-19 in miniature: 34 begins with the last 94 steps of 33, 35 is 34 recorded 109 steps
// later, 37 is 36 recorded 11 steps later; 136 and 205 are independent.
function ownersCase() {
  const x = stream(1300, "x"), y = stream(700, "y");
  return [
    { id: 33, windows: windowsOf(x.slice(0, 590)) },
    { id: 34, windows: windowsOf(x.slice(496, 1086)) },
    { id: 35, windows: windowsOf(x.slice(605, 1195)) },
    { id: 36, windows: windowsOf(y.slice(0, 590)) },
    { id: 37, windows: windowsOf(y.slice(11, 601)) },
    { id: 136, windows: sample("z") },
    { id: 205, windows: sample("w") },
  ];
}

test("of two copies the older is the repeat, and a sample that overlapped only the removed one stays", () => {
  const rep = mouse.repeatedSamples(ownersCase());
  assert.deepEqual(rep.map((r) => [r.id, r.repeats]), [[36, 37], [34, 35]]);
  assert.ok(rep[0].share > 0.95 && rep[1].share > 0.75 && rep[1].share < 0.85, JSON.stringify(rep.map((r) => r.share)));
});

test("the cleanup script reports, then removes the older copies and rebuilds from the newest distinct samples", async () => {
  const file = path.join(DIR, "cleanup.db");
  const run = (...args) => new Promise((resolve) => {
    let out = "";
    const p = spawn(process.execPath, ["scripts/dedup_mouse_samples.js", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, STORAGE: "sqlite", DB_PATH: file, MODEL_API_URL: stubUrl, LOG_FORMAT: "" } });
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    p.on("exit", (code) => resolve({ code, out }));
  });
  const empty = await run();   // on an empty database: creates the schema, finds nothing
  assert.equal(empty.code, 0, empty.out);
  const h = new Database(file);
  const own = ownersCase().concat([{ id: 240, windows: sample("v") }, { id: 241, windows: sample("u") }, { id: 242, windows: sample("t") }]);
  const ins = h.prepare("INSERT INTO mouse_samples (id, user_id, windows, window_count) VALUES (?, 4001, ?, ?)");
  for (const s of own) ins.run(s.id, JSON.stringify(s.windows), s.windows.length);
  h.prepare(`INSERT INTO mouse_profiles (user_id, model_path, sample_windows, threshold, feature_version, decision_version)
             VALUES (4001, '/models/old', 440, 0.303, ?, ?)`).run(mouse.MOUSE_FEATURE_VERSION, mouse.MOUSE_DECISION_VERSION);
  h.close();

  const report = await run();
  assert.equal(report.code, 0, report.out);
  assert.match(report.out, /sample 36 repeats sample 37/);
  assert.match(report.out, /sample 34 repeats sample 35/);
  assert.match(report.out, /would remove 36, 34/);
  assert.equal(rows(file, "SELECT COUNT(*) AS n FROM mouse_samples")[0].n, 10, "a report changes nothing");

  const before = trained.length;
  const done = await run("--apply");
  assert.equal(done.code, 0, done.out);
  assert.deepEqual(rows(file, "SELECT id FROM mouse_samples ORDER BY id").map((r) => r.id), [33, 35, 37, 136, 205, 240, 241, 242]);
  assert.equal(trained.length, before + 1, "one rebuild");
  const sent = trained[trained.length - 1].positiveWindows;
  const expected = [33, 35, 37, 136, 205, 240, 241, 242].flatMap((id) => own.find((s) => s.id === id).windows);
  assert.deepEqual(sent, expected, "the newest 440 distinct windows, in time order");
  assert.equal(rows(file, "SELECT threshold FROM mouse_profiles WHERE user_id = 4001")[0].threshold, 0.3, "the rebuilt profile's p20");
  assert.match(done.out, /threshold 0\.303 -> 0\.3/);
});
