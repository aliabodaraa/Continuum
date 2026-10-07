/**
 * Settings: what each organisation chooses for its apps, the operator's defaults for those choices,
 * and the operator's server-wide switches.
 *
 * Order of precedence for an app setting (first one set wins):
 *   1. the organisation's own value (its console, Settings tab)     -> source "organisation"
 *   2. the operator's default for every organisation (operator page) -> source "operator"
 *   3. the deployment's environment variable (.env)                   -> source "env"
 *   4. the built-in default                                            -> source "default"
 * Values from 1 and 2 are "managed": the SDK lets them override a page's own data-* attributes.
 *
 * The effective values reach ca-service signed inside the identity assertion (claim `cfg`, see
 * ca-service lib/appSettings.js), so nothing has to be kept in sync between the two services.
 * Organisation values live in the tenant record (tenants.json, `settings`); the operator's in
 * settings.json in the gateway's data directory.
 */
const fs = require("fs");
const path = require("path");

const APP = {
  panel: { env: "CONTINUUM_PANEL", def: "show", choices: ["show", "hide"], claim: "panel" },
  keystroke: { env: "CONTINUUM_KEYSTROKE", def: "on", choices: ["on", "off"], claim: "ks" },
  // windows in the typing decision: only the measured packets (ca-service keystrokeSecurity.js)
  keystrokeDecisionWindows: { env: "KEYSTROKE_DECISION_WINDOWS", def: 20, choices: [6, 10, 20], claim: "kw" },
  mouse: { env: "CONTINUUM_MOUSE", def: "on", choices: ["on", "off"], claim: "ms" },
  onboarding: { env: "ONBOARDING_MODE", def: "eager", choices: ["eager", "lazy"], claim: "ob" },
  excludeFieldTypes: { env: "MONITOR_EXCLUDE_TYPES", def: ["hidden"], list: true, claim: "ex" },
  adaptive: { env: "ADAPTIVE_RETRAINING", def: "on", choices: ["on", "off"], claim: "ad" },
  adaptiveGapHours: { env: "ADAPTIVE_MIN_GAP_HOURS", def: 3, number: [0, 168], claim: "gap" },   // pause after each retrain
};
const SERVER = {
  autoApproveTenants: { env: "GATEWAY_AUTO_APPROVE_TENANTS", def: false, bool: true },
  allowPrivateWebhooks: { env: "GATEWAY_ALLOW_PRIVATE_WEBHOOKS", def: false, bool: true },
};
const FIELD_TYPE = /^[a-z][a-z-]{0,23}$/;

function bad(code, note) { return Object.assign(new Error(note || code), { code }); }

// A value as it would be stored, or throws { code: "bad_setting" }.
function normalise(def, v, key) {
  if (def.choices) {
    const val = typeof def.choices[0] === "number" ? Number(v) : v;
    if (!def.choices.includes(val)) throw bad("bad_setting", `${key} must be one of ${def.choices.join(", ")}`);
    return val;
  }
  if (def.number) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < def.number[0] || n > def.number[1]) throw bad("bad_setting", `${key} must be a number from ${def.number[0]} to ${def.number[1]}`);
    return Math.round(n * 100) / 100;
  }
  if (def.list) {
    const items = (Array.isArray(v) ? v : String(v || "").split(",")).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    if (items.length > 20 || items.some((s) => !FIELD_TYPE.test(s))) throw bad("bad_setting", `${key} must be field types such as hidden, password, email`);
    return [...new Set(items)];
  }
  if (def.bool) {
    if (typeof v !== "boolean") throw bad("bad_setting", `${key} must be true or false`);
    return v;
  }
  return v;
}

function fromEnv(def) {
  const raw = process.env[def.env];
  if (raw == null || raw === "") return undefined;
  if (def.bool) return raw === "1" || raw === "true";
  try { return normalise(def, def.number ? raw : def.list ? raw : raw, def.env); } catch (e) { return undefined; }
}

