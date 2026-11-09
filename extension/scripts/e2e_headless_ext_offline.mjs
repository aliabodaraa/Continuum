// End-to-end check of the extension when the Continuum server cannot be reached (2026-11-03) in real headless Chrome
// with the working copy of the extension loaded. Before this, the icon's bars kept filling with the server stopped
// (the pages collected movement that nothing would ever check), a stale "it's you" could stay on, and the popup could
// say "Protected". A gateway is simulated by this script at http://gw.test; "down" makes every request to it fail
// as a refused connection.
//   1. the server up: movement fills the mouse bar and a check gives a verdict
//   2. the server down: the next check fails, the worker goes offline: the verdict is dropped, the pages stop
//      collecting (progress back to 0, no more checks), the icon shows the logo off with "!", the popup says the page
//      is not protected, and a probe is scheduled
//   3. the worker stopped while offline (Chrome does this after ~30 s idle): it comes back offline, nothing collected
//   4. the server back: the probe sees it, collecting resumes and checks give verdicts again
//   5. the organisation turns the mouse off: its bar is empty ("off"), its movement is not collected; back on, it is
//   6. the mouse model cannot score (ca-service answers 503 model_unavailable, 2026-11-08): the worker stays online,
//      only the mouse is marked unavailable, its verdict is dropped, the page keeps collecting; the model back, a
//      verdict again. Before, this 503 took the whole extension offline, typing with it.
//   7. probation after a step-up survives the worker's idle stop (2026-11-08): a suspicious scored verdict after the
//      restart still locks at once. Before, the flag lived only in a variable and the first idle stop ended it.
//
//   node extension/scripts/e2e_headless_ext_offline.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = path.join(ROOT, "extension");
const GW = "http://gw.test", SITE = "http://site.test", PORT = 9381;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- the simulated gateway
const state = { down: false, checks: 0, refused: 0, mouseOn: true, mouseModel: true, unavailable: 0, suspicious: false };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = "x." + b64u({ sub: 78, sk: "SK_EXT" }) + ".y";
function api(p) {
  if (p === "/health") return { ok: true };
  if (p === "/v1/sdk/session") return { token: TOKEN, userId: 78, onboarding: { passkey: true, keystroke: true, mouse: true } };
  if (p === "/v1/sdk/onboarding") return { passkey: true, keystroke: true, mouse: true, keystrokeTraining: false };
  if (p === "/v1/sdk/lock/status") return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, sampleFloorWindows: 3,
    checkMinTextChars: 80, adaptiveEnabled: false, panel: "hide", keystroke: "on", mouse: state.mouseOn ? "on" : "off", onboardingMode: "eager", managed: [], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/check") return { ok: true, checked: false };
  if (p === "/v1/sdk/mouse/check") {
    // what ca-service answers (and the gateway relays) when the model cannot score: no verdict
    if (!state.mouseModel) { state.unavailable++; return { status: 503, body: { ok: false, error: "model_unavailable", retryable: true } }; }
    state.checks++;
    if (state.suspicious) return { ok: true, checked: true, warmup: false, isSuspicious: true, requiresPasskeyChallenge: false, windowCount: 60, lowWindows: 40,
      bufferMax: 60, lockAt: 33, meanScore: 0.2, riskToken: "rt" };
    return { ok: true, checked: true, warmup: false, isSuspicious: false, requiresPasskeyChallenge: false, windowCount: 60, lowWindows: 5,
      bufferMax: 60, lockAt: 33, meanScore: 0.7, riskToken: "rt" };
  }
  return {};
}
const SITE_PAGE = `<!doctype html><meta charset="utf-8"><title>a website</title><body style="height:2000px;margin:0"><p>An ordinary website.</p></body>`;

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ext-offline-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`, "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), errors = [];
const sessions = new Map();   // sessionId -> targetInfo
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const reply = (s, requestId, code, type, body) => send("Fetch.fulfillRequest", { requestId, responseCode: code, body: Buffer.from(body).toString("base64"),
  responseHeaders: [{ name: "Content-Type", value: type }, { name: "Access-Control-Allow-Origin", value: "*" },
    { name: "Access-Control-Allow-Headers", value: "*" }, { name: "Access-Control-Allow-Methods", value: "*" }] }, s);
async function prepare(s, info, waiting) {
  sessions.set(s, info);
  await send("Fetch.enable", { patterns: [{ urlPattern: GW + "/*" }, { urlPattern: SITE + "/*" }] }, s);
  await send("Runtime.enable", {}, s);
  if (waiting) await send("Runtime.runIfWaitingForDebugger", {}, s);
}
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); return; }
  if (m.method === "Target.attachedToTarget") { prepare(m.params.sessionId, m.params.targetInfo, m.params.waitingForDebugger); return; }
  if (m.method === "Target.detachedFromTarget") { sessions.delete(m.params.sessionId); return; }
  if (m.method === "Runtime.exceptionThrown") { errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); return; }
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params, u = new URL(request.url);
  if (u.origin === SITE) { reply(m.sessionId, requestId, 200, "text/html; charset=utf-8", SITE_PAGE); return; }
  if (state.down) { state.refused++; send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }, m.sessionId); return; }
  if (request.method === "OPTIONS") { reply(m.sessionId, requestId, 204, "text/plain", ""); return; }
  const out = api(u.pathname);
  if (out && out.status && out.body) { reply(m.sessionId, requestId, out.status, "application/json", JSON.stringify(out.body)); return; }
  reply(m.sessionId, requestId, 200, "application/json", JSON.stringify(out));
});
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(s, expr)) return true; } catch { /* navigating */ } await sleep(200); } return false; };
const findSession = (pred) => { let last = null; for (const [s, t] of sessions) if (pred(t)) last = s; return last; };
async function waitSession(pred, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = findSession(pred); if (s) return s; await sleep(200); } return null; }
const isSW = (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://");
const sw = () => findSession(isSW);
// The worker's view, read in its own context.
async function W(expr) { const s = await waitSession(isSW); return s ? ev(s, expr) : undefined; }
const status = async (tab) => JSON.parse((await W(`JSON.stringify(statusObj(${tab}))`)) || "null");
const icon = (tab) => W(`Promise.all([new Promise((r) => chrome.action.getTitle({ tabId: ${tab} }, r)), new Promise((r) => chrome.action.getBadgeText({ tabId: ${tab} }, r))])`);
const progress = async (tab) => (await W(`JSON.stringify((typeof tabProgress !== "undefined" && tabProgress[${tab}]) || { ks: 0, mouse: 0 })`)) || "{}";
const alarm = () => W(`new Promise((r) => chrome.alarms.get(PROBE_ALARM, (a) => r(!!a)))`);
const stored = () => W(`new Promise((r) => chrome.storage.local.get("cg_offline", (d) => r(!!(d && d.cg_offline))))`);

let pos = { x: 640, y: 450 }, seed = 5;
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
  await sleep(1000);
}

try {
  // the extension's worker, then a signed-in account (as after the sign-in), then a website
  let swT = null;
  for (let i = 0; i < 80 && !swT; i++) { const { targetInfos } = await send("Target.getTargets"); swT = targetInfos.find(isSW); if (!swT) await sleep(250); }
  const extId = new URL(swT.url).host;
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const { sessionId: sw0 } = await send("Target.attachToTarget", { targetId: swT.targetId, flatten: true });
  await prepare(sw0, swT, false);
  await ev(sw0, `new Promise((r) => chrome.storage.local.set({ cg_account: { gateway: "${GW}", siteKey: "SK_EXT", kind: "personal", label: "test",
    userId: 78, refreshToken: "rt", onboarding: { passkey: true, keystroke: true, mouse: true }, linkedAt: new Date().toISOString() } }, () => r(true)))`);
  await sleep(500);
  await send("Target.createTarget", { url: SITE + "/page.html" });
  const site = await waitSession((t) => t.type === "page" && t.url.startsWith(SITE));
  const siteTarget = sessions.get(site).targetId;
  // Input reaches only the tab in front: after a popup page, the website is brought back before moving.
  const front = async (closeSession) => {
    if (closeSession && sessions.get(closeSession)) await send("Target.closeTarget", { targetId: sessions.get(closeSession).targetId });
    await send("Target.activateTarget", { targetId: siteTarget });
    await sleep(500);
  };
  await waitFor(site, "document.readyState === 'complete'", 10000);
  await sleep(1500);
  const tab = await W(`new Promise((r) => chrome.tabs.query({ url: "${SITE}/*" }, (t) => r(t[0] && t[0].id)))`);

  // ---- 1. the server up
  for (let i = 0; i < 10 && state.checks === 0; i++) await move(site, 150);
  await sleep(500);
  let st = await status(tab);
  ok("1. the server up: movement fills the bar and a check gives a verdict", state.checks > 0 && st.mouseVerdict && st.mouseVerdict.status === "genuine" && !st.offline,
    `${state.checks} checks, verdict ${st.mouseVerdict && st.mouseVerdict.status}`);

  // ---- 2. the server down
  state.down = true;
  const checksBefore = state.checks;
  for (let i = 0; i < 6 && !(await status(tab)).offline; i++) await move(site, 60);
  await sleep(900);   // the pages' progress is reported at most every 300 ms
  st = await status(tab);
  ok("2. the server down: the next check fails and the worker goes offline", !!st.offline && /Can't reach Continuum/.test(st.error || ""), JSON.stringify(st.offline));
  ok("…the last verdict is dropped (no stale \"it's you\")", !st.mouseVerdict && !st.verdict, JSON.stringify(st.mouseVerdict));
  ok("…the page stopped collecting: the bars are back to 0", (await progress(tab)) === JSON.stringify({ ks: 0, mouse: 0 }), await progress(tab));
  const refusedAfter = state.refused;
  await move(site, 400);
  ok("…more movement collects nothing and sends nothing", (await progress(tab)) === JSON.stringify({ ks: 0, mouse: 0 }) && state.checks === checksBefore,
    `progress ${await progress(tab)}, ${state.refused - refusedAfter} more requests tried`);
  const [title2, badge2] = (await icon(tab)) || [];
  ok("…the icon: the logo off with \"!\", and its title says the page is not protected", badge2 === "!" && /can't reach Continuum/.test(title2 || ""), `${badge2} · ${title2}`);
  ok("…a probe is scheduled, and the state is kept for a restarted worker", (await alarm()) === true && (await stored()) === true);
  await send("Target.createTarget", { url: `chrome-extension://${extId}/src/popup/popup.html` });
  const pop = await waitSession((t) => t.type === "page" && t.url.includes("/popup/popup.html"));
  await waitFor(pop, "document.getElementById('verdict') && document.getElementById('verdict').textContent.length > 0", 8000);
  const banner = await ev(pop, "document.getElementById('verdict').textContent");
  ok("…the popup says nothing is checked, not \"Protected\"", /Can't reach Continuum/.test(banner || "") && !/Protected|It's you/.test(banner || ""), banner);
  await front(pop);

  // ---- 3. the worker stopped while offline
  const { targetInfos: t3 } = await send("Target.getTargets");
  const swNow = t3.find(isSW);
  const stopped = swNow ? (await send("Target.closeTarget", { targetId: swNow.targetId })).success : false;
  await sleep(800);
  await send("Target.createTarget", { url: `chrome-extension://${extId}/src/popup/popup.html` });   // its status poll wakes the worker
  await sleep(2500);
  const pop3 = findSession((t) => t.type === "page" && t.url.includes("/popup/popup.html"));
  st = await status(tab);
  await front(pop3);
  ok("3. the worker stopped while offline: it comes back offline", stopped && !!st.offline, `stopped ${stopped}, offline ${JSON.stringify(st.offline)}`);
  const checks3 = state.checks;
  await move(site, 400);
  ok("…and the page still collects and sends nothing", state.checks === checks3 && (await progress(tab)) === JSON.stringify({ ks: 0, mouse: 0 }), await progress(tab));

  // ---- 4. the server back
  state.down = false;
  await W("probeGateway()");   // what the 30-s alarm does
  await sleep(800);
  st = await status(tab);
  ok("4. the server back: the probe sees it and the worker is online", !st.offline && !st.error, JSON.stringify(st.offline));
  ok("…the probe is cancelled and the stored state removed", (await alarm()) === false && (await stored()) === false);
  const checks4 = state.checks;
  for (let i = 0; i < 10 && state.checks === checks4; i++) await move(site, 150);
  await sleep(500);
  st = await status(tab);
  ok("…collecting resumed and a check gives a verdict again", state.checks > checks4 && st.mouseVerdict && st.mouseVerdict.status === "genuine", `${state.checks - checks4} new checks`);
  const [title4, badge4] = (await icon(tab)) || [];
  ok("…the icon shows the bars again", badge4 === "" && /mouse: it's you/.test(title4 || ""), `${badge4} · ${title4}`);

  // ---- 5. the organisation turns the mouse off
  state.mouseOn = false;
  await W("refreshOrgConfig()");
  await sleep(1200);
  st = await status(tab);
  const checks5 = state.checks;
  await move(site, 400);
  ok("5. the organisation turns the mouse off: its movement is not collected or sent", st.disabled.mouse === true && state.checks === checks5
    && JSON.parse(await progress(tab)).mouse === 0, `disabled ${st.disabled.mouse}, progress ${await progress(tab)}`);
  st = await status(tab);
  ok("…its bar is empty and says off", st.bars && st.bars.mouse === "off (organisation setting)", st.bars && st.bars.mouse);
  state.mouseOn = true;
  await W("refreshOrgConfig()");
  await sleep(1200);
  await move(site, 300);
  ok("…switched back on, the movement is collected again", JSON.parse(await progress(tab)).mouse > 0, await progress(tab));

  // ---- 6. the mouse model cannot score
  state.mouseModel = false;
  const u6 = state.unavailable;
  for (let i = 0; i < 10 && state.unavailable === u6; i++) await move(site, 150);
  await sleep(900);
  st = await status(tab);
  ok("6. the mouse model cannot score: the worker stays online, no probe", state.unavailable > u6 && !st.offline && (await alarm()) === false,
    `${state.unavailable - u6} answers 503, offline ${JSON.stringify(st.offline)}`);
  ok("…only the mouse is marked unavailable, and its verdict is dropped", st.unavailable && st.unavailable.mouse === true && st.unavailable.keystroke === false
    && !st.mouseVerdict, `${JSON.stringify(st.unavailable)}, verdict ${JSON.stringify(st.mouseVerdict)}`);
  const u6b = state.unavailable;
  await move(site, 300);
  ok("…the page keeps collecting and checking", JSON.parse(await progress(tab)).mouse > 0 && state.unavailable > u6b,
    `progress ${await progress(tab)}, ${state.unavailable - u6b} more checks`);
  await send("Target.createTarget", { url: `chrome-extension://${extId}/src/popup/popup.html` });
  const pop6 = await waitSession((t) => t.type === "page" && t.url.includes("/popup/popup.html"));
  await waitFor(pop6, "document.getElementById('mouse') && document.getElementById('mouse').textContent.length > 0", 8000);
  const row6 = await ev(pop6, "document.getElementById('mouse').textContent"), banner6 = await ev(pop6, "document.getElementById('verdict').textContent");
  ok("…the popup's mouse row says it is not checked, and the banner is not \"Can't reach\"", /model unavailable/.test(row6 || "") && !/Can't reach/.test(banner6 || ""),
    `${row6} · ${banner6}`);
  await front(pop6);
  state.mouseModel = true;
  await W("probeGateway()");   // a no-op when online (an older worker went offline here)
  await sleep(800);
  const c6 = state.checks;
  for (let i = 0; i < 10 && state.checks === c6; i++) await move(site, 150);
  await sleep(500);
  st = await status(tab);
  ok("…the model back: the next check gives a verdict and clears the mark", state.checks > c6 && st.mouseVerdict && st.mouseVerdict.status === "genuine"
    && (st.unavailable || {}).mouse === false, `${state.checks - c6} new checks, ${JSON.stringify(st.unavailable)}`);

  // ---- 7. probation survives the worker's idle stop (what cg:verified sets after a passed step-up)
  // First let the last step's checks finish: a clean verdict ends probation by design, so one arriving just after the
  // line below made this step fail now and then on a busy machine.
  for (let last = -1; last !== state.checks;) { last = state.checks; await sleep(2500); }
  await W("probation = true; persistProgress(true); true");
  await sleep(300);
  const { targetInfos: t7 } = await send("Target.getTargets");
  const sw7 = t7.find(isSW);
  const stopped7 = sw7 ? (await send("Target.closeTarget", { targetId: sw7.targetId })).success : false;
  await sleep(800);
  await send("Target.createTarget", { url: `chrome-extension://${extId}/src/popup/popup.html` });   // wakes the worker
  await sleep(2500);
  const pop7 = findSession((t) => t.type === "page" && t.url.includes("/popup/popup.html"));
  await front(pop7);
  ok("7. probation survives the worker's stop", stopped7 && (await W("probation")) === true, `stopped ${stopped7}, probation ${await W("probation")}`);
  state.suspicious = true;
  const c7 = state.checks;
  for (let i = 0; i < 10 && state.checks === c7; i++) await move(site, 150);
  await sleep(800);
  st = await status(tab);
  ok("…a suspicious scored verdict after the restart locks at once, without the server asking", state.checks > c7 && st.locked === true && st.lockReason === "mouse",
    `${state.checks - c7} checks, locked ${st.locked} (${st.lockReason})`);
  ok("no script error in the extension or the pages", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  ok("run completed", false, e.stack || e.message);
} finally {
  ws.close(); chrome.kill(); await sleep(400); try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
