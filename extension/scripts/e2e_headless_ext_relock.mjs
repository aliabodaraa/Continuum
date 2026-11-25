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
//      lock overlay (the woken worker had not read its saved lock yet and answered "not locked")
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
const state = { checks: [], lockOnCheck: 0, verifies: 0 };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = "x." + b64u({ sub: 78, sk: "SK_EXT" }) + ".y";
function api(p, method, body) {
  if (p === "/v1/sdk/session") return { token: TOKEN, userId: 78, onboarding: { passkey: true, keystroke: true, mouse: true } };
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false };
  if (p === "/v1/sdk/lock/status") return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3,
    checkMinTextChars: 80, adaptiveEnabled: false, panel: "hide", keystroke: "on", mouse: "on", onboardingMode: "eager", managed: [], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: true, adaptiveEnabled: false };
  if (p === "/v1/sdk/keystroke/check") return { ok: true, checked: false };
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
const page = (n) => `<!doctype html><meta charset="utf-8"><title>page ${n}</title><body style="height:2000px;margin:0"><p>An ordinary website, page ${n}.</p></body>`;
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
  if (m.method === "Runtime.exceptionThrown") { errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); return; }
  if (m.method === "Page.backForwardCacheNotUsed") { bfcacheMisses.push(JSON.stringify(m.params.notRestoredExplanations || []).slice(0, 300)); return; }
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  if (request.method === "OPTIONS") { reply(m.sessionId, requestId, 204, "text/plain", ""); return; }
  const f = serve(request.url);
  if (f) { reply(m.sessionId, requestId, f.code, f.type, f.body); return; }
  let body = {}; try { body = request.postData ? JSON.parse(request.postData) : {}; } catch { /* not JSON */ }
  reply(m.sessionId, requestId, 200, "application/json", JSON.stringify(api(new URL(request.url).pathname, request.method, body)));
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
  const { targetInfos: t3 } = await send("Target.getTargets");
  const swNow = t3.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
  const stopped = swNow ? (await send("Target.closeTarget", { targetId: swNow.targetId })).success : false;
  await sleep(800);
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
  ok("no script error in the extension or the pages", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  ok("run completed", false, e.message);
} finally {
  ws.close(); chrome.kill(); await sleep(400); try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
