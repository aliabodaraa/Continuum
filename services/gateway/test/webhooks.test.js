// The webhook dispatcher (webhooks.js) against a real outbox (STORAGE=postgres) and a real HTTP receiver
// on this machine: delivery, retry after a failure, giving up, timeouts, and two copies never delivering
// one event twice in a pass. node --test (skipped without TEST_DATABASE_URL)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { openStorage } = require("../storage");
const { createDispatcher } = require("../webhooks");
const { BASE, freshDatabase, emptyTables, query } = require("./pg");

let PG = "";
test.before(async () => { PG = await freshDatabase("webhooks"); });
const PG_ONLY = { skip: !BASE && "TEST_DATABASE_URL not set" };
const quiet = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A receiver that answers with the next status in `plan` (the last one repeats); "hang" never answers.
function receiver(plan) {
  const got = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      got.push({ type: req.headers["content-type"], body });
      const step = plan[Math.min(i++, plan.length - 1)];
      if (step === "hang") return;
      res.writeHead(step).end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/hook`, got, close: () => { server.closeAllConnections(); server.close(); } })));
}

async function queue(s, url, n = 1) {
  for (let i = 0; i < n; i++) {
    await s.riskTransition("user-" + Math.random(), "suspicious", () => ({ siteKey: "pk_t", url, body: "eyJ.set." + i }));
  }
}
const rows = () => query(PG, "SELECT id, status, attempts, last_error FROM gw_webhook_outbox ORDER BY id");

test("an event is delivered as a signed SET and marked sent", PG_ONLY, async () => {
  await emptyTables(PG);
  const s = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  const r = await receiver([200]);
  try {
    await queue(s, r.url);
    await createDispatcher({ storage: s, log: quiet }).tick();
    assert.equal(r.got.length, 1);
    assert.equal(r.got[0].type, "application/secevent+jwt");
    assert.equal(r.got[0].body, "eyJ.set.0");
    assert.deepEqual((await rows()).map((x) => [x.status, x.attempts]), [["sent", 1]]);
  } finally { r.close(); await s.close(); }
});

test("a failure is retried later; a success after it marks the event sent", PG_ONLY, async () => {
  await emptyTables(PG);
  const s = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  const r = await receiver([503, 200]);
  try {
    await queue(s, r.url);
    const d = createDispatcher({ storage: s, log: quiet, baseDelayMs: 50 });
    await d.tick();
    let [row] = await rows();
    assert.deepEqual([row.status, row.attempts, row.last_error], ["pending", 1, "HTTP 503"]);
    await d.tick();
    assert.equal(r.got.length, 1, "not before its backoff");
    await sleep(120);
    await d.tick();
    [row] = await rows();
    assert.deepEqual([row.status, row.attempts], ["sent", 2]);
    assert.equal(r.got.length, 2);
    assert.equal(r.got[0].body, r.got[1].body, "the same token again: the receiver drops repeats by jti");
  } finally { r.close(); await s.close(); }
});

test("after the last attempt the event is dead and the tenant is told", PG_ONLY, async () => {
  await emptyTables(PG);
  const s = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  const r = await receiver([500]);
  const dead = [];
  try {
    await queue(s, r.url);
    const d = createDispatcher({ storage: s, log: quiet, baseDelayMs: 1, maxAttempts: 3, onDead: (row, error) => dead.push([row.siteKey, row.attempts, error]) });
    for (let i = 0; i < 3; i++) { await d.tick(); await sleep(20); }
    const [row] = await rows();
    assert.deepEqual([row.status, row.attempts, row.last_error], ["dead", 3, "HTTP 500"]);
    assert.deepEqual(dead, [["pk_t", 3, "HTTP 500"]]);
    await d.tick();
    assert.equal(r.got.length, 3, "never tried again");
  } finally { r.close(); await s.close(); }
});

test("a receiver that never answers times out without holding the dispatcher", PG_ONLY, async () => {
  await emptyTables(PG);
  const s = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  const r = await receiver(["hang"]);
  try {
    await queue(s, r.url);
    const t0 = Date.now();
    await createDispatcher({ storage: s, log: quiet, timeoutMs: 200 }).tick();
    assert.ok(Date.now() - t0 < 2000);
    const [row] = await rows();
    assert.deepEqual([row.status, row.last_error], ["pending", "timeout"]);
  } finally { r.close(); await s.close(); }
});

test("two gateway copies deliver 30 events once each", PG_ONLY, async () => {
  await emptyTables(PG);
  const a = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  const b = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  const r = await receiver([200]);
  try {
    await queue(a, r.url, 30);
    const da = createDispatcher({ storage: a, log: quiet, batch: 4 }), db = createDispatcher({ storage: b, log: quiet, batch: 4 });
    await Promise.all([da.tick(), db.tick()]);
    assert.equal(r.got.length, 30);
    assert.equal(new Set(r.got.map((g) => g.body)).size, 30, "no event twice");
    assert.ok((await rows()).every((x) => x.status === "sent" && x.attempts === 1));
  } finally { r.close(); await a.close(); await b.close(); }
});
