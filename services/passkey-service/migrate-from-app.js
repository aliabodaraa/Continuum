// One-time migration: copy existing passkey credentials from the app's old
// bundled DB into this service's DB. Run once after splitting the service so
// already-registered users keep their passkeys.
//   node migrate-from-app.js /path/to/old-app.db
const Database = require("better-sqlite3");
const dst = require("./db");

const srcPath = process.argv[2];
if (!srcPath) {
  console.error("usage: node migrate-from-app.js <path-to-old-app-db>");
  process.exit(1);
}

const src = new Database(srcPath, { readonly: true });
const creds = src
  .prepare(
    "SELECT user_id, credential_id, public_key, counter, transports FROM passkey_credentials",
  )
  .all();

const ins = dst.prepare(
  "INSERT OR IGNORE INTO passkey_credentials (user_id, credential_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)",
);
let n = 0;
for (const c of creds) {
  const r = ins.run(c.user_id, c.credential_id, c.public_key, c.counter, c.transports);
  n += r.changes;
}
console.log(`migrated ${n} / ${creds.length} credential(s)`);
