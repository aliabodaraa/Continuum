const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// DB location is env-driven so production can point it at a mounted volume
// (persistent, outside the image) while dev keeps the in-source default. The
// default is unchanged, so nothing about local development moves.
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, "continuum.db");
// Ensure the parent dir exists (a fresh named volume starts empty).
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

// Create tables if not exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT,
    profile_photo TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- DEPRECATED: passkey credentials + challenges now live in the standalone
  -- passkey-service (its own DB). These tables are kept only so existing
  -- databases still open cleanly; the app no longer reads or writes them.
  CREATE TABLE IF NOT EXISTS passkey_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    transports TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    challenge TEXT UNIQUE NOT NULL,
    challenge_type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    used INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// The demo app stores NO behavioral samples of its own. Keystroke/mouse texts,
// events, per-user models, samples, and the auth-decision log all live in the
// Continuum CA service (our solution), keyed by user id — the demo just forwards
// that id (via caClient) and the CA retrieves the samples + retrains on adaptive
// update and on submit. These tables are legacy (pre-service-split); drop them so
// the demo genuinely persists no biometric data. Child tables first (FK order).
for (const t of [
  "keystroke_events",
  "keystroke_texts",
  "user_typing_profiles",
  "auth_decisions",
  "mouse_profiles",
  "mouse_samples",
]) {
  db.exec(`DROP TABLE IF EXISTS ${t}`);
}

const userColumns = db.prepare("PRAGMA table_info(users)").all().map((col) => col.name);
if (!userColumns.includes("profile_photo")) {
  db.exec("ALTER TABLE users ADD COLUMN profile_photo TEXT");
}

module.exports = db;
