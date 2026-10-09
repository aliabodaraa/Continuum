// migrate.js: a SQLite file made by the service's own code, copied into a throwaway PostgreSQL database
// on TEST_DATABASE_URL and read back through the service's data layer. Skipped without it.
const os = require("os");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { BASE, freshDatabase } = require("./pg");
process.env.STORAGE = "postgres";

const test = require("node:test");
const assert = require("node:assert/strict");

// The source file, written by db.js on SQLite in its own process (as the running service writes it).
function makeSource(file, extra = "") {
  const script = `
    const db = require(${JSON.stringify(path.resolve(__dirname, "../db"))});
    (async () => {
      const t1 = await db.insert("INSERT INTO keystroke_texts (user_id, text_hash, char_count, is_training) VALUES (?, ?, ?, 1)", 4491128458193823, "h1", 150);
      for (let i = 0; i < 2500; i++) await db.run("INSERT INTO keystroke_events (keystroke_text_id, key_code, event_type, timestamp_relative, field_name) VALUES (?, ?, ?, ?, ?)", t1, 65 + (i % 26), i % 2 ? "keyup" : "keydown", i * 12.5, "f");
      const t2 = await db.insert("INSERT INTO keystroke_texts (user_id, text_hash, char_count) VALUES (?, ?, ?)", 7, "h2", 90);
      await db.run("DELETE FROM keystroke_texts WHERE id = ?", t2);   // its id must not come back
      await db.run("INSERT INTO auth_decisions (user_id, source, mean_score, threshold, verdict, per_window_scores) VALUES (?, ?, ?, ?, ?, ?)", 7, "check", 0.123456789012345, null, "genuine", "[0.1,0.99]");
      await db.run("INSERT INTO user_typing_profiles (user_id, model_json, sample_count) VALUES (?, ?, ?)", 7, JSON.stringify({ note: "Grüße, 東京", threshold: 0.5 }), 6);
      await db.run("INSERT INTO decision_state (user_id, key, value) VALUES (?, ?, ?)", 7, "ks_history", "[true,false]");
      await db.run("INSERT INTO decision_state (user_id, key, value) VALUES (?, ?, ?)", 7, "Mouse_streak", "2");
      await db.run("INSERT INTO training_jobs (user_id, modality, state, reason) VALUES (?, ?, 'queued', ?)", 7, "keystroke", "enrol");
      await db.run("INSERT INTO mouse_samples (user_id, windows, window_count) VALUES (?, ?, ?)", 7, JSON.stringify(Array.from({ length: 60 }, () => Array.from({ length: 50 }, () => [1.5, 2.25]))), 60);
      await db.run("INSERT INTO tenants (tenant_id, name) VALUES (?, ?)", "pk_demo", "Demo");
      await db.run("INSERT INTO principal_aliases (legacy_user_id, principal_id, tenant_id, source) VALUES (?, ?, ?, ?)", 7, 739935229538144, "pk_demo", "demo-direct");
      ${extra}
      await db.close();
    })().catch((e) => { console.error(e); process.exit(1); });`;
  execFileSync(process.execPath, ["-e", script], { env: { ...process.env, STORAGE: "sqlite", DB_PATH: file }, stdio: "inherit" });
}

if (!BASE) {
  test("migrate.js", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-migrate-"));
  const file = path.join(dir, "ca.db");
  let url;
  test.before(async () => { url = await freshDatabase("ca_migrate"); makeSource(file); });

  test("every table is copied and verified identical; values and links read back exactly", async () => {
    const { migrate } = require("../migrate");
    const report = await migrate({ from: file, to: url, log: () => {} });
    assert.equal(report.ok, true, JSON.stringify(report.tables.filter((t) => !t.identical || !t.sequenceOk)));
    const byTable = Object.fromEntries(report.tables.map((t) => [t.table, t.rows]));
    assert.equal(byTable.keystroke_events, 2500);
    assert.equal(byTable.keystroke_texts, 1);

    process.env.DATABASE_URL = url;
    const db = require("../db");
    const text = await db.get("SELECT id, user_id, submitted_at FROM keystroke_texts");
    assert.equal(text.user_id, 4491128458193823);
    assert.match(text.submitted_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    const ev = await db.all("SELECT timestamp_relative FROM keystroke_events WHERE keystroke_text_id = ? ORDER BY timestamp_relative, id", text.id);
    assert.equal(ev.length, 2500);
    assert.equal(ev[3].timestamp_relative, 37.5);
    const d = await db.get("SELECT mean_score, threshold, per_window_scores FROM auth_decisions");
    assert.deepEqual(d, { mean_score: 0.123456789012345, threshold: null, per_window_scores: "[0.1,0.99]" });
    assert.equal(JSON.parse((await db.get("SELECT model_json FROM user_typing_profiles WHERE user_id = 7")).model_json).note, "Grüße, 東京");
    assert.equal((await db.get("SELECT principal_id FROM principal_aliases WHERE legacy_user_id = 7")).principal_id, 739935229538144);
    // the deleted text's id is not given again
    const next = await db.insert("INSERT INTO keystroke_texts (user_id, text_hash) VALUES (?, ?)", 8, "h3");
    assert.equal(next, text.id + 2);
    // the queued job is still owed, and still the only pending one
    await assert.rejects(db.run("INSERT INTO training_jobs (user_id, modality) VALUES (?, ?)", 7, "keystroke"), /unique/i);
    await db.close();
  });

  test("a database that already holds rows is refused unless --replace; --replace copies again", async () => {
    const { migrate } = require("../migrate");
    await assert.rejects(migrate({ from: file, to: url, log: () => {} }), /refusing to mix/);
    const report = await migrate({ from: file, to: url, replace: true, log: () => {} });
    assert.equal(report.ok, true);
  });

  test("a table the service does not know is refused, never left behind", async () => {
    const { migrate } = require("../migrate");
    const other = path.join(dir, "other.db");
    makeSource(other, 'await db.exec("CREATE TABLE stray_notes (id INTEGER PRIMARY KEY, note TEXT)");');
    await assert.rejects(migrate({ from: other, to: url, replace: true, log: () => {} }), /does not know \(stray_notes\)/);
  });
}
