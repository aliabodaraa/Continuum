// express-session store on the demo's own SQLite database (db/init.js), so a sign-in survives a restart of the
// pod. Until 2026-10-29 the sessions lived in the process's memory: every restart ended every session while the
// open pages still looked signed in (a node reboot did that three times in the week of 25 Oct 2026).
// One table, sessions(sid, sess as JSON, expires in ms). An expired row reads as no session and is removed by the
// hourly prune. express-session rebuilds the cookie from the stored JSON (its expiry comes back as a string).
const { Store } = require("express-session");

const PRUNE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

class SqliteSessionStore extends Store {
  constructor(db, { pruneMs = PRUNE_MS } = {}) {
    super();
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)");
    db.exec("CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires)");
    this.q = {
      get: db.prepare("SELECT sess, expires FROM sessions WHERE sid = ?"),
      set: db.prepare("INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires"),
      touch: db.prepare("UPDATE sessions SET expires = ? WHERE sid = ?"),
      destroy: db.prepare("DELETE FROM sessions WHERE sid = ?"),
      prune: db.prepare("DELETE FROM sessions WHERE expires <= ?"),
      count: db.prepare("SELECT count(*) AS n FROM sessions WHERE expires > ?"),
      all: db.prepare("SELECT sess FROM sessions WHERE expires > ?"),
      clear: db.prepare("DELETE FROM sessions"),
    };
    this.prune();
    this.timer = pruneMs > 0 ? setInterval(() => this.prune(), pruneMs) : null;
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  // When a session ends: its cookie's expiry, else now plus the cookie's maxAge, else a day.
  static expiresAt(sess) {
    const c = (sess && sess.cookie) || {};
    if (c.expires) {
      const t = new Date(c.expires).getTime();
      if (Number.isFinite(t)) return t;
    }
    const max = Number(c.maxAge);
    return Date.now() + (Number.isFinite(max) && max > 0 ? max : DAY_MS);
  }

  get(sid, cb) {
    try {
      const r = this.q.get.get(sid);
      if (!r || r.expires <= Date.now()) return cb(null, null);
      cb(null, JSON.parse(r.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { this.q.set.run(sid, JSON.stringify(sess), SqliteSessionStore.expiresAt(sess)); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
  }
  touch(sid, sess, cb) {
    try { this.q.touch.run(SqliteSessionStore.expiresAt(sess), sid); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
  }
  destroy(sid, cb) {
    try { this.q.destroy.run(sid); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
  }
  length(cb) {
    try { cb(null, this.q.count.get(Date.now()).n); } catch (e) { cb(e); }
  }
  all(cb) {
    try { cb(null, this.q.all.all(Date.now()).map((r) => JSON.parse(r.sess))); } catch (e) { cb(e); }
  }
  clear(cb) {
    try { this.q.clear.run(); if (cb) cb(null); } catch (e) { if (cb) cb(e); }
  }
  // Rows whose time has passed. Returns how many went.
  prune() {
    try { return this.q.prune.run(Date.now()).changes; } catch (e) { return 0; }
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = SqliteSessionStore;
