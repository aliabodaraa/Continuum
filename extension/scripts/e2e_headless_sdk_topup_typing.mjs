// End-to-end check of "Add samples" for a trained typing model (2026-11-25) in real headless Chrome.
//
// A trained model takes no enrolment sample, or anyone at an open session could teach it their own typing. Its user may
// add samples after the passkey: the first enrolment stays in one session, and the model can be widened later. The
// SDK on a page with its working copy (sdk/guard.js, sdk/js/*) and every /v1/sdk/ call answered by this script, the
// passkey library replaced by one that answers, so nothing real is needed or reached.
//   1. the trained screen offers "Add samples" beside the reset
//   2. pressing it asks for the passkey, takes the server's grant for it, and opens the passage screen counting the
//      top-up's own samples
//   3. three samples go with the grant; typing is not judged while that screen is open; after the third the screen says
//      the model is being rebuilt
//   4. the grant runs out before the samples are finished: the trained screen says so
//   5. the passkey prompt cancelled: nothing is asked of the server and the trained screen stays
//
//   node extension/scripts/e2e_headless_sdk_topup_typing.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE = "http://topup.test", PORT = 9385;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const GUARD = fs.readFileSync(process.env.GUARD_FILE || path.join(ROOT, "sdk", "guard.js"), "utf8");
const SDK_FILES = { "/js/mouse-features.js": "sdk/js/mouse-features.js", "/js/keystroke-tracker.js": "sdk/js/keystroke-tracker.js", "/js/guard-ar.js": "sdk/js/guard-ar.js" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- what the "server" says
let state;
const fresh = () => ({ checks: 0, verifies: 0, topUps: [], grant: null, waiting: 0, enrolls: [], passkey: "ok" });
function api(p, method, body) {
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false };
  if (p === "/v1/sdk/lock/status") return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3,
    checkMinTextChars: 80, adaptiveEnabled: false, panel: "show", keystroke: "on", mouse: "off", onboardingMode: "eager", managed: [], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: true, training: false, sampleCount: 5, adaptiveEnabled: false, topUpSamples: 3, topUpAdded: state.waiting };
  if (p === "/v1/sdk/keystroke/check") { state.checks++; return { ok: true, checked: false }; }
  // the passkey and the grant it buys, as the gateway
  if (p === "/v1/sdk/passkey/auth/options") return { challengeId: "c1", challenge: "x" };
  if (p === "/v1/sdk/passkey/auth/complete") { state.verifies++; return { verified: true, stepUpToken: "step-" + state.verifies }; }
  if (p === "/v1/sdk/keystroke/topup") {
    state.topUps.push(body.stepUpToken || null);
    if (body.stepUpToken !== "step-" + state.verifies) return { __status: 403, error: "passkey_required" };
    state.grant = "grant-" + state.verifies;
    return { ok: true, topUpToken: state.grant, expiresInMs: 900000 };
  }
  if (p === "/v1/sdk/keystroke/enroll") {
    state.enrolls.push({ topUpToken: body.topUpToken || null, keys: (body.keystrokeEvents || []).filter((e) => e.eventType === "keydown").length, chars: String(body.textContent || "").length });
    if (!state.grant || body.topUpToken !== state.grant) return { __status: 409, ok: false, error: "already_enrolled" };
    state.waiting++;
    const done = state.waiting >= 3, r = { ok: true, trained: true, training: done, topUp: { added: state.waiting, needed: 3 } };
    if (done) state.waiting = 0;
    return r;
  }
  return {};
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-topup-typing-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), handlers = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); } else if (m.method) handlers.forEach((h) => h(m)); });
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(s, expr)) return true; await sleep(150); } return false; };
const SH = "document.getElementById('continuum-guard-host') && document.getElementById('continuum-guard-host').shadowRoot";
const OPEN = `[...((${SH}) ? (${SH}).querySelectorAll('.ov') : [])].find((o) => o.style.display === 'flex')`;   // the popup on screen
// The popup on screen: its title, the sample counter, the error line, and which controls it has.
const WIZ = `(() => { const ov = ${OPEN}; const t = ov && ov.querySelector('.card .t'); if (!t) return null;
  const e = ov.querySelector('.card .e'), c = ov.querySelector('.samplecount'), ta = ov.querySelector('#cta');
  return { title: t.textContent, count: c ? c.textContent : '', note: e && getComputedStyle(e).display !== 'none' ? e.textContent : '', add: !!ov.querySelector('#cadd'),
    reset: !!ov.querySelector('#creset') && getComputedStyle(ov.querySelector('#creset').parentElement).display !== 'none', passage: !!ta, topUp: !!ta && ta.getAttribute('data-topup') === 'keystroke',
    canSave: !!ov.querySelector('#cs') && !ov.querySelector('#cs').disabled }; })()`;
