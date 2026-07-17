// One-time migration: copy behavioral data from the demo app's old bundled DB
// into this CA service's DB, so existing enrollments/models/history survive the
// split. Run once:  node migrate-from-app.js /path/to/old-app.db
const Database = require("better-sqlite3");
const dst = require("./db");

const srcPath = process.argv[2];
if (!srcPath) {
  console.error("usage: node migrate-from-app.js <path-to-old-app-db>");
  process.exit(1);
}
const src = new Database(srcPath, { readonly: true });

// (table, columns) — copied verbatim, preserving primary keys so foreign links
// (keystroke_events.keystroke_text_id) stay valid.
const TABLES = {
  keystroke_texts: ["id", "user_id", "text_content", "keystroke_timings", "model_confidence", "is_suspicious", "sample_purpose", "source_path", "is_training", "submitted_at"],
  keystroke_events: ["id", "keystroke_text_id", "key_code", "event_type", "timestamp_relative", "field_name", "field_type"],
  user_typing_profiles: ["user_id", "model_json", "sample_count", "trained_at"],
  auth_decisions: ["id", "user_id", "checked_at", "source", "window_count", "mean_score", "threshold", "verdict", "passkey_triggered", "passkey_outcome", "per_window_scores"],
  mouse_profiles: ["user_id", "model_path", "sample_windows", "balanced_accuracy", "trained_at"],
  mouse_samples: ["id", "user_id", "windows", "window_count", "created_at"],
};

function tableExists(dbh, name) {
  return !!dbh.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

for (const [table, cols] of Object.entries(TABLES)) {
  if (!tableExists(src, table)) { console.log(`- ${table}: not in source, skipped`); continue; }
  const rows = src.prepare(`SELECT ${cols.join(",")} FROM ${table}`).all();
  const placeholders = cols.map(() => "?").join(",");
  const ins = dst.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`);
  const many = dst.transaction((all) => {
    let n = 0;
    for (const r of all) n += ins.run(...cols.map((c) => r[c])).changes;
    return n;
  });
  console.log(`  ${table}: migrated ${many(rows)} / ${rows.length}`);
}
console.log("done");
