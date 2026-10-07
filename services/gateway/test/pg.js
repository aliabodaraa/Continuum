// PostgreSQL for the gateway's tests. TEST_DATABASE_URL names a throwaway server (scripts/ci-local.sh and
// CI start one); each test file gets its own database on it, because node --test runs files in parallel.
// Never point TEST_DATABASE_URL at a real deployment: databases are dropped here.
const BASE = process.env.TEST_DATABASE_URL || "";

async function freshDatabase(name) {
  if (!BASE) return null;
  const { Client } = require("pg");
  const db = "continuum_test_" + name.replace(/[^a-z0-9_]/g, "_");
  const c = new Client({ connectionString: BASE });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${db}`);
  } finally { await c.end(); }
  const u = new URL(BASE);
  u.pathname = "/" + db;
  return u.toString();
}

const TABLES = ["gw_tenants", "gw_identities", "gw_accounts", "gw_revoked_tokens", "gw_settings", "gw_audit",
  "gw_links", "gw_ceremonies", "gw_admin_failures", "gw_risk_state", "gw_webhook_outbox"];

// Empty every gateway table that exists (the schema is created by the first openStorage).
async function emptyTables(url) {
  const { Client } = require("pg");
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const have = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((r) => r.tablename);
    const list = TABLES.filter((t) => have.includes(t));
    if (list.length) await c.query(`TRUNCATE ${list.join(", ")} RESTART IDENTITY`);
  } finally { await c.end(); }
}

async function query(url, sql, params) {
  const { Client } = require("pg");
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

module.exports = { BASE, freshDatabase, emptyTables, query };
