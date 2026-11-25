// End-to-end check of the SDK's mouse sample recorder in real headless Chrome.
//
// 2026-10-24 (the owner's step 0): until then a second flow ("+ train" pressed again) recorded the same movement beside
// the first and both saved it (two copies entered the owner's profile on 2026-09-19); a flow closed with × or covered by
// another popup went on saving samples in the background; and the wait for the model stopped at its first poll
// (document.body.contains does not see into the shadow root), so the last sample left a spinner that never ended.
// 2026-11-24: the pad asks for tasks (guard.js mouseTasks) in place of one dot. A robot here does each of them with real
// mouse input: a click, a double click, a drag.
//
// The SDK on a page served at the gateway's own origin, with its working copy (sdk/guard.js, sdk/js/*) in place of
// the deployed one, and every /v1/sdk/ call answered by this script, so nothing about a real user is needed.
//   0. the tasks: moving about without doing them saves nothing; four finished tasks and 55 windows save a sample; every
//      kind of task can be done; in Arabic the pad shows no English; the reset is offered only once a sample is on file
//   1. "+ train" pressed twice: one recorder, one sample at a time, and two samples never share movement
//   2. closed with ×: nothing more is recorded or sent; the same with "Done", and when another popup covers it
//   3. the last sample: the SDK waits for the model (polls the status) and then shows the trained profile
//   4. a trained profile: "+ train" shows the trained state and the reset, no pad, and sends nothing
//   5. the server answers already_enrolled to a sample: the recorder stops and the trained state shows
//   6. more samples for a trained profile (2026-11-25): "Add samples" asks for the passkey, takes the server's grant for
//      it, and the pad then sends four samples with the grant; the mouse is not judged while that pad is open; after the
//      fourth the model is rebuilt and the trained screen is back
//   7. the grant runs out before the samples are finished: the trained screen says so
//
//   node extension/scripts/e2e_headless_sdk_mouse.mjs [screenshot dir]     (GUARD_FILE=<path> tests another copy of guard.js)
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = process.argv[2] || path.join(os.tmpdir(), "continuum-mouse-tasks");
fs.mkdirSync(SHOTS, { recursive: true });
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080", PORT = 9373;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const GUARD = fs.readFileSync(process.env.GUARD_FILE || path.join(ROOT, "sdk", "guard.js"), "utf8");
const SDK_FILES = { "/js/mouse-features.js": "sdk/js/mouse-features.js", "/js/keystroke-tracker.js": "sdk/js/keystroke-tracker.js", "/js/guard-ar.js": "sdk/js/guard-ar.js",
  "/vendor/simplewebauthn/index.umd.min.js": "sdk/vendor/simplewebauthn/index.umd.min.js" };
