// End-to-end check of the SDK's mouse sample recorder (2026-10-24, the owner's step 0) in real headless Chrome.
// Until then a second flow ("+ train" pressed again) recorded the same movement beside the first and both saved it
// (two copies entered the owner's profile on 2026-09-19); a flow closed with × or covered by another popup went on
// saving samples in the background; and the wait for the model stopped at its first poll (document.body.contains
// does not see into the shadow root), so the last sample left a spinner that never ended.
//
// The SDK on a page served at the gateway's own origin, with its working copy (sdk/guard.js, sdk/js/*) in place of
// the deployed one, and every /v1/sdk/ call answered by this script, so nothing about a real user is needed.
//   1. "+ train" pressed twice: one recorder, one sample per 55 windows, and two samples never share movement
//   2. closed with ×: nothing more is recorded or sent; the same with "Done", and when another popup covers it
//   3. the last sample: the SDK waits for the model (polls the status) and then shows the trained profile
//   4. a trained profile: "+ train" shows the trained state and the reset, no pad, and sends nothing
//   5. the server answers already_enrolled to a sample: the recorder stops and the trained state shows
//
//   node extension/scripts/e2e_headless_sdk_mouse.mjs            (GUARD_FILE=<path> tests another copy of guard.js)
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080", PORT = 9373;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const GUARD = fs.readFileSync(process.env.GUARD_FILE || path.join(ROOT, "sdk", "guard.js"), "utf8");
const SDK_FILES = { "/js/mouse-features.js": "sdk/js/mouse-features.js", "/js/keystroke-tracker.js": "sdk/js/keystroke-tracker.js",
  "/vendor/simplewebauthn/index.umd.min.js": "sdk/vendor/simplewebauthn/index.umd.min.js" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- what the "server" says, set by each step
let state;
const fresh = (over) => ({ enrolled: false, training: false, onFile: 0, statusPolls: 0, trainingPollsLeft: 0, enrolls: [], enrollAnswer: null, ...over });
function api(p, method, body) {
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: state.enrolled, keystrokeTraining: false };
  if (p === "/v1/sdk/lock/status") return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3,
    checkMinTextChars: 80, adaptiveEnabled: false, panel: "show", keystroke: "off", mouse: "on", onboardingMode: "lazy", managed: [], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: true, adaptiveEnabled: false };
  if (p === "/v1/sdk/mouse/status") {
    state.statusPolls++;
    if (state.training && state.trainingPollsLeft-- <= 0) { state.training = false; state.enrolled = true; }
    return { enrolled: state.enrolled, training: state.training, samplesOnFile: Math.min(8, state.onFile), samplesRequired: 8, sampleWindows: 55,
      totalWindows: state.onFile * 55, needWindows: 440, voteN: 60, voteK: 33 };
  }
  if (p === "/v1/sdk/mouse/enroll") {
    state.enrolls.push({ windows: body.windows || [], at: Date.now() });
    if (state.enrollAnswer) return { ...state.enrollAnswer };
    state.onFile++;
    if (state.onFile >= 8) { state.training = true; return { ok: true, trained: false, training: true, samplesOnFile: 8, samplesRequired: 8, sampleWindows: 55, totalWindows: 440 }; }
    return { ok: true, trained: false, samplesOnFile: state.onFile, samplesRequired: 8, sampleWindows: 55, totalWindows: state.onFile * 55 };
  }
  if (p === "/v1/sdk/mouse/check") return { ok: true, checked: false };
  return {};
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-mouse-"));
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
const WIZ = `(() => { const ov = ${OPEN}; const t = ov && ov.querySelector('.card .t');
  return t ? { title: t.textContent, pad: !!ov.querySelector('#cpad'), reset: !!ov.querySelector('#mreset') } : null; })()`;
const wiz = (s) => ev(s, WIZ);
const clickIn = (s, sel) => ev(s, `(() => { const b = (${SH}).querySelector(${JSON.stringify(sel)}); if (b) b.click(); return !!b; })()`);

