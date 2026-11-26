// More samples for a trained profile, as this app's backend passes them on (2026-11-25): routes/auth/mouse.js and
// routes/auth/text.js. The whole app runs against a stub of Continuum's tenant API (services/continuumApi.js) and a
// throwaway SQLite database.
//   1. the grant is asked of Continuum only after a passkey verified moments ago, with that verification's step-up
//      token, and one passkey buys one grant
//   2. the grant stays in the session: the page never gets it, and it goes with each enrolment sample of its channel
//   3. whatever the page writes as a grant is dropped
//   4. Continuum's "locked" answer to a mouse check goes to the page as it is, and the session locks with it
//   5. the end of a top-up needs a second passkey, verified after the samples; with it the grant leaves the session
// node --test apps/demo/test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "demo-topup-"));
process.env.DB_PATH = path.join(DIR, "demo.db");
process.env.PORT = "0";

// Continuum, as the tenant API answers. Every call is kept with its body.
const calls = [], continuum = { verifies: 0, mouseLocked: false };
const sent = (p) => calls.filter((c) => c.p === p);
const apiPath = require.resolve("../services/continuumApi");
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: {
  request: async (method, p, userId, body) => {
    calls.push({ p, userId, body: body || {} });
    const ok = (data) => ({ status: 200, ok: true, data });
    if (p === "/passkey/status") return ok({ hasPasskey: true });
    if (p === "/onboarding") return ok({ trained: true, keystrokeTraining: false, mouseEnrolled: true });
    if (p === "/keystroke/status") return ok({ trained: true });
    if (p === "/passkey/auth/complete") { continuum.verifies++; return ok({ verified: true, stepUpToken: "step-" + continuum.verifies }); }
    if (p === "/mouse/topup" || p === "/keystroke/topup") {
      if (!body || body.stepUpToken !== "step-" + continuum.verifies) return { status: 403, ok: false, data: { error: "passkey_required" } };
      return ok({ ok: true, topUpToken: "grant-" + p.split("/")[1] + "-" + continuum.verifies, expiresInMs: 900000, maxSamples: 8 });
    }
    if (p === "/mouse/enroll" || p === "/keystroke/enroll") return { status: 202, ok: true, data: { ok: true, trained: true, topUp: { added: 1, needed: 4 } } };
    if (p === "/mouse/topup/confirm" || p === "/keystroke/topup/confirm") {
      if (!body || body.stepUpToken !== "step-" + continuum.verifies) return { status: 403, ok: false, data: { error: "passkey_required" } };
      return { status: 202, ok: true, data: { ok: true, training: true } };
    }
    if (p === "/mouse/check") {
      return continuum.mouseLocked
        ? { status: 423, ok: false, data: { ok: false, checked: true, locked: true, warmup: false, isSuspicious: true, requiresPasskeyChallenge: true } }
        : ok({ checked: true, isSuspicious: false, suspiciousStreak: 0 });
    }
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

db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', ?)").run(bcryptjs.hashSync("pw", 4));

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
    return { status: r.status, json };
  };
}
const signIn = async (b) => assert.equal((await b("POST", "/api/auth/login", { username: "alice", password: "pw" })).status, 200);
const passkey = (b) => b("POST", "/api/webauthn/auth/complete", { userId: 1, challengeId: "c", assertion: { id: "x" } });

test("the mouse: the grant needs a passkey verified moments ago, stays in the session, and goes with each sample", async () => {
  const b = browser();
  await signIn(b);
  const bare = await b("POST", "/api/mouse/topup", {});
  assert.equal(bare.status, 401);
  assert.equal(bare.json.passkeyRequired, true);
  assert.equal(sent("/mouse/topup").length, 0, "Continuum was not asked");

  await b("POST", "/api/mouse/enroll", { windows: "before" });
  assert.equal("topUpToken" in sent("/mouse/enroll")[0].body, false, "with no grant a sample goes as it always did");

  assert.equal((await passkey(b)).status, 200);
  const g = await b("POST", "/api/mouse/topup", {});
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal(sent("/mouse/topup")[0].body.stepUpToken, "step-1", "the step-up token of that passkey");
  assert.equal(JSON.stringify(g.json).includes("grant-"), false, "the page is not given the grant");

  const again = await b("POST", "/api/mouse/topup", {});
  assert.equal(again.status, 401, "one passkey, one grant");

  await b("POST", "/api/mouse/enroll", { windows: "w1", topUpToken: "from-the-page" });
  await b("POST", "/api/mouse/enroll", { windows: "w2" });
  const last2 = sent("/mouse/enroll").slice(-2).map((c) => c.body);
  assert.deepEqual(last2, [{ windows: "w1", topUpToken: "grant-mouse-1" }, { windows: "w2", topUpToken: "grant-mouse-1" }]);
});

