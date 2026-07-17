// Re-key previously-enrolled demo users onto their Continuum identity.
//
// WHY: users who trained via the demo's OWN pages have their CA data keyed by the
// demo's session userId (small ints: 1,2,…). In gateway/SDK mode the same person
// is identified by a deterministic Continuum id = userFor("pk_demo","id:"+userId),
// so the gateway found no model and forced re-onboarding. This copies each trained
// user's keystroke + mouse enrollment (DB rows, with artifact paths rewritten) onto
// their Continuum id. The model WEIGHTS are copied separately on the host (the
// artifact dirs aren't mounted in this container) using the mapping this prints.
//
// Idempotent: skips a target that already has a profile. DB-only; run in the
// ca-service container:  node migrate-identity.js
const crypto = require("crypto");
const db = require("./db");

const SECRET = process.env.GATEWAY_SESSION_SECRET || "dev-gateway-session-secret";
const SITEKEY = process.env.MIGRATE_SITEKEY || "pk_demo";
// Continuum ids are 13-hex-digit ints (~1e14–4.5e15); demo ids are small. Anything
// at/under this is treated as a demo id to migrate (avoids re-migrating targets).
const MAX_DEMO_ID = Number(process.env.MIGRATE_MAX_DEMO_ID || 1e9);

// MUST match gateway userFor(): HMAC-SHA256(secret, siteKey|externalId), first 13 hex → int.
function continuumId(demoUserId) {
  const h = crypto.createHmac("sha256", SECRET).update(SITEKEY + "|id:" + String(demoUserId)).digest("hex");
  return parseInt(h.slice(0, 13), 16);
}

// Every demo user with ANY keystroke/mouse data — profiles, trained samples, or
// raw enrollment windows (not just trained users).
const demoUsers = new Set();
for (const t of ["user_typing_profiles", "mouse_profiles", "keystroke_texts", "mouse_samples"]) {
  for (const r of db.prepare(`SELECT DISTINCT user_id FROM ${t}`).all()) {
    if (Number(r.user_id) <= MAX_DEMO_ID) demoUsers.add(Number(r.user_id));
  }
}

const migrateOne = db.transaction((U, C) => {
  // keystroke profile — rewrite the artifact path user-U → user-C
  const kp = db.prepare("SELECT model_json, sample_count FROM user_typing_profiles WHERE user_id = ?").get(U);
  if (kp) {
    const mj = kp.model_json.split(`user-${U}/`).join(`user-${C}/`);
    db.prepare(
      `INSERT INTO user_typing_profiles (user_id, model_json, sample_count, trained_at)
       VALUES (?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET model_json=excluded.model_json, sample_count=excluded.sample_count, trained_at=CURRENT_TIMESTAMP`,
    ).run(C, mj, kp.sample_count);
  }
  // mouse profile — rewrite model_path user-U → user-C
  const mp = db.prepare("SELECT model_path, sample_windows, balanced_accuracy FROM mouse_profiles WHERE user_id = ?").get(U);
  if (mp) {
    const path = mp.model_path.split(`user-${U}/`).join(`user-${C}/`);
    db.prepare(
      `INSERT INTO mouse_profiles (user_id, model_path, sample_windows, balanced_accuracy, trained_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET model_path=excluded.model_path, sample_windows=excluded.sample_windows, balanced_accuracy=excluded.balanced_accuracy, trained_at=CURRENT_TIMESTAMP`,
    ).run(C, path, mp.sample_windows, mp.balanced_accuracy);
  }
  // mouse samples (raw enrollment windows → future retrains)
  const insMs = db.prepare("INSERT INTO mouse_samples (user_id, windows, window_count, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)");
  for (const s of db.prepare("SELECT windows, window_count FROM mouse_samples WHERE user_id = ?").all(U)) insMs.run(C, s.windows, s.window_count);
  // keystroke texts + their events (remap the text PK so events stay linked)
  const insText = db.prepare(
    `INSERT INTO keystroke_texts (user_id, text_content, keystroke_timings, model_confidence, is_suspicious, sample_purpose, source_path, is_training, submitted_at)
     VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
  );
  const insEvent = db.prepare(
    "INSERT INTO keystroke_events (keystroke_text_id, key_code, event_type, timestamp_relative, field_name, field_type) VALUES (?,?,?,?,?,?)",
  );
  for (const t of db.prepare("SELECT * FROM keystroke_texts WHERE user_id = ?").all(U)) {
    const newId = insText.run(C, t.text_content, t.keystroke_timings, t.model_confidence, t.is_suspicious, t.sample_purpose, t.source_path, t.is_training).lastInsertRowid;
    for (const e of db.prepare("SELECT * FROM keystroke_events WHERE keystroke_text_id = ?").all(t.id)) {
      insEvent.run(newId, e.key_code, e.event_type, e.timestamp_relative, e.field_name, e.field_type);
    }
  }
});

const mapping = {};
for (const U of [...demoUsers].sort((a, b) => a - b)) {
  const C = continuumId(U);
  // Idempotent: skip if the target already has ANY data (profile OR samples).
  const exists = db.prepare(
    "SELECT 1 FROM user_typing_profiles WHERE user_id=? UNION SELECT 1 FROM mouse_profiles WHERE user_id=? UNION SELECT 1 FROM keystroke_texts WHERE user_id=? UNION SELECT 1 FROM mouse_samples WHERE user_id=?",
  ).get(C, C, C, C);
  if (exists) { console.log(`skip  ${U} -> ${C} (target already has data)`); mapping[U] = C; continue; }
  migrateOne(U, C);
  mapping[U] = C;
  console.log(`migrate ${U} -> ${C}`);
}
// Last line: machine-readable mapping for the host-side artifact copy.
console.log("MAPPING " + JSON.stringify(mapping));
