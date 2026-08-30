// The demo app reaches the CA service by two different identities:
//   server-side routes  -> req.session.userId          (the demo users.id)
//   SDK / gateway path  -> HMAC(siteKey|"id:"+userId)  (userFor() in gateway/server.js)
// Seeding only the first left the SDK panel seeing an empty account, which is what shows
// "Sample 1 / 5". Mirror every seeded sample onto the gateway identity so BOTH paths
// resolve to the same typing history — the arrangement account id 1 already has.
const fs = require("fs");
const Database = require("better-sqlite3");
const db = new Database("/app/ca.db");
const map = JSON.parse(fs.readFileSync("/app/gwmap.json", "utf8"));

const texts = db.prepare(
  "SELECT id, text_hash, char_count, is_training, sample_purpose FROM keystroke_texts WHERE user_id = ? AND sample_purpose = 'keyrecs-seed' ORDER BY id",
);
const events = db.prepare(
  "SELECT key_code, event_type, timestamp_relative, field_name FROM keystroke_events WHERE keystroke_text_id = ? ORDER BY id",
);
const insText = db.prepare(
  "INSERT INTO keystroke_texts (user_id, text_hash, char_count, is_training, sample_purpose, submitted_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
);
const insEvent = db.prepare(
  "INSERT INTO keystroke_events (keystroke_text_id, key_code, event_type, timestamp_relative, field_name) VALUES (?, ?, ?, ?, ?)",
);
const already = db.prepare(
  "SELECT COUNT(*) n FROM keystroke_texts WHERE user_id = ? AND sample_purpose = 'keyrecs-seed'",
);

let copied = 0, skipped = 0, evTotal = 0;
const tx = db.transaction((demoId, gwId) => {
  let ev = 0;
  for (const t of texts.all(demoId)) {
    const r = insText.run(gwId, t.text_hash, t.char_count, t.is_training, t.sample_purpose);
    for (const e of events.all(t.id)) {
      insEvent.run(r.lastInsertRowid, e.key_code, e.event_type, e.timestamp_relative, e.field_name);
      ev++;
    }
  }
  return ev;
});

for (const [demoId, gwId] of Object.entries(map)) {
  if (already.get(gwId).n > 0) { skipped++; continue; }   // idempotent
  evTotal += tx(Number(demoId), gwId);
  copied++;
}
console.log(`mirrored ${copied} accounts onto gateway ids (${evTotal} events); ${skipped} already present`);