test("typing: the same, and whatever the page writes as a grant is dropped", async () => {
  const b = browser();
  await signIn(b);
  assert.equal((await b("POST", "/api/text/topup", {})).status, 401);
  await b("POST", "/api/text/enroll", { textContent: "t0", topUp: true, topUpToken: "from-the-page" });
  assert.deepEqual(sent("/keystroke/enroll").slice(-1)[0].body, { textContent: "t0" }, "no grant: the page's own words are dropped");

  await passkey(b);
  const g = await b("POST", "/api/text/topup", {});
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal(JSON.stringify(g.json).includes("grant-"), false);
  await b("POST", "/api/text/enroll", { textContent: "t1", topUp: true, topUpToken: "from-the-page" });
  assert.deepEqual(sent("/keystroke/enroll").slice(-1)[0].body, { textContent: "t1", topUpToken: `grant-keystroke-${continuum.verifies}` });
  // the mouse has no grant in this session
  await b("POST", "/api/mouse/enroll", { windows: "m" });
  assert.deepEqual(sent("/mouse/enroll").slice(-1)[0].body, { windows: "m" });
});

test("a refused grant is passed on as refused, and nothing is kept", async () => {
  const b = browser();
  await signIn(b);
  await passkey(b);
  continuum.verifies += 5;   // Continuum no longer knows that step-up token
  const g = await b("POST", "/api/mouse/topup", {});
  assert.equal(g.status, 403);
  assert.equal(g.json.error, "passkey_required");
  await b("POST", "/api/mouse/enroll", { windows: "x" });
  assert.deepEqual(sent("/mouse/enroll").slice(-1)[0].body, { windows: "x" });
});

test("the end of a top-up needs a second passkey, and the grant leaves the session with it", async () => {
  for (const [api, ch] of [["mouse", "mouse"], ["text", "keystroke"]]) {
    const b = browser();
    await signIn(b);
    await passkey(b);
    assert.equal((await b("POST", `/api/${api}/topup`, {})).status, 200);
    const sample = api === "mouse" ? { windows: "w" } : { textContent: "t" };
    await b("POST", `/api/${api}/enroll`, sample);
    assert.ok(sent(`/${ch}/enroll`).slice(-1)[0].body.topUpToken, "the sample went with the grant");

    const asked = sent(`/${ch}/topup/confirm`).length;
    const bare = await b("POST", `/api/${api}/topup/confirm`, {});
    assert.equal(bare.status, 401, `${ch}: the passkey that opened the top-up does not close it`);
    assert.equal(bare.json.passkeyRequired, true);
    assert.equal(sent(`/${ch}/topup/confirm`).length, asked, "Continuum was not asked");

    await passkey(b);
    const done = await b("POST", `/api/${api}/topup/confirm`, { stepUpToken: "from-the-page" });
    assert.equal(done.status, 202, JSON.stringify(done.json));
    assert.deepEqual(sent(`/${ch}/topup/confirm`).slice(-1)[0].body, { stepUpToken: "step-" + continuum.verifies }, "the step-up token of the second passkey, not the page's");
    assert.equal((await b("POST", `/api/${api}/topup/confirm`, {})).status, 401, "one passkey closes one top-up");

    await b("POST", `/api/${api}/enroll`, sample);
    assert.equal("topUpToken" in sent(`/${ch}/enroll`).slice(-1)[0].body, false, `${ch}: the grant ended with the top-up`);
  }
});

test("Continuum's \"locked\" answer to a mouse check goes to the page as it is, and the session locks with it", async () => {
  const b = browser();
  await signIn(b);
  assert.equal((await b("POST", "/api/mouse/check", { windows: [] })).status, 200);
  continuum.mouseLocked = true;
  try {
    const r = await b("POST", "/api/mouse/check", { windows: [] });
    assert.equal(r.status, 423);
    assert.equal(r.json.locked, true);
    assert.equal(r.json.requiresPasskeyChallenge, true);
    assert.equal((await b("GET", "/api/auth/me")).json.continuousAuthLocked, true, "the app's session is locked too");
  } finally { continuum.mouseLocked = false; }
});
