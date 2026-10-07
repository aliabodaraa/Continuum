// The gateway's storage (storage.js): the same contract for both backends. node --test
//   json      always, in a throwaway directory
//   postgres  when TEST_DATABASE_URL names a throwaway database (scripts/ci-local.sh and CI start one);
//             its tables are emptied first, so never point it at a real deployment
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openStorage } = require("../storage");

const PG = process.env.TEST_DATABASE_URL || "";
const quiet = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(25); }
  return fn();
}

async function emptyPg() {
  const { Client } = require("pg");
  const c = new Client({ connectionString: PG });
  await c.connect();
  await c.query(`DO $$ BEGIN
    IF to_regclass('gw_tenants') IS NOT NULL THEN
      TRUNCATE gw_tenants, gw_identities, gw_accounts, gw_revoked_tokens, gw_settings, gw_audit RESTART IDENTITY;
    END IF; END $$;`);
  await c.end();
}

const backends = [{
  name: "json",
  async fresh() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-storage-"));
    return { open: () => openStorage({ kind: "json", dataDir: dir, log: quiet }), dir };
  },
}];
if (PG) backends.push({
  name: "postgres",
  async fresh() {
    await emptyPg();
    return { open: () => openStorage({ kind: "postgres", databaseUrl: PG, log: quiet }) };
  },
});

for (const b of backends) {
  test(`${b.name}: starts empty, and a tenant survives a restart`, async () => {
    const { open } = await b.fresh();
    const s = await open();
    assert.deepEqual(s.data.tenants.tenants, {});
    s.data.tenants.tenants.pk_a = { name: "A", secret: "s", origins: ["https://a.example"], createdAt: "2026-10-07T10:00:00.000Z" };
    await s.saveTenant("pk_a");
    await s.close();
    const again = await open();
    assert.deepEqual(again.data.tenants.tenants.pk_a, { name: "A", secret: "s", origins: ["https://a.example"], createdAt: "2026-10-07T10:00:00.000Z" });
    delete again.data.tenants.tenants.pk_a;
    await again.saveTenant("pk_a");
    await again.close();
    const third = await open();
    assert.equal(third.data.tenants.tenants.pk_a, undefined);
    await third.close();
  });

  test(`${b.name}: identities, accounts, revocations and settings survive a restart`, async () => {
    const { open } = await b.fresh();
    const s = await open();
    s.data.identity.users["pk_a|id:7"] = { userId: 4503599627370001, externalId: "id:7", createdAt: "2026-10-07T10:00:00.000Z" };
    const stored = await s.saveIdentity("pk_a|id:7");
    assert.equal(stored.userId, 4503599627370001);   // a 52-bit id comes back exact
    s.data.accounts.accounts.a_1 = { email: "x@example.com", createdAt: "2026-10-07T10:00:00.000Z" };
    s.data.accounts.byEmail["x@example.com"] = "a_1";
    await s.saveAccount("a_1");
    const future = Math.floor(Date.now() / 1000) + 3600;
    s.data.accounts.revoked.j1 = future;
    s.data.accounts.revoked.old = 1000;               // long expired: dropped on save
    await s.saveRevoked("j1");
    await s.saveSettings({ defaults: { keystrokeDecisionWindows: 10 }, server: { autoApproveTenants: true } });
    await s.close();
    const again = await open();
    assert.equal(again.data.identity.users["pk_a|id:7"].userId, 4503599627370001);
    assert.equal(again.data.accounts.byEmail["x@example.com"], "a_1");
    assert.equal(again.data.accounts.accounts.a_1.email, "x@example.com");
    assert.deepEqual(again.data.accounts.revoked, { j1: future });
    assert.deepEqual(again.data.settings, { defaults: { keystrokeDecisionWindows: 10 }, server: { autoApproveTenants: true } });
    delete again.data.identity.users["pk_a|id:7"];
    await again.deleteIdentities(["pk_a|id:7"]);
    delete again.data.accounts.accounts.a_1; delete again.data.accounts.byEmail["x@example.com"];
    await again.saveAccount("a_1");
    await again.close();
    const third = await open();
    assert.deepEqual(third.data.identity.users, {});
    assert.deepEqual(third.data.accounts.accounts, {});
    await third.close();
  });

  test(`${b.name}: the activity log, newest first, filtered for a console account`, async () => {
    const { open } = await b.fresh();
    const s = await open();
    const e = (i, siteKey, actor) => ({ at: new Date(Date.UTC(2026, 9, 7, 10, i)).toISOString(), actor, action: "a" + i, siteKey, name: null });
    await s.appendAudit(e(1, "pk_a", { type: "operator" }));
    await s.appendAudit(e(2, "pk_b", { type: "account", email: "x@example.com" }));
    await s.appendAudit(e(3, null, { type: "account", email: "y@example.com" }));
    await s.appendAudit(e(4, "pk_a", { type: "account", email: "y@example.com" }));
    assert.deepEqual((await s.readAudit(null, 10)).map((x) => x.action), ["a4", "a3", "a2", "a1"]);
    assert.deepEqual((await s.readAudit(null, 2)).map((x) => x.action), ["a4", "a3"]);
    // x owns pk_a: everything done to pk_a, plus x's own actions anywhere
    assert.deepEqual((await s.readAudit({ siteKeys: ["pk_a"], email: "x@example.com" }, 10)).map((x) => x.action), ["a4", "a2", "a1"]);
    assert.deepEqual((await s.readAudit({ siteKeys: [], email: "nobody@example.com" }, 10)), []);
    await s.close();
  });
}

