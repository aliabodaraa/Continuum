// boot.js: a transient failure (the database still starting) is retried within the bounded wait; a
// setting error fails at once; the wait ends. node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const { waitFor, transient } = require("../boot");

const quiet = () => {};
const withCode = (code, message = code) => Object.assign(new Error(message), { code });

test("transient: connection and start-up errors, not setting errors", () => {
  assert.equal(transient(withCode("EAI_AGAIN", "getaddrinfo EAI_AGAIN continuum-pg-rw")), true);
  assert.equal(transient(withCode("ECONNREFUSED")), true);
  assert.equal(transient(withCode("57P03", "the database system is starting up")), true);
  assert.equal(transient(withCode("3D000", 'database "gateway" does not exist')), true);
  assert.equal(transient(Object.assign(new Error("fetch failed"), { cause: withCode("ECONNRESET") })), true);
  assert.equal(transient(new Error("STORAGE must be json or postgres (got sqlite)")), false);
  assert.equal(transient(withCode("42P01", "relation does not exist")), false);
});

test("retries a transient failure until it succeeds", async () => {
  let n = 0;
  const value = await waitFor("db", async () => { if (++n < 3) throw withCode("ECONNREFUSED"); return "open"; }, { log: quiet, waitMs: 5000, stepMs: 5 });
  assert.equal(value, "open");
  assert.equal(n, 3);
});

test("a setting error is not retried", async () => {
  let n = 0;
  await assert.rejects(waitFor("db", async () => { n++; throw new Error("STORAGE must be json or postgres"); }, { log: quiet, waitMs: 5000, stepMs: 5 }), /STORAGE must be/);
  assert.equal(n, 1);
});

test("the wait is bounded: the last error comes out", async () => {
  let n = 0;
  const t0 = Date.now();
  await assert.rejects(waitFor("db", async () => { n++; throw withCode("EAI_AGAIN"); }, { log: quiet, waitMs: 60, stepMs: 10 }), { code: "EAI_AGAIN" });
  assert.ok(n >= 3 && n <= 12, `attempts: ${n}`);
  assert.ok(Date.now() - t0 < 2000);
});

test("tells the attempts apart in the log, not on every one", async () => {
  const lines = [];
  await assert.rejects(waitFor("db", async () => { throw withCode("ECONNREFUSED"); }, { log: (m) => lines.push(m), waitMs: 70, stepMs: 5 }));
  assert.ok(lines.length >= 1 && lines.every((l) => /\[boot\] db not ready \(ECONNREFUSED/.test(l)), lines.join("\n"));
});
