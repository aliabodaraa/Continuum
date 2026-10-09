#!/usr/bin/env node
/**
 * Copy this service's data from its SQLite file (STORAGE=sqlite) into its PostgreSQL database
 * (STORAGE=postgres), then prove the copy: every table is read back and compared with the file, row by
 * row (count and checksum). The file is only read, so going back is just STORAGE=sqlite again.
 *
 *   node migrate.js --from <ca.db> --to <postgres url> [--replace]
 *
 * Stop the service first (or give a copy: sqlite3 .backup): the file is read in one read transaction, so
 * what is copied and what is verified is one consistent state.
 *
 * - One transaction: the database gets everything or nothing. A database that already holds rows is refused
 *   unless --replace says to empty it first (a repeat of the final copy before switching over).
 * - Every table and every column is copied as stored, ids included, so every link between rows
 *   (keystroke_events.keystroke_text_id, study_windows.decision_id, ...) holds. Each id counter continues
 *   where SQLite's did, so the id of a deleted row is never given again.
 * - A table or a column this service does not know is refused, never skipped: nothing is left behind
 *   without saying so.
 * - Values keep SQLite's representation (timestamps as "YYYY-MM-DD HH:MM:SS" text, JSON as text, 0/1
 *   flags), which is what the service reads back on either backend; the verification compares exactly that.
 * Exit code 0 only when every table is verified identical.
 */
const path = require("path");
const crypto = require("crypto");

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

const q = (name) => `"${name}"`;
// One canonical text per value, the same from either side: integers exactly (SQLite as BigInt, PostgreSQL's
// bigint as text), floats in JavaScript's shortest exact form, text as it is.
const canon = (v) => (v === null || v === undefined ? null : typeof v === "bigint" ? v.toString() : typeof v === "number" ? String(v) : Buffer.isBuffer(v) ? "\\x" + v.toString("hex") : String(v));
const rowText = (cols, r) => JSON.stringify(cols.map((c) => canon(r[c])));

