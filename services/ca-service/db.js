// The CA service owns ALL behavioral data — no shared DB with the demo app.
// Keystroke samples/events, per-user typing profiles, mouse profiles/samples,
// and the auth-decision log all live here, keyed by an opaque userId supplied
// by the caller. It stores no users, passwords, passkeys, or sessions.
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, "ca.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// Additive migration for databases created before text_hash/char_count existed.
function addColumnIfMissing(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.length && !cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS keystroke_texts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text_content TEXT NOT NULL,
    -- Derived from the text at write time so nothing downstream needs to read the text
    -- itself. Every stored-text consumer compares samples for EQUALITY (alias detection,
    -- duplicate detection, prompt-reuse detection) or wants a LENGTH (paste coverage,
    -- character totals); none needs the words. Keeping these two lets the plaintext be
    -- dropped without losing any capability.
    text_hash TEXT,
    char_count INTEGER,
    keystroke_timings TEXT,
    model_confidence REAL,
    is_suspicious INTEGER DEFAULT 0,
    sample_purpose TEXT DEFAULT 'activity',
    source_path TEXT,
    is_training INTEGER DEFAULT 0,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS keystroke_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keystroke_text_id INTEGER NOT NULL,
    key_code INTEGER,
    event_type TEXT,
    timestamp_relative REAL,
    field_name TEXT,
    field_type TEXT
  );

  CREATE TABLE IF NOT EXISTS user_typing_profiles (
    user_id INTEGER PRIMARY KEY,
    model_json TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    trained_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS auth_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    source TEXT,
    window_count INTEGER,
    mean_score REAL,
    threshold REAL,
    verdict TEXT,
    passkey_triggered INTEGER DEFAULT 0,
    passkey_outcome TEXT,
    per_window_scores TEXT
  );

  CREATE TABLE IF NOT EXISTS mouse_profiles (
    user_id INTEGER PRIMARY KEY,
    model_path TEXT NOT NULL,
    sample_windows INTEGER NOT NULL DEFAULT 0,
    balanced_accuracy REAL,
    trained_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mouse_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    windows TEXT NOT NULL,
    window_count INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Single source of truth for "this user has a passkey step-up pending,"
  -- shared by every caller (apps/demo's own session, the gateway, any future
  -- app) so the SDK can tell on page load whether to log out -- the client-side
  -- lock (guard.js's own locked var) is in-memory only and resets on reload.
  CREATE TABLE IF NOT EXISTS session_locks (
    user_id INTEGER PRIMARY KEY,
    locked_at DATETIME NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_kt_user ON keystroke_texts(user_id);
  CREATE INDEX IF NOT EXISTS idx_ke_text ON keystroke_events(keystroke_text_id);
  CREATE INDEX IF NOT EXISTS idx_ad_user ON auth_decisions(user_id);
  CREATE INDEX IF NOT EXISTS idx_mouse_samples_user ON mouse_samples(user_id);
`);

// Run after the CREATE TABLEs so both fresh and existing databases end up with the columns.
addColumnIfMissing("keystroke_texts", "text_hash", "TEXT");
addColumnIfMissing("keystroke_texts", "char_count", "INTEGER");

module.exports = db;
