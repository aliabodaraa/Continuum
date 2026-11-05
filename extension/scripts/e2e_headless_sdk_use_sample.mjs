// End-to-end check of the SDK's real-use mouse sample (learning from real use, stage 1, 2026-10-24) in real headless
// Chrome. After a verified step-up, when the server offers it, the SDK asks; on a yes it records fresh movement and
// sends one sample of 55 windows. The working copy of the SDK (sdk/guard.js, sdk/js/*) is served at the gateway's
// origin and every /v1/sdk/ call is answered by this script; the passkey is a stub, so nothing real is needed.
//   1. a mouse lock, then the passkey: the verification carries its reason, the question shows, a yes records and
//      sends one sample of 55 windows, none of it from before the lock
//   2. "Not now": nothing is recorded or sent
//   3. no offer from the server: no question
//   4. a lock during the recording: the recording is dropped, nothing is sent
//   5. the mouse channel off on the page: no question even with an offer
//   6. a tenant's own pages (the demo app, same-origin /api/*): the offer comes through its backend's passkey answer and
//      the sample goes to its /api/mouse/use-sample
//
//   node extension/scripts/e2e_headless_sdk_use_sample.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080", PORT = 9375;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const GUARD = fs.readFileSync(process.env.GUARD_FILE || path.join(ROOT, "sdk", "guard.js"), "utf8");
const SDK_FILES = { "/js/mouse-features.js": "sdk/js/mouse-features.js", "/js/keystroke-tracker.js": "sdk/js/keystroke-tracker.js" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- what the "server" says, set by each step
let state;
const OFFER = { offer: true, expiresInMs: 180000, sampleWindows: 55 };
const fresh = (over) => ({ checks: [], lockOnCheck: 1, verifies: [], useSamples: [], offer: OFFER, ...over });
// The demo app's own routes (its backend relays them to the tenant API) answer like the SDK routes.
const DEMO = { "/api/text/config": "/v1/sdk/keystroke/config", "/api/text/typing-status": "/v1/sdk/keystroke/status", "/api/mouse/status": "/v1/sdk/mouse/status",
  "/api/mouse/check": "/v1/sdk/mouse/check", "/api/webauthn/auth/options": "/v1/sdk/passkey/auth/options" };
function api(p, method, body) {
  if (p === "/api/auth/me") return { userId: 1, passkeysRegistered: true, passkeySetupRequired: false };
  if (p === "/api/webauthn/auth/complete") { state.verifies.push(body); return { ok: true, message: "Passkey authentication successful", mouseUseSample: state.offer }; }
  if (p === "/api/mouse/use-sample") { state.useSamples.push(body.windows || []); state.demoSamples = (state.demoSamples || 0) + 1; return { ok: true, stored: true }; }
  if (DEMO[p]) p = DEMO[p];
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false };
  if (p.startsWith("/v1/sdk/lock/status")) return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3,
    checkMinTextChars: 80, adaptiveEnabled: false, panel: "show", keystroke: "off", mouse: "on", onboardingMode: "lazy", managed: [], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: true, adaptiveEnabled: false };
  if (p === "/v1/sdk/mouse/status") return { enrolled: true, training: false, samplesOnFile: 8, samplesRequired: 8, sampleWindows: 55, voteN: 60, voteK: 33 };
  if (p === "/v1/sdk/mouse/check") {
    state.checks.push(body.windows || []);
    const lock = state.checks.length === state.lockOnCheck;
    return { ok: !lock, checked: true, warmup: false, isSuspicious: lock, requiresPasskeyChallenge: lock, windowCount: 60, lowWindows: lock ? 40 : 5,
      bufferMax: 60, lockAt: 33, meanScore: lock ? 0.2 : 0.7, riskToken: "rt" };
  }
  if (p === "/v1/sdk/passkey/auth/options") return { challengeId: "c" + state.verifies.length, challenge: "x" };
  if (p === "/v1/sdk/passkey/auth/complete") { state.verifies.push(body); return { verified: true, mouseUseSample: state.offer }; }
  if (p === "/v1/sdk/mouse/use-sample") { state.useSamples.push(body.windows || []); return { ok: true, stored: true }; }
  return {};
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-use-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), handlers = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); } else if (m.method) handlers.forEach((h) => h(m)); });
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(s, expr)) return true; await sleep(150); } return false; };
const SH = "document.getElementById('continuum-guard-host') && document.getElementById('continuum-guard-host').shadowRoot";
// The question box is the .learn element whose title is about the mouse.
const USE = `[...((${SH}) ? (${SH}).querySelectorAll('.learn') : [])].find((x) => /real mouse use/.test(x.textContent))`;
const useBox = (s) => ev(s, `(() => { const u = ${USE}; return u ? { visible: u.style.display === 'block', text: u.querySelector('.lm').textContent,
  buttons: u.querySelector('.lb').style.display !== 'none' } : null; })()`);
