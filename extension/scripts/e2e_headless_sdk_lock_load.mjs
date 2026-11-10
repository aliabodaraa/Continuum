// End-to-end check of what the SDK does when a page opens on a locked account (2026-11-09), in real headless Chrome.
// Until then the SDK asked /v1/sdk/lock/status/<id>, the gateway only has /v1/sdk/lock/status, and the 404 was read as
// "not locked": the page opened normally until its first check. The stubs of the other SDK suites accepted the wrong
// address, so nothing showed it. And correcting the address alone would have signed a locked user out on every page
// load, for good, since the lock outlives the sign-in and the passkey prompt would never have been reached.
//
// The SDK on a page served at the gateway's own origin, with its working copy (sdk/guard.js) in place of the deployed
// one, and every /v1/sdk/ call answered by this script as the real gateway would (a wrong address gets a 404).
//   1. a locked account: the SDK asks the gateway's own address, once, and the page shows the passkey prompt
//   2. nobody is signed out, on this load or on the next one (no loop)
//   3. an account that is not locked: no prompt
//   4. the lock status cannot be read: no prompt and no sign-out (the server still answers 423 to every check)
//   5. a locked account with an enrolment missing: the passkey prompt comes first, no enrolment window and nothing
//      enrolled (2026-11-10: the enrolment used to run first, so the person the lock was about could enrol for the owner)
//   6. a page that waits for onReady and then asks for the step-up with its own callbacks (the extension's verify pages,
//      connect.html and study.html): one passkey verification (a virtual authenticator) clears the lock and reaches the
//      page's callback; no second prompt
//
//   node extension/scripts/e2e_headless_sdk_lock_load.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url"; import crypto from "node:crypto";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080", PORT = 9411;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const GUARD = fs.readFileSync(path.join(ROOT, "sdk", "guard.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

const state = { locked: true, status: 200, asked: [], logout: 0, login: 0, enrolled: true, enrolCalls: [], verifyPage: false, authCompletes: 0 };
// A passkey for the virtual authenticator of step 6 (P-256, as a platform authenticator makes).
const KEY = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const CRED = crypto.randomBytes(16);
function api(p) {
  if (/enroll|contribute|use-sample|use-anchor/.test(p)) state.enrolCalls.push(p);
  if (p === "/v1/sdk/onboarding") return state.enrolled ? { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false } : { passkey: true, keystroke: false, mouse: false, keystrokeTraining: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3,
    adaptiveConfidenceMin: 0.8, adaptiveRetrainEvery: 3, adaptiveEnabled: false, adaptiveMinGapHours: 3, panel: "show", keystroke: "on", mouse: "off",
    onboardingMode: "eager", managed: ["mouse"], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: true, adaptiveEnabled: false, adaptivePending: 0, adaptiveReady: false };
  if (p === "/v1/sdk/passkey/auth/options") return { challenge: crypto.randomBytes(32).toString("base64url"), rpId: "localhost", timeout: 30000,
    userVerification: "preferred", allowCredentials: [{ id: CRED.toString("base64url"), type: "public-key" }], challengeId: "c-1" };
  if (p === "/v1/sdk/passkey/auth/complete") { state.authCompletes++; state.locked = false; return { verified: true, ok: true }; }
  return {};
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-lock-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), handlers = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); } else if (m.method) handlers.forEach((h) => h(m)); });
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(s, expr)) return true; await sleep(150); } return false; };
const SH = "document.getElementById('continuum-guard-host') && document.getElementById('continuum-guard-host').shadowRoot";
const MODAL = `(() => { const r = ${SH}; const m = r && r.querySelector('.ov'); const d = m && m.querySelector('.d'); const b = m && m.querySelector('.b'); return m ? { shown: m.style.display === 'flex', text: d ? d.textContent : '', button: b ? b.textContent : '' } : null; })()`;

const token = "x." + Buffer.from(JSON.stringify({ sub: "lock-test-user" })).toString("base64url") + ".y";
// The verify page's pattern (connect.html, study.html): wait for onReady, then ask for the step-up with its own callbacks.
const VERIFY = `<script>window.__ready = false; window.__verified = 0; (function w() { if (window.Continuum && window.Continuum.onReady)
  return window.Continuum.onReady(function () { window.__ready = true; window.Continuum.requireStepUp("keystroke", function () { window.__verified++; }); });
  setTimeout(w, 50); })();</script>`;
const html = () => `<!doctype html><meta charset="utf-8"><title>lock test</title><p>An organisation's page.</p>${state.verifyPage ? VERIFY : ""}
  <script src="/guard.js" data-site-key="SK_LOCK_TEST" data-session="${token}" data-onboarding="eager" data-keystroke="on" data-mouse="off" data-logout-url="/__logout" data-login-url="/__login.html"></script>`;
