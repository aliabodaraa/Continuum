// The gateway's short-lived state (storage.js): sign-in links, account ceremonies, the operator lockout,
// each user's last settled risk and the webhook outbox. The same contract for both backends; races
// between two gateway copies on postgres only. node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openStorage } = require("../storage");
const { BASE, freshDatabase, emptyTables, query } = require("./pg");

let PG = "";
test.before(async () => { PG = await freshDatabase("shortlived"); });
const quiet = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PG_ONLY = { skip: !BASE && "TEST_DATABASE_URL not set" };

const backends = [{ name: "json", open: async () => openStorage({ kind: "json", dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "gw-short-")), log: quiet }) }];
if (BASE) backends.push({ name: "postgres", open: async () => { await emptyTables(PG); return openStorage({ kind: "postgres", databaseUrl: PG, log: quiet }); } });

for (const b of backends) {
  test(`${b.name}: a sign-in link is authorized once, redeemed once, and expires`, async () => {
    const s = await b.open();
    try {
      await s.putLink("L1", { siteKey: "pk_a", challenge: "c", at: Date.now(), status: "pending" }, 60000);
      assert.equal((await s.getLink("L1")).status, "pending");
      assert.equal(await s.authorizeLink("L1", "pk_other", { code: "x" }), null, "another tenant cannot authorize it");
      const a = await s.authorizeLink("L1", "pk_a", { code: "abc", externalId: "id:7" });
      assert.equal(a.status, "authorized");
      assert.equal(a.code, "abc");
      assert.equal(await s.authorizeLink("L1", "pk_a", { code: "again" }), null, "authorized only once");
      assert.equal((await s.takeLink("L1")).code, "abc");
      assert.equal(await s.takeLink("L1"), null, "redeemed only once");
      await s.putLink("L2", { siteKey: "pk_a", status: "pending" }, 40);
      await sleep(80);
      assert.equal(await s.getLink("L2"), null, "expired");
      assert.equal(await s.takeLink("L2"), null);
      assert.equal(await s.getLink("missing"), null);
    } finally { await s.close(); }
  });

  test(`${b.name}: a passkey ceremony is taken once and expires`, async () => {
    const s = await b.open();
    try {
      await s.putCeremony("C1", { kind: "login", accountId: "a_1" }, 60000);
      assert.equal((await s.takeCeremony("C1")).accountId, "a_1");
      assert.equal(await s.takeCeremony("C1"), null);
      await s.putCeremony("C2", { kind: "login" }, 40);
      await sleep(80);
      assert.equal(await s.takeCeremony("C2"), null);
    } finally { await s.close(); }
  });

  test(`${b.name}: the operator lockout counts wrong keys in a window, locks at the limit, clears on success`, async () => {
    const s = await b.open();
    try {
      const opt = { windowMs: 60000, limit: 3, lockMs: 60000 };
      assert.equal(await s.adminLockedUntil("ip1"), 0);
      assert.equal((await s.recordAdminFailure("ip1", opt)).n, 1);
      assert.equal((await s.recordAdminFailure("ip1", opt)).n, 2);
      const third = await s.recordAdminFailure("ip1", opt);
      assert.equal(third.n, 3);
      assert.ok(third.until > Date.now(), "locked at the limit");
      assert.ok(await s.adminLockedUntil("ip1") > Date.now());
      assert.equal(await s.adminLockedUntil("ip2"), 0, "per address");
      await s.clearAdminFailures("ip1");
      assert.equal(await s.adminLockedUntil("ip1"), 0);
      // a failure older than the window starts the count again
      const short = { windowMs: 40, limit: 3, lockMs: 60000 };
      await s.recordAdminFailure("ip3", short);
      await sleep(80);
      assert.equal((await s.recordAdminFailure("ip3", short)).n, 1);
    } finally { await s.close(); }
  });

  test(`${b.name}: a risk change is noticed once; the first "genuine" is not an event`, async () => {
    const s = await b.open();
    try {
      const ev = (prev) => (prev === undefined ? null : { siteKey: "pk_a", url: "https://h.example/hook", body: "set-" + prev });
      let r = await s.riskTransition("u1", "genuine", (p) => (p === undefined ? null : ev(p)));
      assert.equal(r.changed, true);
      assert.ok(!r.event && !r.queued, "first sight of genuine: no event");
      r = await s.riskTransition("u1", "genuine", ev);
      assert.equal(r.changed, false);
      r = await s.riskTransition("u1", "suspicious", ev);
      assert.equal(r.changed, true);
      assert.equal(r.prev, "genuine");
      assert.ok(r.event || r.queued, "genuine -> suspicious is an event");
      await s.deleteRiskState("u1");
      r = await s.riskTransition("u1", "suspicious", ev);
      assert.equal(r.prev, undefined, "erased");
    } finally { await s.close(); }
  });
}

