// The demo's session store (lib/sessionStore.js): sessions live in the demo's own SQLite database, so a sign-in
// survives a restart of the server. Uses the demo's node_modules: node --test apps/demo/test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const SqliteSessionStore = require("../lib/sessionStore");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "demo-sessions-"));
test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* a lock on Windows */ } });

const call = (store, method, ...args) => new Promise((resolve, reject) => store[method](...args, (err, v) => (err ? reject(err) : resolve(v))));

test("set, get, touch and destroy; an expired session reads as none and the prune removes it", async () => {
  const db = new Database(path.join(DIR, "store.db"));
  const store = new SqliteSessionStore(db, { pruneMs: 0 });
  await call(store, "set", "a", { cookie: { maxAge: 60000 }, userId: 7 });
  assert.deepEqual(await call(store, "get", "a"), { cookie: { maxAge: 60000 }, userId: 7 });
  assert.equal(await call(store, "length"), 1);
  await call(store, "set", "b", { cookie: { expires: new Date(Date.now() - 1000).toISOString() }, userId: 8 });
  assert.equal(await call(store, "get", "b"), null, "expired: no session");
  assert.equal(await call(store, "length"), 1, "and not counted");
  assert.equal(store.prune(), 1, "the prune removes it");
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 1);
  await call(store, "touch", "a", { cookie: { maxAge: 1 } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await call(store, "get", "a"), null, "a touch moves the expiry");
  await call(store, "set", "c", { cookie: {}, userId: 9 });
  assert.deepEqual(await call(store, "all"), [{ cookie: {}, userId: 9 }]);
  await call(store, "destroy", "c");
  assert.equal(await call(store, "get", "c"), null);
  await call(store, "clear");
  assert.equal(await call(store, "length"), 0);
  store.close();
  db.close();
});

// A small app with the demo's session settings (app.js) on the store.
function demoLike(dbPath) {
  const db = new Database(dbPath);
  const store = new SqliteSessionStore(db, { pruneMs: 0 });
  const app = express();
  app.use(session({ store, secret: "test-secret", resave: false, saveUninitialized: true, cookie: { secure: false, maxAge: 60000 } }));
  app.post("/login", (req, res) => { req.session.userId = 7; res.json({ ok: true }); });
  app.get("/me", (req, res) => (req.session.userId ? res.json({ userId: req.session.userId }) : res.status(401).json({ error: "Not authenticated" })));
  app.post("/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
  return { app, close: () => { store.close(); db.close(); } };
}
async function serve(dbPath) {
  const d = demoLike(dbPath);
  const server = await new Promise((resolve) => { const s = d.app.listen(0, "127.0.0.1", () => resolve(s)); });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => { d.close(); resolve(); }); }),
  };
}

test("a sign-in survives a restart of the server, and a sign-out ends it", async () => {
  const dbPath = path.join(DIR, "restart.db");
  let s = await serve(dbPath);
  const login = await fetch(`${s.base}/login`, { method: "POST" });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^connect\.sid=/);
  assert.equal((await fetch(`${s.base}/me`, { headers: { cookie } })).status, 200);
  await s.stop();                        // the process's memory goes with it
  s = await serve(dbPath);               // a new server on the same database
  const me = await fetch(`${s.base}/me`, { headers: { cookie } });
  assert.equal(me.status, 200, "still signed in after the restart");
  assert.deepEqual(await me.json(), { userId: 7 });
  assert.equal((await fetch(`${s.base}/logout`, { method: "POST", headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${s.base}/me`, { headers: { cookie } })).status, 401, "signed out");
  await s.stop();
});
