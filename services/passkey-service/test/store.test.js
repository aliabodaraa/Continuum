// The passkey service's store (store.js): the same contract for both backends; races between two copies
// and the migration on postgres only (TEST_DATABASE_URL, a throwaway server). node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { openStore } = require("../store");
const { BASE, freshDatabase, emptyTables, query } = require("./pg");

let PG = "";
test.before(async () => { PG = await freshDatabase("passkey"); });
const PG_ONLY = { skip: !BASE && "TEST_DATABASE_URL not set" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pk-store-")), "passkey.db");
const cred = (n) => ({ credentialId: "cred-" + n, publicKey: "pub-" + n, counter: 0, transports: JSON.stringify(["internal"]) });

const backends = [{ name: "sqlite", open: async () => openStore({ kind: "sqlite", dbPath: tmpDb() }) }];
if (BASE) backends.push({ name: "postgres", open: async () => { await emptyTables(PG); return openStore({ kind: "postgres", databaseUrl: PG }); } });

for (const b of backends) {
  test(`${b.name}: credentials are kept per user, found by either id form, counted, reset`, async () => {
    const s = await b.open();
    try {
      await s.addCredential(4503599627370001, cred(1));
      await s.addCredential(4503599627370001, cred(2));
      await s.addCredential(7, cred(3));
      assert.equal(await s.countCredentials(4503599627370001), 2, "a 52-bit Continuum user id works");
      assert.deepEqual((await s.listCredentials(4503599627370001)).map((c) => c.credential_id), ["cred-1", "cred-2"]);
      const found = await s.findCredential(4503599627370001, ["legacy-hex", "cred-2"]);
      assert.equal(found.credential_id, "cred-2");
      assert.equal(found.user_id, 4503599627370001);
      assert.equal(await s.findCredential(7, ["cred-1"]), null, "another user's credential is not found");
      await assert.rejects(s.addCredential(9, cred(1)), { code: "conflict" }, "one credential belongs to one user");
      await s.updateCounter(found.id, 41);
      assert.equal((await s.findCredential(4503599627370001, ["cred-2"])).counter, 41);
      await s.saveChallenge(4503599627370001, "c1", "authentication", 60000);
      assert.equal(await s.resetUser(4503599627370001), 2);
      assert.equal(await s.countCredentials(4503599627370001), 0);
      assert.equal(await s.takeChallenge({ userId: 4503599627370001, type: "authentication" }), null, "its challenges go too");
      assert.equal(await s.countCredentials(7), 1, "other users keep theirs");
    } finally { await s.close(); }
  });

  test(`${b.name}: an id that is not a whole number is no challenge, and not an error`, async () => {
    const s = await b.open();
    try {
      await s.saveChallenge(11, "ch-x", "authentication", 60000);
      for (const id of ["abc", "NaN", NaN, 1.5, -1, 0, "1e400", Infinity, "", {}, [], [5], true]) {
        assert.equal(await s.takeChallenge({ id, userId: 11, type: "authentication" }), null, `id ${JSON.stringify(id)} ${String(id)}`);
      }
      // none of that used the real challenge up
      assert.equal((await s.takeChallenge({ userId: 11, type: "authentication" })).challenge, "ch-x");
    } finally { await s.close(); }
  });

  test(`${b.name}: a challenge is taken once, by its user and kind, and expires`, async () => {
    const s = await b.open();
    try {
      const id = await s.saveChallenge(11, "ch-a", "authentication", 60000);
      assert.equal(typeof id, "number");
      assert.equal(await s.takeChallenge({ id, userId: 12, type: "authentication" }), null, "not another user's");
      assert.equal(await s.takeChallenge({ id, userId: 11, type: "registration" }), null, "not another kind");
      const t = await s.takeChallenge({ id, userId: 11, type: "authentication" });
      assert.equal(t.challenge, "ch-a");
      assert.equal(t.expired, false);
      assert.equal(await s.takeChallenge({ id, userId: 11, type: "authentication" }), null, "taken once");
      // registration: the latest unused one
      await s.saveChallenge(11, "reg-old", "registration", 60000);
      await s.saveChallenge(11, "reg-new", "registration", 60000);
      assert.equal((await s.takeChallenge({ userId: 11, type: "registration" })).challenge, "reg-new");
      // expired: reported as such, and used up
      const old = await s.saveChallenge(11, "ch-old", "authentication", 30);
      await sleep(80);
      const e = await s.takeChallenge({ id: old, userId: 11, type: "authentication" });
      assert.equal(e.expired, true);
      assert.equal(await s.takeChallenge({ id: old, userId: 11, type: "authentication" }), null);
    } finally { await s.close(); }
  });
}

test("postgres: one challenge, ten requests on two copies at once: one succeeds", PG_ONLY, async () => {
  await emptyTables(PG);
  const a = await openStore({ kind: "postgres", databaseUrl: PG });
  const b = await openStore({ kind: "postgres", databaseUrl: PG });
  try {
    for (let round = 0; round < 5; round++) {
      const id = await a.saveChallenge(21, "race-" + round, "authentication", 60000);
      const got = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).takeChallenge({ id, userId: 21, type: "authentication" })));
      assert.equal(got.filter(Boolean).length, 1, `round ${round}`);
    }
    // two copies registering the same credential at once: one keeps it
    const r = await Promise.allSettled([a.addCredential(21, cred(9)), b.addCredential(22, cred(9))]);
    assert.deepEqual(r.map((x) => x.status).sort(), ["fulfilled", "rejected"]);
  } finally { await a.close(); await b.close(); }
});

test("postgres: old used challenges are swept, recent ones stay", PG_ONLY, async () => {
  await emptyTables(PG);
  const s = await openStore({ kind: "postgres", databaseUrl: PG });
  try {
    const oldId = await s.saveChallenge(31, "old", "authentication", 60000);
    await s.takeChallenge({ id: oldId, userId: 31, type: "authentication" });
    await query(PG, "UPDATE webauthn_challenges SET created_at = now() - interval '2 days' WHERE id = $1", [oldId]);
    await s.saveChallenge(31, "fresh", "authentication", 60000);
    await s.sweep();
    assert.deepEqual((await query(PG, "SELECT challenge FROM webauthn_challenges ORDER BY id")).map((r) => r.challenge), ["fresh"]);
  } finally { await s.close(); }
});

test("postgres: migrate.js copies a SQLite file, verifies it, refuses to mix, and --replace repeats it", PG_ONLY, async () => {
  await emptyTables(PG);
  const file = tmpDb();
  const src = await openStore({ kind: "sqlite", dbPath: file });
  for (let i = 0; i < 5; i++) await src.addCredential(100 + (i % 2), cred("m" + i));
  await src.updateCounter((await src.findCredential(100, ["cred-m0"])).id, 7);
  await src.close();
  const migrate = (...extra) => execFileSync(process.execPath, [path.join(__dirname, "..", "migrate.js"), "--from", file, "--to", PG, ...extra], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(migrate(), /verified: 5 credentials of 2 users .*identical/);
  assert.throws(() => migrate(), /refusing to mix/);
  assert.match(migrate("--replace"), /verified: 5 credentials/);
  const s = await openStore({ kind: "postgres", databaseUrl: PG });
  try {
    assert.equal(await s.countCredentials(100), 3);
    assert.equal((await s.findCredential(100, ["cred-m0"])).counter, 7, "the counter came along");
  } finally { await s.close(); }
});
