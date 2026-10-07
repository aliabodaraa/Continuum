#!/usr/bin/env node
/**
 * Copy the gateway's records from the JSON files (STORAGE=json) into PostgreSQL (STORAGE=postgres),
 * then prove the copy: everything is read back from the database and compared with the files, record
 * by record. The files are only read, never changed, so going back is just STORAGE=json again.
 *
 *   node migrate.js --from <data dir> --to <postgres url> [--replace]
 *
 * One transaction: the database gets everything or nothing. A database that already holds records is
 * refused, unless --replace says to empty it first (a repeat of the final copy before switching over).
 * Refresh-token revocations past their token's expiry are not copied (the token is dead anyway).
 * Exit code 0 only when the copy is verified identical.
 */
const fs = require("fs");
const path = require("path");
const { openStorage } = require("./storage");

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

// Key order does not matter (PostgreSQL's jsonb does not keep it); everything else must be equal.
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

function readAuditFile(dir) {
  let text = "";
  try { text = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const entries = [], bad = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try { entries.push(JSON.parse(line)); } catch (e) { bad.push(i + 1); }
  });
  return { entries, bad };
}

async function main() {
  const a = args(process.argv);
  if (a.help || !a.from || !a.to) {
    console.log("usage: node migrate.js --from <data dir> --to <postgres url> [--replace]");
    process.exit(a.help ? 0 : 2);
  }
  const src = await openStorage({ kind: "json", dataDir: a.from });
  const audit = readAuditFile(a.from);
  if (audit.bad.length) throw new Error(`audit.jsonl lines ${audit.bad.join(", ")} are not valid JSON; fix or remove them first`);
  const now = Math.floor(Date.now() / 1000);
  const revoked = Object.fromEntries(Object.entries(src.data.accounts.revoked).filter(([, exp]) => exp >= now));
  const d = src.data;
  console.log(`source ${a.from}: ${Object.keys(d.tenants.tenants).length} tenants, ${Object.keys(d.identity.users).length} identities, ` +
    `${Object.keys(d.accounts.accounts).length} accounts, ${Object.keys(revoked).length} live revocations ` +
    `(${Object.keys(d.accounts.revoked).length - Object.keys(revoked).length} expired, skipped), ${audit.entries.length} activity entries`);

  // Creates the tables if needed; its listener is not used here.
  const dst = await openStorage({ kind: "postgres", databaseUrl: a.to, log: () => {} });
  await dst.close();
  const { Client } = require("pg");
  const c = new Client({ connectionString: a.to });
  await c.connect();
  try {
    const counts = (await c.query(`SELECT (SELECT count(*) FROM gw_tenants) + (SELECT count(*) FROM gw_identities) +
      (SELECT count(*) FROM gw_accounts) + (SELECT count(*) FROM gw_audit) + (SELECT count(*) FROM gw_settings) AS n`)).rows[0].n;
    if (Number(counts) > 0 && !a.replace) throw new Error(`the database already holds ${counts} records; refusing to mix. Use --replace to empty it first.`);

    await c.query("BEGIN");
    if (a.replace) await c.query("TRUNCATE gw_tenants, gw_identities, gw_accounts, gw_revoked_tokens, gw_settings, gw_audit RESTART IDENTITY");
    for (const [k, t] of Object.entries(d.tenants.tenants)) await c.query("INSERT INTO gw_tenants (site_key, doc) VALUES ($1, $2)", [k, t]);
    for (const [k, u] of Object.entries(d.identity.users)) {
      await c.query("INSERT INTO gw_identities (key, site_key, user_id, doc, created_at) VALUES ($1, $2, $3, $4, $5)",
        [k, k.split("|")[0], u.userId, u, u.createdAt || new Date(0).toISOString()]);
    }
    for (const [id, acc] of Object.entries(d.accounts.accounts)) await c.query("INSERT INTO gw_accounts (id, email, doc) VALUES ($1, $2, $3)", [id, acc.email, acc]);
    for (const [jti, exp] of Object.entries(revoked)) await c.query("INSERT INTO gw_revoked_tokens (jti, exp) VALUES ($1, $2)", [jti, exp]);
    await c.query("INSERT INTO gw_settings (name, doc) VALUES ('operator', $1)", [d.settings]);
    for (const e of audit.entries) {   // file order = id order, so "newest first" stays the same
      const email = e.actor && e.actor.type === "account" ? e.actor.email || null : null;
      await c.query("INSERT INTO gw_audit (at, site_key, actor_email, doc) VALUES ($1, $2, $3, $4)", [e.at, e.siteKey || null, email, e]);
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { await c.end(); }
  console.log("copied in one transaction");

  // ---- verify: a fresh read of everything, compared with the files
  const back = await openStorage({ kind: "postgres", databaseUrl: a.to, log: () => {} });
  const problems = [];
  const cmp = (name, x, y) => { if (!same(x, y)) problems.push(name); };
  cmp("tenants", back.data.tenants.tenants, d.tenants.tenants);
  cmp("identities", back.data.identity.users, d.identity.users);
  cmp("accounts", back.data.accounts.accounts, d.accounts.accounts);
  cmp("emails", back.data.accounts.byEmail, d.accounts.byEmail);
  cmp("revocations", back.data.accounts.revoked, revoked);
  cmp("settings", back.data.settings, d.settings);
  const log = (await back.readAudit(null, audit.entries.length + 1)).reverse();
  cmp("activity log", log, audit.entries);
  // the per-record view the gateway uses on every request
  for (const [k, u] of Object.entries(d.identity.users)) if (back.data.identity.users[k].userId !== u.userId) { problems.push(`user id of ${k}`); break; }
  await back.close();
  if (problems.length) {
    console.error(`NOT VERIFIED: ${problems.join(", ")} differ. Keep STORAGE=json; the files are unchanged.`);
    process.exit(1);
  }
  console.log(`verified: tenants ${Object.keys(d.tenants.tenants).length}, identities ${Object.keys(d.identity.users).length} (every user id equal), ` +
    `accounts ${Object.keys(d.accounts.accounts).length}, revocations ${Object.keys(revoked).length}, settings, activity ${log.length} entries in order: identical`);
}

main().catch((e) => { console.error(`migration failed: ${e.message}`); process.exit(1); });
