/**
 * Seed the canonical identity registry.
 *
 * WHY THIS EXISTS
 * ---------------
 * Identity was computed, never stored: principal = HMAC(GATEWAY_SESSION_SECRET,
 * siteKey|externalId). That makes the permanent identity of biometric data depend on a
 * rotatable credential, and the failure is not hypothetical — this database already
 * contains ids 900001..900010 from an earlier counter-based scheme that the current code
 * can no longer derive, two of which still hold records. A silent identity migration has
 * already happened here once.
 *
 * After seeding, identity is READ FROM THIS TABLE. The secret may then rotate without
 * orphaning anyone.
 *
 * WHY NOT SEED FROM identity.json
 * -------------------------------
 * That file records only identities the gateway happened to resolve — 8 of the 95 that
 * actually hold data. Seeding from it would strand 87. The seed is therefore reconstructed
 * from the DATA: every user_id appearing in any biometric table.
 *
 * WHAT IS SEEDED
 * --------------
 * All 45 gateway-derived ids reverse cleanly to a demo user id, so each human is one
 * principal with two aliases:
 *
 *     principal 739935229538144            (external_user_id = "id:1")
 *       ├── alias 1                        demo-direct, first-party path
 *       └── alias 739935229538144          gateway-derived, SDK path
 *
 * principal_id keeps the gateway-derived value so the SDK path is unchanged; it is now
 * immutable because it is stored rather than recomputed.
 *
 * NOT SEEDED: identities holding no data, and the 5 unexplained legacy ids. Those go to
 * retired_identities with a reason, so the residue is documented rather than silently
 * carried forward or silently dropped.
 *
 * HISTORICAL ROWS ARE NEVER TOUCHED. No user_id is rewritten, nothing is merged. The frozen
 * baseline reads raw ids and keeps reading exactly what it always read.
 *
 *   node seed_principals.js --dry-run     inspect the plan
 *   node seed_principals.js --apply       write it
 */
const crypto = require("crypto");
const Database = require("better-sqlite3");

const APPLY = process.argv.includes("--apply");
const TENANT = "pk_demo";
const SECRET = process.env.GATEWAY_SESSION_SECRET || "dev-gateway-session-secret";
const db = new Database("/app/ca.db");

const derive = (ext) =>
  parseInt(crypto.createHmac("sha256", SECRET).update(TENANT + "|" + ext).digest("hex").slice(0, 13), 16);

// ---------- schema (additive; nothing existing is altered) ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- One row per HUMAN per tenant. The UNIQUE constraint is the whole point: it makes
-- "one person receives two identities" impossible at the database level rather than
-- something application code has to remember.
CREATE TABLE IF NOT EXISTS principals (
  principal_id      INTEGER PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(tenant_id),
  external_user_id  TEXT NOT NULL,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, external_user_id)
);

