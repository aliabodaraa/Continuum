/**
 * Server-wide settings the operator can change at run time (from the gateway's operator page),
 * stored here so they survive a restart. An unset value falls back to the environment.
 *
 * Only settings that belong to THIS service and to no organisation live here (today: the research
 * study's logging switch). Per-organisation settings never do: they travel signed in the identity
 * assertion (lib/appSettings.js).
 *
 * Read on hot paths, so they are held in memory: loaded at start (server.js awaits load()), reloaded
 * after every change made here, and every REFRESH_MS from the database, so a change made through
 * another copy of the service reaches this one within that time.
 */
const db = require("../db");

const REFRESH_MS = Number(process.env.RUNTIME_SETTINGS_REFRESH_MS || 10000);
const DEFS = {
  studyLogging: { env: "STUDY_LOGGING", parse: (v) => v === "1" || v === "true" || v === true, fromEnv: () => process.env.STUDY_LOGGING === "1" },
};

let cache = {};
let timer = null;
async function load() {
  const next = {};
  for (const r of await db.all("SELECT key, value FROM runtime_settings")) {
    try { next[r.key] = JSON.parse(r.value); } catch (e) { /* ignore a damaged row; the env value applies */ }
  }
  cache = next;
  if (!timer) {
    timer = setInterval(() => load().catch((e) => console.error(`[settings] reload failed: ${e.message}`)), REFRESH_MS);
    timer.unref();
  }
  return cache;
}

function get(key) {
  const def = DEFS[key];
  if (!def) throw new Error("unknown runtime setting " + key);
  return Object.prototype.hasOwnProperty.call(cache, key) ? def.parse(cache[key]) : def.fromEnv();
}

function describe() {
  const out = {};
  for (const [key, def] of Object.entries(DEFS)) {
    const set = Object.prototype.hasOwnProperty.call(cache, key);
    out[key] = { value: get(key), source: set ? "operator" : "env", env: def.env, envValue: def.fromEnv() };
  }
  return out;
}

/** values: { key: value | null } -- null returns the key to its environment value. */
async function update(values) {
  for (const key of Object.keys(values || {})) {
    if (!DEFS[key]) throw Object.assign(new Error("unknown setting " + key), { code: "unknown_setting" });
  }
  for (const [key, v] of Object.entries(values || {})) {
    if (v === null) await db.run("DELETE FROM runtime_settings WHERE key = ?", key);
    else await db.run("INSERT INTO runtime_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, JSON.stringify(DEFS[key].parse(v)));
  }
  await load();
  return describe();
}

function stop() { clearInterval(timer); timer = null; }

module.exports = { load, get, describe, update, stop };
