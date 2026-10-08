#!/usr/bin/env node
/**
 * Copy this service's passkeys from its SQLite file (STORAGE=sqlite) into its PostgreSQL database
 * (STORAGE=postgres), then prove the copy: every credential is read back and compared with the file,
 * field by field. The file is only read, so going back is just STORAGE=sqlite again.
 *
 *   node migrate.js --from <passkey.db> --to <postgres url> [--replace]
 *
 * One transaction: the database gets every credential or none. A database that already holds credentials
 * is refused unless --replace says to empty it first (a repeat of the final copy before switching over).
 * Challenges are not copied: they live five minutes, and a ceremony in flight during the switch simply
 * starts again. Exit code 0 only when the copy is verified identical.
 */
const path = require("path");
const { openStore } = require("./store");

function args(argv) {
  const out = { replace: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--from") out.from = argv[++i];
    else if (argv[i] === "--to") out.to = argv[++i];
    else if (argv[i] === "--replace") out.replace = true;
    else if (argv[i] === "-h" || argv[i] === "--help") out.help = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

// What a credential is, for comparison: everything that makes it work (key, counter, transports) and whose it is.
const shape = (r) => [Number(r.user_id), r.credential_id, r.public_key, Number(r.counter || 0), r.transports || null];

async function main() {
  const a = args(process.argv);
  if (a.help || !a.from || !a.to) {
    console.log("usage: node migrate.js --from <passkey.db> --to <postgres url> [--replace]");
    process.exit(a.help ? 0 : 2);
  }
  const Database = require("better-sqlite3");
  const src = new Database(path.resolve(a.from), { readonly: true, fileMustExist: true });
  const rows = src.prepare("SELECT user_id, credential_id, public_key, counter, transports, created_at FROM passkey_credentials ORDER BY id").all();
  src.close();
  const users = new Set(rows.map((r) => r.user_id)).size;
  console.log(`source ${a.from}: ${rows.length} credentials of ${users} users`);

  const dst = await openStore({ kind: "postgres", databaseUrl: a.to });   // creates the tables if needed
  await dst.close();
  const { Client } = require("pg");
  const c = new Client({ connectionString: a.to });
  await c.connect();
  try {
    const have = Number((await c.query("SELECT count(*) AS n FROM passkey_credentials")).rows[0].n);
    if (have > 0 && !a.replace) throw new Error(`the database already holds ${have} credentials; refusing to mix. Use --replace to empty it first.`);
    await c.query("BEGIN");
    if (a.replace) await c.query("TRUNCATE passkey_credentials, webauthn_challenges RESTART IDENTITY");
    for (const r of rows) {
      // SQLite's CURRENT_TIMESTAMP is UTC without a zone ("2026-10-08 07:12:00")
      const created = r.created_at ? new Date(String(r.created_at).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(r.created_at) ? "" : "Z")) : new Date();
      await c.query("INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [r.user_id, r.credential_id, r.public_key, r.counter || 0, r.transports || null, created]);
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { await c.end(); }
  console.log("copied in one transaction");

  // ---- verify: a fresh read of every credential, compared with the file
  const v = new Client({ connectionString: a.to });
  await v.connect();
  const back = (await v.query("SELECT user_id, credential_id, public_key, counter, transports FROM passkey_credentials ORDER BY credential_id")).rows;
  await v.end();
  const want = rows.map(shape).sort((x, y) => (x[1] < y[1] ? -1 : 1));
  const got = back.map(shape);
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    console.error(`NOT VERIFIED: ${got.length} credentials read back, ${want.length} expected, or a field differs. Keep STORAGE=sqlite; the file is unchanged.`);
    process.exit(1);
  }
  console.log(`verified: ${got.length} credentials of ${users} users (user, credential id, public key, counter, transports): identical`);
}

main().catch((e) => { console.error(`migration failed: ${e.message}`); process.exit(1); });