const wiz = (s) => ev(s, WIZ);
const clickIn = (s, sel) => ev(s, `(() => { const b = (${SH}).querySelector(${JSON.stringify(sel)}); if (b) b.click(); return !!b; })()`);
const TRAINED = "Your typing rhythm is trained", PASSAGES = "Strengthen your typing rhythm", REBUILT = "Your typing model is being rebuilt";
const titled = (s, title, ms = 8000) => waitFor(s, `(${WIZ}) && (${WIZ}).title === ${JSON.stringify(title)}`, ms);

const token = "x." + Buffer.from(JSON.stringify({ sub: "topup-typing-user" })).toString("base64url") + ".y";
const html = `<!doctype html><meta charset="utf-8"><title>top-up test</title><p>An organisation's page.</p><textarea id="host" rows="6" cols="60"></textarea>
  <script src="/guard.js" data-site-key="SK_TOPUP_TEST" data-session="${token}" data-onboarding="eager" data-keystroke="on" data-mouse="off"></script>`;
const TEXT = "the quick brown fox jumps over the lazy dog while a small bird sings near the old river bank today ";
let typed = 0;
async function type(s, n) {
  for (let i = 0; i < n; i++, typed++) {
    const ch = TEXT[typed % TEXT.length], code = ch === " " ? 32 : ch.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, windowsVirtualKeyCode: code }, s);
    await sleep(5);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: code }, s);
    await sleep(5);
  }
  await sleep(500);   // the last check and its answer
}
const onPage = (s) => ev(s, "document.getElementById('host').focus(), true");
const onPassage = (s) => ev(s, `(${SH}).querySelector('#cta').focus(), true`);
// One sample of the top-up: type until the screen lets it be saved, then save it.
async function sample(s) {
  await onPassage(s);
  for (let i = 0; i < 6 && !(await wiz(s)).canSave; i++) await type(s, 50);
  const could = (await wiz(s)).canSave;
  await clickIn(s, "#cs");
  await sleep(700);
  return could;
}

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  const errors = [];
  handlers.push((m) => { if (m.sessionId === s && m.method === "Runtime.exceptionThrown") errors.push(((m.params.exceptionDetails || {}).exception || {}).description || (m.params.exceptionDetails || {}).text || "error"); });
  handlers.push((m) => {
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== s) return;
    const { requestId, request } = m.params, url = new URL(request.url);
    const reply = (code, type, text) => send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(text).toString("base64") }, s);
    if (url.pathname === "/page.html") return reply(200, "text/html; charset=utf-8", html);
    if (url.pathname === "/guard.js") return reply(200, "application/javascript; charset=utf-8", GUARD);
    // the passkey prompt itself cannot run in headless Chrome: the library that shows it answers, or refuses as a cancel does
    if (url.pathname === "/vendor/simplewebauthn/index.umd.min.js") return reply(200, "application/javascript; charset=utf-8",
      "window.__passkey = 'ok'; window.SimpleWebAuthnBrowser = { startAuthentication: async () => { if (window.__passkey !== 'ok') throw new Error('The operation was cancelled'); return { id: 'cred', response: {} }; }, startRegistration: async () => ({}) };");
    if (SDK_FILES[url.pathname]) return reply(200, "application/javascript; charset=utf-8", fs.readFileSync(path.join(ROOT, SDK_FILES[url.pathname]), "utf8"));
    if (!url.pathname.startsWith("/v1/sdk/")) return reply(404, "text/plain", "");
    let body = {}; try { body = request.postData ? JSON.parse(request.postData) : {}; } catch { /* not JSON */ }
    const out = api(url.pathname, request.method, body) || {}, code = out.__status || 200;
    delete out.__status;
    reply(code, "application/json", JSON.stringify(out));
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: SITE + "/*" }] }, s);
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  const ADD = 'button[title="Add typing samples"]';
  const load = async () => {
    typed = 0; state = fresh();
    await send("Page.navigate", { url: SITE + "/page.html" }, s);
    await waitFor(s, `!!(${SH}) && !!(${SH}).querySelector(${JSON.stringify(ADD)})`, 20000);
    await sleep(1200);   // config, onboarding and the lock status come before the guard starts
  };

  // ---- 1. the trained screen
  await load();
  await onPage(s);
  await type(s, 300);
  const judged = state.checks;   // the live guard judges the page's typing (the model exists)
  await clickIn(s, ADD);
  await titled(s, TRAINED);
  const w1 = await wiz(s);
  ok("1. the trained screen offers \"Add samples\" beside the reset", !!w1 && w1.title === TRAINED && w1.add && w1.reset && !w1.passage, JSON.stringify(w1));

  // ---- 2. the passkey, the grant, the passage screen
  await clickIn(s, "#cadd");
  const open2 = await titled(s, PASSAGES);
  const w2 = await wiz(s);
  ok("2. pressing it asks for the passkey, takes the server's grant for it, and opens the passages", open2 && w2.topUp && state.verifies === 1 && state.topUps.length === 1 && state.topUps[0] === "step-1",
    `${state.verifies} passkey, grant asked with ${JSON.stringify(state.topUps)}, ${JSON.stringify(w2)}`);
  ok("…counting the top-up's own samples, with no reset in the way", w2.count === "Extra sample 1 of 3" && !w2.reset, `${w2.count}, reset ${w2.reset}`);

  // ---- 3. three samples with the grant
  const checks3 = state.checks;
  const saved = [await sample(s)];
  const after1 = await wiz(s);
  saved.push(await sample(s));
  const after2 = await wiz(s);
  saved.push(await sample(s));
  const done3 = await titled(s, REBUILT);
  ok("3. three samples go with the grant, one at a time", saved.every(Boolean) && state.enrolls.length === 3 && state.enrolls.every((e) => e.topUpToken === "grant-1" && e.keys >= 100 && e.chars >= 120)
    && after1.count === "Extra sample 2 of 3" && after2.count === "Extra sample 3 of 3",
    `${state.enrolls.length} samples, grants ${[...new Set(state.enrolls.map((e) => e.topUpToken))].join(",")}, counter ${after1.count} / ${after2.count}`);
  ok("…typing is judged on the page before, and not while the top-up's screen is open", judged > 0 && state.checks === checks3, `${judged} checks before, ${state.checks - checks3} during`);
  ok("…after the third the screen says the model is being rebuilt", done3, JSON.stringify(await wiz(s)));
  await clickIn(s, "#cdone");
  await onPage(s);
  const checks3c = state.checks;
  await type(s, 300);
  ok("…and typing on the page is judged again once it is closed", state.checks > checks3c, `${state.checks - checks3c} checks`);

  // ---- 4. the grant runs out before the samples are finished
  await load();
  await clickIn(s, ADD);
  await titled(s, TRAINED);
  await clickIn(s, "#cadd");
  await titled(s, PASSAGES);
  await sample(s);
  state.grant = null;   // on the server the quarter of an hour is over
  await sample(s);
  const back4 = await titled(s, TRAINED);
  const w4 = await wiz(s);
  ok("4. the grant ran out before the samples were finished: the trained screen says so", back4 && state.enrolls.length === 2 && /ran out/.test(w4.note) && w4.add, `${state.enrolls.length} sent; note: ${w4.note}`);

  // ---- 5. the passkey prompt cancelled
  await load();
  await ev(s, "window.__passkey = 'cancel'; true");
  await clickIn(s, ADD);
  await titled(s, TRAINED);
  await clickIn(s, "#cadd");
  await sleep(1200);
  const w5 = await wiz(s);
  ok("5. the passkey prompt cancelled: the server is asked for no grant and the trained screen stays, with the reason", w5.title === TRAINED && !w5.passage && state.topUps.length === 0 && state.enrolls.length === 0 && !!w5.note,
    `${state.topUps.length} grants asked; note: ${w5.note}`);
  ok("no script error on the page in the whole run", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  ok("run completed", false, e.message);
} finally {
  ws.close(); chrome.kill(); await sleep(400); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
