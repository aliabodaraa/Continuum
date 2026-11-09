// End-to-end check of the SDK's "Contribute sample" popup (2026-10-19) in real headless Chrome. The popup shows only
// when the server's dry run says a click would be accepted, and the SDK asks once per new window, not per key.
//
// The SDK on a page served at the gateway's own origin (the way an organisation's site loads it), with its working
// copy (sdk/guard.js) in place of the deployed one, and every /v1/sdk/ call answered by this script: nothing about a
// user, a model or a passkey is needed, so the popup logic is tested alone and the answers are exactly what each step
// needs. Only the SDK's helper scripts (the key tracker) come from the running gateway.
//   1. typing short of 20 windows: checks run, no question is asked, no popup
//   2. 20 windows reached, the server says no: one question per new window, no popup
//   3. the server says yes: the popup shows; a later no hides it; a yes again and a click sends the sample
//   4. after the click the next sample starts afresh: no question until it has its windows
//   5. the server says the cycle is ready (3 samples): the popup offers the retrain instead
//   6. the server says paused, or adaptive retraining off: asked once, never again
//
//   node extension/scripts/e2e_headless_sdk_popup.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080", PORT = 9371;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const GUARD = fs.readFileSync(path.join(ROOT, "sdk", "guard.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- what the "server" says, set by each step
let state;
const fresh = () => ({ checks: 0, probes: [], contributes: [], dry: { eligible: false, error: "One window in this sample scored 40%, below the 80% floor." } });
const win = (keys) => { const s = Math.max(keys - 1, 0); return s >= 50 ? Math.floor((s - 50) / 10) + 1 : 0; };
function api(p, method, body) {
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false };
  if (p === "/v1/sdk/lock/status") return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3, checkMinTextChars: 80,
    adaptiveConfidenceMin: 0.8, adaptiveRetrainEvery: 3, adaptiveEnabled: true, adaptiveMinGapHours: 3, panel: "show", keystroke: "on", mouse: "off",
    onboardingMode: "eager", managed: ["mouse"], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: true, adaptiveEnabled: true, adaptivePending: 0, adaptiveReady: false, nextContributionAt: null, adaptiveRetrainEvery: 3 };
  if (p === "/v1/sdk/keystroke/check") {
    state.checks++;
    const keys = (body.keystrokeEvents || []).filter((e) => e.eventType === "keydown").length;
    return { checked: true, warmup: false, isSuspicious: false, modelConfidence: 0.93, riskToken: "rt", typingEvaluation: { windowCount: win(keys), modelAvailable: true } };
  }
  if (p === "/v1/sdk/keystroke/contribute") {
    if (body.dryRun) { state.probes.push({ events: (body.keystrokeEvents || []).length, textLength: body.textLength }); return { ok: true, dryRun: true, ...state.dry }; }
    state.contributes.push({ events: (body.keystrokeEvents || []).length, textLength: body.textLength, dryRun: body.dryRun });
    return { ok: true, pending: 1, retrainEvery: 3, ready: false, message: "Sample added: 1 of 3." };
  }
  return {};
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-popup-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), handlers = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); } else if (m.method) handlers.forEach((h) => h(m)); });
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(s, expr)) return true; await sleep(150); } return false; };
const SH = "document.getElementById('continuum-guard-host') && document.getElementById('continuum-guard-host').shadowRoot";
const POPUP = `(() => { const r = ${SH}; const l = r && r.querySelector('.learn'); const g = l && l.querySelector('.go'); return l ? { visible: l.style.display === 'block', text: g ? g.textContent : '' } : null; })()`;
const popupVisible = async (s) => { const p = await ev(s, POPUP); return !!(p && p.visible); };
const popupText = async (s) => { const p = await ev(s, POPUP); return p ? p.text : ""; };

const token = "x." + Buffer.from(JSON.stringify({ sub: "popup-test-user" })).toString("base64url") + ".y";
const html = `<!doctype html><meta charset="utf-8"><title>popup test</title><p>An organisation's page.</p><textarea id="host" rows="6" cols="60"></textarea>
  <script src="/guard.js" data-site-key="SK_POPUP_TEST" data-session="${token}" data-onboarding="eager" data-keystroke="on" data-mouse="off"></script>`;