const KINDS = ["dots", "chips", "word", "phrase", "slider", "seek", "line", "menu", "drop"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- what the "server" says, set by each step
let state, look = { lang: "en", theme: "light" };
const fresh = (over) => ({ enrolled: false, training: false, onFile: 0, statusPolls: 0, trainingPollsLeft: 0, enrolls: [], enrollAnswer: null,
  verifies: 0, topUps: [], grant: null, topUpAdded: 0, checks: 0, ...over });
function api(p, method, body) {
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: state.enrolled, keystrokeTraining: false };
  if (p === "/v1/sdk/lock/status") return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3,
    checkMinTextChars: 80, adaptiveEnabled: false, panel: "show", keystroke: "off", mouse: "on", onboardingMode: "lazy", excludeFieldTypes: ["hidden"],
    panelLanguage: look.lang, panelTheme: look.theme, managed: ["panelLanguage", "panelTheme"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: true, adaptiveEnabled: false };
  if (p === "/v1/sdk/mouse/status") {
    state.statusPolls++;
    if (state.training && state.trainingPollsLeft-- <= 0) { state.training = false; state.enrolled = true; }
    return { enrolled: state.enrolled, training: state.training, samplesOnFile: Math.min(8, state.onFile), samplesRequired: 8, sampleWindows: 55,
      totalWindows: state.onFile * 55, needWindows: 440, voteN: 60, voteK: 33, topUpSamples: 4, topUpAdded: state.topUpAdded };
  }
  // the passkey (the page's WebAuthn library is a stand-in here) and the grant it buys for a top-up, as the gateway
  if (p === "/v1/sdk/passkey/auth/options") return { challengeId: "c1", challenge: "x" };
  if (p === "/v1/sdk/passkey/auth/complete") { state.verifies++; return { verified: true, stepUpToken: "step-" + state.verifies }; }
  if (p === "/v1/sdk/mouse/topup") {
    state.topUps.push(body.stepUpToken || null);
    if (body.stepUpToken !== "step-" + state.verifies) return { __status: 403, error: "passkey_required" };
    state.grant = "grant-" + state.verifies;
    return { ok: true, topUpToken: state.grant, expiresInMs: 900000 };
  }
  if (p === "/v1/sdk/mouse/enroll") {
    state.enrolls.push({ windows: body.windows || [], at: Date.now(), topUpToken: body.topUpToken || null });
    if (state.enrollAnswer) return { ...state.enrollAnswer };
    if (state.enrolled) {   // a trained profile: a sample only with the grant, four of them rebuild the model
      if (!state.grant || body.topUpToken !== state.grant) return { __status: 409, ok: false, error: "already_enrolled" };
      state.topUpAdded++;
      if (state.topUpAdded < 4) return { ok: true, trained: true, topUp: { added: state.topUpAdded, needed: 4 } };
      state.topUpAdded = 0; state.training = true; state.trainingPollsLeft = 2;
      return { ok: true, trained: true, training: true, topUp: { added: 4, needed: 4 } };
    }
    state.onFile++;
    if (state.onFile >= 8) { state.training = true; return { ok: true, trained: false, training: true, samplesOnFile: 8, samplesRequired: 8, sampleWindows: 55, totalWindows: 440 }; }
    return { ok: true, trained: false, samplesOnFile: state.onFile, samplesRequired: 8, sampleWindows: 55, totalWindows: state.onFile * 55 };
  }
  if (p === "/v1/sdk/mouse/check") { state.checks++; return { ok: true, checked: false }; }
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
// The task on the pad: its kind, its number, and where its start (data-tk-a) and end (data-tk-b) are on the page.
const TASK = `(() => { const sh = ${SH}; const pad = sh && sh.querySelector('#cpad'); const st = pad && pad.querySelector('.tk-stage'); if (!st) return null;
  const c = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; };
  const all = (q) => [...st.querySelectorAll(q)].map(c);
  return { kind: st.getAttribute('data-kind'), seq: st.getAttribute('data-seq'), a: c(st.querySelector('[data-tk-a]')), b: c(st.querySelector('[data-tk-b]')),
    words: all('.tk-w'), chips: all('.tk-chip'), dot: c(st.querySelector('.pt')), say: pad.querySelector('.tk-say').textContent,
    pips: pad.querySelectorAll('.tk-n i.on').length, text: pad.textContent + ' ' + (sh.querySelector('#mdiag') || {}).textContent + ' ' + (sh.querySelector('.msamp') || {}).textContent }; })()`;
const RESET_SHOWN = `(() => { const r = (${SH}).querySelector('#mresetrow'); return !!r && getComputedStyle(r).display !== 'none'; })()`;
async function shot(s, name) {
  const r = await ev(s, `(() => { const ov = ${OPEN}; const c = ov && ov.querySelector('.card'); if (!c) return null; const b = c.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; })()`);
  const p = await send("Page.captureScreenshot", r ? { format: "png", clip: { ...r, scale: 1 } } : { format: "png" }, s);
  if (p && p.data) fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(p.data, "base64"));
}