-- Every historical user_id that belongs to a principal. Rows are NOT rewritten; this
-- table records which raw ids mean the same human, so production reads can unify them
-- while the frozen baseline keeps addressing raw ids directly.
CREATE TABLE IF NOT EXISTS principal_aliases (
  legacy_user_id  INTEGER PRIMARY KEY,
  principal_id    INTEGER NOT NULL REFERENCES principals(principal_id),
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  source          TEXT NOT NULL,          -- demo-direct | gateway-derived
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Identities deliberately NOT carried forward, with the reason recorded.
CREATE TABLE IF NOT EXISTS retired_identities (
  legacy_user_id  INTEGER PRIMARY KEY,
  reason          TEXT NOT NULL,
  evidence        TEXT,
  retired_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alias_principal ON principal_aliases(principal_id);
CREATE INDEX IF NOT EXISTS idx_principal_tenant ON principals(tenant_id);
`;

// ---------- reconstruct the true identity set from the DATA ----------
function idsHoldingData() {
  const ids = new Set();
  const sources = [
    "SELECT DISTINCT user_id u FROM keystroke_texts",
    "SELECT DISTINCT user_id u FROM user_typing_profiles",
    "SELECT DISTINCT user_id u FROM auth_decisions",
    "SELECT DISTINCT user_id u FROM mouse_samples",
    "SELECT DISTINCT user_id u FROM mouse_profiles",
  ];
  for (const s of sources) for (const r of db.prepare(s).all()) ids.add(r.u);
  return [...ids].sort((a, b) => a - b);
}

function plan() {
  const ids = new Set(idsHoldingData());
  // reverse map: which demo user id produces which gateway id
  const reverse = new Map();
  for (let n = 1; n <= 500; n++) reverse.set(derive("id:" + n), n);

  const principals = new Map();   // demoId -> { principal_id, external_user_id, aliases[] }
  const retired = [];

  for (const id of ids) {
    if (id < 100000) {
      // demo-direct id — its principal is the gateway id derived from it
      const pid = derive("id:" + id);
      if (!principals.has(id)) principals.set(id, { principal_id: pid, external_user_id: "id:" + id, aliases: [] });
      principals.get(id).aliases.push({ legacy_user_id: id, source: "demo-direct" });
    } else if (reverse.has(id)) {
      const demoId = reverse.get(id);
      if (!principals.has(demoId)) principals.set(demoId, { principal_id: id, external_user_id: "id:" + demoId, aliases: [] });
      principals.get(demoId).aliases.push({ legacy_user_id: id, source: "gateway-derived" });
    } else {
      retired.push({
        legacy_user_id: id,
        reason: id < 1000000 ? "counter-era id, predates the HMAC scheme, not derivable"
                             : "unexplained id, no demo user reverses to it",
        evidence: `texts=${db.prepare("SELECT COUNT(*) n FROM keystroke_texts WHERE user_id=?").get(id).n}, ` +
                  `decisions=${db.prepare("SELECT COUNT(*) n FROM auth_decisions WHERE user_id=?").get(id).n}`,
      });
    }
  }
  return { principals, retired };
}

const { principals, retired } = plan();
const bothIds = [...principals.values()].filter((p) => p.aliases.length === 2);

console.log(`tenant                : ${TENANT} (the only tenant carried forward)`);
console.log(`principals to seed    : ${principals.size}`);
console.log(`  with BOTH aliases   : ${bothIds.length}  (same human, two historical ids)`);
console.log(`  with one alias      : ${principals.size - bothIds.length}`);
console.log(`aliases total         : ${[...principals.values()].reduce((n, p) => n + p.aliases.length, 0)}`);
console.log(`retired identities    : ${retired.length}`);
retired.forEach((r) => console.log(`    ${r.legacy_user_id}  ${r.reason}  [${r.evidence}]`));

const ali = principals.get(1);
if (ali) {
  console.log(`\nali (demo id 1):`);
  console.log(`  principal_id      : ${ali.principal_id}`);
  console.log(`  aliases           : ${ali.aliases.map((a) => a.legacy_user_id + " (" + a.source + ")").join(", ")}`);
}

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply to seed.");
  process.exit(0);
}

db.exec(SCHEMA);
const tx = db.transaction(() => {
  db.prepare("INSERT OR IGNORE INTO tenants (tenant_id, name, status) VALUES (?,?,?)")
    .run(TENANT, "Demo", "active");
  const insP = db.prepare("INSERT OR IGNORE INTO principals (principal_id, tenant_id, external_user_id) VALUES (?,?,?)");
  const insA = db.prepare("INSERT OR IGNORE INTO principal_aliases (legacy_user_id, principal_id, tenant_id, source) VALUES (?,?,?,?)");
  const insR = db.prepare("INSERT OR IGNORE INTO retired_identities (legacy_user_id, reason, evidence) VALUES (?,?,?)");
  for (const p of principals.values()) {
    insP.run(p.principal_id, TENANT, p.external_user_id);
    for (const a of p.aliases) insA.run(a.legacy_user_id, p.principal_id, TENANT, a.source);
  }
  for (const r of retired) insR.run(r.legacy_user_id, r.reason, r.evidence);
});
tx();

console.log("\nseeded.");
console.log("  tenants            :", db.prepare("SELECT COUNT(*) n FROM tenants").get().n);
console.log("  principals         :", db.prepare("SELECT COUNT(*) n FROM principals").get().n);
console.log("  principal_aliases  :", db.prepare("SELECT COUNT(*) n FROM principal_aliases").get().n);
console.log("  retired_identities :", db.prepare("SELECT COUNT(*) n FROM retired_identities").get().n);
console.log("\nNo historical row was modified. Raw user_id addressing is unchanged.");
