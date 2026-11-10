// End-to-end check of the × on the SDK's mandatory windows (2026-11-09), in real headless Chrome. The × signs the user
// out and returns them to a sign-in page. Until now, on an organisation's page that named none, it went to /login.html,
// a page of our demo app that the organisation need not have (Acme: "Cannot GET /login.html"). Now the × is there only
// when the page names its sign-in page with data-login-url.
//
// The SDK on a page served at the gateway's own origin, with its working copy (sdk/guard.js) in place of the deployed
// one, and every /v1/sdk/ call answered by this script.
//   1. no sign-in page named: the onboarding window has no ×, and neither has the passkey prompt of a locked account
//   2. a sign-in page named: the × is there; pressing it calls the page's sign-out address, then goes to its sign-in page
//   3. a sign-in page named and no sign-out address: the × goes straight to the sign-in page, and calls no address we made up
//
//   node extension/scripts/e2e_headless_sdk_close_button.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080", PORT = 9413;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const GUARD = fs.readFileSync(path.join(ROOT, "sdk", "guard.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

const state = { locked: false, enrolled: false, attrs: "", calls: [], nav: [] };
function api(p) {
  if (p === "/v1/sdk/onboarding") return state.enrolled ? { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false } : { passkey: false, keystroke: false, mouse: false, keystrokeTraining: false };
  if (p === "/v1/sdk/lock/status") return { locked: state.locked };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3,
    adaptiveConfidenceMin: 0.8, adaptiveRetrainEvery: 3, adaptiveEnabled: false, adaptiveMinGapHours: 3, panel: "show", keystroke: "on", mouse: "off",
    onboardingMode: "eager", managed: ["mouse"], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: state.enrolled, adaptiveEnabled: false, adaptivePending: 0, adaptiveReady: false };
  return {};
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-close-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), handlers = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); } else if (m.method) handlers.forEach((h) => h(m)); });
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(s, expr)) return true; await sleep(150); } return false; };
const SH = "document.getElementById('continuum-guard-host') && document.getElementById('continuum-guard-host').shadowRoot";
// The window on screen, and whether it offers a visible ×.
const OPEN = `[...(${SH}).querySelectorAll('.ov')].find((o) => o.style.display === 'flex')`;
const WIN = `(() => { const o = ${OPEN}; if (!o) return null; const x = o.querySelector('.wizx'); return { title: (o.querySelector('h2,.t') || {}).textContent || '', x: !!x && x.style.display !== 'none' }; })()`;

const token = "x." + Buffer.from(JSON.stringify({ sub: "close-test-user" })).toString("base64url") + ".y";
const html = () => `<!doctype html><meta charset="utf-8"><title>close test</title><p>An organisation's page.</p>
  <script src="/guard.js" data-site-key="SK_CLOSE_TEST" data-session="${token}" data-onboarding="eager" data-keystroke="on" data-mouse="off" ${state.attrs}></script>`;
const PAGE = GW + "/__close_test.html";

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  handlers.push((m) => {
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== s) return;
    const { requestId, request } = m.params, url = new URL(request.url);
    const reply = (code, type, text) => send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(text).toString("base64") }, s);
    if (url.pathname === "/__close_test.html") return reply(200, "text/html; charset=utf-8", html());
    if (url.pathname === "/guard.js") return reply(200, "application/javascript", GUARD);
    if (url.pathname.startsWith("/v1/sdk/")) return reply(200, "application/json", JSON.stringify(api(url.pathname)));
    state.calls.push(request.method + " " + url.pathname);
    return reply(200, url.pathname.endsWith(".html") ? "text/html; charset=utf-8" : "application/json", url.pathname.endsWith(".html") ? "<title>sign in</title>" : "{}");
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: GW + "/__close_test.html*" }, { urlPattern: GW + "/guard.js*" }, { urlPattern: GW + "/v1/sdk/*" }, { urlPattern: GW + "/__org/*" }, { urlPattern: GW + "/login.html*" }, { urlPattern: GW + "/api/auth/logout*" }] }, s);
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  const open = async (o) => { Object.assign(state, o, { calls: [] }); await send("Page.navigate", { url: PAGE }, s); await waitFor(s, `!!(${SH}) && !!(${OPEN})`, 20000); await sleep(600); };
  const pressX = async () => { await ev(s, `(() => { const o = ${OPEN}; o.querySelector('.wizx').click(); return true; })()`); await waitFor(s, "location.pathname !== '/__close_test.html'", 8000); await sleep(300); };

  await open({ enrolled: false, locked: false, attrs: "" });
  const w1 = await ev(s, WIN);
  ok("1. no sign-in page named: the onboarding window has no ×", !!w1 && w1.x === false, JSON.stringify(w1));
  await open({ enrolled: true, locked: true, attrs: "" });
  const w2 = await ev(s, WIN);
  ok("…and neither has the passkey prompt of a locked account", !!w2 && w2.x === false, JSON.stringify(w2));

  await open({ enrolled: false, locked: false, attrs: 'data-login-url="/__org/signin.html" data-logout-url="/__org/signout"' });
  const w3 = await ev(s, WIN);
  ok("2. a sign-in page named: the × is there", !!w3 && w3.x === true, JSON.stringify(w3));
  await pressX();
  ok("…pressing it calls the page's sign-out address, then goes to its sign-in page",
    state.calls.join(" ; ") === "POST /__org/signout ; GET /__org/signin.html" && (await ev(s, "location.pathname")) === "/__org/signin.html", state.calls.join(" ; "));

  await open({ enrolled: false, locked: false, attrs: 'data-login-url="/__org/signin.html"' });
  await pressX();
  ok("3. no sign-out address: the × goes straight to the sign-in page, calling no address we made up",
    state.calls.join(" ; ") === "GET /__org/signin.html", state.calls.join(" ; "));
} catch (e) {
  bad++; console.log("  FAIL  " + (e && e.stack || e));
} finally {
  try { ws.close(); } catch (e) { /* closed */ }
  chrome.kill();
}
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