test("postgres: a sign-in started on one copy finishes on another; races are settled once", PG_ONLY, async () => {
  await emptyTables(PG);
  const a = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  const b = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  try {
    await a.putLink("X", { siteKey: "pk_a", challenge: "c", status: "pending" }, 60000);
    assert.equal((await b.getLink("X")).challenge, "c");
    const both = await Promise.all([a.authorizeLink("X", "pk_a", { code: "from-a" }), b.authorizeLink("X", "pk_a", { code: "from-b" })]);
    assert.equal(both.filter(Boolean).length, 1, "two callbacks, one authorization");
    const takes = await Promise.all([a.takeLink("X"), b.takeLink("X")]);
    assert.equal(takes.filter(Boolean).length, 1, "two redemptions, one success");
    await a.putCeremony("Y", { kind: "register" }, 60000);
    const cs = await Promise.all([a.takeCeremony("Y"), b.takeCeremony("Y")]);
    assert.equal(cs.filter(Boolean).length, 1);
    // 20 wrong keys spread over two copies at once are all counted
    const opt = { windowMs: 60000, limit: 1000, lockMs: 60000 };
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).recordAdminFailure("ipX", opt)));
    assert.equal(Math.max(...rs.map((r) => r.n)), 20);
    assert.deepEqual(rs.map((r) => r.n).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
    // the same risk change seen by both copies at once: one event in the outbox
    await a.riskTransition("u9", "genuine", () => null);
    const ev = () => ({ siteKey: "pk_a", url: "https://h.example/hook", body: "set" });
    const rr = await Promise.all([a.riskTransition("u9", "suspicious", ev), b.riskTransition("u9", "suspicious", ev)]);
    assert.equal(rr.filter((r) => r.changed).length, 1);
    assert.equal((await query(PG, "SELECT count(*)::int AS n FROM gw_webhook_outbox"))[0].n, 1);
  } finally { await a.close(); await b.close(); }
});

test("postgres: a cached fact one copy forgets is forgotten by the others", PG_ONLY, async () => {
  await emptyTables(PG);
  const a = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  const b = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  try {
    const heardByA = [], heardByB = [];
    a.on("forget", (k) => heardByA.push(k));
    b.on("forget", (k) => heardByB.push(k));
    const t0 = Date.now();
    await a.forget("passkey:42");
    while (!heardByB.length && Date.now() - t0 < 3000) await sleep(10);
    assert.deepEqual(heardByB, ["passkey:42"]);
    assert.deepEqual(heardByA, [], "the sender already dropped its own copy");
  } finally { await a.close(); await b.close(); }
});

test("postgres: the outbox hands each event to one copy, retries, gives up, and is swept", PG_ONLY, async () => {
  await emptyTables(PG);
  const a = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  const b = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  try {
    for (let i = 0; i < 6; i++) await a.riskTransition("v" + i, "suspicious", () => ({ siteKey: "pk_a", url: "https://h.example/" + i, body: "b" + i }));
    const [ca, cb] = await Promise.all([a.claimWebhooks(10, 30000), b.claimWebhooks(10, 30000)]);
    const ids = [...ca, ...cb].map((r) => r.id);
    assert.equal(ids.length, 6, "every event claimed");
    assert.equal(new Set(ids).size, 6, "by exactly one copy");
    assert.ok([...ca, ...cb].every((r) => r.attempts === 1));
    assert.deepEqual(await a.claimWebhooks(10, 30000), [], "leased: not handed out again");
    const [first, second, third] = [...ca, ...cb];
    await a.finishWebhook(first.id, { ok: true });
    await a.finishWebhook(second.id, { error: "HTTP 500", retryInMs: 0 });
    await a.finishWebhook(third.id, { error: "timeout", dead: true });
    const again = await b.claimWebhooks(10, 30000);
    assert.deepEqual(again.map((r) => [r.id, r.attempts]), [[second.id, 2]], "the failed one comes back, counted");
    const rows = await query(PG, "SELECT id, status, last_error FROM gw_webhook_outbox ORDER BY id");
    assert.equal(rows.find((r) => Number(r.id) === first.id).status, "sent");
    assert.equal(rows.find((r) => Number(r.id) === third.id).status, "dead");
    assert.equal(rows.find((r) => Number(r.id) === third.id).last_error, "timeout");
    // a lease that runs out (the copy died mid-delivery) hands the event out again
    await query(PG, "UPDATE gw_webhook_outbox SET next_at = now() WHERE id = $1", [second.id]);
    assert.equal((await a.claimWebhooks(10, 30000))[0].id, second.id);
    // the sweep keeps what is recent
    await query(PG, "UPDATE gw_webhook_outbox SET done_at = now() - interval '8 days' WHERE id = $1", [first.id]);
    await a.putLink("old", { status: "pending" }, 1);
    await sleep(20);
    await a.sweep();
    assert.equal((await query(PG, "SELECT count(*)::int AS n FROM gw_webhook_outbox WHERE id = $1", [first.id]))[0].n, 0, "old sent event swept");
    assert.equal((await query(PG, "SELECT count(*)::int AS n FROM gw_webhook_outbox WHERE id = $1", [third.id]))[0].n, 1, "a recent dead one kept");
    assert.equal((await query(PG, "SELECT count(*)::int AS n FROM gw_links"))[0].n, 0, "expired link swept");
  } finally { await a.close(); await b.close(); }
});
