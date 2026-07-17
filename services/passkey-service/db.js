// The passkey service owns its OWN store — no shared database with the app.
// It keeps only what FIDO2 needs: credentials and challenges, keyed by an
// opaque userId supplied by the caller. It does NOT store users, passwords,
// behavioral models, or session state.
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, "passkey.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS passkey_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    transports TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    challenge TEXT NOT NULL,
    challenge_type TEXT,          -- 'registration' | 'authentication'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    used INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_pk_cred_user ON passkey_credentials(user_id);
  CREATE INDEX IF NOT EXISTS idx_pk_chal_user ON webauthn_challenges(user_id);
`);

module.exports = db;
