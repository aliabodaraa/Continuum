// End-to-end check of what the SDK's key tracker records and when it checks (2026-11-08), in real headless Chrome.
// The SDK on a page served at the gateway's own origin, with the working copy of sdk/ (guard.js and its scripts) in
// place of the deployed one, and every /v1/sdk/ call answered by this script, as in e2e_headless_sdk_paste.mjs.
//   1. a chat box emptied at every send: the text in it never reaches 80 characters, but the keys typed do, so typing
//      checks go out, counting the keys typed (before: the field's text only, so the channel never checked)
//   2. a held key's auto-repeat and IME key 229 are not recorded as keystrokes (before: a held arrow key looked like
//      erratic typing to the server's degenerate-input rule, and an Android keyboard like one key hammered)
//   3. text dropped into a field counts as a paste: one check goes out at once, carrying it (before: dragging text in
//      got past the organisation's paste allowance)
//
//   node extension/scripts/e2e_headless_sdk_input.mjs        (SDK_ROOT=<folder> tests another copy of sdk/)
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SDK = process.env.SDK_ROOT || path.join(ROOT, "sdk");
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080", PORT = 9374;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- what the "server" is sent: every typing check's length and events
const checks = [];
function api(p, method, body) {
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false };
  if (p.startsWith("/v1/sdk/lock/status/")) return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3, checkMinTextChars: 80,
    adaptiveConfidenceMin: 0.8, adaptiveRetrainEvery: 3, adaptiveEnabled: false, adaptiveMinGapHours: 3, panel: "show", keystroke: "on", mouse: "off",
    onboardingMode: "eager", managed: ["mouse"], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: true, adaptiveEnabled: false, adaptivePending: 0, adaptiveReady: false, nextContributionAt: null, adaptiveRetrainEvery: 3 };
  if (p === "/v1/sdk/keystroke/check") {
    checks.push({ textLength: body.textLength, events: body.keystrokeEvents || [] });
    return { ok: true, checked: false, message: "More typed text is required before rhythm verification" };
  }
  return {};
}
const MIME = { ".js": "application/javascript" };
function sdkFile(p) {   // /guard.js, /js/*.js and /vendor/** from the copy of sdk/ under test
  const rel = p === "/guard.js" ? "guard.js" : p.replace(/^\//, "");
  if (!/^(guard\.js|js\/[\w.-]+\.js|vendor\/[\w./-]+\.js)$/.test(rel)) return null;
  const f = path.join(SDK, rel);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-input-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), handlers = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); } else if (m.method) handlers.forEach((h) => h(m)); });
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(s, expr)) return true; await sleep(150); } return false; };
const SH = "document.getElementById('continuum-guard-host') && document.getElementById('continuum-guard-host').shadowRoot";

const token = "x." + Buffer.from(JSON.stringify({ sub: "input-test-user" })).toString("base64url") + ".y";
const html = `<!doctype html><meta charset="utf-8"><title>input test</title><p>A chat page.</p><textarea id="host" name="message" rows="6" cols="60"></textarea>
  <script src="/guard.js" data-site-key="SK_INPUT_TEST" data-session="${token}" data-onboarding="eager" data-keystroke="on" data-mouse="off"></script>`;