module.exports = function createSettings(dataDir) {
  const FILE = path.join(dataDir, "settings.json");
  let store = { defaults: {}, server: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    store = { defaults: raw.defaults || {}, server: raw.server || {} };
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`settings.json unreadable (${e.message}); refusing to start with unknown settings`);
  }
  function save() {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, FILE);
  }

  // ---- app settings ----
  function resolve(key, tenantSettings) {
    const def = APP[key];
    if (tenantSettings && Object.prototype.hasOwnProperty.call(tenantSettings, key)) return { value: tenantSettings[key], source: "organisation" };
    if (Object.prototype.hasOwnProperty.call(store.defaults, key)) return { value: store.defaults[key], source: "operator" };
    const e = fromEnv(def);
    return e !== undefined ? { value: e, source: "env" } : { value: def.def, source: "default" };
  }
  function effective(tenant) {
    const ts = (tenant && tenant.settings) || null;
    const values = {}, sources = {};
    for (const key of Object.keys(APP)) {
      const r = resolve(key, ts);
      values[key] = r.value;
      sources[key] = r.source;
    }
    // Lazy enrolment means "the user turns a channel on in the panel": with the panel hidden it
    // could never happen, so enrolment is asked up front. Writes refuse the combination; this
    // covers one an operator default could still create for an organisation.
    if (values.panel === "hide" && values.onboarding === "lazy") values.onboarding = "eager";
    return { values, sources };
  }
  function claim(tenant) {
    const { values, sources } = effective(tenant);
    const c = { m: Object.keys(APP).filter((k) => sources[k] === "organisation" || sources[k] === "operator") };
    for (const [key, def] of Object.entries(APP)) c[def.claim] = values[key];
    return c;
  }
  function describe(tenant) {
    const { values, sources } = effective(tenant);
    const operatorDefault = effective(null).values;
    return Object.keys(APP).map((key) => ({
      key, value: values[key], source: sources[key], env: APP[key].env, envValue: fromEnv(APP[key]) ?? null,
      builtIn: APP[key].def, operatorDefault: operatorDefault[key],
      choices: APP[key].choices || null, range: APP[key].number || null, list: !!APP[key].list,
    }));
  }
  // changes: { key: value | null }; null removes the value at this level. Returns the changed keys.
  function applyApp(target, changes, check) {
    const next = { ...target };
    const changed = [];
    for (const [key, v] of Object.entries(changes || {})) {
      if (!APP[key]) throw bad("unknown_setting", `unknown setting ${key}`);
      if (v === null) { if (key in next) { delete next[key]; changed.push(key); } continue; }
      const nv = normalise(APP[key], v, key);
      if (JSON.stringify(next[key]) !== JSON.stringify(nv)) { next[key] = nv; changed.push(key); }
    }
    check(next);
    return { next, changed };
  }
  function lazyNeedsPanel(values) {
    if (values.panel === "hide" && values.onboarding === "lazy") {
      throw bad("lazy_needs_panel", "Enrolment on demand needs the panel (the user turns a channel on there). Show the panel, or require enrolment.");
    }
  }

  function updateTenant(tenant, changes) {
    const { next, changed } = applyApp(tenant.settings || {}, changes, (n) => {
      const vals = {};
      for (const key of Object.keys(APP)) vals[key] = resolve(key, n).value;
      lazyNeedsPanel(vals);
    });
    return { settings: next, changed };
  }

  // ---- server switches ----
  function server(key) {
    const def = SERVER[key];
    if (Object.prototype.hasOwnProperty.call(store.server, key)) return store.server[key];
    const e = fromEnv(def);
    return e !== undefined ? e : def.def;
  }
  function describeServer() {
    return Object.keys(SERVER).map((key) => ({
      key, value: server(key), source: Object.prototype.hasOwnProperty.call(store.server, key) ? "operator" : (fromEnv(SERVER[key]) !== undefined ? "env" : "default"),
      env: SERVER[key].env, envValue: fromEnv(SERVER[key]) ?? null, builtIn: SERVER[key].def,
    }));
  }

  // body: { defaults: {key: v|null}, server: {key: v|null} }. Returns the changed keys, prefixed.
  function updateOperator(body) {
    const d = applyApp(store.defaults, body.defaults, (n) => {
      const vals = {};
      for (const key of Object.keys(APP)) {
        vals[key] = Object.prototype.hasOwnProperty.call(n, key) ? n[key] : (fromEnv(APP[key]) ?? APP[key].def);
      }
      lazyNeedsPanel(vals);
    });
    const srv = { ...store.server };
    const changedServer = [];
    for (const [key, v] of Object.entries(body.server || {})) {
      if (!SERVER[key]) throw bad("unknown_setting", `unknown setting ${key}`);
      if (v === null) { if (key in srv) { delete srv[key]; changedServer.push(key); } continue; }
      const nv = normalise(SERVER[key], v, key);
      if (srv[key] !== nv) { srv[key] = nv; changedServer.push(key); }
    }
    const prev = store;
    store = { defaults: d.next, server: srv };
    try { save(); } catch (e) { store = prev; throw bad("store_write_failed", e.message); }
    return [...d.changed.map((k) => "defaults." + k), ...changedServer.map((k) => "server." + k)];
  }

  return { APP, SERVER, effective, claim, describe, updateTenant, server, describeServer, updateOperator };
};
