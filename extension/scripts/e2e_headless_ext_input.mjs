// End-to-end check of what the extension records as typing (2026-11-08), in real headless Chrome with the working copy
// of the extension loaded and a gateway simulated by this script (every request to http://gw.test is answered here).
//   1. keys on the page itself (space to scroll, a web app's one-letter shortcuts) and on a checkbox are not typing:
//      only the keys typed into the text area are recorded (before: all of them, which the server's degenerate-input
//      rule read as one key hammered)
//   2. a held key's auto-repeat and IME keys (229, or any key during a composition) are not recorded
//   3. text dropped into the field counts as a paste: one check goes out at once, carrying it
// A paste sends a check at once with every event recorded so far, so each step ends with one to read them.
//
//   node extension/scripts/e2e_headless_ext_input.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = process.env.EXT_ROOT || path.join(ROOT, "extension");
const GW = "http://gw.test", SITE = "http://site.test", PORT = 9383;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- the simulated gateway: every typing check's events are kept
const checks = [];
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = "x." + b64u({ sub: 78, sk: "SK_EXT" }) + ".y";
function api(p, method, body) {
  if (p === "/v1/sdk/session") return { token: TOKEN, userId: 78, onboarding: { passkey: true, keystroke: true, mouse: true } };
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false };
  if (p.startsWith("/v1/sdk/lock/status")) return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3,
    checkMinTextChars: 80, adaptiveEnabled: false, panel: "hide", keystroke: "on", mouse: "on", onboardingMode: "eager", managed: [], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: true, adaptiveEnabled: false };
  if (p === "/v1/sdk/keystroke/check") { checks.push(body.keystrokeEvents || []); return { ok: true, checked: false }; }
  if (p === "/v1/sdk/mouse/status") return { enrolled: true, training: false, samplesOnFile: 8, samplesRequired: 8, sampleWindows: 55, voteN: 60, voteK: 33 };
  if (p === "/v1/sdk/mouse/check") return { ok: true, checked: true, warmup: true, isSuspicious: false, windowCount: 0, riskToken: "rt" };
  return {};
}
const SITE_PAGE = `<!doctype html><meta charset="utf-8"><title>a website</title><body style="height:3000px"><p>An ordinary website.</p>
  <label><input type="checkbox" id="cb"> remember me</label><textarea id="box" name="comment" rows="6" cols="60"></textarea></body>`;
function serve(url) {
  const u = new URL(url), p = u.pathname;
  if (u.origin === SITE) return p === "/page.html" ? { code: 200, type: "text/html; charset=utf-8", body: SITE_PAGE } : { code: 404, type: "text/plain", body: "" };
  if (u.hostname === "fonts.googleapis.com") return { code: 200, type: "text/css", body: "" };
  return null;
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ext-input-"));
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
async function key(s, ch, extra = {}) {
  const code = ch === " " ? 32 : ch.toUpperCase().charCodeAt(0);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, windowsVirtualKeyCode: code, ...extra }, s);
  await sleep(4);
  if (!extra.autoRepeat) await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: code }, s);
  await sleep(4);
}
const paste = (s, text) => ev(s, `(() => { const t = document.getElementById('box'); const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
  t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
const drop = (s, text) => ev(s, `(() => { const t = document.getElementById('box'); const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
  t.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
const downs = (events, code) => events.filter((e) => e.eventType === "keydown" && (code == null || e.keyCode === code)).length;
const lastCheck = () => checks[checks.length - 1] || [];

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

  // ---- 1. keys on the page and on a checkbox, then a word in the text area
  await ev(site, "document.activeElement && document.activeElement.blur(), true");
  for (let i = 0; i < 20; i++) { await key(site, " "); await key(site, "j"); }   // scrolling, and a web app's shortcut
  await ev(site, "document.getElementById('cb').focus(), true");
  for (let i = 0; i < 10; i++) await key(site, " ");                             // toggling a checkbox
  await ev(site, "document.getElementById('box').focus(), true");
  for (const ch of "hello") await key(site, ch);
  await paste(site, "x");
  await sleep(1200);
  ok("1. keys on the page and on a checkbox are not typing: only the 5 keys typed into the text area are recorded",
    checks.length === 1 && downs(lastCheck()) === 5, `${checks.length} checks, ${downs(lastCheck())} keydowns`);

  // ---- 2. a held key and IME keys, in the text area
  await key(site, "k");
  for (let i = 0; i < 30; i++) await key(site, "k", { autoRepeat: true });       // the key held down: Chrome repeats its keydown
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "k", windowsVirtualKeyCode: 75 }, site);
  // what an IME reports for every key; Chrome drops a 229 sent through the debugger, so these are the page's own events
  await ev(site, `(() => { const t = document.getElementById('box');
    for (let i = 0; i < 10; i++) for (const type of ["keydown", "keyup"]) {
      t.dispatchEvent(new KeyboardEvent(type, { key: "Process", keyCode: 229, bubbles: true }));
      t.dispatchEvent(new KeyboardEvent(type, { key: "7", keyCode: 55, isComposing: true, bubbles: true }));
    }
    return true; })()`);
  await paste(site, "y");
  await sleep(1200);
  ok("2. a held key's auto-repeat is not recorded: one press, one keydown", checks.length === 2 && downs(lastCheck(), 75) === 1, `${downs(lastCheck(), 75)} keydowns of the held K`);
  ok("…and IME keys (229, or any key during a composition) are not recorded at all", downs(lastCheck(), 229) === 0 && downs(lastCheck(), 55) === 0,
    `${downs(lastCheck(), 229)} keydowns of 229, ${downs(lastCheck(), 55)} composing`);

  // ---- 3. text dropped into the field
  const before3 = checks.length;
  await drop(site, "dropped text");
  await sleep(1200);
  const pastes = lastCheck().filter((e) => e.eventType === "paste");
  ok("3. text dropped into the field sends a check at once", checks.length === before3 + 1, `${checks.length - before3} checks`);
  ok("…carrying it as a paste of its length", pastes.length === 3 && pastes[2].pastedLength === 12, JSON.stringify(pastes.map((e) => e.pastedLength)));
} catch (e) {
  bad++; console.log("  FAIL  " + (e && e.stack || e));
} finally {
  try { ws.close(); } catch (e) { /* closed */ }
  chrome.kill(); await sleep(400); try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
