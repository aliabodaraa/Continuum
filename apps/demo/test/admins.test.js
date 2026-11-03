// Every user's records (the all-users decision CSV, the per-user metrics table) only for the usernames in
// DEMO_ADMIN_USERS (apps/demo/lib/admins.js); anyone else gets their own. The typing routes run against a stub of
// the Continuum client and a throwaway SQLite database. node --test apps/demo/test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "demo-admins-"));
process.env.DB_PATH = path.join(DIR, "demo.db");
process.env.DEMO_ADMIN_USERS = " Boss , other ";

// The Continuum client: decisions and metrics for two users, 1 (alice) and 2 (boss).
const caPath = require.resolve("../services/caClient");
require.cache[caPath] = { id: caPath, filename: caPath, loaded: true, exports: {
  keystrokeDecisionsAll: async () => ({ status: 200, data: { rows: [
    { id: 1, user_id: 1, checked_at: "2026-11-01 10:00:00", source: "check", window_count: 20, mean_score: 0.8, threshold: 0.5, verdict: "genuine", passkey_triggered: 0 },
    { id: 2, user_id: 2, checked_at: "2026-11-01 11:00:00", source: "check", window_count: 20, mean_score: 0.3, threshold: 0.5, verdict: "suspicious", passkey_triggered: 1 }] } }),
  keystrokeDecisions: async (uid) => ({ status: 200, data: { decisions: [{ id: uid, checked_at: "2026-11-01 10:00:00", source: "check", window_count: 20, mean_score: 0.8, threshold: 0.5, verdict: "genuine", passkey_triggered: 0 }] } }),
  keystrokeMetrics: async () => ({ status: 200, data: { rows: [
    { user_id: 1, total: 10, genuine_count: 9, suspicious_count: 1, avg_score: 0.7, first_check: "a", last_check: "b" },
    { user_id: 2, total: 4, genuine_count: 2, suspicious_count: 2, avg_score: 0.5, first_check: "c", last_check: "d" }], profileMap: {} } }),
} };

const express = require("express");
const session = require("express-session");
const db = require("../db/init");
const { isAdminName, adminNames } = require("../lib/admins");
const textRoute = require("../routes/auth/text");

db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', 'x'), (2, 'boss', 'x')").run();
test.after(() => { try { db.close(); fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* a lock on Windows */ } });

function app() {
  const a = express();
  a.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  a.post("/as/:id", (req, res) => { req.session.userId = Number(req.params.id); res.json({ ok: true }); });
  a.use("/api/text", textRoute);
  return a;
}
async function as(userId) {
  const server = await new Promise((r) => { const s = app().listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(`${base}/as/${userId}`, { method: "POST" })).headers.get("set-cookie").split(";")[0];
  const get = (p) => fetch(base + p, { headers: { cookie } });
  return { get, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test("the admin list: names trimmed, any case, nobody when unset", () => {
  assert.deepEqual([...adminNames()], ["boss", "other"]);
  assert.equal(isAdminName("BOSS"), true);
  assert.equal(isAdminName("alice"), false);
  assert.equal(isAdminName("boss", {}), false, "no DEMO_ADMIN_USERS: nobody");
});

test("a user who is not an admin: no all-users CSV, and only their own metrics row", async () => {
  const c = await as(1);
  try {
    const all = await c.get("/api/text/decisions/export?all=1");
    assert.equal(all.status, 403);
    assert.deepEqual(await all.json(), { error: "admins_only" });
    const own = await c.get("/api/text/decisions/export");
    assert.equal(own.status, 200);
    assert.doesNotMatch(await own.text(), /boss/);
    const m = await (await c.get("/api/text/metrics")).json();
    assert.deepEqual(m.users.map((u) => u.username), ["alice"]);
    assert.equal(m.allUsers, false);
    assert.equal(m.summary.totalUsers, 1);
  } finally { await c.close(); }
});

test("an admin: the all-users CSV with usernames, and every user's metrics", async () => {
  const c = await as(2);
  try {
    const all = await c.get("/api/text/decisions/export?all=1");
    assert.equal(all.status, 200);
    const csv = await all.text();
    assert.match(csv, /^id,username,/);
    assert.match(csv, /,alice,/);
    assert.match(csv, /,boss,/);
    const m = await (await c.get("/api/text/metrics")).json();
    assert.deepEqual(m.users.map((u) => u.username).sort(), ["alice", "boss"]);
    assert.equal(m.allUsers, true);
  } finally { await c.close(); }
});
