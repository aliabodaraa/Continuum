// The worker's start, with the read of its saved state held back (2026-11-25). Chrome starts the worker for a message
// and may hand it that message before chrome.storage.local.get has answered. The end-to-end harness does not produce
// that order (there the read wins), so here background.js runs in a plain script context with a stand-in for the
// chrome API whose storage read answers only when the test says so.
//   1. a hello before the read is answered after it, with the saved lock (it used to be answered "not locked, nobody
//      signed in" at once)
//   2. a passkey verified before the read lifts the lock (it used to be dropped: the gateway was not known yet)
//   3. a message that gets no answer is closed once it has been handled
//   4. an epoch issued before the read (a change of user that woke the worker) is not replaced by the saved one
//   5. a read that never answers does not hold the messages for ever
//   6. a lock starts a new epoch, so nothing a page collected before it can be checked after it
//   7. the lock button pressed before the read opens the verify page (it used to do nothing: nobody was signed in yet)
//
//   node extension/scripts/unit_worker_restore.mjs
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";
import { fileURLToPath } from "node:url";
const EXT = process.env.EXT_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(EXT, "src", "background.js"), "utf8");
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };
const tick = () => new Promise((r) => setImmediate(r));

const GW = "http://gw.test";
const ACCOUNT = { gateway: GW, siteKey: "SK", kind: "personal", label: "test", userId: 78, refreshToken: "rt", onboarding: { passkey: true, keystroke: true, mouse: true } };
const USER = ["personal", GW, "SK", 78].join("|");
const saved = () => ({ cg_account: ACCOUNT, cg_buffer_epoch: "bSAVED",
  cg_progress: { user: USER, locked: true, lockReason: "mouse", lockPasted: false, probation: false, verdict: null, mouseVerdict: null, at: Date.now() } });

// A worker just started: its script has run, its listeners are registered, and its storage read waits in `reads`.
function start(store) {
  const listeners = {}, reads = [], timers = [], opened = [];
  const on = (name) => ({ addListener: (fn) => { (listeners[name] = listeners[name] || []).push(fn); } });
  const copy = (o) => JSON.parse(JSON.stringify(o));
  const pick = (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in store) out[k] = copy(store[k]); return out; };
  const chrome = {
    runtime: { id: "ext", onMessage: on("message"), onInstalled: on("installed"), onStartup: on("startup"), openOptionsPage() {} },
    storage: {
      // the answer is what was stored when the read was asked for, as in the browser
      local: { get(keys, cb) { const snap = pick(keys); reads.push(() => cb(snap)); },
        set(o, cb) { Object.assign(store, copy(o)); if (cb) cb(); }, remove(k, cb) { for (const x of [].concat(k)) delete store[x]; if (cb) cb(); } },
      session: { get(k, cb) { if (cb) cb({}); return Promise.resolve({}); }, set() { return Promise.resolve(); }, remove() { return Promise.resolve(); } },
      onChanged: on("changed"),
    },
    tabs: { query(q, cb) { cb([]); }, sendMessage() {}, create(o, cb) { opened.push(o.url); if (cb) cb({ id: 9 }); }, remove() {}, get() {},
      onRemoved: on("tabRemoved"), onActivated: on("tabActivated"), onUpdated: on("tabUpdated") },
    windows: { create(o, cb) { opened.push(o.url); if (cb) cb({ tabs: [{ id: 9 }] }); } },
    alarms: { create() {}, clear() {}, onAlarm: on("alarm") },
    commands: { onCommand: on("command") },
    action: { setIcon() {}, setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    scripting: { executeScript() {} },
  };
  const ctx = vm.createContext({ chrome, console, URL, TextEncoder, crypto: globalThis.crypto, btoa,
    // the gateway: a session for the signed-in account, nothing else
    fetch: (url) => String(url).endsWith("/v1/sdk/session")
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ token: "session-token", userId: 78 }) })
      : Promise.reject(new Error("no network in this test")),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} });
  vm.runInContext(SRC, ctx, { filename: "background.js" });
  const message = (msg, sender) => { const got = { called: 0, value: undefined }; const ret = listeners.message[0](msg, sender || { tab: { id: 1 } }, (v) => { got.called++; got.value = v; }); return { got, ret }; };
  return { ctx, store, listeners, message, timers, opened, read: () => { const r = reads.splice(0); r.forEach((f) => f()); } };
}

