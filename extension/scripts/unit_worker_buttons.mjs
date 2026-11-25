// Buttons whose action could not be carried out (the review of 2026-11-25), on the worker's side. background.js runs in a
// plain script context with a stand-in for the chrome API and a simulated gateway (no network, no browser):
//   1. the lock's "Verify with passkey" once the sign-in itself is dead (refresh token expired or revoked): the overlay is
//      told to sign in again, not "Can't reach Continuum"; the settings learn it too
//   2. "Sign in again" as the locked account: the lock stays (also after a restart of the worker) and the passkey page opens
//   3. "Sign in again" as another account while locked: refused, its new sign-in revoked, the locked account and its lock kept
//   4. a second "Sign in" while one is open: the open window is brought to the front, the sign-in in progress is kept; one
//      for another organisation replaces it and closes its window
//   5. the gateway refuses this copy of the extension at the end of a sign-in: the message says so, with the id
//   6. "Finish enrolment" while locked: refused, nothing opened
//   7. a channel the organisation turned off stays off across a restart of the worker, and is noticed when it is back on
//   8. the tabs already open when the extension is installed get the Arabic phrases before content.js
//   9. another account signing in in place of a signed-in one (not locked): the pages start again from empty buffers
//
//   node extension/scripts/unit_worker_buttons.mjs
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
import { fileURLToPath } from "node:url";
const EXT = process.env.EXT_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(EXT, "src", "background.js"), "utf8");
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };
// the sign-in's SHA-256 (WebCrypto) answers on another thread, later than any number of ticks: some real time too
const settle = async () => { for (let k = 0; k < 3; k++) { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 20)); } };

const GW = "http://gw.test", SITE = "http://site.test";
const ACCOUNT = { gateway: GW, siteKey: "SK", kind: "personal", label: "test", userId: 78, refreshToken: "rt", onboarding: { passkey: true, keystroke: true, mouse: true } };
const USER = ["personal", GW, "SK", 78].join("|");
const locked = () => ({ cg_account: ACCOUNT, cg_buffer_epoch: "bSAVED",
  cg_progress: { user: USER, locked: true, lockReason: "mouse", lockPasted: false, probation: false, verdict: null, mouseVerdict: null, at: Date.now() } });
const SESSION_OK = { token: "session-token", userId: 78 };
const DEAD = { status: 401, body: { error: "invalid_refresh_token" } };
const token = (userId, refreshToken) => ({ token: "t" + userId, refreshToken, userId, siteKey: "SK", kind: "personal", tenantName: "Personal", label: "u" + userId,
  onboarding: { passkey: true, keystroke: true, mouse: true } });