const MODAL_OPEN = `[...(${SH}).querySelectorAll('.ov')].some((o) => o.style.display === 'flex' && /Identity check required/.test(o.textContent))`;

const token = "x." + Buffer.from(JSON.stringify({ sub: "use-test-user" })).toString("base64url") + ".y";
const page = (mouse, demo) => demo ? `<!doctype html><meta charset="utf-8"><title>demo app page</title><body style="height:2000px"><p>The demo app.</p>
  <script>window.SimpleWebAuthnBrowser = { startAuthentication: async () => ({ id: "cred", response: {} }), startRegistration: async () => ({}) };</script>
  <script src="/guard.js" data-mouse="on" data-keystroke="off"></script>` : `<!doctype html><meta charset="utf-8"><title>use test</title><body style="height:2000px"><p>An organisation's page.</p>
  <script>window.SimpleWebAuthnBrowser = { startAuthentication: async () => ({ id: "cred", response: {} }), startRegistration: async () => ({}) };</script>
  <script src="/guard.js" data-site-key="SK_USE_TEST" data-session="${token}" data-mouse="${mouse}" data-keystroke="off"></script>`;
let html = page("on");

let pos = { x: 640, y: 450 }, seed = 7;
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
  await sleep(900);
}
const runs = (windows) => { const r = new Set(); for (const w of windows) for (let i = 0; i + 20 <= w.length; i++) r.add(JSON.stringify(w.slice(i, i + 20))); return r; };
const shared = (a, b) => { const ra = runs(a), rb = runs(b); let n = 0; for (const x of rb) if (ra.has(x)) n++; return rb.size ? n / rb.size : 0; };
// Move until the SDK's mouse check locks (the server says so at its first check), then verify with the passkey.
// While the SDK's own lock is up, a page asks for the step-up too (as the demo's lab page does): its callback must
// still run at the verification. pageTold counts those calls.
let pageTold = 0;
async function lockAndVerify(s) {
  for (let i = 0; i < 12 && !(await ev(s, MODAL_OPEN)); i++) await move(s, 150);
  const locked = await ev(s, MODAL_OPEN);
  await ev(s, "window.__pageTold = 0; window.Continuum.requireStepUp('keystroke', () => { window.__pageTold++; }); true");
  await ev(s, `(${SH}).querySelector('.ov .card .b').click()`);
  await waitFor(s, `!(${MODAL_OPEN})`, 5000);
  await sleep(300);
  pageTold = await ev(s, "window.__pageTold");
  return locked;
}

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  handlers.push((m) => {
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== s) return;
    const { requestId, request } = m.params, url = new URL(request.url);
    const reply = (code, type, text) => send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(text).toString("base64") }, s);
    if (url.pathname === "/__use_test.html") return reply(200, "text/html; charset=utf-8", html);
    if (url.pathname === "/guard.js") return reply(200, "application/javascript", GUARD);
    if (SDK_FILES[url.pathname]) return reply(200, "application/javascript", fs.readFileSync(path.join(ROOT, SDK_FILES[url.pathname]), "utf8"));
    let body = {}; try { body = request.postData ? JSON.parse(request.postData) : {}; } catch { /* not JSON */ }
    reply(200, "application/json", JSON.stringify(api(url.pathname, request.method, body)));
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: GW + "/__use_test.html*" }, { urlPattern: GW + "/guard.js*" }, { urlPattern: GW + "/js/*" },
    { urlPattern: GW + "/v1/sdk/*" }, { urlPattern: GW + "/api/*" }] }, s);
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  const load = async (over, mouse = "on", demo = false) => {
    state = fresh(over); html = page(mouse, demo);
    await send("Page.navigate", { url: GW + "/__use_test.html" }, s);
    await waitFor(s, `!!(${SH}) && !!(${SH}).querySelector('.panel')`, 20000);
    await sleep(1500);
  };

  // ---- 1. lock, passkey, yes, one sample of fresh movement
  await load();
  const locked = await lockAndVerify(s);
  ok("1. a mouse lock, then the passkey", locked && state.verifies.length === 1, `${state.checks.length} checks, ${state.verifies.length} verifications`);
  ok("…the verification says it answered a mouse lock", (state.verifies[0] || {}).reason === "mouse", JSON.stringify(state.verifies[0] || {}));
  ok("…a page that asked for the step-up while the SDK was already locked is told of the verification", pageTold === 1, `callback ran ${pageTold} times`);
  const box = await useBox(s);
  ok("…the server offered a sample: the question shows, with its two buttons", !!box && box.visible && box.buttons && /Your profile does not change/.test(box.text), JSON.stringify(box));
  const beforeLock = state.checks[0] || [];
  await ev(s, `(${USE}).querySelector('.go').click()`);
  for (let i = 0; i < 8 && state.useSamples.length === 0; i++) await move(s, 200);
  const sent = state.useSamples[0] || [];
  ok("…a yes records and sends one sample of 55 windows", state.useSamples.length === 1 && sent.length === 55, `${state.useSamples.length} sent, ${sent.length} windows`);
  ok("…none of it from before the lock", sent.length > 0 && shared(beforeLock, sent) === 0, `${(100 * shared(beforeLock, sent)).toFixed(1)}% shared with the movement the lock judged`);
  await sleep(300);
  ok("…and the box says it was saved", /Saved/.test(((await useBox(s)) || {}).text || ""), ((await useBox(s)) || {}).text);
  await move(s, 700);
  ok("…and nothing more is sent", state.useSamples.length === 1, `${state.useSamples.length} sent`);

  // ---- 2. "Not now"
  await load();
  await lockAndVerify(s);
  await ev(s, `(${USE}).querySelector('.gh').click()`);
  await move(s, 900);
  ok("2. \"Not now\": nothing is recorded or sent, and the question goes", state.useSamples.length === 0 && !((await useBox(s)) || {}).visible, `${state.useSamples.length} sent`);

  // ---- 3. no offer
  await load({ offer: { offer: false, why: "paused" } });
  await lockAndVerify(s);
  ok("3. no offer from the server: no question", !((await useBox(s)) || {}).visible && state.verifies.length === 1);

  // ---- 4. a lock during the recording. The sample (55 windows) is complete before the first mouse check after the
  // passkey can run (60 windows), so the lock here comes from the page (any channel locks the same way).
  await load();
  await lockAndVerify(s);
  await ev(s, `(${USE}).querySelector('.go').click()`);
  await move(s, 300);                             // about half a sample
  await ev(s, `window.Continuum.requireStepUp("keystroke")`);
  const relocked = await waitFor(s, MODAL_OPEN, 3000);
  await move(s, 700);
  ok("4. a lock during the recording drops it: nothing is sent", relocked && state.useSamples.length === 0 && !((await useBox(s)) || {}).visible,
    `locked again: ${relocked}, ${state.useSamples.length} sent`);
  await ev(s, `(${SH}).querySelector('.ov .card .b').click()`);
  await waitFor(s, `!(${MODAL_OPEN})`, 5000);
  await move(s, 700);
  ok("…and after the next passkey nothing is sent without a new yes", state.useSamples.length === 0 && state.verifies.length === 2, `${state.useSamples.length} sent`);

  // ---- 5. the mouse channel off on the page (as on the extension's own verify page)
  await load({}, "off");
  await ev(s, `window.Continuum.requireStepUp("mouse")`);
  await waitFor(s, MODAL_OPEN, 3000);
  await ev(s, `(${SH}).querySelector('.ov .card .b').click()`);
  await waitFor(s, `!(${MODAL_OPEN})`, 5000);
  await sleep(500);
  ok("5. mouse off on the page: no question, though the server offered one", state.verifies.length === 1 && !((await useBox(s)) || {}).visible);

  // ---- 6. the demo app's own pages
  await load({}, "on", true);
  await lockAndVerify(s);
  ok("6. a tenant's own page: the verification goes to its backend, with its reason", state.verifies.length === 1 && state.verifies[0].reason === "mouse" && state.verifies[0].userId === 1,
    JSON.stringify(state.verifies[0] || {}));
  const box6 = await useBox(s);
  ok("…the offer its backend passed on shows the question", !!box6 && box6.visible && box6.buttons, JSON.stringify(box6));
  await ev(s, `(${USE}).querySelector('.go').click()`);
  for (let i = 0; i < 8 && state.useSamples.length === 0; i++) await move(s, 200);
  ok("…and a yes sends one sample of 55 windows to its /api/mouse/use-sample", state.demoSamples === 1 && (state.useSamples[0] || []).length === 55,
    `${state.demoSamples || 0} sent there`);
} catch (e) {
  ok("run completed", false, e.message);
} finally {
  ws.close(); chrome.kill(); await sleep(400); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