// ---- 1. a hello before the read
{
  const w = start(saved());
  const hello = w.message({ type: "cg:hello", origin: "http://site.test" });
  const early = hello.got.called ? JSON.stringify({ locked: hello.got.value.locked, signedIn: !!hello.got.value.capture }) : "held";
  w.read(); await tick();
  const v = hello.got.value || {};
  ok("1. a hello before the saved state is read is not answered before it", early === "held", early);
  ok("…and is answered after it with the saved lock, the account and the saved epoch", hello.got.called === 1 && v.locked === true && !!v.capture && v.capture.kind === "personal" && v.bufferEpoch === "bSAVED",
    JSON.stringify({ locked: v.locked, signedIn: !!v.capture, epoch: v.bufferEpoch }));
}
// ---- 2. the passkey's result before the read
{
  const w = start(saved());
  w.message({ type: "cg:verified" }, { url: GW + "/connect.html?mode=verify", tab: { id: 9 } });
  w.read(); await tick();
  const locked = vm.runInContext("state.locked", w.ctx);
  ok("2. a passkey verified before the saved state is read lifts the lock", locked === false && w.store.cg_progress.locked === false,
    `worker locked: ${locked}, saved lock: ${w.store.cg_progress.locked}`);
  ok("…and starts a new epoch", !!w.store.cg_buffer_epoch && w.store.cg_buffer_epoch !== "bSAVED", String(w.store.cg_buffer_epoch));
}
// ---- 3. a message with no answer
{
  const w = start(saved());
  const p = w.message({ type: "cg:progress", ks: 1, mouse: 2 });
  w.read(); await tick();
  ok("3. a held message that gets no answer is closed after it is handled", p.ret === true && p.got.called === 1 && p.got.value === undefined, `closed ${p.got.called} time(s)`);
}
// ---- 4. an epoch issued before the read
{
  const store = saved(); delete store.cg_account;                 // nobody was signed in when the worker stopped
  const w = start(store);
  w.listeners.changed[0]({ cg_account: { newValue: ACCOUNT } }, "local");   // the sign-in that woke it: a change of user
  const issued = vm.runInContext("typeof bufferEpoch === \"undefined\" ? null : bufferEpoch", w.ctx);
  w.read(); await tick();
  const after = vm.runInContext("typeof bufferEpoch === \"undefined\" ? null : bufferEpoch", w.ctx);
  ok("4. an epoch issued before the read stays (the worker and its storage agree)", !!issued && issued !== "bSAVED" && after === issued && w.store.cg_buffer_epoch === issued,
    `issued ${issued}, worker ${after}, saved ${w.store.cg_buffer_epoch}`);
}
// ---- 5. a read that never answers
{
  const w = start(saved());
  const hello = w.message({ type: "cg:hello", origin: "http://site.test" });
  const guard = w.timers.find((t) => t.ms === 3000);
  if (guard) guard.fn();
  await tick();
  ok("5. a read that never answers holds a message for 3 s at most", !!guard && hello.got.called === 1, guard ? `answered: ${hello.got.called}` : "no 3 s guard");
}
// ---- 6. a lock starts a new epoch
{
  const store = saved(); store.cg_progress.locked = false;
  const w = start(store);
  w.read(); await tick();
  vm.runInContext("engageLock(\"mouse\", false)", w.ctx);
  const e = vm.runInContext("typeof bufferEpoch === \"undefined\" ? null : bufferEpoch", w.ctx);
  ok("6. a lock starts a new epoch, saved with it", !!e && e !== "bSAVED" && w.store.cg_buffer_epoch === e && w.store.cg_progress.locked === true, `epoch ${e}, saved lock ${w.store.cg_progress.locked}`);
}
// ---- 7. the lock button before the read
{
  const w = start(saved());
  w.message({ type: "cg:open-verify" });
  w.read(); for (let i = 0; i < 8; i++) await tick();
  ok("7. the lock button pressed before the saved state is read opens the verify page", w.opened.length === 1 && w.opened[0].startsWith(GW + "/connect.html?mode=verify"),
    w.opened.length ? w.opened[0].split("#")[0] : "nothing opened");
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
