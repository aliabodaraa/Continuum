// End-to-end check, in real headless Chrome, of buttons the demo app showed when their action could not run (2026-11-25).
// The demo app's own dashboard and the SDK in its demo mode (no site key: it uses the app's /api/*), from the working copy
// (apps/demo/public/dashboard.html, sdk/guard.js, sdk/js/*), with every request answered by this script at
// http://demo.test as the demo app's server answers it (a locked session gets its gate's 423). The passkey library and the
// mouse features are stubs, so no authenticator and no real movement are needed. Nothing real is reached.
//   1. a page still open when the account is locked elsewhere (its check is refused 423 "locked"): the SDK shows the
//      passkey prompt, naming no channel, and the adaptive popup does not stay above it; for a typing check, then a mouse
//      check (whose row must not say "watching")
//   2. a page opened on a locked account: the passkey prompt at load, nothing sent that the lock refuses, nobody signed
//      out; one passkey clears it
//   3. the dashboard after the SDK's onboarding window registered the passkey: no "Register Passkey" left (refused 403)
//   4. the dashboard's "Replace" with the new passkey cancelled: "Register Passkey" shows, not Replace and Reset
//   5. the dashboard opened on a locked account: the passkey prompt at load; after it the page says unlocked
//   6. the dashboard while the typing model is being built: the banner says so, with no "Start enrollment"
//
//   node extension/scripts/e2e_headless_demo_lock_buttons.mjs
// GUARD_FILE / DASHBOARD_FILE: other copies to test instead (the committed ones, say, to see the checks fail).
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE = "http://demo.test", PORT = 9421;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- the demo app's server, as each step sets it
let state;
const GENUINE = { checked: true, warmup: false, isSuspicious: false, modelConfidence: 0.95, riskToken: "rt", typingEvaluation: { windowCount: 3, modelAvailable: true } };
// what the app's gate (app.js) answers a locked session
const LOCKED = { error: "Passkey verification required before continuing", continuousAuthLocked: true, requiresPasskeyChallenge: true };
const fresh = (o) => ({ hasPasskey: true, locked: false, training: false, adaptiveReady: false, ksAnswer: [200, GENUINE],
  mouseAnswer: [200, { checked: false, warmup: true, windowCount: 0, bufferMax: 60 }], calls: [], authCompletes: 0, logout: 0, login: 0, ...o });
const typing = () => (state.training ? { trained: false, training: true, sampleCount: 5, requiredSamples: 5, remainingSamples: 0, remainingPositiveWindows: 0 }
  : { trained: true, training: false, sampleCount: 5, requiredSamples: 5 });
