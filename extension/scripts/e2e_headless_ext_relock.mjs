// End-to-end check that a lock lifted by the passkey is never followed by a lock on the same movement (2026-11-25), in
// real headless Chrome with the working copy of the extension loaded. A gateway is simulated by this script (every
// request to http://gw.test is answered here, the verify page and the SDK from the working copy), so nothing real is
// touched. On 22 and 24 Nov the owner was asked for his passkey again right after giving it: the first check after the
// unlock carried 58 and 59 of the 60 windows of the check that had locked him. A page that did not hear the unlock
// (one kept in the back/forward cache, a frozen or hidden tab) kept the movement from before the lock, and when it
// was shown again its self-heal removed the overlay without dropping that movement.
//   1. a lock, the passkey on the verify page: the first check after it shares no window with the check that locked
//   2. a page that was in the back/forward cache while the lock was lifted: shown again, its first check shares no
//      window with the check that locked either
//   3. the worker stopped while the account is locked (Chrome does this after ~30 s idle): a page shown again keeps its
//      lock overlay
//   4. the worker asleep when the overlay's button is pressed, and asleep again when the passkey is verified: the verify
//      page opens and the lock is lifted
//      (3 and 4 also pass on the worker of before 25 Nov: in this harness a woken worker has read its saved state before
//      the message reaches it. The other order, where that worker answered "not locked" and dropped the passkey's
//      result, is produced by unit_worker_restore.mjs, which holds the read back.)
// Pages that were not listening when the worker told the others (the review of 25 Nov):
//   5. the user pauses while a page is in the back/forward cache: shown again, the page records nothing, so no key
//      typed during the pause and no movement from it leaves the page after the pause
//   6. the user switches the extension off for a site while a page of it is in the cache: shown again, the page
//      records nothing and nothing of it is checked
//   7. a page that did not hear the lock: its next check is refused and it shows the lock
//   8. a page still showing a lock that was lifted: its button drops the overlay, and no passkey is asked for
//   9. a check still waiting for its answer when its page goes into the cache: the answer never reaches the page, and
//      back again it must be checked as before (it used to collect and never send a check again until reloaded)
//
//   node extension/scripts/e2e_headless_ext_relock.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = process.env.EXT_ROOT || path.join(ROOT, "extension");
const GW = "http://gw.test", SITE = "http://site.test", PORT = 9379;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- the simulated gateway: the check numbered lockOnCheck asks for the passkey
const state = { checks: [], ksChecks: [], lockOnCheck: 0, verifies: 0, holdMs: 0, held: 0 };   // holdMs: the next mouse check is answered that much later
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = "x." + b64u({ sub: 78, sk: "SK_EXT" }) + ".y";
function api(p, method, body) {
  if (p === "/v1/sdk/session") return { token: TOKEN, userId: 78, onboarding: { passkey: true, keystroke: true, mouse: true } };
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false };
  if (p === "/v1/sdk/lock/status") return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3,
    checkMinTextChars: 80, adaptiveEnabled: false, panel: "hide", keystroke: "on", mouse: "on", onboardingMode: "eager", managed: [], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: true, adaptiveEnabled: false };
  if (p === "/v1/sdk/keystroke/check") { state.ksChecks.push(body.keystrokeEvents || []); return { ok: true, checked: false }; }
  if (p === "/v1/sdk/mouse/status") return { enrolled: true, training: false, samplesOnFile: 8, samplesRequired: 8, sampleWindows: 55, voteN: 60, voteK: 33 };
  if (p === "/v1/sdk/mouse/check") {
    state.checks.push(body.windows || []);
    const lock = state.checks.length === state.lockOnCheck;
    return { ok: !lock, checked: true, warmup: false, isSuspicious: lock, requiresPasskeyChallenge: lock, windowCount: 60, lowWindows: lock ? 40 : 5,
      bufferMax: 60, lockAt: 33, meanScore: lock ? 0.2 : 0.7, riskToken: "rt" };
  }
  if (p === "/v1/sdk/passkey/auth/options") return { challengeId: "c" + state.verifies, challenge: "x" };
  if (p === "/v1/sdk/passkey/auth/complete") { state.verifies++; return { verified: true }; }
  return {};
}
const page = (n) => `<!doctype html><meta charset="utf-8"><title>page ${n}</title><body style="height:2000px;margin:0"><p>An ordinary website, page ${n}.</p><input id="box" type="text"></body>`;
const WEBAUTHN_STUB = "window.SimpleWebAuthnBrowser = { startAuthentication: async () => ({ id: 'cred', response: {} }), startRegistration: async () => ({}) };";
function serve(url) {
  const u = new URL(url), p = u.pathname;
  const file = (rel, type) => ({ code: 200, type, body: fs.readFileSync(path.join(ROOT, rel), "utf8") });
  if (u.origin === SITE) return /^\/page[12]\.html$/.test(p) ? { code: 200, type: "text/html; charset=utf-8", body: page(p[5]) } : { code: 404, type: "text/plain", body: "" };
  if (u.hostname === "fonts.googleapis.com") return { code: 200, type: "text/css", body: "" };
  if (p === "/connect.html") return file("services/gateway/public/connect.html", "text/html; charset=utf-8");
  if (p.startsWith("/ui/")) return file("services/gateway/public" + p, p.endsWith(".css") ? "text/css" : "application/javascript");
  if (p === "/guard.js") return file("sdk/guard.js", "application/javascript");
  if (p.startsWith("/js/")) return file("sdk" + p, "application/javascript");
  if (p === "/vendor/simplewebauthn/index.umd.min.js") return { code: 200, type: "application/javascript", body: WEBAUTHN_STUB };
  return null;
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ext-relock-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`, "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), errors = [], bfcacheMisses = [];
const sessions = new Map();   // sessionId -> targetInfo
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const reply = (s, requestId, code, type, body) => send("Fetch.fulfillRequest", { requestId, responseCode: code, body: Buffer.from(body).toString("base64"),
  responseHeaders: [{ name: "Content-Type", value: type }, { name: "Access-Control-Allow-Origin", value: "*" },
    { name: "Access-Control-Allow-Headers", value: "*" }, { name: "Access-Control-Allow-Methods", value: "*" }] }, s);
async function prepare(s, info, waiting) {
  sessions.set(s, info);
  await send("Fetch.enable", { patterns: [{ urlPattern: GW + "/*" }, { urlPattern: SITE + "/*" }, { urlPattern: "https://fonts.googleapis.com/*" }] }, s);
  await send("Runtime.enable", {}, s);
  if (info.type === "page") await send("Page.enable", {}, s);
  if (waiting) await send("Runtime.runIfWaitingForDebugger", {}, s);
}
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); return; }
  if (m.method === "Target.attachedToTarget") { prepare(m.params.sessionId, m.params.targetInfo, m.params.waitingForDebugger); return; }
  if (m.method === "Target.detachedFromTarget") { sessions.delete(m.params.sessionId); return; }
  if (m.method === "Runtime.exceptionThrown") { errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); return; }
  if (m.method === "Page.backForwardCacheNotUsed") { bfcacheMisses.push(JSON.stringify(m.params.notRestoredExplanations || []).slice(0, 300)); return; }
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  if (request.method === "OPTIONS") { reply(m.sessionId, requestId, 204, "text/plain", ""); return; }
  const f = serve(request.url);
  if (f) { reply(m.sessionId, requestId, f.code, f.type, f.body); return; }
  let body = {}; try { body = request.postData ? JSON.parse(request.postData) : {}; } catch { /* not JSON */ }
  const pathname = new URL(request.url).pathname, answer = JSON.stringify(api(pathname, request.method, body));
  if (pathname === "/v1/sdk/mouse/check" && state.holdMs > 0) {
    const ms = state.holdMs; state.holdMs = 0; state.held = Date.now();
    setTimeout(() => reply(m.sessionId, requestId, 200, "application/json", answer), ms);
    return;
  }
  reply(m.sessionId, requestId, 200, "application/json", answer);
});
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(s, expr)) return true; } catch { /* navigating */ } await sleep(200); } return false; };
const findSession = (pred) => { for (const [s, t] of sessions) if (pred(t)) return s; return null; };
async function waitSession(pred, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = findSession(pred); if (s) return s; await sleep(200); } return null; }

let pos = { x: 640, y: 450 }, seed = 5;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
async function move(s, n) {
  for (let i = 0; i < n; i++) {
    const a = rnd() * 2 * Math.PI, d = 4 + Math.floor(rnd() * 26);
    let x = pos.x + d * Math.cos(a), y = pos.y + d * Math.sin(a);
    if (x < 50 || x > 1230) x = pos.x - d * Math.cos(a);
    if (y < 50 || y > 850) y = pos.y - d * Math.sin(a);
    pos = { x, y };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(pos.x), y: Math.round(pos.y) }, s);
    if (i % 4 === 0) await sleep(4);
  }
  await sleep(1000);
}
const SH = "document.getElementById('continuum-guard-host') && document.getElementById('continuum-guard-host').shadowRoot";
const MODAL = `(${SH}) && [...(${SH}).querySelectorAll('.ov')].find((o) => o.style.display === 'flex' && /Identity check required/.test(o.textContent))`;
const isVerifyPage = (t) => t.type === "page" && t.url.startsWith(GW + "/connect.html");
const overlay = (s) => ev(s, "!!document.getElementById('__cgVerifyBtn')");
const key = (w) => JSON.stringify(w);
const isWorker = (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://");
const isVerifyTarget = async () => (await send("Target.getTargets")).targetInfos.some(isVerifyPage);
const waitUntil = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(200); } return false; };
// In the extension's worker (its variables are the script's globals). It is awake wherever this is called.
async function swEval(expression) { const s = await waitSession(isWorker, 8000); return s ? ev(s, expression) : undefined; }
// Chrome stops an idle worker after ~30 s; here it is stopped at once. The next message from a page starts a new one.
async function stopWorker() {
  const sw = (await send("Target.getTargets")).targetInfos.find(isWorker);
  const stopped = sw ? (await send("Target.closeTarget", { targetId: sw.targetId })).success : false;
  await sleep(800);
  return stopped;
}
async function type(s, text) {
  for (const ch of text) {
    const code = ch.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, windowsVirtualKeyCode: code }, s); await sleep(4);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: code }, s); await sleep(4);
  }
}
const paste = (s, text) => ev(s, `(() => { const t = document.getElementById('box'); const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
  t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
const downs = (events, code) => events.filter((e) => e.eventType === "keydown" && e.keyCode === code).length;
const sharedWith = (a, b) => { const set = new Set(a.map(key)); return b.filter((w) => set.has(key(w))).length; };

// Move until the website shows the lock; returns the windows of the check that locked.
async function lockBy(s) {
  state.lockOnCheck = state.checks.length + 1;
  for (let i = 0; i < 15 && !(await overlay(s)); i++) await move(s, 150);
  return (await overlay(s)) ? state.checks[state.lockOnCheck - 1] : null;
}
// The overlay's button, then the passkey on the verify page; resolves when the verify page has closed.
async function verifyFrom(s) {
  for (const [x, t] of sessions) if (isVerifyPage(t)) sessions.delete(x);   // a closed page from an earlier round
  await ev(s, "document.getElementById('__cgVerifyBtn').click()");
  const vp = await waitSession(isVerifyPage);
  if (vp && (await waitFor(vp, `!!(${MODAL})`, 20000))) await ev(vp, `(${MODAL}).querySelector('.b').click()`);
  for (let i = 0; i < 40; i++) { const { targetInfos } = await send("Target.getTargets"); if (!targetInfos.some(isVerifyPage)) return true; await sleep(250); }
  return false;
}
// Move until a check arrives that came after `from` checks; returns its windows (or null).
async function nextCheck(s, from) {
  for (let i = 0; i < 12 && state.checks.length <= from; i++) await move(s, 150);
  return state.checks.length > from ? state.checks[from] : null;
}

try {
  // the extension's worker, then a signed-in account (as after the sign-in), then a website
  let swT = null;
  for (let i = 0; i < 80 && !swT; i++) { const { targetInfos } = await send("Target.getTargets"); swT = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://")); if (!swT) await sleep(250); }
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const { sessionId: sw0 } = await send("Target.attachToTarget", { targetId: swT.targetId, flatten: true });
  await prepare(sw0, swT, false);
  await ev(sw0, `new Promise((r) => chrome.storage.local.set({ cg_account: { gateway: "${GW}", siteKey: "SK_EXT", kind: "personal", label: "test",
    userId: 78, refreshToken: "rt", onboarding: { passkey: true, keystroke: true, mouse: true }, linkedAt: new Date().toISOString() } }, () => r(true)))`);
  await sleep(500);
  await send("Target.createTarget", { url: SITE + "/page1.html" });
  const site = await waitSession((t) => t.type === "page" && t.url.startsWith(SITE));
  await waitFor(site, "document.readyState === 'complete'", 10000);
  await sleep(1500);

  // ---- 1. lock, passkey: the first check after it is fresh movement
  const lock1 = await lockBy(site);
  const unlocked1 = lock1 && (await verifyFrom(site));
  const from1 = state.checks.length;
  const after1 = unlocked1 ? await nextCheck(site, from1) : null;
  ok("1. a lock, then the passkey on the verify page", !!lock1 && unlocked1 && !(await overlay(site)), `${state.checks.length} checks, ${state.verifies} verifications`);
  ok("…the first check after it shares no window with the check that locked", !!after1 && sharedWith(lock1, after1) === 0,
    after1 ? `${sharedWith(lock1, after1)} of ${after1.length} windows the same` : "no check after the unlock");

  // ---- 2. a page kept in the back/forward cache while the lock was lifted
  await ev(site, "window.__page = 'one'; true");
  const lock2 = await lockBy(site);
  await send("Page.navigate", { url: SITE + "/page2.html" }, site);
  await waitFor(site, "location.pathname === '/page2.html' && document.readyState === 'complete'", 10000);
  await waitFor(site, "!!document.getElementById('__cgVerifyBtn')", 8000);   // the new page is locked too
  const unlocked2 = lock2 && (await verifyFrom(site));
  await ev(site, "history.back(); true");
  await waitFor(site, "location.pathname === '/page1.html' && document.readyState === 'complete'", 10000);
  const restored = (await ev(site, "window.__page === 'one'")) === true;
  await ev(site, "document.dispatchEvent(new Event('visibilitychange')); true");   // as when the user comes back to the tab
  await sleep(1200);
  const from2 = state.checks.length;
  const after2 = unlocked2 ? await nextCheck(site, from2) : null;
  ok("2. a page in the back/forward cache while the lock was lifted is shown again, unlocked", !!lock2 && unlocked2 && restored && !(await overlay(site)),
    `restored from the cache: ${restored}${bfcacheMisses.length ? "; not cached: " + bfcacheMisses.join(" | ") : ""}`);
  ok("…its first check shares no window with the check that locked", !!after2 && sharedWith(lock2, after2) === 0,
    after2 ? `${sharedWith(lock2, after2)} of ${after2.length} windows the same` : "no check after the unlock");

  // ---- 3. the worker stopped while the account is locked
  const lock3 = await lockBy(site);
  const stopped = await stopWorker();
  await ev(site, "document.dispatchEvent(new Event('visibilitychange')); true");   // wakes the worker with a hello
  await sleep(2500);
  ok("3. the worker stopped while locked, the page shown again: the overlay stays", !!lock3 && stopped && (await overlay(site)) === true,
    `worker stopped: ${stopped}, overlay: ${await overlay(site)}`);
  const checks3 = state.checks.length;
  await move(site, 300);
  ok("…and nothing is checked while it is up", state.checks.length === checks3, `${state.checks.length - checks3} checks`);
  const unlocked3 = await verifyFrom(site);
  const after3 = unlocked3 ? await nextCheck(site, state.checks.length) : null;
  ok("…the passkey then unlocks it, and the next check shares nothing with the one that locked", unlocked3 && !!after3 && sharedWith(lock3, after3) === 0,
    after3 ? `${sharedWith(lock3, after3)} of ${after3.length} windows the same` : "no check after the unlock");

  // ---- 4. the worker asleep at the button, and asleep again at the passkey
  const lock4 = await lockBy(site);
  const stopped4a = await stopWorker();
  for (const [x, t] of sessions) if (isVerifyPage(t)) sessions.delete(x);
  await ev(site, "document.getElementById('__cgVerifyBtn').click()");   // the message that wakes the worker
  const vp4 = await waitSession(isVerifyPage, 10000);
  const modal4 = !!vp4 && (await waitFor(vp4, `!!(${MODAL})`, 20000));
  ok("4. the worker asleep when the button is pressed: the verify page opens", !!lock4 && stopped4a && modal4, `worker stopped: ${stopped4a}, verify page: ${!!vp4}`);
  const stopped4b = await stopWorker();
  if (modal4) await ev(vp4, `(${MODAL}).querySelector('.b').click()`);   // the passkey: its result wakes the worker
  const closed4 = await waitUntil(async () => !(await isVerifyTarget()), 10000);
  await sleep(600);
  ok("…the worker asleep when the passkey is verified: the lock is lifted", stopped4b && closed4 && (await overlay(site)) === false,
    `worker stopped: ${stopped4b}, verify page closed: ${closed4}, overlay: ${await overlay(site)}`);
  if (await overlay(site)) await verifyFrom(site);   // leave the next part an unlocked account

  // ---- 5. the user pauses while a page is in the back/forward cache
  await ev(site, "window.__page = 'five'; true");
  await send("Page.navigate", { url: SITE + "/page2.html" }, site);
  await waitFor(site, "location.pathname === '/page2.html' && document.readyState === 'complete'", 10000);
  await swEval("new Promise((r) => chrome.storage.local.set({ cg_paused: true }, () => r(true)))");
  await sleep(600);
  await ev(site, "history.back(); true");
  await waitFor(site, "location.pathname === '/page1.html' && document.readyState === 'complete'", 10000);
  const restored5 = (await ev(site, "window.__page === 'five'")) === true;
  await sleep(1000);   // the page asks the worker what it missed
  await ev(site, "document.getElementById('box').focus(), true");
  await type(site, "xxxxxxxxxxxx");                         // typed during the pause
  for (let i = 0; i < 7; i++) await move(site, 150);        // moved during the pause: more than a check holds
  const checks5 = state.checks.length, ks5 = state.ksChecks.length;
  await swEval("new Promise((r) => chrome.storage.local.set({ cg_paused: false }, () => r(true)))");
  await sleep(1000);
  await paste(site, "p");                                   // a paste is checked at once, with the page's key buffer
  await waitUntil(() => state.ksChecks.length > ks5, 6000);
  const sent5 = state.ksChecks.length > ks5 ? state.ksChecks[state.ksChecks.length - 1] : null;
  await move(site, 150);                                    // far less movement than a check needs
  ok("5. paused while a page is in the back/forward cache: no key typed during the pause leaves the page after it", restored5 && !!sent5 && downs(sent5, 88) === 0,
    `restored from the cache: ${restored5}; ${sent5 ? downs(sent5, 88) + " of its 12 key presses in the check after the pause" : "no check after the pause"}`);
  ok("…and the movement from the pause is not checked after it", state.checks.length === checks5, `${state.checks.length - checks5} checks`);

  // ---- 6. the site switched off while a page of it is in the back/forward cache
  await ev(site, "window.__page = 'six'; true");
  await send("Page.navigate", { url: SITE + "/page2.html" }, site);
  await waitFor(site, "location.pathname === '/page2.html' && document.readyState === 'complete'", 10000);
  // as the popup's "off on this site" does (background.js cg:toggleExclude)
  await swEval(`config.exclusions.push("${SITE}"); chrome.storage.local.set({ cg_exclusions: config.exclusions }); broadcastConfig(); true`);
  await sleep(600);
  await ev(site, "history.back(); true");
  await waitFor(site, "location.pathname === '/page1.html' && document.readyState === 'complete'", 10000);
  const restored6 = (await ev(site, "window.__page === 'six'")) === true;
  await sleep(1000);
  const checks6x = state.checks.length;
  for (let i = 0; i < 7; i++) await move(site, 150);
  ok("6. a site switched off while its page is in the back/forward cache: shown again, nothing of it is checked", restored6 && state.checks.length === checks6x,
    `restored from the cache: ${restored6}, ${state.checks.length - checks6x} checks`);
  await swEval(`config.exclusions = config.exclusions.filter((o) => o !== "${SITE}"); chrome.storage.local.set({ cg_exclusions: config.exclusions }); broadcastConfig(); true`);
  await sleep(800);
  const from6 = state.checks.length;   // the control: the page was silent because of the switch, not because it had stopped
  for (let i = 0; i < 10 && state.checks.length === from6; i++) await move(site, 150);
  ok("…and it is checked again once the site is switched back on", state.checks.length > from6, `${state.checks.length - from6} checks`);

  // ---- 7. a page that did not hear the lock
  await swEval("state.locked = true; state.lockReason = 'mouse'; state.lockPasted = false; persistProgress(true); true");   // locked, no page told
  const checks6 = state.checks.length;
  let shown6 = false;
  for (let i = 0; i < 15 && !shown6; i++) { await move(site, 150); shown6 = await overlay(site); }
  ok("7. a page that did not hear the lock shows it at its next check, and nothing is checked", shown6 && state.checks.length === checks6,
    `overlay: ${shown6}, ${state.checks.length - checks6} checks`);
  const unlocked6 = shown6 ? await verifyFrom(site) : false;
  if (!unlocked6) await swEval("releaseLock(); true");

  // ---- 8. a page still showing a lock that was lifted
  const lock7 = await lockBy(site);
  await swEval("state.locked = false; state.lockReason = null; newBufferEpoch(); persistProgress(true); true");   // lifted, this page not told
  const verifies7 = state.verifies;
  for (const [x, t] of sessions) if (isVerifyPage(t)) sessions.delete(x);
  await ev(site, "document.getElementById('__cgVerifyBtn').click()");
  await sleep(1500);
  const opened7 = await isVerifyTarget();
  ok("8. the button of a lock already lifted drops the overlay, and no passkey is asked for", !!lock7 && (await overlay(site)) === false && !opened7 && state.verifies === verifies7,
    `overlay: ${await overlay(site)}, verify page opened: ${opened7}`);
  const after7 = opened7 ? null : await nextCheck(site, state.checks.length);
  ok("…and the next check shares nothing with the one that locked", !!after7 && sharedWith(lock7, after7) === 0,
    after7 ? `${sharedWith(lock7, after7)} of ${after7.length} windows the same` : "no check");
  // ---- 9. a check waiting for its answer when its page goes into the back/forward cache
  await ev(site, "window.__page = 'nine'; true");
  state.holdMs = 4000; state.held = 0;
  for (let i = 0; i < 12 && !state.held; i++) await move(site, 40);
  const held9 = !!state.held;
  await send("Page.navigate", { url: SITE + "/page2.html" }, site);   // the page leaves while its check waits
  await waitFor(site, "location.pathname === '/page2.html' && document.readyState === 'complete'", 10000);
  await sleep(4500);                                                   // the answer comes while it is in the cache
  await ev(site, "history.back(); true");
  await waitFor(site, "location.pathname === '/page1.html' && document.readyState === 'complete'", 10000);
  const restored9 = (await ev(site, "window.__page === 'nine'")) === true;
  await sleep(1000);
  const from9 = state.checks.length;
  for (let i = 0; i < 8 && state.checks.length === from9; i++) await move(site, 150);
  ok("9. a check waiting for its answer when its page went into the cache: back again, the page is checked as before", held9 && restored9 && state.checks.length > from9,
    `a check was waiting: ${held9}, restored from the cache: ${restored9}, ${state.checks.length - from9} checks after it`);
  ok("no script error in the extension or the pages", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  ok("run completed", false, e.message);
} finally {
  ws.close(); chrome.kill(); await sleep(400); try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
