// End-to-end check of the SDK when a demo-mode page's own sign-in ends (2026-10-25) in real headless Chrome. The demo
// app keeps its sessions in memory, so a restart of its server signs everyone out: its API then answers 401 while the
// open page still looks signed in. Before this the panel kept showing "watching"/"verified" with no check running, and
// a step-up asked /api/auth/me, got no user and showed the server's "userId required".
// The working copy of the SDK (sdk/guard.js, sdk/js/*) is served at a test origin and every /api/ call is answered by
// this script; the passkey is a stub.
//   1. signed in: checks run and the panel shows the vote, no "signed out"
//   2. the sign-in ends during use: the next mouse check gets 401, the panel says "signed out", the modal offers the
//      sign-in page, no further check is sent, and its button opens the sign-in page
//   3. the sign-in ended before a step-up (the 25 Oct case): "Verify" shows "Signed out", no passkey is asked for,
//      and "userId required" never appears
//   4. the same for a typing check
//   5. gateway mode (an organisation's page): a 401 does not show "signed out" (its session is the SDK's own)
//
//   node extension/scripts/e2e_headless_sdk_session_end.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORIGIN = "http://localhost:8080", PORT = 9377;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const GUARD = fs.readFileSync(process.env.GUARD_FILE || path.join(ROOT, "sdk", "guard.js"), "utf8");
const SDK_FILES = { "/js/mouse-features.js": "sdk/js/mouse-features.js", "/js/keystroke-tracker.js": "sdk/js/keystroke-tracker.js" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- what the "server" says, set by each step
let state;
const fresh = (over) => ({ authed: true, mouseChecks: 0, ksChecks: 0, options: 0, ...over });
const CONFIG = { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3, checkMinTextChars: 80,
  adaptiveEnabled: false, panel: "show", keystroke: "on", mouse: "on", onboardingMode: "lazy", managed: [], excludeFieldTypes: ["hidden"] };
const NOT_AUTHED = [401, { error: "Not authenticated" }];
function api(p, body) {
  // The demo app's own routes: everything needs its sign-in.
  if (p.startsWith("/api/")) {
    if (!state.authed) {
      if (p === "/api/mouse/check") state.mouseChecks++;
      if (p === "/api/text/check") state.ksChecks++;
      if (p === "/api/webauthn/auth/options") state.options++;
      return NOT_AUTHED;
    }
    if (p === "/api/auth/me") return [200, { userId: 1, passkeysRegistered: true, passkeySetupRequired: false }];
    if (p === "/api/text/config") return [200, CONFIG];
    if (p === "/api/text/typing-status") return [200, { trained: true, adaptiveEnabled: false }];
    if (p === "/api/mouse/status") return [200, { enrolled: true, training: false, samplesOnFile: 8, samplesRequired: 8, sampleWindows: 55, voteN: 60, voteK: 33 }];
    if (p === "/api/mouse/check") { state.mouseChecks++; return [200, MOUSE_OK]; }
    if (p === "/api/text/check") { state.ksChecks++; return [200, { ok: true, checked: true, warmup: true, typingEvaluation: { windowCount: 3, modelAvailable: true }, modelConfidence: 0.9 }]; }
    if (p === "/api/webauthn/auth/options") { state.options++; return [200, { challengeId: "c", challenge: "x" }]; }
    if (p === "/api/webauthn/auth/complete") return [200, { ok: true, mouseUseSample: { offer: false } }];
    return [200, {}];
  }
  // Gateway mode (step 5): the SDK's own session.
  if (p === "/v1/sdk/onboarding") return [200, { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false }];
  if (p.startsWith("/v1/sdk/lock/status")) return [200, { locked: false }];
  if (p === "/v1/sdk/keystroke/config") return [200, { ...CONFIG, keystroke: "off" }];
  if (p === "/v1/sdk/keystroke/status") return [200, { trained: true, adaptiveEnabled: false }];
  if (p === "/v1/sdk/mouse/status") return [200, { enrolled: true, training: false, samplesOnFile: 8, samplesRequired: 8, sampleWindows: 55, voteN: 60, voteK: 33 }];
  if (p === "/v1/sdk/mouse/check") { state.mouseChecks++; return state.authed ? [200, MOUSE_OK] : [401, { error: "invalid or expired session" }]; }
  return [200, {}];
}
const MOUSE_OK = { ok: true, checked: true, warmup: false, isSuspicious: false, requiresPasskeyChallenge: false, windowCount: 60, lowWindows: 5,
  bufferMax: 60, lockAt: 33, meanScore: 0.7, riskToken: "rt" };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-signout-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), handlers = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); } else if (m.method) handlers.forEach((h) => h(m)); });
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(s, expr)) return true; await sleep(150); } return false; };
const SH = "document.getElementById('continuum-guard-host') && document.getElementById('continuum-guard-host').shadowRoot";
// The step-up modal is the first overlay the SDK adds (the onboarding wizard is the second).
const MODAL = `(() => { const r = ${SH}; const m = r && r.querySelectorAll('.ov')[0]; if (!m) return null;
  return { shown: m.style.display === 'flex', title: m.querySelector('.t').textContent, text: m.querySelector('.d').textContent,
    button: m.querySelector('.b').textContent, error: m.querySelector('.e').style.display !== 'none' ? m.querySelector('.e').textContent : '' }; })()`;