const PAGE = GW + "/__lock_test.html";

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  handlers.push((m) => {
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== s) return;
    const { requestId, request } = m.params, url = new URL(request.url);
    const reply = (code, type, text) => send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(text).toString("base64") }, s);
    const json = (code, o) => reply(code, "application/json", JSON.stringify(o));
    if (url.pathname === "/__lock_test.html") return reply(200, "text/html; charset=utf-8", html());
    if (url.pathname === "/guard.js") return reply(200, "application/javascript", GUARD);
    if (url.pathname === "/__logout") { state.logout++; return json(200, {}); }
    if (url.pathname === "/__login.html") { state.login++; return reply(200, "text/html; charset=utf-8", "<title>sign in</title>"); }
    if (url.pathname.startsWith("/v1/sdk/lock/status")) {
      state.asked.push(url.pathname);
      if (url.pathname !== "/v1/sdk/lock/status") return json(404, { error: "not_found" });   // as the real gateway answers
      return state.status === 200 ? json(200, { locked: state.locked }) : json(state.status, { error: "unavailable" });
    }
    return json(200, api(url.pathname));
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: GW + "/__lock_test.html*" }, { urlPattern: GW + "/guard.js*" }, { urlPattern: GW + "/v1/sdk/*" }, { urlPattern: GW + "/__logout*" }, { urlPattern: GW + "/__login.html*" }] }, s);
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  const open = async () => { state.asked = []; await send("Page.navigate", { url: PAGE }, s); await waitFor(s, `!!(${SH})`, 20000); await sleep(1800); };

  await open();
  ok("1. a locked account: the SDK asks the gateway's own address, once", state.asked.length === 1 && state.asked[0] === "/v1/sdk/lock/status", JSON.stringify(state.asked));
  const m1 = await ev(s, MODAL);
  ok("…and the page shows the passkey prompt", !!(m1 && m1.shown) && /Verify with passkey/.test(m1.button) && /Verify with your passkey/.test(m1.text), JSON.stringify(m1));
  ok("2. nobody is signed out", state.logout === 0 && state.login === 0 && (await ev(s, "location.pathname")) === "/__lock_test.html", `logout ${state.logout}, login page ${state.login}`);

  await open();
  const m2 = await ev(s, MODAL);
  ok("…and the next load of the same locked account shows the prompt again, still without a sign-out (no loop)", !!(m2 && m2.shown) && state.logout === 0 && state.login === 0, `logout ${state.logout}, login page ${state.login}`);

  state.locked = false;
  await open();
  const m3 = await ev(s, MODAL);
  ok("3. an account that is not locked: no prompt", !(m3 && m3.shown) && state.asked.length === 1, JSON.stringify(m3));

  state.status = 503;
  await open();
  const m4 = await ev(s, MODAL);
  ok("4. the lock status cannot be read: no prompt and no sign-out", !(m4 && m4.shown) && state.logout === 0 && state.login === 0, JSON.stringify(m4));

  Object.assign(state, { status: 200, locked: true, enrolled: false, enrolCalls: [] });
  await open();
  const m5 = await ev(s, MODAL);
  const wiz5 = await ev(s, `(() => { const o = (${SH}).querySelectorAll('.ov')[1]; return !!o && o.style.display === 'flex'; })()`);
  ok("5. locked, with an enrolment missing: the passkey prompt comes first, with no enrolment window", !!(m5 && m5.shown) && wiz5 === false, `prompt ${JSON.stringify(m5 && m5.shown)}, enrolment window ${wiz5}`);
  ok("…and nothing is enrolled while the account is locked", state.enrolCalls.length === 0, JSON.stringify(state.enrolCalls));

  await send("WebAuthn.enable", {}, s);
  const { authenticatorId } = await send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } }, s);
  await send("WebAuthn.addCredential", { authenticatorId, credential: { credentialId: CRED.toString("base64"), isResidentCredential: false, rpId: "localhost", privateKey: KEY, signCount: 1 } }, s);
  Object.assign(state, { locked: true, enrolled: true, verifyPage: true, authCompletes: 0 });
  await open();
  ok("6. a verify page that waits for onReady gets it while the account is locked", (await ev(s, "window.__ready")) === true, String(await ev(s, "window.__ready")));
  await ev(s, `(() => { const b = (${SH}).querySelector('.ov .b'); b.click(); return true; })()`);
  await waitFor(s, "window.__verified > 0", 15000); await sleep(1500);
  const m6 = await ev(s, MODAL);
  ok("…and one passkey verification clears the lock and reaches the page's own callback, with no second prompt",
    state.authCompletes === 1 && (await ev(s, "window.__verified")) === 1 && !(m6 && m6.shown), `verifications ${state.authCompletes}, page callback ${await ev(s, "window.__verified")}, prompt ${JSON.stringify(m6 && m6.shown)}`);
} catch (e) {
  bad++; console.log("  FAIL  " + (e && e.stack || e));
} finally {
  try { ws.close(); } catch (e) { /* closed */ }
  chrome.kill();
}
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