// A worker just started, with its saved state read. route: path -> answer, or { status, body }, or a function of the body.
async function start(store, route = {}, opts = {}) {
  const listeners = {}, reads = [], sent = [], opened = [], removed = [], focused = [], injected = [], calls = [], later = [];
  const session = opts.session || {};
  const tabs = new Map([[1, { id: 1, url: SITE + "/", windowId: 1 }]]);
  let nextId = 100;
  const copy = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const pick = (src, keys) => { const out = {}; for (const k of [].concat(keys)) if (k in src) out[k] = copy(src[k]); return out; };
  const on = (name) => ({ addListener: (fn) => { (listeners[name] = listeners[name] || []).push(fn); } });
  const newWindow = (url) => { const w = nextId++, t = nextId++; tabs.set(t, { id: t, url, windowId: w }); opened.push(url); return { id: w, tabs: [{ id: t, windowId: w, url }] }; };
  const chrome = {
    runtime: { id: "ext", onMessage: on("message"), onInstalled: on("installed"), onStartup: on("startup"), openOptionsPage() {} },
    storage: {
      local: { get(keys, cb) { const snap = pick(store, keys); reads.push(() => cb(snap)); },
        set(o, cb) { Object.assign(store, copy(o)); if (cb) cb(); }, remove(k, cb) { for (const x of [].concat(k)) delete store[x]; if (cb) cb(); } },
      session: { get(k, cb) { const out = pick(session, k); if (cb) cb(out); return Promise.resolve(out); },
        set(o) { Object.assign(session, copy(o)); return Promise.resolve(); }, remove(k) { for (const x of [].concat(k)) delete session[x]; return Promise.resolve(); } },
      onChanged: on("changed"),
    },
    tabs: { query(q, cb) { cb([...tabs.values()].map(copy)); }, sendMessage(id, msg, cb) { sent.push(copy(msg)); if (cb) cb(); },
      create(o, cb) { const w = newWindow(o.url); if (cb) cb(w.tabs[0]); }, remove(id, cb) { removed.push(id); tabs.delete(id); if (cb) cb(); },
      get(id, cb) { cb(tabs.has(id) ? copy(tabs.get(id)) : undefined); },
      onRemoved: on("tabRemoved"), onActivated: on("tabActivated"), onUpdated: on("tabUpdated") },
    // opts.slowWindows: the window's callback comes only when the test says so (a second click while it is being opened)
    windows: { create(o, cb) { const w = newWindow(o.url); if (opts.slowWindows) later.push(() => cb && cb(w)); else if (cb) cb(w); },
      update(id, o, cb) { if (o && o.focused) focused.push(id); if (cb) cb(); } },
    alarms: { create() {}, clear() {}, onAlarm: on("alarm") },
    commands: { onCommand: on("command") },
    action: { setIcon() {}, setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    scripting: { executeScript(o, cb) { injected.push(o.files); if (cb) cb(); } },
  };
  const fetchStub = async (url, o) => {
    const u = new URL(String(url)); let body = {}; try { body = o && o.body ? JSON.parse(o.body) : {}; } catch { /* not JSON */ }
    calls.push({ path: u.pathname, body });
    const h = route[u.pathname], out = typeof h === "function" ? h(body) : h;
    if (!out) throw new Error("no network in this test: " + u.pathname);
    const status = out.status || 200, data = out.status ? out.body : out;
    const res = { ok: status < 400, status, json: async () => copy(data) };
    res.clone = () => res;
    return res;
  };
  const ctx = vm.createContext({ chrome, console, URL, TextEncoder, crypto: globalThis.crypto, btoa, fetch: fetchStub,
    setTimeout: () => 0, clearTimeout() {} });
  vm.runInContext(SRC, ctx, { filename: "background.js" });
  reads.splice(0).forEach((f) => f());
  await settle();
  const message = async (msg, sender) => {
    let got; const ret = listeners.message[0](msg, sender || { tab: { id: 1, url: SITE + "/" }, url: SITE + "/" }, (v) => { got = v; });
    await settle();
    return { ret, got };
  };
  const W = (expr) => vm.runInContext(expr, ctx);
  return { ctx, W, store, session, listeners, message, sent, opened, removed, focused, injected, calls, later, tabs };
}
const types = (w) => w.sent.map((m) => m.type);
const doneFrom = (tabId) => ({ url: GW + "/connect.html?mode=done", tab: { id: tabId } });
const linkTab = (w) => w.session.cg_link_pending && w.session.cg_link_pending.tabId;

// ---- 1. the lock's button with a dead sign-in
{
  const w = await start(locked(), { "/v1/sdk/session": DEAD });
  const r = await w.message({ type: "cg:open-verify" });
  const st = JSON.parse(w.W("JSON.stringify(statusObj(null))"));
  ok("1. the lock's button with a dead sign-in: the overlay is told to sign in again", types(w).includes("cg:sign-in-needed") && !types(w).includes("cg:gateway-unreachable"),
    types(w).join(", "));
  ok("…the status says the sign-in expired (not \"Can't reach\"), and the settings can offer to sign in again", /expired/.test(st.error || "") && st.signInExpired === true,
    `${st.error} · signInExpired ${st.signInExpired}`);
  ok("…nothing opened, still locked", w.opened.length === 0 && st.locked === true && r.got && r.got.locked === true);
  // not locked: a page's check keeps the plain message, not the gateway's code
  const store = locked(); store.cg_progress.locked = false;
  const w2 = await start(store, { "/v1/sdk/session": DEAD });
  await w2.message({ type: "cg:check", channel: "mouse", bufferEpoch: w2.W("bufferEpoch"), body: { windows: [] } });
  ok("…a page's check with the dead sign-in leaves that message in place", /expired/.test(w2.W("state.error") || ""), w2.W("state.error"));
}
// ---- 2. "Sign in again" as the locked account
{
  const w = await start(locked(), { "/v1/sdk/session": DEAD, "/v1/link/token": token(78, "rt2"), "/v1/link/revoke": { ok: true } });
  await w.message({ type: "cg:open-verify" });
  const again = await w.message({ type: "cg:sign-in-again" });
  const link = w.opened.find((u) => u.startsWith(GW + "/connect.html?mode=link&k=SK"));
  ok("2. \"Sign in again\" opens the sign-in of the account's own server and organisation", again.got && again.got.ok === true && !!link, w.opened.join(" | "));
  const tab = linkTab(w);
  await w.message({ type: "cg:link-code", link: "L", code: "C" }, doneFrom(tab));
  const st = JSON.parse(w.W("JSON.stringify(statusObj(null))"));
  ok("…signed in again as the locked account: the new sign-in is kept and the lock stays", w.store.cg_account.refreshToken === "rt2" && st.locked === true
    && w.store.cg_progress.locked === true && w.store.cg_progress.user === USER, `refresh ${w.store.cg_account.refreshToken}, locked ${st.locked}`);
  ok("…the passkey page opens next, the sign-in window is closed and the old sign-in revoked",
    w.opened.some((u) => u.startsWith(GW + "/connect.html?mode=verify")) && w.removed.includes(tab) && w.calls.some((c) => c.path === "/v1/link/revoke" && c.body.refreshToken === "rt"),
    w.opened.map((u) => u.split("#")[0]).join(" | "));
  ok("…and the settings no longer offer to sign in again", st.signInExpired === false);
  const w2 = await start(w.store, { "/v1/sdk/session": SESSION_OK });
  ok("…a restarted worker is still locked", w2.W("state.locked") === true);
}
// ---- 3. "Sign in again" as another account while locked
{
  const w = await start(locked(), { "/v1/sdk/session": DEAD, "/v1/link/token": token(99, "rtX"), "/v1/link/revoke": { ok: true } });
  await w.message({ type: "cg:open-verify" });
  await w.message({ type: "cg:sign-in-again" });
  const tab = linkTab(w);
  const before = w.opened.length;
  w.sent.length = 0;
  await w.message({ type: "cg:link-code", link: "L", code: "C" }, doneFrom(tab));
  ok("3. another account signing in while locked is refused: the locked account and its lock stay",
    w.store.cg_account.userId === 78 && w.store.cg_account.refreshToken === "rt" && w.W("state.locked") === true && w.W("account.userId") === 78,
    `account ${w.store.cg_account.userId}, locked ${w.W("state.locked")}`);
  ok("…its new sign-in is revoked, nothing else opens, its window is closed",
    w.calls.some((c) => c.path === "/v1/link/revoke" && c.body.refreshToken === "rtX") && w.opened.length === before && w.removed.includes(tab));
  const told = w.sent.find((m) => m.type === "cg:sign-in-needed");
  ok("…and the overlay says why", !!told && /locked for test/.test(told.message || ""), told && told.message);
  const w2 = await start(w.store, { "/v1/sdk/session": DEAD });
  ok("…a restarted worker is still locked", w2.W("state.locked") === true);
  // The settings' ordinary "Sign in" was the way round the lock that stood open: another account signed in over the
  // locked one, the lock went with it, and that account's own passkey then lifted it.
  const v = await start(locked(), { "/v1/sdk/session": SESSION_OK, "/v1/link/token": token(99, "rtY"), "/v1/link/revoke": { ok: true } });
  await v.message({ type: "cg:sign-in", gateway: GW, siteKey: "" });
  const signInTab = [...v.tabs.values()].find((t) => String(t.url).includes("/connect.html?mode=link"));
  await v.message({ type: "cg:link-code", link: "L", code: "C" }, doneFrom(signInTab ? signInTab.id : 0));
  ok("…the settings' ordinary sign-in as another account, while locked, is refused as well", !!signInTab && v.store.cg_account.userId === 78 && v.W("account.userId") === 78 && v.W("state.locked") === true,
    `account ${v.store.cg_account.userId}, locked ${v.W("state.locked")}`);
}
// ---- 4. a second "Sign in" while one is open
{
  const w = await start({}, {});
  await w.message({ type: "cg:sign-in", gateway: GW, siteKey: "pk_personal" });
  const first = JSON.stringify(w.session.cg_link_pending);
  await w.message({ type: "cg:sign-in", gateway: GW, siteKey: "pk_personal" });
  ok("4. a second \"Sign in\" while one is open: no second window, the open one to the front, the same sign-in kept",
    w.opened.length === 1 && w.focused.length === 1 && JSON.stringify(w.session.cg_link_pending) === first, `${w.opened.length} windows, ${w.focused.length} focused`);
  const tab = linkTab(w);
  await w.message({ type: "cg:sign-in", gateway: GW, siteKey: "pk_org" });
  ok("…another organisation's sign-in replaces it and closes its window", w.opened.length === 2 && w.removed.includes(tab) && w.session.cg_link_pending.siteKey === "pk_org");
  const s = await start({}, {}, { slowWindows: true });
  await s.message({ type: "cg:sign-in", gateway: GW, siteKey: "pk_personal" });
  await s.message({ type: "cg:sign-in", gateway: GW, siteKey: "pk_personal" });
  s.later.forEach((f) => f()); await settle();
  ok("…a double click while the window is being opened opens one window", s.opened.length === 1 && linkTab(s) != null, `${s.opened.length} windows`);
}
// ---- 5. the gateway refuses this copy of the extension
{
  const w = await start({}, { "/v1/link/token": { status: 403, body: { error: "origin_not_allowed" } } });
  await w.message({ type: "cg:sign-in", gateway: GW, siteKey: "pk_personal" });
  const tab = linkTab(w);
  await w.message({ type: "cg:link-code", link: "L", code: "C" }, doneFrom(tab));
  const e = w.W("state.error") || "";
  ok("5. refused for this copy of the extension: said plainly, with the id, and the sign-in window closed",
    /does not accept this copy of the extension \(id ext\)/.test(e) && w.removed.includes(tab), e);
}
// ---- 6. "Finish enrolment" while locked
{
  const w = await start(locked(), { "/v1/sdk/session": SESSION_OK });
  const r = await w.message({ type: "cg:open-enrol" });
  ok("6. \"Finish enrolment\" while locked: refused, nothing opened", r.got && r.got.error === "locked" && w.opened.length === 0, JSON.stringify(r.got));
  const store = locked(); store.cg_progress.locked = false;
  const w2 = await start(store, { "/v1/sdk/session": SESSION_OK });
  await w2.message({ type: "cg:open-enrol" });
  ok("…not locked, it opens the enrolment page", w2.opened.length === 1 && w2.opened[0].startsWith(GW + "/connect.html?mode=enrol"), w2.opened.map((u) => u.split("#")[0]).join(" | "));
}
// ---- 7. a channel turned off, across a restart
{
  const store = locked(); store.cg_progress.locked = false;
  const w = await start(store, { "/v1/sdk/session": SESSION_OK, "/v1/sdk/mouse/check": { status: 409, body: { error: "mouse_disabled" } } });
  await w.message({ type: "cg:check", channel: "mouse", bufferEpoch: w.W("bufferEpoch"), body: { windows: [] } });
  ok("7. the organisation turns the mouse off: kept in storage", !!(w.store.cg_disabled && w.store.cg_disabled.mouse), JSON.stringify(w.store.cg_disabled));
  const off = { "/v1/sdk/session": SESSION_OK, "/v1/sdk/keystroke/config": { keystroke: "on", mouse: "off" } };
  const w2 = await start(w.store, off);
  const hello = await w2.message({ type: "cg:hello", origin: SITE });
  ok("…a restarted worker tells the pages it is still off", !!(hello.got && hello.got.capture && hello.got.capture.off.mouse === true), JSON.stringify(hello.got && hello.got.capture));
  ok("…and asks the organisation's settings at once", w2.calls.some((c) => c.path === "/v1/sdk/keystroke/config"));
  const w3 = await start(w.store, { "/v1/sdk/session": SESSION_OK, "/v1/sdk/keystroke/config": { keystroke: "on", mouse: "on" } });
  const hello3 = await w3.message({ type: "cg:hello", origin: SITE });
  ok("…switched back on meanwhile: a restarted worker notices it and the pages collect it again", hello3.got && hello3.got.capture.off.mouse === false && !(w3.store.cg_disabled || {}).mouse,
    JSON.stringify(hello3.got && hello3.got.capture));
}
// ---- 8. tabs open at install
{
  const w = await start({}, {});
  w.listeners.installed[0]({ reason: "update" });
  const files = w.injected[0] || [];
  ok("8. tabs open at install get lang-ar.js before content.js", files.indexOf("src/lang-ar.js") >= 0 && files.indexOf("src/lang-ar.js") < files.indexOf("src/content.js"), files.join(", "));
}
// ---- 9. another account in place of a signed-in one, not locked
{
  const store = locked(); store.cg_progress.locked = false;
  const w = await start(store, { "/v1/link/token": token(99, "rtX"), "/v1/link/revoke": { ok: true } });
  const epoch = w.W("bufferEpoch");
  await w.message({ type: "cg:sign-in", gateway: GW, siteKey: "SK" });
  w.sent.length = 0;
  await w.message({ type: "cg:link-code", link: "L", code: "C" }, doneFrom(linkTab(w)));
  const reset = w.sent.find((m) => m.type === "cg:reset");
  ok("9. another account replacing a signed-in one (not locked): a new buffer epoch, the pages told to start again",
    w.store.cg_account.userId === 99 && w.W("bufferEpoch") !== epoch && !!reset && reset.bufferEpoch === w.W("bufferEpoch"), `account ${w.store.cg_account.userId}`);
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
