// The app's gate (app.js passkeySetupGate) and its cached "has a passkey" (services/passkeyClient.js), 2026-11-25:
//   1. a locked session asked for another page goes to the dashboard (where the SDK asks for the passkey), still signed
//      in and still locked; until then it was signed out
//   2. a locked session's mouse check is refused 423 like every other action, and every refusal asks for the passkey
//      (requiresPasskeyChallenge); the mouse check used to pass and come back as a plain verdict
//   3. an account created in a signed-in browser has no passkey (it kept the previous user's "has a passkey")
//   4. a "no passkey" answer is asked again after a few seconds (it lasted the whole session)
// The whole app runs against a stub of Continuum's tenant API (services/continuumApi.js) and a throwaway SQLite database.
// node --test apps/demo/test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "demo-lockgate-"));
process.env.DB_PATH = path.join(DIR, "demo.db");
process.env.PORT = "0";

// Continuum, as the tenant API answers: passkeys per user, a trained typing model, a typing check that asks for the passkey.
const passkeys = {}, calls = [];
const apiPath = require.resolve("../services/continuumApi");
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: {
  request: async (method, p, userId) => {
    calls.push(p);
    const ok = (data) => ({ status: 200, ok: true, data });
    if (p === "/passkey/status") return ok({ hasPasskey: !!passkeys[userId] });
    if (p === "/onboarding") return ok({ trained: true, keystrokeTraining: false, mouseEnrolled: true });
    if (p === "/keystroke/status") return ok({ trained: true });
    if (p === "/keystroke/check") return ok({ checked: true, isSuspicious: true, requiresPasskeyChallenge: true });
    if (p === "/mouse/check") return ok({ checked: true, isSuspicious: false, suspiciousStreak: 0 });
    return ok({ ok: true });
  },
} };
const idPath = require.resolve("../services/continuumId");
require.cache[idPath] = { id: idPath, filename: idPath, loaded: true, exports: {
  resolveContinuumId: async () => null, attachContinuumId: (req, res, next) => next() } };

// app.js starts its own server: keep it, to read its port and close it.
const express = require("express");
let server;
const listen = express.application.listen;
express.application.listen = function (...args) { server = listen.apply(this, args); return server; };
const bcryptjs = require("bcryptjs");
const db = require("../db/init");
require("../app");
const base = () => `http://127.0.0.1:${server.address().port}`;

const HASH = bcryptjs.hashSync("pw", 4);
db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', ?), (2, 'carol', ?)").run(HASH, HASH);
passkeys[1] = true;

test.before(() => new Promise((r) => (server.listening ? r() : server.once("listening", r))));
test.after(() => {
  server.closeAllConnections(); server.close();
  try { db.close(); fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* a lock on Windows */ }
});

// A browser: its cookie, kept from the first answer that sets one.
function browser() {
  let cookie = "";
  return async (method, p, body) => {
    const r = await fetch(base() + p, { method, redirect: "manual", headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* a page */ }
    return { status: r.status, location: r.headers.get("location"), json };
  };
}
const signIn = async (b, username) => assert.equal((await b("POST", "/api/auth/login", { username, password: "pw" })).status, 200);

test("a locked session: other pages go to the dashboard, signed in and still locked", async () => {
  const b = browser();
  await signIn(b, "alice");
  const n = calls.filter((p) => p === "/mouse/check").length;
  assert.equal((await b("POST", "/api/mouse/check", { windows: [] })).status, 200, "unlocked: the mouse check passes");
  assert.equal(calls.filter((p) => p === "/mouse/check").length, n + 1);
  assert.equal((await b("POST", "/api/text/check", {})).json.requiresPasskeyChallenge, true, "the typing check locks the session");
  for (const page of ["/profile.html", "/lab.html", "/opinion.html"]) {
    const r = await b("GET", page);
    assert.equal(r.status, 302, page);
    assert.equal(r.location, "/dashboard.html", page);
  }
  const me = await b("GET", "/api/auth/me");
  assert.equal(me.status, 200, "still signed in");
  assert.equal(me.json.continuousAuthLocked, true, "and still locked");
  assert.equal((await b("GET", "/dashboard.html")).status, 200);
});

test("a locked session: the mouse check and the page's own actions are refused 423, asking for the passkey", async () => {
  const b = browser();
  await signIn(b, "alice");
  await b("POST", "/api/text/check", {});
  const n = calls.filter((p) => p === "/mouse/check").length;
  const m = await b("POST", "/api/mouse/check", { windows: [] });
  assert.equal(m.status, 423);
  assert.equal(m.json.continuousAuthLocked, true);
  assert.equal(m.json.requiresPasskeyChallenge, true);
  assert.equal(calls.filter((p) => p === "/mouse/check").length, n, "not sent to Continuum");
  const save = await b("PUT", "/api/auth/profile", { username: "alice" });
  assert.equal(save.status, 423);
  assert.equal(save.json.requiresPasskeyChallenge, true);
  assert.equal((await b("GET", "/api/text/typing-status")).status, 200, "what the page reads still answers");
});

test("an account created in a signed-in browser has no passkey", async () => {
  const b = browser();
  await signIn(b, "alice");
  assert.equal((await b("GET", "/api/auth/me")).json.passkeysRegistered, true);
  assert.equal((await b("POST", "/api/auth/register", { username: "bob", password: "pw" })).status, 200);
  const me = await b("GET", "/api/auth/me");
  assert.equal(me.json.username, "bob");
  assert.equal(me.json.passkeysRegistered, false);
  assert.equal(me.json.passkeySetupRequired, true);
});

test("a \"no passkey\" is asked again after a few seconds", async () => {
  const b = browser();
  passkeys[2] = false;   // Continuum says no at sign-in (as when its own lookup fails)
  await signIn(b, "carol");
  assert.equal((await b("GET", "/api/auth/me")).json.passkeysRegistered, false);
  passkeys[2] = true;    // the passkey is there
  assert.equal((await b("GET", "/api/auth/me")).json.passkeysRegistered, false, "kept for a few seconds");
  await new Promise((r) => setTimeout(r, 5200));
  const me = await b("GET", "/api/auth/me");
  assert.equal(me.json.passkeysRegistered, true);
  assert.equal(me.json.passkeySetupRequired, false);
});