const ROWS = `(() => { const r = ${SH}; return r ? [...r.querySelectorAll('.st')].map((x) => x.textContent) : []; })()`;
const clickModal = (s) => ev(s, `(${SH}).querySelectorAll('.ov')[0].querySelector('.b').click()`);

const token = "x." + Buffer.from(JSON.stringify({ sub: "signout-test-user" })).toString("base64url") + ".y";
const STUB = `<script>window.SimpleWebAuthnBrowser = { startAuthentication: async () => ({ id: "cred", response: {} }), startRegistration: async () => ({}) };</script>`;
const page = (gateway) => `<!doctype html><meta charset="utf-8"><title>sign-out test</title><body style="height:2000px"><p>A page.</p>
  <textarea id="host" name="message" rows="6" cols="60"></textarea>${STUB}
  ${gateway ? `<script src="/guard.js" data-site-key="SK_SIGNOUT" data-session="${token}" data-mouse="on" data-keystroke="off"></script>`
    : `<script src="/guard.js" data-mouse="on" data-keystroke="on"></script>`}`;
let html = page(false);

let pos = { x: 640, y: 450 }, seed = 11;
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
  await sleep(1900);   // one check every 1.6 s
}
async function type(s, text) {
  for (const ch of text) {
    const code = ch === " " ? 32 : ch.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, windowsVirtualKeyCode: code }, s);
    await sleep(5);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: code }, s);
    await sleep(5);
  }
  await sleep(800);
}

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  handlers.push((m) => {
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== s) return;
    const { requestId, request } = m.params, url = new URL(request.url);
    const reply = (code, type, text) => send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(text).toString("base64") }, s);
    if (url.pathname === "/__signout_test.html") return reply(200, "text/html; charset=utf-8", html);
    if (url.pathname === "/login.html") return reply(200, "text/html; charset=utf-8", "<!doctype html><title>sign in</title><p>Sign in</p>");
    if (url.pathname === "/guard.js") return reply(200, "application/javascript", GUARD);
    if (SDK_FILES[url.pathname]) return reply(200, "application/javascript", fs.readFileSync(path.join(ROOT, SDK_FILES[url.pathname]), "utf8"));
    let body = {}; try { body = request.postData ? JSON.parse(request.postData) : {}; } catch { /* not JSON */ }
    const [code, out] = api(url.pathname, body);
    reply(code, "application/json", JSON.stringify(out));
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: ORIGIN + "/__signout_test.html*" }, { urlPattern: ORIGIN + "/login.html*" }, { urlPattern: ORIGIN + "/guard.js*" },
    { urlPattern: ORIGIN + "/js/*" }, { urlPattern: ORIGIN + "/api/*" }, { urlPattern: ORIGIN + "/v1/sdk/*" }] }, s);
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  const load = async (over, gateway = false) => {
    state = fresh(over); html = page(gateway);
    await send("Page.navigate", { url: ORIGIN + "/__signout_test.html" }, s);
    await waitFor(s, `!!(${SH}) && !!(${SH}).querySelector('.panel')`, 20000);
    await sleep(1500);
    await ev(s, `(() => { try { localStorage.setItem('continuumGuardMouse', '1'); } catch (e) {} return true; })()`);
  };

  // ---- 1. signed in
  await load();
  for (let i = 0; i < 6 && state.mouseChecks === 0; i++) await move(s, 200);
  await move(s, 120);
  const rows1 = await ev(s, ROWS), m1 = await ev(s, MODAL);
  ok("1. signed in: mouse checks run and the panel shows the vote", state.mouseChecks > 0 && rows1.some((r) => /low · locks at 33/.test(r)), `${state.mouseChecks} checks, ${JSON.stringify(rows1)}`);
  ok("…nothing says signed out, and no modal", !rows1.some((r) => /signed out/.test(r)) && !(m1 && m1.shown), JSON.stringify(m1));

  // ---- 2. the sign-in ends during use
  state.authed = false;
  const before = state.mouseChecks;
  await move(s, 150);
  const rows2 = await ev(s, ROWS), m2 = await ev(s, MODAL);
  ok("2. the sign-in ends: the next mouse check gets 401 and the panel says so", state.mouseChecks === before + 1 && rows2.some((r) => /mouse: signed out — sign in again/.test(r)),
    `${state.mouseChecks - before} check(s) after, ${JSON.stringify(rows2)}`);
  ok("…the modal says the session has ended and offers the sign-in page", !!m2 && m2.shown && m2.title === "Signed out" && /session has ended/.test(m2.text) && m2.button === "Sign in again",
    JSON.stringify(m2));
  const after = state.mouseChecks;
  await move(s, 300);
  ok("…no further check is sent", state.mouseChecks === after, `${state.mouseChecks - after} more`);
  ok("…the page is not reported as locked by a step-up", (await ev(s, "window.Continuum.isLocked()")) === false);
  await clickModal(s);
  ok("…and its button opens the sign-in page", await waitFor(s, "location.pathname === '/login.html'", 5000), await ev(s, "location.pathname"));

  // ---- 3. the sign-in ended before a step-up (no check noticed it yet)
  await load();
  state.authed = false;
  await ev(s, `window.Continuum.requireStepUp("mouse")`);
  const m3a = await ev(s, MODAL);
  ok("3. a mouse step-up opens the passkey modal", !!m3a && m3a.shown && m3a.title === "Identity check required" && m3a.button === "Verify with passkey", JSON.stringify(m3a));
  await clickModal(s);
  await sleep(800);
  const m3 = await ev(s, MODAL);
  ok("…'Verify' finds the sign-in gone: 'Signed out', with the sign-in button", !!m3 && m3.shown && m3.title === "Signed out" && m3.button === "Sign in again", JSON.stringify(m3));
  ok("…no passkey is asked for", state.options === 0, `${state.options} options requests`);
  ok("…and 'userId required' never appears", !/userId required/.test(JSON.stringify(m3)), m3 && m3.error);

  // ---- 4. a typing check
  await load();
  await ev(s, "document.getElementById('host').focus()");
  await type(s, "the quick brown fox jumps over the lazy dog and then it runs far away into the green field ");
  const ksBefore = state.ksChecks;
  state.authed = false;
  await type(s, "and the dog sleeps all day long in the warm sun near the old house by the river bank ");
  const rows4 = await ev(s, ROWS), m4 = await ev(s, MODAL);
  ok("4. a typing check after the sign-in ended: the panel says signed out", state.ksChecks > ksBefore && rows4.some((r) => /keystroke: signed out — sign in again/.test(r)),
    `${state.ksChecks - ksBefore} check(s), ${JSON.stringify(rows4)}`);
  ok("…and the modal offers the sign-in page", !!m4 && m4.shown && m4.title === "Signed out", JSON.stringify(m4));

  // ---- 5. gateway mode is unchanged
  await load({}, true);
  for (let i = 0; i < 6 && state.mouseChecks === 0; i++) await move(s, 200);
  state.authed = false;
  const g0 = state.mouseChecks;
  await move(s, 150);
  const rows5 = await ev(s, ROWS), m5 = await ev(s, MODAL);
  ok("5. gateway mode: a 401 on its own session does not show 'signed out'", state.mouseChecks > g0 && !rows5.some((r) => /signed out/.test(r)) && !(m5 && m5.shown && m5.title === "Signed out"),
    `${state.mouseChecks - g0} check(s), ${JSON.stringify(rows5)}`);
} catch (e) {
  ok("run completed", false, e.message);
} finally {
  ws.close(); chrome.kill(); await sleep(400); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
