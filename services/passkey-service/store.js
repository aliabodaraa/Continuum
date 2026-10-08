// Where this service keeps passkeys and WebAuthn challenges. STORAGE picks the backend:
//   sqlite    (default) one file (DB_PATH), as before: one copy of the service
//   postgres  DATABASE_URL: this service's own database, so several copies can run side by side
// Both keep the same two tables and the same rules. A challenge is TAKEN in one atomic statement (marked
// used as it is read, and only while unused and unexpired), so a challenge answers one ceremony even when
// two requests carrying it arrive at once on different copies: many synced passkeys keep their signature
// counter at 0, so the counter alone would not stop a replay.
const SCHEMA_SQLITE = `
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
`;
const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS passkey_credentials (
    id            bigserial PRIMARY KEY,
    user_id       bigint NOT NULL,
    credential_id text NOT NULL UNIQUE,
    public_key    text NOT NULL,
    counter       bigint NOT NULL DEFAULT 0,
    transports    text,
    created_at    timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id             bigserial PRIMARY KEY,
    user_id        bigint NOT NULL,
    challenge      text NOT NULL,
    challenge_type text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    used           boolean NOT NULL DEFAULT false
  );
  CREATE INDEX IF NOT EXISTS idx_pk_cred_user ON passkey_credentials (user_id);
  CREATE INDEX IF NOT EXISTS idx_pk_chal_user ON webauthn_challenges (user_id, challenge_type, id DESC);