const token = "x." + Buffer.from(JSON.stringify({ sub: "mouse-test-user" })).toString("base64url") + ".y";
const html = `<!doctype html><meta charset="utf-8"><title>mouse test</title><body style="height:2000px"><p>An organisation's page.</p>
  <script src="/guard.js" data-site-key="SK_MOUSE_TEST" data-session="${token}"></script>`;

// A random walk of steps of 4-29 px in every direction inside the window, one event per step.
let pos = { x: 640, y: 450 }, seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
async function move(s, n) {
  for (let i = 0; i < n; i++) {
    const a = rnd() * 2 * Math.PI, d = 4 + Math.floor(rnd() * 26);
    let x = pos.x + d * Math.cos(a), y = pos.y + d * Math.sin(a);
    if (x < 50 || x > 1230) x = pos.x - d * Math.cos(a);   // turn back at the edges, so every step moves
    if (y < 50 || y > 850) y = pos.y - d * Math.sin(a);
    pos = { x, y };
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(pos.x), y: Math.round(pos.y) }, s);
    if (i % 4 === 0) await sleep(4);
  }
  await sleep(900);   // the recorder looks every 400 ms; a save and its answer
}
// Move until the SDK has sent `n` samples in all (or give up after a few samples' worth of movement).
async function moveUntilSent(s, n) { for (let i = 0; i < 8 && state.enrolls.length < n; i++) await move(s, 200); }
// Two samples share movement when a run of 20 consecutive steps of one occurs in the other (lib/mouse.js REPEAT_RUN).
const runs = (windows) => { const r = new Set(); for (const w of windows) for (let i = 0; i + 20 <= w.length; i++) r.add(JSON.stringify(w.slice(i, i + 20))); return r; };
const shared = (a, b) => { const ra = runs(a), rb = runs(b); let n = 0; for (const x of rb) if (ra.has(x)) n++; return rb.size ? n / rb.size : 0; };

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  handlers.push((m) => {
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== s) return;
    const { requestId, request } = m.params, url = new URL(request.url);
    const reply = (code, type, text) => send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(text).toString("base64") }, s);
    if (url.pathname === "/__mouse_test.html") return reply(200, "text/html; charset=utf-8", html);
    if (url.pathname === "/guard.js") return reply(200, "application/javascript", GUARD);
    if (SDK_FILES[url.pathname]) return reply(200, "application/javascript", fs.readFileSync(path.join(ROOT, SDK_FILES[url.pathname]), "utf8"));
    let body = {}; try { body = request.postData ? JSON.parse(request.postData) : {}; } catch { /* not JSON */ }
    const out = api(url.pathname, request.method, body) || {}, code = out.__status || 200;
    delete out.__status;
    reply(code, "application/json", JSON.stringify(out));
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: GW + "/__mouse_test.html*" }, { urlPattern: GW + "/guard.js*" }, { urlPattern: GW + "/js/*" },
    { urlPattern: GW + "/vendor/*" }, { urlPattern: GW + "/v1/sdk/*" }] }, s);
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  const load = async (over) => {
    state = fresh(over);
    await send("Page.navigate", { url: GW + "/__mouse_test.html" }, s);
    await waitFor(s, `!!(${SH}) && !!(${SH}).querySelector('button[title="Add mouse samples"]')`, 20000);
    await sleep(1200);   // config, onboarding and the lock status come before the guard starts
  };

  // ---- 1. "+ train" pressed twice
  await load();
  await clickIn(s, 'button[title="Add mouse samples"]');
  await clickIn(s, 'button[title="Add mouse samples"]');
  await waitFor(s, `!!(${SH}).querySelector('#cpad')`, 5000);
  await move(s, 640);
  ok("1. \"+ train\" pressed twice: one sample for one sample's movement, not two", state.enrolls.length === 1, `${state.enrolls.length} saved`);
  await move(s, 640);
  ok("…the next sample's movement gives the second sample", state.enrolls.length === 2, `${state.enrolls.length} saved`);
  const w0 = (state.enrolls[0] || {}).windows || [], w1 = (state.enrolls[1] || {}).windows || [];
  ok("…each is 55 windows, and the two share no movement", w0.length === 55 && w1.length === 55 && shared(w0, w1) === 0,
    `${w0.length} and ${w1.length} windows, ${(100 * shared(w0, w1)).toFixed(1)}% shared`);

  // ---- 2. closed with ×, with "Done", or covered by another popup
  await ev(s, `(() => { const ov = ${OPEN}; const x = ov && ov.querySelector('.wizx'); if (x) x.click(); return !!x; })()`);
  const n2 = state.enrolls.length;
  await move(s, 1300);
  ok("2. closed with ×: nothing more is recorded or sent", state.enrolls.length === n2 && !(await wiz(s)), `${state.enrolls.length - n2} sent after closing`);
  await clickIn(s, 'button[title="Add mouse samples"]');
  await waitFor(s, `!!(${SH}).querySelector('#cpad')`, 5000);
  await move(s, 200);
  await clickIn(s, "#mdone");
  const n3 = state.enrolls.length;
  await move(s, 1300);
  ok("…closed with \"Done\": the same", state.enrolls.length === n3, `${state.enrolls.length - n3} sent after closing`);
  await clickIn(s, 'button[title="Add mouse samples"]');
  await waitFor(s, `!!(${SH}).querySelector('#cpad')`, 5000);
  await move(s, 200);
  await clickIn(s, 'button[title="Add typing samples"]');   // the typing popup takes the window
  await waitFor(s, `!(${SH}).querySelector('#cpad')`, 5000);
  const n4 = state.enrolls.length;
  await move(s, 1300);
  ok("…covered by another popup: the same", state.enrolls.length === n4, `${state.enrolls.length - n4} sent after it was covered`);

  // ---- 3. the last sample: wait for the model, then the trained state
  await load({ onFile: 7, trainingPollsLeft: 2 });
  await clickIn(s, 'button[title="Add mouse samples"]');
  await waitFor(s, `!!(${SH}).querySelector('#cpad')`, 5000);
  const polls0 = state.statusPolls;
  await move(s, 640);
  const trainedShown = await waitFor(s, `(${WIZ}) && (${WIZ}).title === 'Your mouse movement is trained'`, 15000);
  ok("3. the last sample: the SDK polls the status while the model is built", state.statusPolls - polls0 >= 3, `${state.statusPolls - polls0} status reads after the save`);
  ok("…and then shows the trained profile with the reset", trainedShown && !!(await wiz(s)).reset, JSON.stringify(await wiz(s)));
  const n5 = state.enrolls.length;
  await move(s, 700);
  ok("…and records nothing more", state.enrolls.length === n5, `${state.enrolls.length - n5} sent after the model was built`);

  // ---- 4. a trained profile
  await load({ enrolled: true, onFile: 8 });
  await clickIn(s, 'button[title="Add mouse samples"]');
  await waitFor(s, `!!(${WIZ})`, 5000);
  const w4 = await wiz(s);
  ok("4. trained: \"+ train\" shows the trained state and the reset, no pad", !!w4 && w4.title === "Your mouse movement is trained" && !w4.pad && w4.reset, JSON.stringify(w4));
  await move(s, 700);
  ok("…and sends nothing", state.enrolls.length === 0, `${state.enrolls.length} sent`);

  // ---- 5. the server says already_enrolled
  await load({ enrollAnswer: { __status: 409, ok: false, error: "already_enrolled" } });
  await clickIn(s, 'button[title="Add mouse samples"]');
  await waitFor(s, `!!(${SH}).querySelector('#cpad')`, 5000);
  await moveUntilSent(s, 1);
  await sleep(500);
  const w5 = await wiz(s);
  ok("5. already_enrolled from the server: the trained state shows", !!w5 && w5.title === "Your mouse movement is trained", JSON.stringify(w5));
  const n6 = state.enrolls.length;
  await move(s, 700);
  ok("…and the recorder has stopped", n6 === 1 && state.enrolls.length === n6, `${n6} then ${state.enrolls.length} sent`);
} catch (e) {
  ok("run completed", false, e.message);
} finally {
  ws.close(); chrome.kill(); await sleep(400); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