function api(p, body) {
  state.calls.push(p);
  switch (p) {
    case "/api/auth/me": return [200, { userId: 7, username: "tester", profilePhoto: null, passkeySetupRequired: !state.hasPasskey, passkeysRegistered: state.hasPasskey,
      continuousAuthLocked: state.locked, typingStatus: typing(), isAdmin: false }];
    case "/api/auth/logout": state.logout++; return [200, { ok: true }];
    case "/api/text/config": return [200, { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, checkMinTextChars: 80,
      adaptiveConfidenceMin: 0.8, adaptiveRetrainEvery: 3, adaptiveEnabled: true, adaptiveMinGapHours: 3, panel: "show", keystroke: "on", mouse: "on",
      onboardingMode: "eager", excludeFieldTypes: ["hidden"] }];
    case "/api/text/typing-status": return [200, { ...typing(), adaptiveEnabled: true, adaptivePending: 3, adaptiveReady: state.adaptiveReady, nextContributionAt: null }];
    case "/api/text/stats": return [200, { typingStatus: typing(), passkeysRegistered: state.hasPasskey, passkey_count: state.hasPasskey ? 1 : 0 }];
    case "/api/text/decisions": return [200, { decisions: [] }];
    case "/api/text/metrics": return [200, { users: [], allUsers: false, summary: { totalUsers: 0, totalDecisions: 0, overallFRR: null, overallTAR: null, avgScore: null } }];
    case "/api/text/check": return state.ksAnswer;
    case "/api/text/contribute": return [200, body.dryRun ? { eligible: false } : { ok: true }];
    case "/api/mouse/status": return [200, { enrolled: true, samplesOnFile: 8, samplesRequired: 8, sampleWindows: 55, totalWindows: 440, sessions: 8 }];
    case "/api/mouse/check": return state.mouseAnswer;
    // Continuum starts a registration only for the account's first passkey
    case "/api/webauthn/register/options": return state.hasPasskey ? [403, { error: "passkey_required" }]
      : [200, { challenge: "Y2g", rp: { name: "demo" }, user: { id: "dTc", name: "tester", displayName: "tester" }, pubKeyCredParams: [] }];
    case "/api/webauthn/register/complete": state.hasPasskey = true; return [200, { ok: true }];
    case "/api/webauthn/register/reset": state.hasPasskey = false; state.locked = false; return [200, { ok: true }];
    case "/api/webauthn/auth/options": return state.hasPasskey ? [200, { challenge: "Y2g", challengeId: "c-1", allowCredentials: [] }] : [400, { error: "No passkeys registered" }];
    case "/api/webauthn/auth/complete": state.authCompletes++; state.locked = false; return [200, { ok: true, mouseUseSample: { offer: false } }];
  }
  return [404, { error: "not_found" }];
}
// The passkey library: a passkey made or used at once, or the prompt closed when window.__cancelReg is set.
const WEBAUTHN = `window.SimpleWebAuthnBrowser = {
  startRegistration: async function () { if (window.__cancelReg) { var e = new Error("The operation either timed out or was not allowed."); e.name = "NotAllowedError"; throw e; }
    return { id: "cred-new", type: "public-key" }; },
  startAuthentication: async function () { return { id: "cred-1", type: "public-key" }; } };`;
// The mouse features: no movement until window.__moving is set, then a full vote of windows at every check.
const MOUSE = `window.mouseFeatures = {
  createMouseTracker: function () { var n = 0; return { eventCount: function () { return window.__moving ? ++n : 0; }, getEvents: function () { return []; },
    reset: function () {}, stop: function () {}, windowCount: function () { return 0; } }; },
  eventsToSteps: function () { return []; },
  stepsToWindows: function () { var w = []; for (var i = 0; i < 60; i++) w.push([0, 0, 0]); return w; } };`;