// The key a table is read in, the same order on both sides: an integer key when it has one (its order does
// not depend on the database's text collation); otherwise the table is small and is sorted here.
function keyOf(cols) {
  const m = /\b(\w+) (?:ID|USERID PRIMARY KEY)\b/.exec(cols);
  return m && !/PRIMARY KEY \(/.test(cols) ? m[1] : null;
}

const BATCH_ROWS = 1000;
const BATCH_BYTES = 4 * 1024 * 1024;   // mouse_samples rows hold whole sessions; keep each statement small

async function migrate({ from, to, replace = false, log = console.log }) {
  // the schema exactly as the service creates it (tables, indexes, the one-pending-job rule)
  process.env.STORAGE = "postgres";
  process.env.DATABASE_URL = to;
  const db = require("./db");
  await db.open();
  await db.close();

  const Database = require("better-sqlite3");
  const src = new Database(path.resolve(from), { readonly: true, fileMustExist: true });
  src.defaultSafeIntegers(true);   // ids up to 2^63 exactly, never through a float
  const { Client } = require("pg");
  const pg = new Client({ connectionString: to });
  await pg.connect();
  const report = { tables: [], ok: true };
  src.exec("BEGIN");   // one consistent read of the file, for the copy and the verification
  try {
    const coll = (await pg.query("SELECT datcollate FROM pg_database WHERE datname = current_database()")).rows[0].datcollate;
    if (coll !== "C" && coll !== "POSIX") {
      log(`WARNING: the database sorts text by "${coll}"; SQLite compares bytes. Create it with LC_COLLATE 'C' ` +
        "(deploy/postgres/init-local.sql) so every text order and comparison stays as it was.");
    }

    // ---- what is in the file, against what the service knows
    const known = new Map(db.TABLES.map(([name, cols]) => [name, cols]));
    const fileTables = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const unknown = fileTables.filter((t) => !known.has(t));
    if (unknown.length) throw new Error(`the file has tables this service does not know (${unknown.join(", ")}); refusing to leave them behind`);
    const seq = new Map();
    if (src.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) {
      for (const r of src.prepare("SELECT name, seq FROM sqlite_sequence").all()) seq.set(r.name, BigInt(r.seq));
    }

    const plan = [];
    for (const [name, cols] of known) {
      if (!fileTables.includes(name)) { log(`- ${name}: not in the file (an older file), left empty`); continue; }
      const fileCols = src.prepare(`PRAGMA table_info(${q(name)})`).all().map((c) => c.name);
      const dbCols = (await pg.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", [name])).rows.map((r) => r.column_name);
      const extra = fileCols.filter((c) => !dbCols.includes(c));
      if (extra.length) throw new Error(`${name}: the file has columns the database does not (${extra.join(", ")}); refusing to drop them`);
      plan.push({ name, cols: fileCols, key: keyOf(cols), hasId: /\bid ID\b/.test(cols) });
    }

    // ---- copy, in one transaction
    const have = Number((await pg.query(`SELECT ${plan.map((t) => `(SELECT count(*) FROM ${q(t.name)})`).join(" + ") || "0"} AS n`)).rows[0].n);
    if (have > 0 && !replace) throw new Error(`the database already holds ${have} rows; refusing to mix. Use --replace to empty it first.`);
    await pg.query("BEGIN");
    try {
      if (replace) await pg.query(`TRUNCATE ${db.TABLES.map(([n]) => q(n)).join(", ")} RESTART IDENTITY`);
      for (const t of plan) {
        const t0 = Date.now();
        const colList = t.cols.map(q).join(", ");
        let rows = [], bytes = 0, n = 0;
        const flush = async () => {
          if (!rows.length) return;
          const params = [];
          const values = rows.map((r) => "(" + t.cols.map((c) => { params.push(r[c] === undefined ? null : r[c]); return "$" + params.length; }).join(", ") + ")");
          await pg.query(`INSERT INTO ${q(t.name)} (${colList}) VALUES ${values.join(", ")}`, params.map((v) => (typeof v === "bigint" ? v.toString() : v)));
          n += rows.length;
          rows = []; bytes = 0;
        };
        const order = t.key ? ` ORDER BY ${q(t.key)}` : "";
        for (const r of src.prepare(`SELECT ${colList} FROM ${q(t.name)}${order}`).iterate()) {
          for (const c of t.cols) if (Buffer.isBuffer(r[c])) throw new Error(`${t.name}.${c}: binary value; this service stores none`);
          rows.push(r);
          for (const c of t.cols) bytes += typeof r[c] === "string" ? r[c].length : 8;
          if (rows.length >= BATCH_ROWS || bytes >= BATCH_BYTES) await flush();
        }
        await flush();
        // the id counter continues where SQLite's did (sqlite_sequence remembers ids of deleted rows too)
        if (t.hasId) {
          const max = BigInt((await pg.query(`SELECT COALESCE(MAX(id), 0) AS m FROM ${q(t.name)}`)).rows[0].m);
          const last = seq.has(t.name) && seq.get(t.name) > max ? seq.get(t.name) : max;
          if (last > 0n) await pg.query("SELECT setval(pg_get_serial_sequence($1, 'id'), $2, true)", [t.name, last.toString()]);
          t.lastId = last.toString();
        }
        t.copied = n;
        log(`  ${t.name}: ${n} rows (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      }
      await pg.query("COMMIT");
    } catch (e) {
      await pg.query("ROLLBACK").catch(() => {});
      throw e;
    }
    log("copied in one transaction");

    // ---- verify: every row read back, compared with the file (count and checksum per table)
    for (const t of plan) {
      const colList = t.cols.map(q).join(", ");
      const hs = crypto.createHash("sha256"), hd = crypto.createHash("sha256");
      let ns = 0, nd = 0;
      if (t.key) {
        for (const r of src.prepare(`SELECT ${colList} FROM ${q(t.name)} ORDER BY ${q(t.key)}`).iterate()) { hs.update(rowText(t.cols, r) + "\n"); ns++; }
        // keyset pages: the database's rows in the same key order, never all in memory at once
        let after = null;
        for (;;) {
          const page = (await pg.query(
            `SELECT ${colList} FROM ${q(t.name)}${after === null ? "" : ` WHERE ${q(t.key)} > $1`} ORDER BY ${q(t.key)} LIMIT 5000`,
            after === null ? [] : [after])).rows;
          if (!page.length) break;
          for (const r of page) { hd.update(rowText(t.cols, r) + "\n"); nd++; }
          after = page[page.length - 1][t.key];
        }
      } else {
        const a = src.prepare(`SELECT ${colList} FROM ${q(t.name)}`).all().map((r) => rowText(t.cols, r)).sort();
        const b = (await pg.query(`SELECT ${colList} FROM ${q(t.name)}`)).rows.map((r) => rowText(t.cols, r)).sort();
        for (const x of a) hs.update(x + "\n");
        for (const x of b) hd.update(x + "\n");
        ns = a.length; nd = b.length;
      }
      const same = ns === nd && hs.digest("hex") === hd.digest("hex");
      let seqOk = true;
      if (t.hasId && BigInt(t.lastId) > 0n) {
        const s = (await pg.query("SELECT last_value FROM " + (await pg.query("SELECT pg_get_serial_sequence($1, 'id') AS s", [t.name])).rows[0].s)).rows[0].last_value;
        seqOk = String(s) === t.lastId;
      }
      report.tables.push({ table: t.name, rows: ns, identical: same, nextIdAfter: t.lastId || null, sequenceOk: seqOk });
      if (!same || !seqOk) report.ok = false;
      log(`  ${same && seqOk ? "identical" : "DIFFERENT"}  ${t.name}: ${ns} rows in the file, ${nd} in the database${t.hasId ? `, ids continue after ${t.lastId}${seqOk ? "" : " (SEQUENCE WRONG)"}` : ""}`);
    }
  } finally {
    try { src.exec("COMMIT"); } catch (_) {}
    src.close();
    await pg.end();
  }
  return report;
}

module.exports = { migrate };

if (require.main === module) {
  const a = args(process.argv);
  if (a.help || !a.from || !a.to) {
    console.log("usage: node migrate.js --from <ca.db> --to <postgres url> [--replace]");
    process.exit(a.help ? 0 : 2);
  }
  console.log(`source ${a.from}`);
  migrate(a).then((r) => {
    const rows = r.tables.reduce((s, t) => s + t.rows, 0);
    if (!r.ok) {
      console.error(`NOT VERIFIED: a table differs (above). Keep STORAGE=sqlite; the file is unchanged.`);
      process.exit(1);
    }
    console.log(`verified: ${r.tables.length} tables, ${rows} rows, identical to the file`);
  }).catch((e) => { console.error(`migration failed: ${e.message}`); process.exit(1); });
}
