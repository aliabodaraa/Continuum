// End-to-end check of the extension's real-use mouse sample (learning from real use, stage 1, 2026-10-24) in real
// headless Chrome with the working copy of the extension loaded. A gateway is simulated by this script (every request to
// http://gw.test is answered here, the verify page and the SDK from the working copy), so nothing real is touched.
//   1. a mouse lock on a website, the passkey on the gateway's verify page, the question there, a yes: the page closes,
//      the website records fresh movement and the worker sends one sample of 55 windows, none of it from before the lock
//   2. "Not now": the page closes and nothing is recorded or sent
//   3. the worker is stopped while the sample is recorded (Chrome does this after ~30 s idle): the sample still arrives
//
//   node extension/scripts/e2e_headless_ext_use_sample.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = path.join(ROOT, "extension");
const GW = "http://gw.test", SITE = "http://site.test", PORT = 9377;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- the simulated gateway
const OFFER = { offer: true, expiresInMs: 180000, sampleWindows: 55 };
const state = { checks: [], lockOnCheck: 1, verifies: [], useSamples: [], sessions: 0 };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = "x." + b64u({ sub: 77, sk: "SK_EXT" }) + ".y";
function api(p, method, body) {
  if (p === "/v1/sdk/session") { state.sessions++; return { token: TOKEN, userId: 77, onboarding: { passkey: true, keystroke: true, mouse: true } }; }
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false };
  if (p.startsWith("/v1/sdk/lock/status")) return { locked: false };
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
  if (p === "/v1/sdk/passkey/auth/options") return { challengeId: "c" + state.verifies.length, challenge: "x" };
  if (p === "/v1/sdk/passkey/auth/complete") { state.verifies.push(body); return { verified: true, mouseUseSample: OFFER }; }
  if (p === "/v1/sdk/mouse/use-sample") { state.useSamples.push(body.windows || []); return { ok: true, stored: true }; }
  return {};
}
const SITE_PAGE = `<!doctype html><meta charset="utf-8"><title>a website</title><body style="height:2000px;margin:0"><p>An ordinary website.</p></body>`;
const WEBAUTHN_STUB = "window.SimpleWebAuthnBrowser = { startAuthentication: async () => ({ id: 'cred', response: {} }), startRegistration: async () => ({}) };";
function serve(url) {
  const u = new URL(url), p = u.pathname;
  const file = (rel, type) => ({ code: 200, type, body: fs.readFileSync(path.join(ROOT, rel), "utf8") });
  if (u.origin === SITE) return p === "/page.html" ? { code: 200, type: "text/html; charset=utf-8", body: SITE_PAGE } : { code: 404, type: "text/plain", body: "" };
  if (u.hostname === "fonts.googleapis.com") return { code: 200, type: "text/css", body: "" };
  if (p === "/connect.html") return file("services/gateway/public/connect.html", "text/html; charset=utf-8");
  if (p.startsWith("/ui/")) return file("services/gateway/public" + p, p.endsWith(".css") ? "text/css" : "application/javascript");
  if (p === "/guard.js") return file("sdk/guard.js", "application/javascript");
  if (p.startsWith("/js/")) return file("sdk" + p, "application/javascript");
  if (p === "/vendor/simplewebauthn/index.umd.min.js") return { code: 200, type: "application/javascript", body: WEBAUTHN_STUB };
  return null;
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ext-use-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`, "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), errors = [];
const sessions = new Map();   // sessionId -> targetInfo
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const reply = (s, requestId, code, type, body) => send("Fetch.fulfillRequest", { requestId, responseCode: code, body: Buffer.from(body).toString("base64"),
  responseHeaders: [{ name: "Content-Type", value: type }, { name: "Access-Control-Allow-Origin", value: "*" },
    { name: "Access-Control-Allow-Headers", value: "*" }, { name: "Access-Control-Allow-Methods", value: "*" }] }, s);
async function prepare(s, info, waiting) {
  sessions.set(s, info);
  await send("Fetch.enable", { patterns: [{ urlPattern: GW + "/*" }, { urlPattern: SITE + "/*" }, { urlPattern: "https://fonts.googleapis.com/*" }] }, s);
  await send("Runtime.enable", {}, s);
  if (waiting) await send("Runtime.runIfWaitingForDebugger", {}, s);
}
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); return; }
  if (m.method === "Target.attachedToTarget") { prepare(m.params.sessionId, m.params.targetInfo, m.params.waitingForDebugger); return; }
  if (m.method === "Runtime.exceptionThrown") { errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); return; }
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

let pos = { x: 640, y: 450 }, seed = 3;
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
const runs = (windows) => { const r = new Set(); for (const w of windows) for (let i = 0; i + 20 <= w.length; i++) r.add(JSON.stringify(w.slice(i, i + 20))); return r; };
const shared = (a, b) => { const ra = runs(a), rb = runs(b); let n = 0; for (const x of rb) if (ra.has(x)) n++; return rb.size ? n / rb.size : 0; };
const SH = "document.getElementById('continuum-guard-host') && document.getElementById('continuum-guard-host').shadowRoot";
const MODAL = `(${SH}) && [...(${SH}).querySelectorAll('.ov')].find((o) => o.style.display === 'flex' && /Identity check required/.test(o.textContent))`;
const isVerifyPage = (t) => t.type === "page" && t.url.startsWith(GW + "/connect.html");

// Lock the website by moving, open the verify page from the overlay, pass the passkey there; returns that page's session.
async function lockAndVerify(site) {
  state.lockOnCheck = state.checks.length + 1;
  for (let i = 0; i < 15 && !(await ev(site, "!!document.getElementById('__cgVerifyBtn')")); i++) await move(site, 150);
  const locked = await ev(site, "!!document.getElementById('__cgVerifyBtn')");
  for (const [s, t] of sessions) if (isVerifyPage(t)) sessions.delete(s);   // a closed page from an earlier round
  await ev(site, "document.getElementById('__cgVerifyBtn').click()");
  const page = await waitSession(isVerifyPage);
  const modal = page && (await waitFor(page, `!!(${MODAL})`, 20000));
  if (modal) await ev(page, `(${MODAL}).querySelector('.b').click()`);
  const asked = page && (await waitFor(page, "!document.getElementById('useAsk').classList.contains('hidden')", 10000));
  return { locked, page, asked };
}

try {
  // the extension's worker, then a signed-in account (as after the sign-in), then a website
  let swT = null;
  for (let i = 0; i < 80 && !swT; i++) { const { targetInfos } = await send("Target.getTargets"); swT = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://")); if (!swT) await sleep(250); }
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const { sessionId: sw0 } = await send("Target.attachToTarget", { targetId: swT.targetId, flatten: true });
  await prepare(sw0, swT, false);
  await ev(sw0, `new Promise((r) => chrome.storage.local.set({ cg_account: { gateway: "${GW}", siteKey: "SK_EXT", kind: "personal", label: "test",
    userId: 77, refreshToken: "rt", onboarding: { passkey: true, keystroke: true, mouse: true }, linkedAt: new Date().toISOString() } }, () => r(true)))`);
  await sleep(500);
  await send("Target.createTarget", { url: SITE + "/page.html" });
  const site = await waitSession((t) => t.type === "page" && t.url.startsWith(SITE));
  await waitFor(site, "document.readyState === 'complete'", 10000);
  await sleep(1500);

  // ---- 1. lock, passkey, yes, one sample of fresh movement from the website
  const r1 = await lockAndVerify(site);
  ok("1. a mouse lock on the website, then the passkey on the verify page", r1.locked && !!r1.page && state.verifies.length === 1,
    `${state.checks.length} checks, ${state.verifies.length} verifications`);
  ok("…the verification says it answered a mouse lock", (state.verifies[0] || {}).reason === "mouse", JSON.stringify(state.verifies[0] || {}));
  ok("…the verify page asks before anything is recorded", r1.asked && state.useSamples.length === 0);
  const beforeLock = state.checks[state.checks.length - 1] || [];
  await ev(r1.page, "document.getElementById('useYes').click()");
  await sleep(1500);
  const { targetInfos: t1 } = await send("Target.getTargets");
  ok("…a yes closes the verify page and unlocks the website", !t1.some(isVerifyPage) && !(await ev(site, "!!document.getElementById('__cgVerifyBtn')")));
  for (let i = 0; i < 8 && state.useSamples.length === 0; i++) await move(site, 200);
  const sent = state.useSamples[0] || [];
  ok("…the website records and the worker sends one sample of 55 windows", state.useSamples.length === 1 && sent.length === 55, `${state.useSamples.length} sent, ${sent.length} windows`);
  ok("…none of it from before the lock", sent.length > 0 && shared(beforeLock, sent) === 0, `${(100 * shared(beforeLock, sent)).toFixed(1)}% shared`);
  const sw1 = findSession((t) => t.type === "service_worker") || sw0;
  const st1 = await ev(sw1, "JSON.stringify(statusObj(null).useSample)").catch(() => null);
  ok("…and the popup's status says it was saved", /"ok":true/.test(st1 || ""), st1);
  await move(site, 700);
  ok("…and nothing more is sent", state.useSamples.length === 1, `${state.useSamples.length} sent`);

  // ---- 2. "Not now"
  const r2 = await lockAndVerify(site);
  ok("2. a second lock and passkey: the question again", r2.locked && r2.asked);
  if (r2.page) await ev(r2.page, "document.getElementById('useNo').click()");
  await sleep(1500);
  const { targetInfos: t2 } = await send("Target.getTargets");
  await move(site, 900);
  ok("…\"Not now\" closes the page and nothing is recorded or sent", !t2.some(isVerifyPage) && state.useSamples.length === 1, `${state.useSamples.length - 1} sent`);

  // ---- 3. the worker stopped during the recording
  const r3 = await lockAndVerify(site);
  if (r3.page) await ev(r3.page, "document.getElementById('useYes').click()");
  await sleep(1200);
  await move(site, 250);   // part of the sample
  const { targetInfos: t3 } = await send("Target.getTargets");
  const swNow = t3.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
  const stopped = swNow ? (await send("Target.closeTarget", { targetId: swNow.targetId })).success : false;
  for (let i = 0; i < 8 && state.useSamples.length === 1; i++) await move(site, 200);
  ok("3. the worker stopped while the sample was recorded: the sample still arrives", stopped && state.useSamples.length === 2 && (state.useSamples[1] || []).length === 55,
    `worker stopped: ${stopped}, ${state.useSamples.length - 1} sent`);
  ok("no script error in the extension or the pages", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  ok("run completed", false, e.message);
} finally {
  ws.close(); chrome.kill(); await sleep(400); try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