const token = "x." + Buffer.from(JSON.stringify({ sub: "mouse-test-user" })).toString("base64url") + ".y";
const html = `<!doctype html><meta charset="utf-8"><title>mouse test</title><body style="height:2000px"><p>An organisation's page.</p>
  <script src="/guard.js" data-site-key="SK_MOUSE_TEST" data-session="${token}"></script>`;

let pos = { x: 640, y: 450 }, seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
// A random walk of steps of 4-29 px in every direction inside the window, one event per step: movement, no task.
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
// ---- the robot: real mouse input, as a person would do each task
const mouse = (s, type, extra = {}) => send("Input.dispatchMouseEvent", { type, x: Math.round(pos.x), y: Math.round(pos.y), ...extra }, s);
async function glide(s, x, y, held) {   // to (x, y) in steps of 5-13 px, a little off the straight line
  const sx = pos.x, sy = pos.y, n = Math.max(2, Math.round(Math.hypot(x - sx, y - sy) / (5 + rnd() * 8)));
  for (let i = 1; i <= n; i++) {
    const f = i / n, j = i < n ? 3 : 0;
    pos = { x: sx + (x - sx) * f + (rnd() - 0.5) * j, y: sy + (y - sy) * f + (rnd() - 0.5) * j };
    await mouse(s, "mouseMoved", held ? { button: "left", buttons: 1 } : {});
    if (i % 4 === 0) await sleep(4);
  }
}
const press = (s, n = 1) => mouse(s, "mousePressed", { button: "left", buttons: 1, clickCount: n });
const release = (s, n = 1) => mouse(s, "mouseReleased", { button: "left", buttons: 0, clickCount: n });
const click = async (s) => { await press(s); await sleep(30); await release(s); };
const drag = async (s, a, b) => { await glide(s, a.x, a.y); await press(s); await sleep(30); await glide(s, b.x, b.y, true); await sleep(30); await release(s); };
// Does the task on the pad; returns its kind once the pad has moved on to the next one, null otherwise.
async function doTask(s, before) {
  const k = await ev(s, TASK);
  if (!k || !k.kind) { await sleep(150); return null; }
  if (before) await before(k);
  if (k.kind === "dots") { for (let i = 0; i < 3; i++) { const d = ((await ev(s, TASK)) || {}).dot; if (!d) break; await glide(s, d.x, d.y); await click(s); await sleep(40); } }
  else if (k.kind === "chips") { for (const c of k.chips) { await glide(s, c.x, c.y); await click(s); await sleep(30); } }
  else if (k.kind === "word") { await glide(s, k.a.x, k.a.y); await press(s, 1); await release(s, 1); await sleep(40); await press(s, 2); await release(s, 2); }
  else if (k.kind === "phrase" || k.kind === "slider" || k.kind === "drop") await drag(s, k.a, k.b);
  else if (k.kind === "seek") { await glide(s, k.b.x, k.b.y); await click(s); }
  else if (k.kind === "line") { for (const w of k.words) await glide(s, w.x, w.y); }
  else if (k.kind === "menu") { await glide(s, k.a.x, k.a.y); await click(s); await sleep(150); const m = await ev(s, TASK); if (m && m.b) { await glide(s, m.b.x, m.b.y); await click(s); } }   // the pad may have closed meanwhile (a saved sample ended the flow)
  const moved = await waitFor(s, `(() => { const k = ${TASK}; return !k || k.seq !== ${JSON.stringify(k.seq)}; })()`, 3000);
  return moved ? k.kind : null;
}
// Does tasks until the SDK has sent `n` samples in all; returns how many tasks it took.
async function work(s, n, max = 40) {
  let did = 0;
  for (let i = 0; i < max && state.enrolls.length < n; i++) { if (await doTask(s)) did++; if (!(await ev(s, TASK))) break; }
  await sleep(900);
  return did;
}
// Two samples share movement when a run of 20 consecutive steps of one occurs in the other (lib/mouse.js REPEAT_RUN).
const runs = (windows) => { const r = new Set(); for (const w of windows) for (let i = 0; i + 20 <= w.length; i++) r.add(JSON.stringify(w.slice(i, i + 20))); return r; };
const shared = (a, b) => { const ra = runs(a), rb = runs(b); let n = 0; for (const x of rb) if (ra.has(x)) n++; return rb.size ? n / rb.size : 0; };
// The direction of the steps of saved samples (the model sees |dx| and |dy| only): sideways, slanted, up or down, in
// per cent, and the pixels travelled up and down in a window.
function geometry(enrolls) {
  const c = [0, 0, 0]; let vy = 0, n = 0;
  for (const e of enrolls) for (const w of e.windows) { n++; for (const [dx, dy] of w) { if (!dx && !dy) continue; const a = Math.atan2(dy, dx) * 180 / Math.PI; c[a < 22.5 ? 0 : a < 67.5 ? 1 : 2]++; vy += dy; } }
  const t = c[0] + c[1] + c[2] || 1;
  return { sideways: Math.round(100 * c[0] / t), slanted: Math.round(100 * c[1] / t), upDown: Math.round(100 * c[2] / t), upDownPx: Math.round(vy / (n || 1)) };
}

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  handlers.push((m) => {
    if (m.method !== "Fetch.requestPaused" || m.sessionId !== s) return;
    const { requestId, request } = m.params, url = new URL(request.url);
    const reply = (code, type, text) => send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(text).toString("base64") }, s);
    if (url.pathname === "/__mouse_test.html") return reply(200, "text/html; charset=utf-8", html);
    if (url.pathname === "/guard.js") return reply(200, "application/javascript; charset=utf-8", GUARD);
    // the passkey prompt itself cannot run in headless Chrome: the library that shows it is replaced by one that answers
    if (url.pathname === "/vendor/simplewebauthn/index.umd.min.js") return reply(200, "application/javascript; charset=utf-8",
      "window.SimpleWebAuthnBrowser = { startAuthentication: async () => ({ id: 'cred', response: {} }), startRegistration: async () => ({}) };");
    if (SDK_FILES[url.pathname]) return reply(200, "application/javascript; charset=utf-8", fs.readFileSync(path.join(ROOT, SDK_FILES[url.pathname]), "utf8"));
    let body = {}; try { body = request.postData ? JSON.parse(request.postData) : {}; } catch { /* not JSON */ }
    const out = api(url.pathname, request.method, body) || {}, code = out.__status || 200;
    delete out.__status;
    reply(code, "application/json", JSON.stringify(out));
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: GW + "/__mouse_test.html*" }, { urlPattern: GW + "/guard.js*" }, { urlPattern: GW + "/js/*" },
    { urlPattern: GW + "/vendor/*" }, { urlPattern: GW + "/v1/sdk/*" }] }, s);
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  const errors = [];
  handlers.push((m) => { if (m.sessionId === s && m.method === "Runtime.exceptionThrown") errors.push(((m.params.exceptionDetails || {}).exception || {}).description || (m.params.exceptionDetails || {}).text || "error"); });
  const ADD = 'button[title="Add mouse samples"], button[title="أضف عيّنات فأرة"]';
  const load = async (over) => {
    state = fresh(over);
    await send("Page.navigate", { url: GW + "/__mouse_test.html" }, s);
    await waitFor(s, `!!(${SH}) && !!(${SH}).querySelector(${JSON.stringify(ADD)})`, 20000);
    await sleep(1200);   // config, onboarding and the lock status come before the guard starts
  };
  const openPad = async () => { await clickIn(s, ADD); return waitFor(s, `!!(${SH}).querySelector('#cpad .tk-stage[data-kind]')`, 5000); };

  // ---- 0. the tasks
  await load();
  ok("0. the pad opens on a task", await openPad(), JSON.stringify(await ev(s, TASK)).slice(0, 120));
  await shot(s, "en-light-0-start");
  ok("…with nothing on file the reset is not offered (it would have nothing to delete)", (await ev(s, RESET_SHOWN)) === false);
  await move(s, 1300);   // more than two samples' worth of movement, and no task done
  ok("…moving about without doing the tasks saves nothing", state.enrolls.length === 0, `${state.enrolls.length} saved`);
  const seen = new Set(), failed = [];
  let did = 0, atFirstSave = 0;
  for (let i = 0; i < 30 && seen.size < KINDS.length; i++) {
    const kind = await doTask(s, async (k) => { if (!seen.has(k.kind)) await shot(s, "en-light-" + k.kind); });
    if (kind) { seen.add(kind); did++; } else failed.push(((await ev(s, TASK)) || {}).kind);
    await sleep(450);   // the recorder looks every 400 ms
    if (!atFirstSave && state.enrolls.length) atFirstSave = did;
  }
  ok("…the fourth finished task saves the sample (its windows were there already)", atFirstSave === 4, `saved after ${atFirstSave} tasks`);
  ok("…every kind of task can be done with real input", seen.size === KINDS.length && !failed.length, `done: ${[...seen].join(", ")}${failed.length ? "; not finished: " + failed.join(", ") : ""}`);
  ok("…and the reset is offered once a sample is on file", (await ev(s, RESET_SHOWN)) === true);
  ok("…each saved sample is 55 windows", state.enrolls.length >= 1 && state.enrolls.every((e) => e.windows.length === 55), state.enrolls.map((e) => e.windows.length).join(", "));
  await shot(s, "en-light-9-after");
  look = { lang: "ar", theme: "dark" };
  await load();
  await openPad();
  await shot(s, "ar-dark-0-start");
  const seenAr = new Set(), latin = [];
  for (let i = 0; i < 30 && seenAr.size < KINDS.length; i++) {
    const kind = await doTask(s, async (k) => {
      if (/[A-Za-z]{2,}/.test(k.text)) latin.push(k.kind + ": " + (k.text.match(/[A-Za-z]{2,}[A-Za-z ]*/) || [""])[0]);
      if (!seenAr.has(k.kind)) await shot(s, "ar-dark-" + k.kind);
    });
    if (kind) seenAr.add(kind);
  }
  const dirAr = await ev(s, `(() => { const ov = ${OPEN}; const c = ov && ov.querySelector('.card'); return c ? getComputedStyle(c).direction : ''; })()`);
  ok("…in Arabic every kind is done too, right to left, and the pad shows no English", seenAr.size === KINDS.length && dirAr === "rtl" && !latin.length,
    `${seenAr.size} kinds, direction ${dirAr}${latin.length ? ", English: " + latin.slice(0, 3).join(" | ") : ""}`);
  look = { lang: "en", theme: "light" };

  // ---- what the tasks ask of the pointer (2026-11-25). The first task pad ran sideways: 64% of the owner's steps on it
  // were sideways and 12% up or down, against 41% and 24% in his real use the same day. The robot moves in straight
  // lines, so its samples show what the tasks themselves ask for: on that pad 70% sideways, 8% up or down and 124 px up
  // and down a window; with the pad as tall as the window, list texts, upright bars and hops drawn by direction,
  // about 48%, 18% and 190 px.
  // Seven samples differ by which tasks came up (49 to 58% sideways in single rounds), so two rounds are read together
  // and only the sideways share is held to a limit, well between the two pads; the rest is reported.
  const robot = [];
  for (let round = 0; round < 2; round++) { await load(); await openPad(); await work(s, 7, 90); robot.push(...state.enrolls); }
  const g = geometry(robot);
  await shot(s, "en-light-layout");
  ok("…the tasks do not run sideways: the robot's steps go up, down and slanted too", robot.length >= 14 && g.sideways <= 62,
    `${robot.length} samples: ${g.sideways}% sideways, ${g.slanted}% slanted, ${g.upDown}% up or down, ${g.upDownPx} px up and down a window`);

  // ---- 1. "+ train" pressed twice
  await load();
  await clickIn(s, ADD);
  await openPad();
  await work(s, 1);
  ok("1. \"+ train\" pressed twice: one sample for one sample's work, not two", state.enrolls.length === 1, `${state.enrolls.length} saved`);
  await work(s, 2);
  ok("…the next tasks give the second sample", state.enrolls.length === 2, `${state.enrolls.length} saved`);
  const w0 = (state.enrolls[0] || {}).windows || [], w1 = (state.enrolls[1] || {}).windows || [];
  ok("…each is 55 windows, and the two share no movement", w0.length === 55 && w1.length === 55 && shared(w0, w1) === 0,
    `${w0.length} and ${w1.length} windows, ${(100 * shared(w0, w1)).toFixed(1)}% shared`);

  // ---- 2. closed with ×, with "Done", or covered by another popup
  await ev(s, `(() => { const ov = ${OPEN}; const x = ov && ov.querySelector('.wizx'); if (x) x.click(); return !!x; })()`);
  const n2 = state.enrolls.length;
  await work(s, n2 + 1, 6); await move(s, 1300);
  ok("2. closed with ×: nothing more is recorded or sent", state.enrolls.length === n2 && !(await wiz(s)), `${state.enrolls.length - n2} sent after closing`);
  await openPad();
  await doTask(s); await doTask(s);
  await clickIn(s, "#mdone");
  const n3 = state.enrolls.length;
  await move(s, 1300);
  ok("…closed with \"Done\": the same", state.enrolls.length === n3, `${state.enrolls.length - n3} sent after closing`);
  await openPad();
  await doTask(s); await doTask(s);
  await clickIn(s, 'button[title="Add typing samples"]');   // the typing popup takes the window
  await waitFor(s, `!(${SH}).querySelector('#cpad')`, 5000);
  const n4 = state.enrolls.length;
  await move(s, 1300);
  ok("…covered by another popup: the same", state.enrolls.length === n4, `${state.enrolls.length - n4} sent after it was covered`);

  // ---- 3. the last sample: wait for the model, then the trained state
  await load({ onFile: 7, trainingPollsLeft: 2 });
  await openPad();
  const polls0 = state.statusPolls;
  await work(s, 1);
  const trainedShown = await waitFor(s, `(${WIZ}) && (${WIZ}).title === 'Your mouse movement is trained'`, 15000);
  ok("3. the last sample: the SDK polls the status while the model is built", state.statusPolls - polls0 >= 3, `${state.statusPolls - polls0} status reads after the save`);
  ok("…and then shows the trained profile with the reset", trainedShown && !!(await wiz(s)).reset, JSON.stringify(await wiz(s)));
  const n5 = state.enrolls.length;
  await move(s, 700);
  ok("…and records nothing more", state.enrolls.length === n5, `${state.enrolls.length - n5} sent after the model was built`);

  // ---- 4. a trained profile
  await load({ enrolled: true, onFile: 8 });
  await clickIn(s, ADD);
  await waitFor(s, `!!(${WIZ})`, 5000);
  const w4 = await wiz(s);
  ok("4. trained: \"+ train\" shows the trained state and the reset, no pad", !!w4 && w4.title === "Your mouse movement is trained" && !w4.pad && w4.reset, JSON.stringify(w4));
  await move(s, 700);
  ok("…and sends nothing", state.enrolls.length === 0, `${state.enrolls.length} sent`);

  // ---- 5. the server says already_enrolled
  await load({ enrollAnswer: { __status: 409, ok: false, error: "already_enrolled" } });
  await openPad();
  await work(s, 1);
  await sleep(500);
  const w5 = await wiz(s);
  ok("5. already_enrolled from the server: the trained state shows", !!w5 && w5.title === "Your mouse movement is trained", JSON.stringify(w5));
  const n6 = state.enrolls.length;
  await move(s, 700);
  ok("…and the recorder has stopped", n6 === 1 && state.enrolls.length === n6, `${n6} then ${state.enrolls.length} sent`);

  // ---- 6. more samples for a trained profile
  const TRAINED = "Your mouse movement is trained";
  const trainedScreen = (s2) => waitFor(s2, `(${WIZ}) && (${WIZ}).title === '${TRAINED}' && !(${WIZ}).pad`, 15000);
  const openTopUp = async () => {
    await clickIn(s, ADD);
    await trainedScreen(s);
    const label = await ev(s, `(() => { const b = (${SH}).querySelector('#madd'); return b ? b.textContent : null; })()`);
    await clickIn(s, "#madd");
    const pad = await waitFor(s, `!!(${SH}).querySelector('#cpad[data-topup="mouse"] .tk-stage[data-kind]')`, 8000);
    return { label, pad };
  };
  await load({ enrolled: true, onFile: 8 });
  // the mouse switch of the panel (the second of the two switches): the loads above, with no profile, left it off, and
  // the SDK remembers the choice
  const MSW = `[...(${SH}).querySelectorAll('.tgl')].pop()`;
  // (on a slow machine the guard may not have started when the switch is first read: until a check is seen)
  for (let i = 0; i < 4 && state.checks === 0; i++) {
    if ((await ev(s, `(${MSW}).getAttribute('aria-checked')`)) !== "true") await ev(s, `(${MSW}).click(), true`);
    await move(s, 1300);
    await sleep(1800);
  }
  const judged = state.checks;   // the live guard checks this movement (the profile exists)
  const t6 = await openTopUp();
  ok("6. a trained profile offers \"Add samples\" beside the reset", t6.label === "Add samples", String(t6.label));
  ok("…pressing it asks for the passkey, takes the server's grant for it, and opens the pad", t6.pad && state.verifies === 1 && state.topUps.length === 1 && state.topUps[0] === "step-1",
    `pad ${t6.pad}, ${state.verifies} passkey, grant asked with ${JSON.stringify(state.topUps)}`);
  const head6 = await ev(s, `((${SH}).querySelector('#mhead') || {}).textContent`);
  ok("…which counts the top-up's own samples", head6 === "Extra sample 1 of 4", String(head6));
  await shot(s, "en-light-topup");
  const checks6 = state.checks;
  await work(s, 3, 60);
  const head6b = await ev(s, `((${SH}).querySelector('#mhead') || {}).textContent`);
  await work(s, 4, 60);
  const back6 = await trainedScreen(s);
  ok("…four samples go with the grant, one at a time", state.enrolls.length === 4 && state.enrolls.every((e) => e.topUpToken === "grant-1") && head6b === "Extra sample 4 of 4",
    `${state.enrolls.length} samples, grants ${[...new Set(state.enrolls.map((e) => e.topUpToken))].join(",")}, after three: ${head6b}`);
  ok("…the mouse is judged before the top-up and not while its pad is open", judged > 0 && state.checks === checks6, `${judged} checks before, ${state.checks - checks6} during`);
  ok("…after the fourth the model is rebuilt and the trained screen is back", back6, JSON.stringify(await wiz(s)));
  await clickIn(s, "#mdone");
  const checks6c = state.checks;
  await move(s, 1500);
  ok("…and the mouse is judged again once it is closed", state.checks > checks6c, `${state.checks - checks6c} checks`);

  // ---- 7. the grant runs out before the samples are finished
  await load({ enrolled: true, onFile: 8 });
  const t7 = await openTopUp();
  await work(s, 1, 30);
  state.grant = null;   // on the server the quarter of an hour is over
  await work(s, 2, 30);
  await trainedScreen(s);
  const note7 = await ev(s, `(() => { const ov = ${OPEN}; const e = ov && ov.querySelector('.card .e'); return e && getComputedStyle(e).display !== 'none' ? e.textContent : ''; })()`);
  ok("7. the grant ran out before the samples were finished: the trained screen says so", t7.pad && state.enrolls.length === 2 && /ran out/.test(note7), `${state.enrolls.length} sent; note: ${note7}`);
  ok("no script error on the page in the whole run", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  ok("run completed", false, e.message);
} finally {
  ws.close(); chrome.kill(); await sleep(400); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log("screenshots: " + SHOTS);
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
