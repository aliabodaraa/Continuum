// End-to-end check of the extension's paste check (2026-10-25) in real headless Chrome with the working copy of the
// extension loaded. An organisation allows a number of pastes per field (ca-service counts them; "unlimited" by
// default). Before this the extension sent a typing check only when a new typing window formed, so a paste that no
// typing followed was never judged. A gateway is simulated by this script (every request to http://gw.test is
// answered here), so nothing real is touched.
//   1. a little typing on a website (no window yet): no check is sent
//   2. a paste with nothing typed after it: one check goes out at once, carrying the paste, and the gateway's
//      "within the allowance" answer locks nothing
//   3. the gateway says the allowance is exceeded: the next paste locks the website, and the overlay says it was a paste
//
//   node extension/scripts/e2e_headless_ext_paste.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = path.join(ROOT, "extension");
const GW = "http://gw.test", SITE = "http://site.test", PORT = 9379;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- the simulated gateway
const state = { checks: [], exceeded: false };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = "x." + b64u({ sub: 78, sk: "SK_EXT" }) + ".y";
function api(p, method, body) {
  if (p === "/v1/sdk/session") return { token: TOKEN, userId: 78, onboarding: { passkey: true, keystroke: true, mouse: true } };
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false };
  if (p === "/v1/sdk/lock/status") return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3,
    checkMinTextChars: 80, adaptiveEnabled: false, panel: "hide", keystroke: "on", mouse: "on", onboardingMode: "eager", managed: [], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: true, adaptiveEnabled: false };
  if (p === "/v1/sdk/keystroke/check") {
    const ev = body.keystrokeEvents || [];
    const pastes = ev.filter((e) => e.eventType === "paste");
    state.checks.push({ pastes: pastes.length, pastedLength: pastes.map((e) => e.pastedLength), field: pastes.map((e) => e.fieldName), textLength: body.textLength });
    if (state.exceeded && pastes.length) {
      return { ok: false, checked: true, warmup: false, requiresPasskeyChallenge: true, isSuspicious: true, scoredWindowCount: 0, riskToken: "rt",
        typingEvaluation: { modelType: "paste-policy", windowCount: 0, modelAvailable: true }, message: "More pastes into one field than allowed. Passkey verification required." };
    }
    return { ok: true, checked: false };
  }
  if (p === "/v1/sdk/mouse/status") return { enrolled: true, training: false, samplesOnFile: 8, samplesRequired: 8, sampleWindows: 55, voteN: 60, voteK: 33 };
  if (p === "/v1/sdk/mouse/check") return { ok: true, checked: true, warmup: true, isSuspicious: false, windowCount: 0, riskToken: "rt" };
  return {};
}
const SITE_PAGE = `<!doctype html><meta charset="utf-8"><title>a website</title><body><p>An ordinary website.</p><textarea id="box" name="comment" rows="6" cols="60"></textarea></body>`;
function serve(url) {
  const u = new URL(url), p = u.pathname;
  if (u.origin === SITE) return p === "/page.html" ? { code: 200, type: "text/html; charset=utf-8", body: SITE_PAGE } : { code: 404, type: "text/plain", body: "" };
  if (u.hostname === "fonts.googleapis.com") return { code: 200, type: "text/css", body: "" };
  return null;
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ext-paste-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`, "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map();
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
async function type(s, text) {
  for (const ch of text) {
    const code = ch === " " ? 32 : ch.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, windowsVirtualKeyCode: code }, s);
    await sleep(5);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: code }, s);
    await sleep(5);
  }
  await sleep(600);
}
// A real paste event, as the browser fires it (Ctrl+V), with the clipboard's text.
const paste = (s, text) => ev(s, `(() => { const t = document.getElementById('box'); const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
  t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
const OVERLAY = "(() => { const b = document.getElementById('__cgVerifyBtn'); return b ? b.parentElement.textContent : null; })()";

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
  await send("Target.createTarget", { url: SITE + "/page.html" });
  const site = await waitSession((t) => t.type === "page" && t.url.startsWith(SITE));
  await waitFor(site, "document.readyState === 'complete'", 10000);
  await sleep(1500);
  await ev(site, "document.getElementById('box').focus()");

  await type(site, "hello there friend");
  ok("1. a little typing, short of a window, sends no check", state.checks.length === 0, `${state.checks.length} checks`);

  await paste(site, "hello");
  await sleep(1200);
  const c = state.checks[0] || {};
  ok("2. a paste with nothing typed after it sends one check at once", state.checks.length === 1, `${state.checks.length} checks`);
  ok("…carrying the paste, its field and its length only", c.pastes === 1 && c.pastedLength[0] === 5 && c.field[0] === "comment", JSON.stringify(c));
  ok("…and the gateway's answer within the allowance locks nothing", (await ev(site, OVERLAY)) === null);

  state.exceeded = true;
  await paste(site, "world");
  const locked = await waitFor(site, "!!document.getElementById('__cgVerifyBtn')", 8000);
  ok("3. the next paste goes out at once too", state.checks.length === 2 && state.checks[1].pastes === 2, JSON.stringify(state.checks[1] || {}));
  ok("…the gateway's 'exceeded' locks the website", locked);
  const text = await ev(site, OVERLAY);
  ok("…and the overlay says it was a paste, not the rhythm", !!text && /pasted into a field more times than allowed/.test(text), text);
} catch (e) {
  bad++; console.log("  FAIL  " + (e && e.stack || e));
} finally {
  try { ws.close(); } catch (e) { /* closed */ }
  chrome.kill();
}
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
