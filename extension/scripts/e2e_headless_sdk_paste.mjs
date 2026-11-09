// End-to-end check of the SDK's paste check (2026-10-25) in real headless Chrome. An organisation allows a number of
// pastes per field (ca-service counts them; "unlimited" by default). Before this a check waited for a new typing
// window, so a paste that no typing followed was never judged.
//
// The SDK on a page served at the gateway's own origin, with its working copy (sdk/guard.js) in place of the deployed
// one, and every /v1/sdk/ call answered by this script, as in e2e_headless_sdk_popup.mjs. Only the SDK's helper
// scripts (the key tracker) come from the running gateway.
//   1. a little typing (short of the 80 characters and of a window): no check is sent
//   2. a paste with nothing typed after it: one check goes out at once, carrying the paste, and the server's
//      "within the allowance" answer locks nothing
//   3. the server says the allowance is exceeded: the next paste locks the page, and the window says it was a paste
//
//   node extension/scripts/e2e_headless_sdk_paste.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080", PORT = 9373;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const GUARD = fs.readFileSync(path.join(ROOT, "sdk", "guard.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- what the "server" says, set by each step
const state = { checks: [], exceeded: false };
function api(p, method, body) {
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false };
  if (p === "/v1/sdk/lock/status") return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3, checkMinTextChars: 80,
    adaptiveConfidenceMin: 0.8, adaptiveRetrainEvery: 3, adaptiveEnabled: false, adaptiveMinGapHours: 3, panel: "show", keystroke: "on", mouse: "off",
    onboardingMode: "eager", managed: ["mouse"], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: true, adaptiveEnabled: false, adaptivePending: 0, adaptiveReady: false, nextContributionAt: null, adaptiveRetrainEvery: 3 };
  if (p === "/v1/sdk/keystroke/check") {
    const ev = body.keystrokeEvents || [];
    const pastes = ev.filter((e) => e.eventType === "paste");
    state.checks.push({ pastes: pastes.length, pastedLength: pastes.map((e) => e.pastedLength), keys: ev.filter((e) => e.eventType === "keydown").length, textLength: body.textLength });
    if (state.exceeded && pastes.length) {
      return { ok: false, checked: true, warmup: false, requiresPasskeyChallenge: true, isSuspicious: true, scoredWindowCount: 0, riskToken: "rt",
        typingEvaluation: { modelType: "paste-policy", windowCount: 0, modelAvailable: true }, message: "More pastes into one field than allowed. Passkey verification required." };
    }
    return { ok: true, checked: false, message: "More typed text is required before rhythm verification" };
  }
  return {};
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-paste-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), handlers = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); } else if (m.method) handlers.forEach((h) => h(m)); });
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(s, expr)) return true; await sleep(150); } return false; };
const SH = "document.getElementById('continuum-guard-host') && document.getElementById('continuum-guard-host').shadowRoot";
const MODAL = `(() => { const r = ${SH}; const m = r && r.querySelector('.ov'); const d = m && m.querySelector('.d'); return m ? { shown: m.style.display === 'flex', text: d ? d.textContent : '' } : null; })()`;

const token = "x." + Buffer.from(JSON.stringify({ sub: "paste-test-user" })).toString("base64url") + ".y";
const html = `<!doctype html><meta charset="utf-8"><title>paste test</title><p>An organisation's page.</p><textarea id="host" name="message" rows="6" cols="60"></textarea>
  <script src="/guard.js" data-site-key="SK_PASTE_TEST" data-session="${token}" data-onboarding="eager" data-keystroke="on" data-mouse="off"></script>`;
async function type(s, text) {
  for (const ch of text) {
    const code = ch === " " ? 32 : ch.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, windowsVirtualKeyCode: code }, s);
    await sleep(5);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: code }, s);
    await sleep(5);
  }
  await sleep(500);
}
// A real paste event, as the browser fires it (Ctrl+V), with the clipboard's text.
const paste = (s, text) => ev(s, `(() => { const t = document.getElementById('host'); const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
  t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  handlers.push((m) => {
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== s) return;
    const { requestId, request } = m.params, url = new URL(request.url);
    const reply = (code, type, text) => send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(text).toString("base64") }, s);
    if (url.pathname === "/__paste_test.html") return reply(200, "text/html; charset=utf-8", html);
    if (url.pathname === "/guard.js") return reply(200, "application/javascript", GUARD);
    let body = {}; try { body = request.postData ? JSON.parse(request.postData) : {}; } catch { /* not JSON */ }
    reply(200, "application/json", JSON.stringify(api(url.pathname, request.method, body)));
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: GW + "/__paste_test.html*" }, { urlPattern: GW + "/guard.js*" }, { urlPattern: GW + "/v1/sdk/*" }] }, s);
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  await send("Page.navigate", { url: GW + "/__paste_test.html" }, s);
  await waitFor(s, `!!(${SH}) && !!document.getElementById('host')`, 20000);
  await sleep(1200);   // config, onboarding and the lock status are asked before the guard starts
  await ev(s, "document.getElementById('host').focus()");

  await type(s, "hello there friend");
  ok("1. a little typing, short of 80 characters and of a window, sends no check", state.checks.length === 0, `${state.checks.length} checks`);

  await paste(s, "hello");
  await sleep(800);
  const c = state.checks[0] || {};
  ok("2. a paste with nothing typed after it sends one check at once", state.checks.length === 1, `${state.checks.length} checks`);
  ok("…carrying the paste and its length only", c.pastes === 1 && c.pastedLength && c.pastedLength[0] === 5, JSON.stringify(c));
  const m1 = await ev(s, MODAL);
  ok("…and the server's answer within the allowance locks nothing", !(m1 && m1.shown), JSON.stringify(m1));

  state.exceeded = true;
  await paste(s, "world");
  await sleep(800);
  ok("3. the next paste goes out at once too", state.checks.length === 2 && state.checks[1].pastes === 2, JSON.stringify(state.checks[1] || {}));
  const m2 = await ev(s, MODAL);
  ok("…the server's 'exceeded' locks the page", !!(m2 && m2.shown), JSON.stringify(m2));
  ok("…and the window says it was a paste, not the rhythm", !!(m2 && /pasted into this field more times than allowed/.test(m2.text)), m2 && m2.text);
} catch (e) {
  bad++; console.log("  FAIL  " + (e && e.stack || e));
} finally {
  try { ws.close(); } catch (e) { /* closed */ }
  chrome.kill();
}
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
