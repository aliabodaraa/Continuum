// The SQLite file of this service (STORAGE=sqlite), opened directly: for the maintenance scripts
// (scripts/rekey-users.js, migrate.js). The service itself goes through store.js, which keeps the same
// tables and also offers PostgreSQL. It keeps only what FIDO2 needs: credentials and challenges, keyed by
// an opaque userId supplied by the caller; no users, passwords, behavioural models or sessions.
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { SCHEMA_SQLITE } = require("./store");

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, "passkey.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.exec(SCHEMA_SQLITE);

module.exports = db;