test("json: a damaged file stops the start instead of being read as empty", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-storage-"));
  fs.writeFileSync(path.join(dir, "identity.json"), "{ broken");
  await assert.rejects(openStorage({ kind: "json", dataDir: dir }), /identity\.json is not valid JSON/);
  fs.writeFileSync(path.join(dir, "identity.json"), "{}");
  fs.writeFileSync(path.join(dir, "settings.json"), "{ broken");
  await assert.rejects(openStorage({ kind: "json", dataDir: dir }), /settings\.json unreadable/);
});

test("an unknown STORAGE value is refused", async () => {
  await assert.rejects(openStorage({ kind: "mongo" }), /STORAGE must be json or postgres/);
});

test("postgres: two gateway copies see each other's changes", { skip: !PG && "TEST_DATABASE_URL not set" }, async () => {
  await emptyPg();
  const a = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  const b = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  try {
    const seen = { settings: null, identity: null };
    b.on("settings", (doc) => { seen.settings = doc; });
    b.on("identity", (key) => { seen.identity = key; });

    a.data.tenants.tenants.pk_n = { name: "N", secret: "s1", origins: [] };
    await a.saveTenant("pk_n");
    assert.ok(await until(() => b.data.tenants.tenants.pk_n && b.data.tenants.tenants.pk_n.secret === "s1"), "b sees the new tenant");
    a.data.tenants.tenants.pk_n.status = "revoked";
    await a.saveTenant("pk_n");
    assert.ok(await until(() => b.data.tenants.tenants.pk_n.status === "revoked"), "b sees the revocation");
    delete a.data.tenants.tenants.pk_n;
    await a.saveTenant("pk_n");
    assert.ok(await until(() => !b.data.tenants.tenants.pk_n), "b sees the deletion");

    await a.saveSettings({ defaults: { mouse: "off" }, server: {} });
    assert.ok(await until(() => seen.settings && seen.settings.defaults.mouse === "off"), "b's settings listener is told");

    a.data.identity.users["pk_n|id:1"] = { userId: 123, externalId: "id:1", createdAt: "2026-10-07T10:00:00.000Z" };
    await a.saveIdentity("pk_n|id:1");
    assert.ok(await until(() => b.data.identity.users["pk_n|id:1"] && seen.identity === "pk_n|id:1"), "b sees the identity");

    a.data.accounts.accounts.a_9 = { email: "z@example.com" }; a.data.accounts.byEmail["z@example.com"] = "a_9";
    await a.saveAccount("a_9");
    assert.ok(await until(() => b.data.accounts.byEmail["z@example.com"] === "a_9"), "b sees the account");
    a.data.accounts.revoked.jx = Math.floor(Date.now() / 1000) + 600;
    await a.saveRevoked("jx");
    assert.ok(await until(() => b.data.accounts.revoked.jx), "b refuses the revoked refresh token too");
  } finally { await a.close(); await b.close(); }
});

