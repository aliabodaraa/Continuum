// A column added to a table that already exists (ADDED_COLUMNS in db.js) reaches PostgreSQL too (2026-11-08). It was
// added on SQLite only, so the first new column would have passed every test and failed on the live database with a
// 500. An older database is simulated by dropping four such columns from a new one; the data layer is then opened
// again, as a copy of the service does at start. In a throwaway database on TEST_DATABASE_URL; skipped without it.
const { BASE, freshDatabase } = require("./pg");
process.env.STORAGE = "postgres";

const test = require("node:test");
const assert = require("node:assert/strict");
if (!BASE) {
  test("PostgreSQL added columns", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  const db = require("../db");
  const columns = async () => new Map((await db.all(
    "SELECT table_name || '.' || column_name AS k, data_type AS t FROM information_schema.columns WHERE table_schema = current_schema()",
  )).map((r) => [r.k, r.t]));
  const DROPPED = ["training_jobs.lease_until", "training_jobs.locked_by", "keystroke_texts.char_count", "mouse_profiles.threshold"];
  test.before(async () => { process.env.DATABASE_URL = await freshDatabase("ca_columns"); });
  test.after(() => db.close());

  test("an older database gets the columns added since, with the same types as a new one", async () => {
    await db.open();
    const fresh = await columns();
    await db.exec("ALTER TABLE training_jobs DROP COLUMN lease_until, DROP COLUMN locked_by");
    await db.exec("ALTER TABLE keystroke_texts DROP COLUMN char_count");
    await db.exec("ALTER TABLE mouse_profiles DROP COLUMN threshold");
    const old = await columns();
    for (const k of DROPPED) assert.equal(old.has(k), false, `${k} was dropped`);
    await db.close();
    await db.open();
    const now = await columns();
    for (const k of DROPPED) assert.equal(now.get(k), fresh.get(k), `${k}: ${now.get(k)} (a new database: ${fresh.get(k)})`);
    assert.equal(now.size, fresh.size, "nothing else changed");
    // the code that needs them works again: the training queue's lease
    await db.run("INSERT INTO training_jobs (user_id, modality, state, locked_by, lease_until) VALUES (?, ?, 'running', ?, ?)",
      1, "keystroke", "copy-a", "2026-11-08 12:00:00");
    assert.deepEqual(await db.get("SELECT locked_by, lease_until FROM training_jobs WHERE user_id = ?", 1),
      { locked_by: "copy-a", lease_until: "2026-11-08 12:00:00" });
  });

  test("opening a database that is already up to date alters nothing", async () => {
    const before = await columns();
    await db.close();
    await db.open();
    assert.deepEqual([...(await columns())], [...before]);
  });
}
