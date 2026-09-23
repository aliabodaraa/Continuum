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
    -- text_content was removed: the plaintext a user typed is no longer stored anywhere.
    -- Derived from the text in memory at write time so nothing downstream needs the text
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

  -- Action-based mouse profile (Antal & Egyed-Zsigmond, IET Biometrics 2019).
  -- Separate from mouse_profiles/mouse_samples: the two pipelines store
  -- different things (39-feature action vectors vs 50x7 windows) and must be
  -- able to coexist while the window path is kept as a comparison arm.
  CREATE TABLE IF NOT EXISTS mouse_action_profiles (
    user_id INTEGER PRIMARY KEY,
    model_path TEXT NOT NULL,
    sample_actions INTEGER NOT NULL,
    trained_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mouse_action_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    actions TEXT NOT NULL,
    action_count INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_mouse_action_samples_user ON mouse_action_samples(user_id);

  -- DURABLE DECISION STATE.
  --
  -- The keystroke challenge debounce (2 of the last 3 checks) and the mouse suspicious
  -- streak used to live in process memory: a 'Map' in ca-service, another 'Map' in the
  -- gateway, and 'req.session.mouseSuspiciousStreak' in the demo. Three copies of one
  -- fact, all of them lost on restart.
  --
  -- The failure that matters is not the lost counter, it is WHO benefits from losing it.
  -- An impostor one suspicious check away from a step-up gets a clean slate from any
  -- restart — a deploy, a crash, an OOM kill. The debounce exists precisely to accumulate
  -- evidence across checks, so state that cannot survive a restart is a debounce with a
  -- reset button. It is also why the gateway cannot run two replicas: two processes would
  -- each hold half the evidence and neither would ever reach the threshold.
  --
  -- Generic (user_id, key) rather than a column per counter: these are small, they change
  -- together, and new modalities should not need a migration to get one.
  CREATE TABLE IF NOT EXISTS decision_state (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, key)
  );

  -- DURABLE TRAINING QUEUE.
  --
  -- Adaptive retraining used to be 'setImmediate(...)' guarded by an in-memory Set. Both
  -- halves failed on restart: the in-flight run vanished mid-training (leaving a possibly
  -- half-written model directory), and the guard that prevents a duplicate run vanished
  -- with it. Nothing recorded that training had been owed, so the work was simply lost and
  -- the user's model silently stopped keeping up with them.
  --
  -- A row is the durable record of owed work. 'state' makes an interrupted run recoverable:
  -- on boot the worker returns anything still marked 'running' to 'queued', because a
  -- process that is gone cannot be running anything. 'attempts' bounds the retry so a
  -- permanently unsatisfiable job (corrupt samples, a model shape that no longer loads)
  -- fails loudly instead of spinning forever.
  CREATE TABLE IF NOT EXISTS training_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    modality TEXT NOT NULL DEFAULT 'keystroke',
    state TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    finished_at DATETIME
  );

  -- The worker claims by (state, id) and callers dedupe by (user_id, modality, state).
  CREATE INDEX IF NOT EXISTS idx_jobs_state ON training_jobs(state, id);
  CREATE INDEX IF NOT EXISTS idx_jobs_user ON training_jobs(user_id, modality, state);
`);

// Run after the CREATE TABLEs so both fresh and existing databases end up with the columns.
addColumnIfMissing("keystroke_texts", "text_hash", "TEXT");
addColumnIfMissing("keystroke_texts", "char_count", "INTEGER");
// Mouse profiles now carry the per-user decision threshold (5th percentile of the user's own
// enrolment scores) and the feature version the model was trained on, so a profile built on the
// retired 7-feature representation is recognised and retrained instead of mis-scored.
addColumnIfMissing("mouse_profiles", "threshold", "REAL");
addColumnIfMissing("mouse_profiles", "feature_version", "TEXT");
addColumnIfMissing("mouse_profiles", "enrol_percentiles", "TEXT");
// One row per scored mouse check (lib/mouse.js checkMouse): what the model saw and decided.
db.exec(`CREATE TABLE IF NOT EXISTS mouse_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  window_count INTEGER,
  threshold REAL,
  low_windows INTEGER,
  vote_k INTEGER,
  vote_n INTEGER,
  warmup INTEGER,
  suspicious INTEGER,
  scores TEXT
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_mouse_decisions_user ON mouse_decisions(user_id, id)");

module.exports = db;