test("postgres: the database settles races between copies", { skip: !PG && "TEST_DATABASE_URL not set" }, async () => {
  await emptyPg();
  const a = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  const b = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  try {
    // the same user first seen by both copies at once (30 of them, all racing): one stored record each,
    // and both copies answer with it
    a.data.identity.users["pk_r|id:1"] = { userId: 555, externalId: "id:1", createdAt: "2026-10-07T10:00:00.000Z" };
    b.data.identity.users["pk_r|id:1"] = { userId: 555, externalId: "id:1", createdAt: "2026-10-07T10:00:01.000Z" };
    const [ra, rb] = await Promise.all([a.saveIdentity("pk_r|id:1"), b.saveIdentity("pk_r|id:1")]);
    assert.equal(ra.createdAt, rb.createdAt);
    const keys = Array.from({ length: 30 }, (_, i) => `pk_r|race:${i}`);
    for (const [i, k] of keys.entries()) {
      a.data.identity.users[k] = { userId: 7000 + i, externalId: `race:${i}`, createdAt: "2026-10-07T10:00:00.000Z" };
      b.data.identity.users[k] = { userId: 7000 + i, externalId: `race:${i}`, createdAt: "2026-10-07T10:00:02.000Z" };
    }
    const both = await Promise.all(keys.flatMap((k) => [a.saveIdentity(k), b.saveIdentity(k)]));
    for (let i = 0; i < keys.length; i++) assert.equal(both[2 * i].createdAt, both[2 * i + 1].createdAt, keys[i]);
    // two different users can never get one user id (they would share one biometric profile)
    a.data.identity.users["pk_r|id:2"] = { userId: 555, externalId: "id:2", createdAt: "2026-10-07T10:00:00.000Z" };
    await assert.rejects(a.saveIdentity("pk_r|id:2"), { code: "conflict" });
    // one email, two accounts registered on two copies at once: the second is refused
    a.data.accounts.accounts.a_1 = { email: "same@example.com" };
    b.data.accounts.accounts.a_2 = { email: "same@example.com" };
    const r = await Promise.allSettled([a.saveAccount("a_1"), b.saveAccount("a_2")]);
    assert.deepEqual(r.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(r.find((x) => x.status === "rejected").reason.code, "conflict");
  } finally { await a.close(); await b.close(); }
});

test("postgres: a user first seen while the database fails is saved once it is back", { skip: !PG && "TEST_DATABASE_URL not set" }, async () => {
  await emptyPg();
  const s = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  const { Client } = require("pg");
  const admin = new Client({ connectionString: PG });
  await admin.connect();
  const inDb = async (key) => (await admin.query("SELECT 1 FROM gw_identities WHERE key = $1", [key])).rowCount === 1;
  try {
    await admin.query("ALTER TABLE gw_identities RENAME TO gw_identities_away");   // writes fail, as when the database is down
    s.data.identity.users["pk_o|id:1"] = { userId: 901, externalId: "id:1", createdAt: "2026-10-07T10:00:00.000Z" };
    await assert.rejects(s.saveIdentity("pk_o|id:1"));
    await admin.query("ALTER TABLE gw_identities_away RENAME TO gw_identities");
    // the change feed drops and comes back: its reload keeps the unsaved record, and saves it
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE 'LISTEN%' AND pid <> pg_backend_pid()");
    let saved = false;
    for (let i = 0; i < 100 && !saved; i++) { await sleep(50); saved = await inDb("pk_o|id:1"); }
    assert.ok(saved, "saved after the reconnect");
    assert.equal(s.data.identity.users["pk_o|id:1"].userId, 901);
    // the other path: the next new user's save takes an earlier unsaved one along
    await admin.query("ALTER TABLE gw_identities RENAME TO gw_identities_away");
    s.data.identity.users["pk_o|id:2"] = { userId: 902, externalId: "id:2", createdAt: "2026-10-07T10:00:00.000Z" };
    await assert.rejects(s.saveIdentity("pk_o|id:2"));
    await admin.query("ALTER TABLE gw_identities_away RENAME TO gw_identities");
    s.data.identity.users["pk_o|id:3"] = { userId: 903, externalId: "id:3", createdAt: "2026-10-07T10:00:00.000Z" };
    await s.saveIdentity("pk_o|id:3");
    assert.ok(await inDb("pk_o|id:2") && await inDb("pk_o|id:3"));
  } finally {
    await admin.query("ALTER TABLE IF EXISTS gw_identities_away RENAME TO gw_identities").catch(() => {});
    await admin.end(); await s.close();
  }
});

test("postgres: ready() reports a lost database", { skip: !PG && "TEST_DATABASE_URL not set" }, async () => {
  await emptyPg();
  const s = await openStorage({ kind: "postgres", databaseUrl: PG, log: quiet });
  await s.ready();
  await s.close();
  await assert.rejects(s.ready());
});