const LETTERS = "the quick brown fox jumps over the lazy dog while we wait for the next message to come in soon";
async function key(s, ch, extra = {}) {
  const code = extra.code || (ch === " " ? 32 : ch.toUpperCase().charCodeAt(0));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, windowsVirtualKeyCode: code, ...extra }, s);
  await sleep(4);
  if (!extra.autoRepeat) await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: code }, s);
  await sleep(4);
}
const clearBox = (s) => ev(s, "(() => { const t = document.getElementById('host'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
const paste = (s, text) => ev(s, `(() => { const t = document.getElementById('host'); const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
  t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
const drop = (s, text) => ev(s, `(() => { const t = document.getElementById('host'); const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)});
  t.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
const downs = (events, code) => events.filter((e) => e.eventType === "keydown" && (code == null || e.keyCode === code)).length;

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  handlers.push((m) => {
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== s) return;
    const { requestId, request } = m.params, url = new URL(request.url);
    const reply = (code, type, text) => send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(text).toString("base64") }, s);
    if (url.pathname === "/__input_test.html") return reply(200, "text/html; charset=utf-8", html);
    if (!url.pathname.startsWith("/v1/")) {
      const f = sdkFile(url.pathname);
      return f != null ? reply(200, MIME[".js"], f) : reply(404, "text/plain", "");
    }
    let body = {}; try { body = request.postData ? JSON.parse(request.postData) : {}; } catch { /* not JSON */ }
    reply(200, "application/json", JSON.stringify(api(url.pathname, request.method, body)));
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: GW + "/*" }] }, s);
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  await send("Page.navigate", { url: GW + "/__input_test.html" }, s);
  await waitFor(s, `!!(${SH}) && !!document.getElementById('host') && !!window.continuumKeystrokes`, 20000);
  await sleep(1200);   // config, onboarding and the lock status are asked before the guard starts
  await ev(s, "document.getElementById('host').focus()");

  // ---- 1. a chat box emptied at every send
  for (let i = 0; i < 90; i++) {
    await key(s, LETTERS[i]);
    if (i % 15 === 14) await clearBox(s);   // "sent": the box is empty again
  }
  await sleep(800);
  const inBox = await ev(s, "document.getElementById('host').value.length");
  const c1 = checks[0];
  ok("1. a chat box emptied at every send still gets typing checks", checks.length >= 1 && inBox < 15, `${checks.length} checks, ${inBox} characters left in the box`);
  ok("…which count the keys typed, not the text left", !!c1 && c1.textLength >= 80, c1 && `textLength ${c1.textLength}`);

  // ---- 2. a held key and IME keys
  await clearBox(s);
  const before = checks.length;
  await key(s, "k");
  for (let i = 0; i < 30; i++) await key(s, "k", { autoRepeat: true });   // the key held down: Chrome repeats its keydown
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "k", windowsVirtualKeyCode: 75 }, s);
  // What an IME (an Android keyboard) reports for every key: keyCode 229, or the key while a composition is open. Chrome
  // drops a 229 sent through the debugger, so these are the page's own events, as the IME's would be.
  await ev(s, `(() => { const t = document.getElementById('host');
    for (let i = 0; i < 10; i++) for (const type of ["keydown", "keyup"]) {
      t.dispatchEvent(new KeyboardEvent(type, { key: "Process", keyCode: 229, bubbles: true }));
      t.dispatchEvent(new KeyboardEvent(type, { key: "7", keyCode: 55, isComposing: true, bubbles: true }));
    }
    return true; })()`);
  await paste(s, "x");   // a paste sends a check at once, with every event recorded so far
  await sleep(800);
  const c2 = checks[checks.length - 1] || { events: [] };
  const kTyped = [...LETTERS.slice(0, 90)].filter((ch) => ch === "k").length;   // step 1's sentence has its own K
  ok("2. a held key's auto-repeat is not recorded: one press, one keydown", checks.length > before && downs(c2.events, 75) === kTyped + 1,
    `${downs(c2.events, 75) - kTyped} keydowns of the held K`);
  ok("…and IME keys (229, or any key during a composition) are not recorded at all", downs(c2.events, 229) === 0 && downs(c2.events, 55) === 0,
    `${downs(c2.events, 229)} keydowns of 229, ${downs(c2.events, 55)} composing`);

  // ---- 3. text dropped into the field
  const before3 = checks.length;
  await drop(s, "dropped text");
  await sleep(800);
  const c3 = checks[checks.length - 1] || { events: [] };
  const pastes3 = c3.events.filter((e) => e.eventType === "paste");
  ok("3. text dropped into the field sends a check at once", checks.length === before3 + 1, `${checks.length - before3} checks`);
  ok("…carrying it as a paste of its length", pastes3.length === 2 && pastes3[pastes3.length - 1].pastedLength === 12, JSON.stringify(pastes3.map((e) => e.pastedLength)));
} catch (e) {
  bad++; console.log("  FAIL  " + (e && e.stack || e));
} finally {
  try { ws.close(); } catch (e) { /* closed */ }
  chrome.kill(); await sleep(300); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