const PASSAGE = "the quick brown fox jumps over the lazy dog while a small bird sings near the old river bank today ";
let typed = 0;
async function type(s, n) {
  for (let i = 0; i < n; i++, typed++) {
    const ch = PASSAGE[typed % PASSAGE.length], code = ch === " " ? 32 : ch.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, windowsVirtualKeyCode: code }, s);
    await sleep(5);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: code }, s);
    await sleep(5);
  }
  await sleep(500);   // the last check and its answer
}

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  handlers.push((m) => {
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== s) return;
    const { requestId, request } = m.params, url = new URL(request.url);
    const reply = (code, type, text) => send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(text).toString("base64") }, s);
    if (url.pathname === "/__popup_test.html") return reply(200, "text/html; charset=utf-8", html);
    if (url.pathname === "/guard.js") return reply(200, "application/javascript", GUARD);
    let body = {}; try { body = request.postData ? JSON.parse(request.postData) : {}; } catch { /* not JSON */ }
    reply(200, "application/json", JSON.stringify(api(url.pathname, request.method, body)));
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: GW + "/__popup_test.html*" }, { urlPattern: GW + "/guard.js*" }, { urlPattern: GW + "/v1/sdk/*" }] }, s);
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  const load = async () => {
    typed = 0; state = fresh();
    await send("Page.navigate", { url: GW + "/__popup_test.html" }, s);
    await waitFor(s, `!!(${SH}) && !!document.getElementById('host')`, 20000);
    await sleep(1200);   // config, onboarding and the lock status are asked before the guard starts
    await ev(s, "document.getElementById('host').focus()");
  };

  // ---- 1-4. one page, the server's answer changed between steps
  await load();
  await type(s, 200);
  ok("1. short of 20 windows the checks run, no question is asked and there is no popup",
    state.checks >= 8 && state.probes.length === 0 && !(await popupVisible(s)), `${state.checks} checks, ${state.probes.length} questions`);

  await type(s, 80);   // windows 20 to 23 form at 241, 251, 261 and 271 keys
  ok("2. at 20 windows the SDK starts asking, once per new window, and the server's no keeps the popup away",
    state.probes.length >= 3 && state.probes.length <= 6 && !(await popupVisible(s)), `${state.probes.length} questions for about 4 windows, 80 keys typed`);
  const p0 = state.probes[0] || {};
  ok("…each question carries the typing since the previous sample and its length", p0.events > 400 && p0.textLength >= 240, JSON.stringify(p0));

  state.dry = { eligible: true, windows: 24, sampleMean: 0.93 };
  await type(s, 10);
  ok("3. the server says yes at the next window: the popup shows", (await popupVisible(s)) && (await popupText(s)) === "Contribute sample", await popupText(s));

  state.dry = { eligible: false, error: "Sample not clean enough to contribute (70% < 80%)." };
  await type(s, 10);
  ok("…a no at the window after hides it again", !(await popupVisible(s)));

  state.dry = { eligible: true, windows: 26 };
  await type(s, 10);
  ok("…and a yes shows it again", await popupVisible(s));
  const before = state.probes.length;
  await ev(s, `(${SH}).querySelector('.learn .go').click()`);
  await sleep(800);
  const c = state.contributes[0] || {};
  ok("a click sends the sample for real (no dry run), once", state.contributes.length === 1 && c.dryRun === undefined && c.events > 400 && c.textLength >= 290, JSON.stringify(c));
  ok("…the popup says it was added, then goes away", /Added/.test(await ev(s, `(${SH}).querySelector('.learn .lm').textContent`)));
  await sleep(3000);
  ok("…and closes", !(await popupVisible(s)));

  await type(s, 100);   // ten windows into the next sample
  ok("4. the next sample starts afresh: no question until it has its 20 windows", state.probes.length === before && !(await popupVisible(s)), `${state.probes.length} questions, ${before} before the click`);

  // ---- 5. the cycle is ready: the popup offers the retrain
  await load();
  state.dry = { eligible: false, error: "ready_to_retrain", pending: 3, retrainEvery: 3, message: "3 samples are ready. Retrain your model (with your passkey) before adding more." };
  await type(s, 260);
  ok("5. when the server says three samples are ready, the popup offers the retrain", (await popupVisible(s)) && (await popupText(s)) === "Retrain with passkey", await popupText(s));

  // ---- 6. paused, or adaptive retraining switched off: asked once, never again
  for (const [name, dry] of [["paused after a retrain", { eligible: false, error: "adaptive_paused", nextContributionAt: new Date(Date.now() + 3 * 3600000).toISOString(), pauseHours: 3 }],
                             ["adaptive retraining off for the organisation", { eligible: false, error: "adaptive_disabled" }]]) {
    await load();
    state.dry = dry;
    await type(s, 260);
    const first = state.probes.length;
    await type(s, 60);
    ok(`6. ${name}: asked once, never again, no popup`, first === 1 && state.probes.length === 1 && !(await popupVisible(s)), `${first} then ${state.probes.length} questions`);
  }
} catch (e) {
  ok("run completed", false, e.message);
} finally {
  ws.close(); chrome.kill(); await sleep(400); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