const SDK_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>sdk</title><body><p>A page of the demo app.</p><textarea id="ta" rows="6" cols="60"></textarea>
  <script src="/guard.js?v=21" data-keystroke="on" data-mouse="optional"></script></body></html>`;
function file(p) {
  if (p === "/guard.js") return fs.readFileSync(process.env.GUARD_FILE || path.join(ROOT, "sdk", "guard.js"));
  if (p === "/dashboard.html") return fs.readFileSync(process.env.DASHBOARD_FILE || path.join(ROOT, "apps", "demo", "public", "dashboard.html"));
  if (p === "/js/keystroke-tracker.js" || p === "/js/guard-ar.js") return fs.readFileSync(path.join(ROOT, "sdk", p));
  if (p === "/js/mouse-features.js") return MOUSE;
  if (p === "/vendor/simplewebauthn/index.umd.min.js") return WEBAUTHN;
  if (p === "/__sdk.html") return SDK_PAGE;
  return null;
}

// ---- Chrome + a minimal CDP client
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-demo-lock-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), handlers = [], errors = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); } else if (m.method) handlers.forEach((h) => h(m)); });
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(s, expr)) return true; await sleep(150); } return false; };
const R = "document.getElementById('continuum-guard-host').shadowRoot";
const MODAL = `(() => { const m = ${R}.querySelector('.ov'); return { shown: m.style.display === 'flex', text: m.querySelector('.d').textContent }; })()`;
const LEARN_UP = `${R}.querySelector('.learn').style.display === 'block'`;
const ROW = (i) => `${R}.querySelectorAll('.rows .row')[${i}].querySelector('.st').textContent`;
const WIZ = `${R}.querySelectorAll('.ov')[1]`;
const PASTE = "document.getElementById('ta').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }))";
const verify = async (s) => { await ev(s, `${R}.querySelector('.ov .b').click()`); await waitFor(s, `${R}.querySelector('.ov').style.display === 'none'`, 6000); await sleep(1200); };
const display = (id2) => `(document.getElementById('${id2}') ? getComputedStyle(document.getElementById('${id2}')).display : 'missing')`;

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  handlers.push((m) => {
    if (m.method === "Runtime.exceptionThrown" && m.sessionId === s) errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== s) return;
    const { requestId, request } = m.params, url = new URL(request.url);
    const reply = (code, type, text) => send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(text).toString("base64") }, s);
    if (url.host !== "demo.test") return reply(204, "text/plain", "");   // the dashboard's chart library: not needed
    if (url.pathname === "/login.html") { state.login++; return reply(200, "text/html; charset=utf-8", "<title>sign in</title>"); }
    const f = file(url.pathname); if (f != null) return reply(200, url.pathname.endsWith(".html") ? "text/html; charset=utf-8" : "application/javascript; charset=utf-8", f);
    let body = {}; try { body = request.postData ? JSON.parse(request.postData) : {}; } catch { /* not JSON */ }
    const [code, json] = api(url.pathname, body);
    return reply(code, "application/json", JSON.stringify(json));
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, s);
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  const open = async (p) => { await send("Page.navigate", { url: SITE + p }, s); await waitFor(s, `!!document.getElementById('continuum-guard-host') && !!${R}.querySelector('.panel')`, 15000); await sleep(1500); };

  // 1. locked elsewhere, typing: a clean run brings up the adaptive popup, then the next check is refused 423 "locked"
  state = fresh({ adaptiveReady: true });
  await open("/__sdk.html");
  await ev(s, "(() => { const t = document.getElementById('ta'); t.focus(); t.value = 'hello'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await ev(s, PASTE); await sleep(800); await ev(s, PASTE);
  ok("1. (set-up) after a clean run the adaptive popup is up", await waitFor(s, LEARN_UP, 5000));
  state.ksAnswer = [423, LOCKED];
  await ev(s, PASTE); await sleep(900);
  const m1 = await ev(s, MODAL);
  ok("1. a typing check refused 423 \"locked\": the passkey prompt shows, naming no channel", m1.shown && /recent activity/.test(m1.text), JSON.stringify(m1));
  ok("…and the adaptive popup does not stay above it", !(await ev(s, LEARN_UP)));
  await verify(s);
  ok("…and one passkey clears it", state.authCompletes === 1 && !(await ev(s, MODAL)).shown, `verifications ${state.authCompletes}`);

  // 1. locked elsewhere, mouse
  state = fresh({ mouseAnswer: [423, LOCKED] });
  await open("/__sdk.html");
  await ev(s, "window.__moving = true");
  await waitFor(s, `${R}.querySelector('.ov').style.display === 'flex'`, 6000); await sleep(300);
  const m1b = await ev(s, MODAL), row1b = await ev(s, ROW(1));
  ok("1. a mouse check refused 423 \"locked\": the passkey prompt shows, naming no channel", m1b.shown && /recent activity/.test(m1b.text), JSON.stringify(m1b));
  ok("…and the mouse row does not say it is watching", /locked/.test(row1b) && !/watching/.test(row1b), row1b);

  // 2. a page opened on a locked account
  state = fresh({ locked: true });
  await open("/__sdk.html");
  const m2 = await ev(s, MODAL);
  ok("2. a page opened on a locked account: the passkey prompt at load", m2.shown && /Verify with your passkey/.test(m2.text), JSON.stringify(m2));
  ok("…nothing sent that the lock refuses", !state.calls.some((p) => /check|enroll|contribute|use-sample/.test(p)), JSON.stringify(state.calls));
  ok("…and nobody signed out", state.logout === 0 && state.login === 0 && (await ev(s, "location.pathname")) === "/__sdk.html", `logout ${state.logout}, sign-in page ${state.login}`);
  await verify(s);
  const ks2 = await ev(s, ROW(0));
  ok("…one passkey clears it and the guard starts", state.authCompletes === 1 && !(await ev(s, MODAL)).shown && !/locked/.test(ks2), `verifications ${state.authCompletes}, typing row "${ks2}"`);

  // 3. the dashboard and the SDK's onboarding window
  state = fresh({ hasPasskey: false });
  await open("/dashboard.html");
  await waitFor(s, `!!${WIZ}.querySelector('#cw')`, 8000);
  ok("3. (set-up) no passkey: the dashboard offers Register Passkey and the SDK's onboarding asks for one",
    (await ev(s, display("regPasskeyBtn"))) !== "none" && !!(await ev(s, `!!${WIZ}.querySelector('#cw')`)));
  await ev(s, `${WIZ}.querySelector('#cw').click()`);
  await waitFor(s, `!!${WIZ}.querySelector('#cd')`, 8000);
  await ev(s, `${WIZ}.querySelector('#cd').click()`); await sleep(1500);
  const d3 = await ev(s, `({ reg: ${display("regPasskeyBtn")}, banner: document.getElementById('bannerPasskey').classList.contains('hidden'), badge: document.getElementById('passkeyStatusBadge').textContent.trim() })`);
  ok("3. once the SDK's onboarding made the passkey: no Register Passkey and no banner asking for one", state.hasPasskey && d3.reg === "none" && d3.banner && /registered/.test(d3.badge), JSON.stringify(d3));

  // 4. Replace, with the new passkey cancelled
  state = fresh({});
  await open("/dashboard.html");
  ok("4. (set-up) a passkey: the dashboard offers Replace and Reset", (await ev(s, display("replacePasskeyBtn"))) !== "none" && (await ev(s, display("resetPasskeyBtn"))) !== "none");
  await ev(s, "(() => { window.confirm = () => true; window.__cancelReg = true; return replacePasskey().then(() => true); })()"); await sleep(800);
  const d4 = await ev(s, `({ reg: ${display("regPasskeyBtn")}, rep: ${display("replacePasskeyBtn")}, rst: ${display("resetPasskeyBtn")}, badge: document.getElementById('passkeyStatusBadge').textContent.trim() })`);
  ok("4. Replace with the new passkey cancelled: Register Passkey shows, Replace and Reset do not", !state.hasPasskey && d4.reg !== "none" && d4.rep === "none" && d4.rst === "none" && /No passkey/.test(d4.badge), JSON.stringify(d4));

  // 5. the dashboard opened on a locked account
  state = fresh({ locked: true });
  await open("/dashboard.html");
  const m5 = await ev(s, MODAL);
  ok("5. the dashboard opened on a locked account: the passkey prompt at load, over the page's lock banner",
    m5.shown && !(await ev(s, "document.getElementById('bannerLocked').classList.contains('hidden')")), JSON.stringify(m5));
  await verify(s);
  const d5 = await ev(s, "({ banner: document.getElementById('bannerLocked').classList.contains('hidden'), session: document.getElementById('statusSession').textContent.trim() })");
  ok("…one passkey, and the page says unlocked", state.authCompletes === 1 && d5.banner && d5.session === "Active", JSON.stringify(d5));
  ok("…and nobody signed out", state.logout === 0 && state.login === 0 && (await ev(s, "location.pathname")) === "/dashboard.html", `logout ${state.logout}, sign-in page ${state.login}`);

  // 6. the typing model being built
  state = fresh({ training: true });
  await open("/dashboard.html");
  const d6 = await ev(s, `({ shown: !document.getElementById('bannerRhythm').classList.contains('hidden'), text: document.getElementById('bannerRhythmText').textContent, btn: ${display("bannerRhythmBtn")} })`);
  ok("6. the typing model being built: the banner says so, with no Start enrollment", d6.shown && /being built/.test(d6.text) && d6.btn === "none", JSON.stringify(d6));

  ok("no error on any page", errors.length === 0, errors.join(" | "));
} catch (e) {
  bad++; console.log("  FAIL  " + (e && e.stack || e));
} finally {
  try { ws.close(); } catch (e) { /* closed */ }
  chrome.kill();
}
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
