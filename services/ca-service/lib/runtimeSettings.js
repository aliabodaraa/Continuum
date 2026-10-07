/**
 * Server-wide settings the operator can change at run time (from the gateway's operator page),
 * stored here so they survive a restart. An unset value falls back to the environment.
 *
 * Only settings that belong to THIS service and to no organisation live here (today: the research
 * study's logging switch). Per-organisation settings never do: they travel signed in the identity
 * assertion (lib/appSettings.js).
 */
const db = require("../db");

db.exec(`CREATE TABLE IF NOT EXISTS runtime_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const DEFS = {
  studyLogging: { env: "STUDY_LOGGING", parse: (v) => v === "1" || v === "true" || v === true, fromEnv: () => process.env.STUDY_LOGGING === "1" },
};

let cache = null;
function load() {
  cache = {};
  for (const r of db.prepare("SELECT key, value FROM runtime_settings").all()) {
    try { cache[r.key] = JSON.parse(r.value); } catch (e) { /* ignore a damaged row; the env value applies */ }
  }
  return cache;
}

function get(key) {
  const def = DEFS[key];
  if (!def) throw new Error("unknown runtime setting " + key);
  const c = cache || load();
  return Object.prototype.hasOwnProperty.call(c, key) ? def.parse(c[key]) : def.fromEnv();
}

function describe() {
  const c = cache || load();
  const out = {};
  for (const [key, def] of Object.entries(DEFS)) {
    const set = Object.prototype.hasOwnProperty.call(c, key);
    out[key] = { value: get(key), source: set ? "operator" : "env", env: def.env, envValue: def.fromEnv() };
  }
  return out;
}

/** values: { key: value | null } -- null returns the key to its environment value. */
function update(values) {
  for (const [key, v] of Object.entries(values || {})) {
    if (!DEFS[key]) throw Object.assign(new Error("unknown setting " + key), { code: "unknown_setting" });
    if (v === null) db.prepare("DELETE FROM runtime_settings WHERE key = ?").run(key);
    else db.prepare("INSERT INTO runtime_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, JSON.stringify(DEFS[key].parse(v)));
  }
  load();
  return describe();
}

module.exports = { get, describe, update };
