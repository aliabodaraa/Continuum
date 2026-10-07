/**
 * Insert the KeyRecs-derived accounts.
 *
 * Two databases, two passes, because they live in different containers:
 *   pass "users" (web container)      -> demo continuum.db users table, prints an id map
 *   pass "samples" (ca-service)       -> ca.db keystroke_texts + keystroke_events
 *
 * The demo app assigns the user id, so the users pass runs first and its map is fed to the
 * samples pass. Behavioural data is keyed by that id, exactly as it is for a live signup.
 *
 * Provenance is recorded in the database itself (users.data_source), not just in a filename,
 * so anyone reading the table can see these are dataset-derived accounts rather than people
 * who enrolled through the app.
 *
 *   node seed_accounts_insert.js users   /path/accounts.json /path/idmap.json
 *   node seed_accounts_insert.js samples /path/accounts.json /path/idmap.json
 */
const fs = require("fs");
const Database = require("better-sqlite3");
// required lazily: only the "users" pass needs it, and it exists only in the web
// container, while the "samples" pass runs in ca-service

const [mode, accountsPath, idMapPath] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(accountsPath, "utf8"));

const PROVENANCE = data.source;
const DEMO_PASSWORD = "123";
const TEXT_HASH_SALT = process.env.TEXT_HASH_SALT || "continuum-text-hash-salt";
const textHash = (t) => require("crypto").createHmac("sha256", TEXT_HASH_SALT).update(String(t || "")).digest("hex"); // demo-only credential, per request; not for any deployed instance

if (mode === "users") {
  const db = new Database("/app/db/continuum.db");
  // additive column so provenance lives with the record
  const cols = db.prepare("SELECT * FROM users LIMIT 1").get() || {};
  if (!("data_source" in cols)) {
    db.exec("ALTER TABLE users ADD COLUMN data_source TEXT");
    console.log("added users.data_source");
  }
  const hash = require("bcryptjs").hashSync(DEMO_PASSWORD, 10);
  const find = db.prepare("SELECT id FROM users WHERE username = ?");
  const ins = db.prepare(
    "INSERT INTO users (username, password_hash, email, data_source) VALUES (?, ?, ?, ?)",
  );
  const upd = db.prepare("UPDATE users SET data_source = ? WHERE id = ?");
  const map = {};
  let created = 0;
  for (const a of data.accounts) {
    const existing = find.get(a.username);
    if (existing) {
      upd.run(PROVENANCE, existing.id);
      map[a.username] = existing.id;
      continue;
    }
    const r = ins.run(a.username, hash, `${a.participant}@keyrecs.dataset.invalid`, PROVENANCE);
    map[a.username] = r.lastInsertRowid;
    created++;
  }
  fs.writeFileSync(idMapPath, JSON.stringify(map, null, 2));
  console.log(`users: ${created} created, ${Object.keys(map).length} total mapped`);
  console.log(`password for every seeded account: ${DEMO_PASSWORD}`);
  db.close();
} else if (mode === "samples") {
  const db = new Database("/app/ca.db");
  const map = JSON.parse(fs.readFileSync(idMapPath, "utf8"));
  const insText = db.prepare(
    `INSERT INTO keystroke_texts (user_id, text_hash, char_count, is_training, sample_purpose, submitted_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  );
  const insEvent = db.prepare(
    `INSERT INTO keystroke_events (keystroke_text_id, key_code, event_type, timestamp_relative, field_name)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const already = db.prepare(
    "SELECT COUNT(*) n FROM keystroke_texts WHERE user_id = ? AND sample_purpose = 'keyrecs-seed'",
  );

  const tx = db.transaction((account, userId) => {
    let texts = 0;
    let events = 0;
    for (const [flag, list] of [[1, account.training], [0, account.heldOut]]) {
      for (const s of list) {
        const r = insText.run(userId, textHash(s.text), String(s.text || "").length, flag, "keyrecs-seed");
        for (const e of s.events) {
          insEvent.run(r.lastInsertRowid, e.keyCode, e.eventType, e.timestampRelative, "demo");
          events++;
        }
        texts++;
      }
    }
    return { texts, events };
  });

  let totalT = 0;
  let totalE = 0;
  let skipped = 0;
  for (const a of data.accounts) {
    const userId = map[a.username];
    if (!userId) {
      console.log(`  no id for ${a.username}, skipping`);
      continue;
    }
    if (already.get(userId).n > 0) {
      skipped++;
      continue; // idempotent: never double-insert on a re-run
    }
    const { texts, events } = tx(a, userId);
    totalT += texts;
    totalE += events;
  }
  console.log(`samples: ${totalT} texts, ${totalE} events inserted; ${skipped} accounts already seeded`);
  db.close();
} else {
  console.error("mode must be 'users' or 'samples'");
  process.exit(1);
}