`;
const SCHEMA_LOCK = 4000417;   // pg_advisory_xact_lock: copies starting together create the tables once

function conflict(message) { return Object.assign(new Error(message), { code: "conflict" }); }
// One shape for a credential row, whichever backend (numbers as numbers; PostgreSQL returns bigint as text).
const credRow = (r) => (r ? { id: Number(r.id), user_id: Number(r.user_id), credential_id: r.credential_id, public_key: r.public_key,
  counter: Number(r.counter || 0), transports: r.transports || null } : null);
const chalRow = (r, expired) => (r ? { id: Number(r.id), user_id: Number(r.user_id), challenge: r.challenge, challenge_type: r.challenge_type, expired: !!expired } : null);

// ---------------------------------------------------------------- sqlite
function openSqlite(dbPath) {
  const path = require("path");
  const fs = require("fs");
  const Database = require("better-sqlite3");
  const file = dbPath ? path.resolve(dbPath) : path.resolve(__dirname, "passkey.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(SCHEMA_SQLITE);
  // A challenge is taken (marked used) whether or not it has expired, so an expired one cannot be retried.
  const take = db.transaction((sel, args) => {
    const row = db.prepare(sel).get(...args);
    if (!row) return null;
    const changed = db.prepare("UPDATE webauthn_challenges SET used = 1 WHERE id = ? AND used = 0").run(row.id).changes;
    if (!changed) return null;
    return chalRow(row, !row.expires_at || new Date(row.expires_at) <= new Date());
  });
  return {
    kind: "sqlite",
    db,
    async countCredentials(userId) { return db.prepare("SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id = ?").get(userId).n; },
    async listCredentials(userId) { return db.prepare("SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY id").all(userId).map(credRow); },
    async findCredential(userId, ids) {
      const q = `SELECT * FROM passkey_credentials WHERE user_id = ? AND credential_id IN (${ids.map(() => "?").join(", ")})`;
      return credRow(db.prepare(q).get(userId, ...ids));
    },
    async addCredential(userId, c) {
      try {
        db.prepare("INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)")
          .run(userId, c.credentialId, c.publicKey, c.counter || 0, c.transports || null);
      } catch (e) { if (/UNIQUE/.test(e.message)) throw conflict("credential_exists"); throw e; }
    },
    async updateCounter(id, counter) { db.prepare("UPDATE passkey_credentials SET counter = ? WHERE id = ?").run(counter, id); },
    async resetUser(userId) {
      return db.transaction(() => {
        const n = db.prepare("DELETE FROM passkey_credentials WHERE user_id = ?").run(userId).changes;
        db.prepare("DELETE FROM webauthn_challenges WHERE user_id = ?").run(userId);
        return n;
      })();
    },
    async saveChallenge(userId, challenge, type, ttlMs) {
      return Number(db.prepare("INSERT INTO webauthn_challenges (user_id, challenge, challenge_type, expires_at) VALUES (?, ?, ?, ?)")
        .run(userId, challenge, type, new Date(Date.now() + ttlMs).toISOString()).lastInsertRowid);
    },
    // { id } takes that challenge (it must belong to userId); without an id, the user's latest unused one of that type.
    async takeChallenge({ id, userId, type }) {
      return id != null
        ? take("SELECT * FROM webauthn_challenges WHERE id = ? AND user_id = ? AND challenge_type = ? AND used = 0", [Number(id), userId, type])
        : take("SELECT * FROM webauthn_challenges WHERE user_id = ? AND challenge_type = ? AND used = 0 ORDER BY id DESC LIMIT 1", [userId, type]);
    },
    // Used and expired challenges are only history: dropped after a day.
    async sweep() {
      db.prepare("DELETE FROM webauthn_challenges WHERE (used = 1 OR expires_at < ?) AND created_at < datetime('now', '-1 day')").run(new Date().toISOString());
    },
    async ready() { db.prepare("SELECT 1").get(); },
    async close() { db.close(); },
  };
}

// ---------------------------------------------------------------- postgres
async function openPostgres(databaseUrl) {
  let pg;
  try { pg = require("pg"); } catch (e) { throw new Error("STORAGE=postgres needs the 'pg' package (the image has it)"); }
  if (!databaseUrl) throw new Error("STORAGE=postgres needs DATABASE_URL (postgres://user:password@host:5432/db)");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: Number(process.env.DATABASE_POOL_MAX || 5) });
  pool.on("error", (e) => console.error(`[storage] idle database connection failed: ${e.message}`));
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK]);
    await c.query(SCHEMA_PG);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }

  // One statement: of two requests carrying the same challenge, only one gets it back.
  const TAKE = (where) => `UPDATE webauthn_challenges SET used = true
    WHERE id = (SELECT id FROM webauthn_challenges WHERE ${where} AND used = false ORDER BY id DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
      AND used = false
    RETURNING id, user_id, challenge, challenge_type, expires_at <= now() AS expired`;
  return {
    kind: "postgres",
    async countCredentials(userId) { return Number((await pool.query("SELECT count(*) AS n FROM passkey_credentials WHERE user_id = $1", [userId])).rows[0].n); },
    async listCredentials(userId) { return (await pool.query("SELECT * FROM passkey_credentials WHERE user_id = $1 ORDER BY id", [userId])).rows.map(credRow); },
    async findCredential(userId, ids) {
      return credRow((await pool.query("SELECT * FROM passkey_credentials WHERE user_id = $1 AND credential_id = ANY($2) LIMIT 1", [userId, ids])).rows[0]);
    },
    async addCredential(userId, cr) {
      try {
        await pool.query("INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports) VALUES ($1, $2, $3, $4, $5)",
          [userId, cr.credentialId, cr.publicKey, cr.counter || 0, cr.transports || null]);
      } catch (e) { if (e.code === "23505") throw conflict("credential_exists"); throw e; }
    },
    async updateCounter(id, counter) { await pool.query("UPDATE passkey_credentials SET counter = $2 WHERE id = $1", [id, counter]); },
    async resetUser(userId) {
      const k = await pool.connect();
      try {
        await k.query("BEGIN");
        const n = (await k.query("DELETE FROM passkey_credentials WHERE user_id = $1", [userId])).rowCount;
        await k.query("DELETE FROM webauthn_challenges WHERE user_id = $1", [userId]);
        await k.query("COMMIT");
        return n;
      } catch (e) { await k.query("ROLLBACK").catch(() => {}); throw e; } finally { k.release(); }
    },
    async saveChallenge(userId, challenge, type, ttlMs) {
      const r = await pool.query(`INSERT INTO webauthn_challenges (user_id, challenge, challenge_type, expires_at)
        VALUES ($1, $2, $3, now() + ($4::double precision * interval '1 millisecond')) RETURNING id`, [userId, challenge, type, ttlMs]);
      return Number(r.rows[0].id);
    },
    async takeChallenge({ id, userId, type }) {
      const r = id != null
        ? await pool.query(TAKE("id = $1 AND user_id = $2 AND challenge_type = $3"), [Number(id), userId, type])
        : await pool.query(TAKE("user_id = $1 AND challenge_type = $2"), [userId, type]);
      return r.rows[0] ? chalRow(r.rows[0], r.rows[0].expired) : null;
    },
    async sweep() { await pool.query("DELETE FROM webauthn_challenges WHERE (used OR expires_at < now()) AND created_at < now() - interval '1 day'"); },
    async ready() { await pool.query("SELECT 1"); },
    async close() { await pool.end(); },
  };
}

async function openStore({ kind, dbPath, databaseUrl } = {}) {
  const k = String(kind || "sqlite").toLowerCase();
  if (k === "sqlite") return openSqlite(dbPath);
  if (k === "postgres") return openPostgres(databaseUrl);
  throw new Error(`STORAGE must be sqlite or postgres (got ${kind})`);
}

module.exports = { openStore, SCHEMA_SQLITE };
