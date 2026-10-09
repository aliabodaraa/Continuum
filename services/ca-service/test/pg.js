// PostgreSQL for ca-service's tests. TEST_DATABASE_URL names a throwaway server (scripts/ci-local.sh and CI
// start one); each test file gets its own database on it, because node --test runs files in parallel.
// Never point TEST_DATABASE_URL at a real deployment: databases are dropped here.
const BASE = process.env.TEST_DATABASE_URL || "";

// A new, empty database (byte-order text collation, as deploy/postgres/init-local.sql creates `ca`).
async function freshDatabase(name) {
  if (!BASE) return null;
  const { Client } = require("pg");
  const db = "continuum_test_" + name.replace(/[^a-z0-9_]/g, "_");
  const c = new Client({ connectionString: BASE });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${db} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  } finally { await c.end(); }
  const u = new URL(BASE);
  u.pathname = "/" + db;
  return u.toString();
}

module.exports = { BASE, freshDatabase };
