/**
 * Where the gateway keeps its records: the organisations (tenants), the identity map, the Continuum
 * accounts and the refresh tokens given up at sign-out, the operator's settings, and the activity log.
 * STORAGE picks the backend:
 *   json      (default) files in DATA_DIR, as before: tenants.json, identity.json, accounts.json,
 *             settings.json, audit.jsonl. A save rewrites the whole file (temporary file + rename).
 *   postgres  one PostgreSQL database (DATABASE_URL). The gateway then keeps no records on its own
 *             disk, so several identical copies can run side by side (a stateless service with a
 *             backing store, as cloud platforms expect).
 *
 * Reads never wait for storage: every record is loaded at start and requests read the copy in memory,
 * so the check path costs no database round trip. Every change is written through before the request
 * answers, and a failed write rejects, so the caller can undo its change in memory and refuse. With
 * postgres each write also notifies the other copies (LISTEN/NOTIFY), which reload that one record;
 * a copy that loses its listening connection reloads everything once it is back.
 *
 * Short-lived state lives here too, so that no request depends on which gateway copy it reaches:
 * sign-in links of the extension, account passkey ceremonies, the operator lockout, and each user's last
 * settled risk. With json it stays in this process's memory (one gateway, as before); with postgres it
 * is in tables with an expiry time, changed in single atomic statements. With postgres a risk change
 * also writes its webhook event to an outbox in the same transaction (webhooks.js delivers it).
 *
 * The signing keys are not here on purpose: they are secrets, and a deployment mounts them from its
 * secret store (a Kubernetes Secret, say), never from the database.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EMPTY = () => ({
  tenants: { tenants: {} },
  identity: { users: {} },
  accounts: { accounts: {}, byEmail: {}, revoked: {} },
  settings: { defaults: {}, server: {} },
});
const siteKeyOf = (identityKey) => String(identityKey).split("|")[0];
const nowSec = () => Math.floor(Date.now() / 1000);
function conflict(message) { return Object.assign(new Error(message), { code: "conflict" }); }

// Which activity-log entries a reader sees: null = all (the operator), or one console account's own
// actions plus anything done to its organisations.
function auditMatch(filter) {
  if (!filter) return () => true;
  const keys = new Set(filter.siteKeys || []);
  return (e) => (e.siteKey && keys.has(e.siteKey)) || (!!filter.email && e.actor && e.actor.type === "account" && e.actor.email === filter.email);
}

// Drop refresh-token revocations past the token's own expiry: the token is dead anyway.
function pruneRevoked(revoked) {
  const now = nowSec();
  for (const [jti, exp] of Object.entries(revoked)) if (exp < now) delete revoked[jti];
}

// ---------------------------------------------------------------- short-lived state in memory (json)
// One gateway process: plain maps, as before. Expired entries read as absent and are swept.
function memoryShortLived() {
  const links = new Map(), ceremonies = new Map(), fails = new Map(), risk = new Map();
  const live = (m, id) => {
    const e = m.get(String(id || ""));
    if (!e) return null;
    if (e.exp <= Date.now()) { m.delete(String(id)); return null; }
    return e;
  };
  return {
    async putLink(id, doc, ttlMs) { links.set(id, { doc, exp: Date.now() + ttlMs }); },
    async getLink(id) { const e = live(links, id); return e ? e.doc : null; },
    async authorizeLink(id, siteKey, patch) {
      const e = live(links, id);
      if (!e || e.doc.status !== "pending" || e.doc.siteKey !== siteKey) return null;
      Object.assign(e.doc, patch, { status: "authorized" });
      return e.doc;
    },
    async takeLink(id) { const e = live(links, id); links.delete(String(id || "")); return e ? e.doc : null; },
    async putCeremony(id, doc, ttlMs) { ceremonies.set(id, { doc, exp: Date.now() + ttlMs }); },
    async takeCeremony(id) { const e = live(ceremonies, id); ceremonies.delete(String(id || "")); return e ? e.doc : null; },
    async adminLockedUntil(who) { const f = fails.get(who); return f && f.until > Date.now() ? f.until : 0; },
    async recordAdminFailure(who, { windowMs, limit, lockMs }) {
      const now = Date.now();
      let f = fails.get(who);
      if (!f || now - f.first >= windowMs) f = { n: 0, first: now, until: 0 };
      f.n += 1;
      if (f.n >= limit) f.until = now + lockMs;
      fails.set(who, f);
      return { n: f.n, until: f.until };
    },
    async clearAdminFailures(who) { fails.delete(who); },
    // json has no outbox: the caller sends the event itself (as before)
    async riskTransition(key, value, makeEvent) {
      const prev = risk.get(key);
      if (prev === value) return { prev, changed: false };
      risk.set(key, value);
      return { prev, changed: true, event: makeEvent(prev) || null };
    },
    async deleteRiskState(key) { risk.delete(key); },
    async riskGet(key) { return risk.get(key); },
    async sweep() {
      const now = Date.now();
      for (const m of [links, ceremonies]) for (const [id, e] of m) if (e.exp <= now) m.delete(id);
      for (const [who, f] of fails) if (f.until <= now && now - f.first >= 3600000) fails.delete(who);
    },
  };
}

// ---------------------------------------------------------------- json: the files in DATA_DIR
// A missing file starts empty, but a file that exists and cannot be read or parsed stops the gateway.
// Reading it as empty used to re-seed pk_demo over the wreckage and re-allocate every user id,
// orphaning their biometric profiles, with nothing in the log.
function loadJson(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new Error(`[gateway] cannot read ${file}: ${e.message}`);
  }
  try { return JSON.parse(text); } catch (e) {
    throw new Error(`[gateway] ${file} is not valid JSON (${e.message}). Refusing to start rather than ` +
      `treat it as empty; restore it from a backup (a leftover ${path.basename(file)}.tmp may hold the last write).`);
  }
}
// Atomic on one filesystem: a crash mid-write leaves the previous version.
function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function openJson(dataDir) {
  const F = {
    tenants: path.join(dataDir, "tenants.json"),
    identity: path.join(dataDir, "identity.json"),
    accounts: path.join(dataDir, "accounts.json"),
    settings: path.join(dataDir, "settings.json"),
    audit: path.join(dataDir, "audit.jsonl"),
  };
  const data = EMPTY();
  data.tenants = loadJson(F.tenants, data.tenants);
  data.tenants.tenants = data.tenants.tenants || {};
  data.identity = loadJson(F.identity, data.identity);
  data.identity.users = data.identity.users || {};
  data.accounts = loadJson(F.accounts, data.accounts);
  for (const k of ["accounts", "byEmail", "revoked"]) data.accounts[k] = data.accounts[k] || {};
  let raw;
  try { raw = loadJson(F.settings, {}); } catch (e) {
    throw new Error(`settings.json unreadable (${e.message}); refusing to start with unknown settings`);
  }
  data.settings = { defaults: raw.defaults || {}, server: raw.server || {} };

  const saveAccounts = () => { pruneRevoked(data.accounts.revoked); saveJson(F.accounts, data.accounts); };
  return {
    kind: "json",
    data,
    outbox: false,
    ...memoryShortLived(),
    async saveTenant() { saveJson(F.tenants, data.tenants); },
    async saveTenants() { saveJson(F.tenants, data.tenants); },
    async saveIdentity(key) { saveJson(F.identity, data.identity); return data.identity.users[key]; },
    async deleteIdentities(keys) { if (keys.length) saveJson(F.identity, data.identity); },
    async saveAccount(id) {
      const a = data.accounts.accounts[id];
      if (a && data.accounts.byEmail[a.email] && data.accounts.byEmail[a.email] !== id) throw conflict("email_taken");
      saveAccounts();
    },
    async saveRevoked() { saveAccounts(); },
    async saveSettings(doc) { data.settings = doc; saveJson(F.settings, doc); },
    async appendAudit(e) { fs.appendFileSync(F.audit, JSON.stringify(e) + "\n"); },
    async readAudit(filter, limit) {
      let lines = [];
      try { lines = fs.readFileSync(F.audit, "utf8").split("\n"); } catch (e) { return []; }
      const keep = auditMatch(filter), out = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        if (!lines[i]) continue;
        let e; try { e = JSON.parse(lines[i]); } catch (x) { continue; }
        if (keep(e)) out.push(e);
      }
      return out;
    },
    async ready() { fs.accessSync(dataDir, fs.constants.W_OK); },
    on() {},
    async forget() {},   // one process: nothing to tell
    async close() {},
  };
}

// ---------------------------------------------------------------- postgres
const SCHEMA = `
CREATE TABLE IF NOT EXISTS gw_tenants (
  site_key   text PRIMARY KEY,
  doc        jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- (organisation, its own user id) -> the Continuum user id. A stored allocation never moves, and two
-- keys can never share a user id (they would share one biometric profile).
CREATE TABLE IF NOT EXISTS gw_identities (
  key        text PRIMARY KEY,
  site_key   text NOT NULL,
  user_id    bigint NOT NULL UNIQUE,
  doc        jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gw_identities_site ON gw_identities (site_key);
CREATE TABLE IF NOT EXISTS gw_accounts (
  id         text PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  doc        jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gw_revoked_tokens (
  jti text PRIMARY KEY,
  exp bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS gw_settings (
  name       text PRIMARY KEY,
  doc        jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gw_audit (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL,
  site_key    text,
  actor_email text,
  doc         jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS gw_audit_site ON gw_audit (site_key, id DESC);
CREATE INDEX IF NOT EXISTS gw_audit_actor ON gw_audit (actor_email, id DESC);
-- Short-lived state, so a flow may continue on any gateway copy. Times are the database's (now()), so the
-- copies' clocks do not matter.
CREATE TABLE IF NOT EXISTS gw_links (
  id         text PRIMARY KEY,
  doc        jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS gw_ceremonies (
  id         text PRIMARY KEY,
  doc        jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS gw_admin_failures (
  who      text PRIMARY KEY,
  n        integer NOT NULL,
  first_at timestamptz NOT NULL,
  until_at timestamptz
);
-- Each user's last settled risk (genuine | suspicious), so a change is noticed whichever copy sees it.
CREATE TABLE IF NOT EXISTS gw_risk_state (
  key        text PRIMARY KEY,
  risk       text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Risk-change events (signed SETs) for the tenants' webhooks, written in the same transaction as the risk
-- change and delivered by webhooks.js: pending -> sent, or dead after the last attempt.
CREATE TABLE IF NOT EXISTS gw_webhook_outbox (
  id         bigserial PRIMARY KEY,
  site_key   text NOT NULL,
  url        text NOT NULL,
  body       text NOT NULL,
  status     text NOT NULL DEFAULT 'pending',
  attempts   integer NOT NULL DEFAULT 0,
  next_at    timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at    timestamptz
);
CREATE INDEX IF NOT EXISTS gw_webhook_due ON gw_webhook_outbox (next_at) WHERE status = 'pending';
`;
const CHANNEL = "gw_change";
const SCHEMA_LOCK = 4100417;   // pg_advisory_xact_lock: two copies starting together create the tables once

async function openPostgres(databaseUrl, log) {
  let pg;
  try { pg = require("pg"); } catch (e) {
    throw new Error("STORAGE=postgres needs the 'pg' package (npm install in services/gateway; the image has it)");
  }
  if (!databaseUrl) throw new Error("STORAGE=postgres needs DATABASE_URL (postgres://user:password@host:5432/db)");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: Number(process.env.DATABASE_POOL_MAX || 5) });
  pool.on("error", (e) => log(`[storage] idle database connection failed: ${e.message}`));
  const instance = crypto.randomBytes(6).toString("hex");   // tells this copy's notifications from the others'
  const data = EMPTY();
  const pendingIdentities = new Map();   // key -> identity record not saved yet (the database was down)
  const listeners = { tenant: [], identity: [], account: [], revoked: [], settings: [], forget: [] };
  const emit = (kind, key, value) => { for (const fn of listeners[kind]) { try { fn(key, value); } catch (e) { log(`[storage] ${kind} listener: ${e.message}`); } } };

  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { c.release(); }
  }
  // Delivered to the other copies when the transaction commits, never for a rolled-back one.
  const notify = (c, kind, key) => c.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ o: instance, k: kind, id: key })]);

  await tx(async (c) => { await c.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK]); await c.query(SCHEMA); });

  // ---- load: everything, into the same container objects (server.js keeps references to them)
  async function loadAll() {
    const [t, i, a, r, s] = await Promise.all([
      pool.query("SELECT site_key, doc FROM gw_tenants"),
      pool.query("SELECT key, doc FROM gw_identities"),
      pool.query("SELECT id, email, doc FROM gw_accounts"),
      pool.query("SELECT jti, exp FROM gw_revoked_tokens"),
      pool.query("SELECT doc FROM gw_settings WHERE name = 'operator'"),
    ]);
    data.tenants.tenants = Object.fromEntries(t.rows.map((x) => [x.site_key, x.doc]));
    data.identity.users = Object.fromEntries(i.rows.map((x) => [x.key, x.doc]));
    data.accounts.accounts = Object.fromEntries(a.rows.map((x) => [x.id, x.doc]));
    data.accounts.byEmail = Object.fromEntries(a.rows.map((x) => [x.email, x.id]));
    data.accounts.revoked = Object.fromEntries(r.rows.map((x) => [x.jti, Number(x.exp)]));
    const sd = (s.rows[0] && s.rows[0].doc) || {};
    data.settings = { defaults: sd.defaults || {}, server: sd.server || {} };
  }
  await loadAll();

  // ---- another copy changed one record: reload it
  async function reload(kind, key) {
    if (kind === "tenant") {
      const r = await pool.query("SELECT doc FROM gw_tenants WHERE site_key = $1", [key]);
      if (r.rows[0]) data.tenants.tenants[key] = r.rows[0].doc; else delete data.tenants.tenants[key];
    } else if (kind === "identity") {
      const r = await pool.query("SELECT doc FROM gw_identities WHERE key = $1", [key]);
      if (r.rows[0]) data.identity.users[key] = r.rows[0].doc; else delete data.identity.users[key];
    } else if (kind === "account") {
      const r = await pool.query("SELECT email, doc FROM gw_accounts WHERE id = $1", [key]);
      const old = data.accounts.accounts[key];
      if (old && data.accounts.byEmail[old.email] === key) delete data.accounts.byEmail[old.email];
      if (r.rows[0]) { data.accounts.accounts[key] = r.rows[0].doc; data.accounts.byEmail[r.rows[0].email] = key; } else delete data.accounts.accounts[key];
    } else if (kind === "revoked") {
      const r = await pool.query("SELECT exp FROM gw_revoked_tokens WHERE jti = $1", [key]);
      if (r.rows[0]) data.accounts.revoked[key] = Number(r.rows[0].exp); else delete data.accounts.revoked[key];
    } else if (kind === "settings") {
      const r = await pool.query("SELECT doc FROM gw_settings WHERE name = 'operator'");
      const sd = (r.rows[0] && r.rows[0].doc) || {};
      data.settings = { defaults: sd.defaults || {}, server: sd.server || {} };
      key = data.settings;
    } else return;
    emit(kind, key, kind === "settings" ? key : undefined);
  }

  // ---- the listening connection, reconnected with backoff; a reconnect reloads everything, since
  // notifications sent while it was down are lost
  let listener = null, closing = false, backoff = 1000, retryTimer = null;
  function scheduleReconnect() {
    if (closing || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; reconnect(); }, backoff);
    retryTimer.unref();
  }
  async function listen() {
    const c = new pg.Client({ connectionString: databaseUrl });
    c.on("error", (e) => log(`[storage] change feed lost: ${e.message}`));
    c.on("end", () => { if (listener === c) { listener = null; scheduleReconnect(); } });
    c.on("notification", (n) => {
      let m; try { m = JSON.parse(n.payload); } catch (e) { return; }
      if (!m || m.o === instance) return;
      // "forget": another copy says a cached fact is out of date (nothing to reload here)
      if (m.k === "forget") return emit("forget", m.id);
      reload(m.k, m.id).catch((e) => log(`[storage] reload ${m.k} ${m.id} failed: ${e.message}`));
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${CHANNEL}`);
    } catch (e) { c.end().catch(() => {}); throw e; }
    listener = c;
  }
  async function reconnect() {
    if (closing || listener) return;
    try {
      await listen();
      await loadAll();
      // the reload knows nothing of records kept while the database was down: put them back, save them
      for (const [k, rec] of pendingIdentities) if (!data.identity.users[k]) data.identity.users[k] = rec;
      await flushPendingIdentities();
      emit("settings", data.settings, data.settings);
      log("[storage] change feed back; records reloaded");
      backoff = 1000;
    } catch (e) {
      backoff = Math.min(backoff * 2, 30000);
      log(`[storage] change feed still down (${e.message}); retry in ${backoff / 1000} s`);
      if (listener) { const l = listener; listener = null; l.end().catch(() => {}); }
      scheduleReconnect();
    }
  }
  await listen();

  // ---- writes
  async function upsertTenant(c, siteKey) {
    const t = data.tenants.tenants[siteKey];
    if (t) await c.query("INSERT INTO gw_tenants (site_key, doc) VALUES ($1, $2) ON CONFLICT (site_key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()", [siteKey, t]);
    else await c.query("DELETE FROM gw_tenants WHERE site_key = $1", [siteKey]);
    await notify(c, "tenant", siteKey);
  }
  async function insertIdentity(key) {
    const rec = data.identity.users[key];
    let stored;
    try {
      stored = await tx(async (c) => {
        const ins = await c.query("INSERT INTO gw_identities (key, site_key, user_id, doc, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (key) DO NOTHING RETURNING doc",
          [key, siteKeyOf(key), rec.userId, rec, rec.createdAt || new Date().toISOString()]);
        if (ins.rows[0]) { await notify(c, "identity", key); return ins.rows[0].doc; }
        return (await c.query("SELECT doc FROM gw_identities WHERE key = $1", [key])).rows[0].doc;
      });
    } catch (e) {
      if (e.code !== "23505") throw e;
      // The user id is taken. Either another copy stored this same user a moment ago (two copies saw
      // them first at once, and the database checked the id before the key): its record wins. Or the id
      // is another user's: refused, since going on would give two people one profile.
      const r = await pool.query("SELECT doc FROM gw_identities WHERE key = $1", [key]);
      if (!r.rows[0]) throw conflict("identity_collision");
      stored = r.rows[0].doc;
    }
    data.identity.users[key] = stored;
    return stored;
  }
  // Records kept while the database was down, saved once it answers again (on reconnect, or with the
  // next new user). One that now collides with a stored user id is dropped: it would share a profile.
  async function flushPendingIdentities() {
    for (const [k, rec] of [...pendingIdentities]) {
      if (!data.identity.users[k]) data.identity.users[k] = rec;
      try { await insertIdentity(k); pendingIdentities.delete(k); } catch (e) {
        if (e.code !== "conflict") break;
        pendingIdentities.delete(k); delete data.identity.users[k];
        log(`[storage] identity ${k} dropped: its user id is already another user's`);
      }
    }
  }
  const ms = "($X::double precision * interval '1 millisecond')";
  const dur = (n) => ms.replace("$X", "$" + n);
  const shortLived = {
    async putLink(id, doc, ttlMs) {
      await pool.query(`INSERT INTO gw_links (id, doc, expires_at) VALUES ($1, $2, now() + ${dur(3)})`, [id, doc, ttlMs]);
    },
    async getLink(id) {
      const r = await pool.query("SELECT doc FROM gw_links WHERE id = $1 AND expires_at > now()", [String(id || "")]);
      return r.rows[0] ? r.rows[0].doc : null;
    },
    // One statement: two callbacks for one link cannot both authorize it.
    async authorizeLink(id, siteKey, patch) {
      const r = await pool.query(
        `UPDATE gw_links SET doc = doc || $3::jsonb WHERE id = $1 AND expires_at > now() AND doc->>'status' = 'pending' AND doc->>'siteKey' = $2 RETURNING doc`,
        [String(id || ""), siteKey, { ...patch, status: "authorized" }]);
      return r.rows[0] ? r.rows[0].doc : null;
    },
    // Removed as it is read: a link's code gets one attempt, on whichever copy.
    async takeLink(id) {
      const r = await pool.query("DELETE FROM gw_links WHERE id = $1 RETURNING doc, expires_at > now() AS live", [String(id || "")]);
      return r.rows[0] && r.rows[0].live ? r.rows[0].doc : null;
    },
    async putCeremony(id, doc, ttlMs) {
      await pool.query(`INSERT INTO gw_ceremonies (id, doc, expires_at) VALUES ($1, $2, now() + ${dur(3)})`, [id, doc, ttlMs]);
    },
    async takeCeremony(id) {
      const r = await pool.query("DELETE FROM gw_ceremonies WHERE id = $1 RETURNING doc, expires_at > now() AS live", [String(id || "")]);
      return r.rows[0] && r.rows[0].live ? r.rows[0].doc : null;
    },
    async adminLockedUntil(who) {
      const r = await pool.query("SELECT extract(epoch FROM until_at) * 1000 AS until FROM gw_admin_failures WHERE who = $1 AND until_at > now()", [who]);
      return r.rows[0] ? Number(r.rows[0].until) : 0;
    },
    // One statement, so wrong keys sent to several copies at once are all counted.
    async recordAdminFailure(who, { windowMs, limit, lockMs }) {
      const fresh = `f.first_at <= now() - ${dur(2)}`;
      const r = await pool.query(
        `INSERT INTO gw_admin_failures AS f (who, n, first_at, until_at)
           VALUES ($1, 1, now(), CASE WHEN 1 >= $3 THEN now() + ${dur(4)} END)
         ON CONFLICT (who) DO UPDATE SET
           n        = CASE WHEN ${fresh} THEN 1 ELSE f.n + 1 END,
           first_at = CASE WHEN ${fresh} THEN now() ELSE f.first_at END,
           until_at = CASE WHEN (CASE WHEN ${fresh} THEN 1 ELSE f.n + 1 END) >= $3 THEN now() + ${dur(4)} ELSE f.until_at END
         RETURNING n, coalesce(extract(epoch FROM until_at) * 1000, 0) AS until`,
        [who, windowMs, limit, lockMs]);
      return { n: r.rows[0].n, until: Number(r.rows[0].until) };
    },
    async clearAdminFailures(who) { await pool.query("DELETE FROM gw_admin_failures WHERE who = $1", [who]); },
    // The previous risk is read under a row lock, so of two copies seeing the same change at once only one
    // records it (and queues its event). makeEvent(prev) returns { siteKey, url, body } or null.
    riskTransition: (key, value, makeEvent) => tx(async (c) => {
      await c.query("INSERT INTO gw_risk_state (key, risk) VALUES ($1, NULL) ON CONFLICT (key) DO NOTHING", [key]);
      const prev = (await c.query("SELECT risk FROM gw_risk_state WHERE key = $1 FOR UPDATE", [key])).rows[0].risk || undefined;
      if (prev === value) return { prev, changed: false };
      await c.query("UPDATE gw_risk_state SET risk = $2, updated_at = now() WHERE key = $1", [key, value]);
      const ev = makeEvent(prev);
      if (ev) await c.query("INSERT INTO gw_webhook_outbox (site_key, url, body) VALUES ($1, $2, $3)", [ev.siteKey, ev.url, ev.body]);
      return { prev, changed: true, queued: !!ev };
    }),
    async deleteRiskState(key) { await pool.query("DELETE FROM gw_risk_state WHERE key = $1", [key]); },
    async riskGet(key) {
      const r = await pool.query("SELECT risk FROM gw_risk_state WHERE key = $1", [key]);
      return r.rows[0] ? r.rows[0].risk || undefined : undefined;
    },
    // Due events, leased for leaseMs (a copy that dies mid-delivery leaves them to the next one). The
    // attempt is counted when claimed.
    async claimWebhooks(limit, leaseMs) {
      const r = await pool.query(
        `UPDATE gw_webhook_outbox SET next_at = now() + ${dur(2)}, attempts = attempts + 1
         WHERE id IN (SELECT id FROM gw_webhook_outbox WHERE status = 'pending' AND next_at <= now()
                      ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
         RETURNING id, site_key, url, body, attempts`, [limit, leaseMs]);
      return r.rows.map((x) => ({ id: Number(x.id), siteKey: x.site_key, url: x.url, body: x.body, attempts: x.attempts }));
    },
    // { ok } | { error, retryInMs } | { error, dead: true }
    async finishWebhook(id, out) {
      if (out.ok) await pool.query("UPDATE gw_webhook_outbox SET status = 'sent', done_at = now(), last_error = NULL WHERE id = $1", [id]);
      else if (out.dead) await pool.query("UPDATE gw_webhook_outbox SET status = 'dead', done_at = now(), last_error = $2 WHERE id = $1", [id, out.error]);
      else await pool.query(`UPDATE gw_webhook_outbox SET next_at = now() + ${dur(3)}, last_error = $2 WHERE id = $1`, [id, out.error, out.retryInMs]);
    },
    // Expired entries, and finished webhook rows (sent after 7 days, dead after 30).
    async sweep() {
      await pool.query("DELETE FROM gw_links WHERE expires_at <= now()");
      await pool.query("DELETE FROM gw_ceremonies WHERE expires_at <= now()");
      await pool.query("DELETE FROM gw_admin_failures WHERE (until_at IS NULL OR until_at <= now()) AND first_at <= now() - interval '1 hour'");
      await pool.query("DELETE FROM gw_webhook_outbox WHERE (status = 'sent' AND done_at < now() - interval '7 days') OR (status = 'dead' AND done_at < now() - interval '30 days')");
    },
  };
  return {
    kind: "postgres",
    data,
    outbox: true,
    ...shortLived,
    saveTenant: (siteKey) => tx((c) => upsertTenant(c, siteKey)),
    saveTenants: (keys) => tx(async (c) => { for (const k of keys) await upsertTenant(c, k); }),
    // First sighting of a user. Another copy may have stored the same key a moment ago: the stored
    // record always wins, and is returned. A record that could not be saved (the database was down)
    // is kept in memory and retried with the next one, as a JSON save rewrites the whole file.
    async saveIdentity(key) {
      let stored;
      try { stored = await insertIdentity(key); } catch (e) {
        if (e.code !== "conflict") pendingIdentities.set(key, data.identity.users[key]);
        throw e;
      }
      pendingIdentities.delete(key);
      await flushPendingIdentities();
      return stored;
    },
    deleteIdentities: (keys) => (keys.length ? tx(async (c) => {
      await c.query("DELETE FROM gw_identities WHERE key = ANY($1)", [keys]);
      for (const k of keys) await notify(c, "identity", k);
    }) : Promise.resolve()),
    saveAccount: (id) => tx(async (c) => {
      const a = data.accounts.accounts[id];
      if (a) {
        try {
          await c.query("INSERT INTO gw_accounts (id, email, doc) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, doc = EXCLUDED.doc, updated_at = now()", [id, a.email, a]);
        } catch (e) { if (e.code === "23505") throw conflict("email_taken"); throw e; }
      } else await c.query("DELETE FROM gw_accounts WHERE id = $1", [id]);
      await notify(c, "account", id);
    }),
    async saveRevoked(jti) {
      pruneRevoked(data.accounts.revoked);
      await tx(async (c) => {
        const exp = data.accounts.revoked[jti];
        if (exp != null) await c.query("INSERT INTO gw_revoked_tokens (jti, exp) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING", [jti, exp]);
        await c.query("DELETE FROM gw_revoked_tokens WHERE exp < $1", [nowSec()]);
        await notify(c, "revoked", jti);
      });
    },
    saveSettings: (doc) => tx(async (c) => {
      await c.query("INSERT INTO gw_settings (name, doc) VALUES ('operator', $1) ON CONFLICT (name) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()", [doc]);
      await notify(c, "settings", "operator");
    }).then(() => { data.settings = doc; }),
    async appendAudit(e) {
      const email = e.actor && e.actor.type === "account" ? e.actor.email || null : null;
      await pool.query("INSERT INTO gw_audit (at, site_key, actor_email, doc) VALUES ($1, $2, $3, $4)", [e.at, e.siteKey || null, email, e]);
    },
    async readAudit(filter, limit) {
      const r = filter
        ? await pool.query("SELECT doc FROM gw_audit WHERE site_key = ANY($1) OR ($2::text IS NOT NULL AND actor_email = $2) ORDER BY id DESC LIMIT $3",
          [[...(filter.siteKeys || [])], filter.email || null, limit])
        : await pool.query("SELECT doc FROM gw_audit ORDER BY id DESC LIMIT $1", [limit]);
      return r.rows.map((x) => x.doc);
    },
    async ready() { await pool.query("SELECT 1"); if (!listener) throw new Error("change feed down"); },
    on(kind, fn) { listeners[kind].push(fn); },
    // Tell the other copies to drop a fact they may have cached (key: "<cache>:<id>").
    async forget(key) { await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ o: instance, k: "forget", id: key })]); },
    async close() {
      closing = true;
      if (listener) await listener.end().catch(() => {});
      await pool.end();
    },
    _instance: instance,
  };
}

// opts: { kind: "json" | "postgres", dataDir, databaseUrl, log }
async function openStorage(opts) {
  const kind = String(opts.kind || "json").toLowerCase();
  const log = opts.log || ((m) => console.error(m));
  if (kind === "json") return openJson(opts.dataDir);
  if (kind === "postgres") return openPostgres(opts.databaseUrl, log);
  throw new Error(`STORAGE must be json or postgres (got ${opts.kind})`);
}

module.exports = { openStorage, siteKeyOf, auditMatch };
