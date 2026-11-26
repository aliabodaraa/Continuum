// Buttons whose action could not be carried out (the review of 2026-11-25), in the popup, the settings page and the lock
// overlay, in real headless Chrome with the working copy of the extension loaded. A gateway is simulated by this script
// (every request to http://gw.test is answered here), so nothing real is touched. The worker's side of the same fixes is
// unit_worker_buttons.mjs.
//   1. the organisation turned the mouse off and the mouse is not enrolled: no "Finish enrolment" (the enrolment page skips
//      a channel that is off, so the button stayed for good); switched back on, the button is there
//   2. locked: no "Finish enrolment" (the page asked for the passkey, then the lock again), and "Sign out" is off with the
//      reason (signing out is refused while locked); unlocked, both are back. The study's "Save study settings" is off
//      too (2026-11-26): saved, they changed who the user is and the lock went with it, whatever was typed in the fields
//   3. the server cannot be reached: no "Finish enrolment" (the page cannot load)
//   4. "Exclude this site" only on a page that is recorded: not on the extension's own pages nor on the gateway's
//   5. study mode on: the display switch "Show the live verdict" is off with a note (the study's own switch decides)
//   6. the study's "Open enrolment page" with study mode off: says to save first, opens nothing (it opened the page of
//      the account signed in above)
//   7. locked with a dead sign-in: the overlay's "Verify with passkey" says the sign-in expired and offers "Sign in again",
//      which opens the sign-in; the settings page offers it too
//   8. "Test connection" at another address than the gateway's own (its publicUrl): says which address to use (the
//      sign-in page refuses any other at its first step, without naming the right one)
//
//   node extension/scripts/e2e_headless_ext_buttons.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = process.env.EXT_ROOT || path.join(ROOT, "extension");
const GW = "http://gw.test", SITE = "http://site.test", PORT = 9400;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- the simulated gateway
const state = { mouseOn: true, dead: false, down: false, publicUrl: GW };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = "x." + b64u({ sub: 78, sk: "SK_EXT" }) + ".y";
const ONBOARDING = { passkey: true, keystroke: true, mouse: false, keystrokeTraining: false };   // the mouse not enrolled
function api(p) {
  if (p === "/health") return { ok: true, service: "gateway" };
  if (p === "/v1/console/config") return { publicUrl: state.publicUrl };
  if (p === "/v1/sdk/session") return state.dead ? { status: 401, body: { error: "invalid_refresh_token" } } : { token: TOKEN, userId: 78, onboarding: ONBOARDING };
  if (p === "/v1/sdk/onboarding") return ONBOARDING;
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, checkMinTextChars: 80, panel: "hide",
    keystroke: "on", mouse: state.mouseOn ? "on" : "off", onboardingMode: "eager", managed: [], excludeFieldTypes: ["hidden"] };
  if (p === "/v1/sdk/keystroke/check") return { ok: true, checked: false };
  if (p === "/v1/sdk/mouse/check") return { ok: true, checked: false, enrolled: false };
  return {};
}
const SITE_PAGE = `<!doctype html><meta charset="utf-8"><title>a website</title><body style="height:2000px;margin:0"><p>An ordinary website.</p></body>`;
const GW_PAGE = `<!doctype html><meta charset="utf-8"><title>gateway page</title><body><p>The gateway's sign-in (simulated).</p></body>`;

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ext-buttons-"));
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
  if (state.down) { send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }, m.sessionId); return; }
  if (request.method === "OPTIONS") { reply(m.sessionId, requestId, 204, "text/plain", ""); return; }
  if (u.pathname.endsWith(".html")) { reply(m.sessionId, requestId, 200, "text/html; charset=utf-8", GW_PAGE); return; }
  const out = api(u.pathname);
  if (out && out.status && out.body) { reply(m.sessionId, requestId, out.status, "application/json", JSON.stringify(out.body)); return; }
  reply(m.sessionId, requestId, 200, "application/json", JSON.stringify(out));
});
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(s, expr)) return true; } catch { /* navigating */ } await sleep(200); } return false; };
const findSession = (pred) => { let last = null; for (const [s, t] of sessions) if (pred(t)) last = s; return last; };
async function waitSession(pred, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const s = findSession(pred); if (s) return s; await sleep(200); } return null; }
const isSW = (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://");
async function W(expr) { const s = await waitSession(isSW); return s ? ev(s, expr) : undefined; }
const targets = async () => (await send("Target.getTargets")).targetInfos;
const shown = (id) => `(() => { const e = document.getElementById(${JSON.stringify(id)}); return !!e && e.style.display !== 'none' && !e.classList.contains('hidden'); })()`;

try {
  // the extension's worker, then a signed-in account whose mouse is not enrolled, then a website
  let swT = null;
  for (let i = 0; i < 80 && !swT; i++) { swT = (await targets()).find(isSW); if (!swT) await sleep(250); }
  const extId = new URL(swT.url).host;
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const { sessionId: sw0 } = await send("Target.attachToTarget", { targetId: swT.targetId, flatten: true });
  await prepare(sw0, swT, false);
  await ev(sw0, `new Promise((r) => chrome.storage.local.set({ cg_account: { gateway: "${GW}", siteKey: "SK_EXT", kind: "personal", label: "test",
    userId: 78, refreshToken: "rt", onboarding: ${JSON.stringify(ONBOARDING)}, linkedAt: new Date().toISOString() } }, () => r(true)))`);
  await sleep(500);
  await send("Target.createTarget", { url: SITE + "/page.html" });
  const site = await waitSession((t) => t.type === "page" && t.url.startsWith(SITE));
  await waitFor(site, `location.href.startsWith("${SITE}") && document.readyState === 'complete'`, 10000);
  await send("Target.createTarget", { url: `chrome-extension://${extId}/src/popup/popup.html` });
  const pop = await waitSession((t) => t.type === "page" && t.url.includes("/popup/popup.html"));
  await send("Target.createTarget", { url: `chrome-extension://${extId}/src/options.html` });
  const opt = await waitSession((t) => t.type === "page" && t.url.includes("/src/options.html"));
  await waitFor(pop, shown("mainPanel"), 8000);
  await waitFor(opt, shown("signedIn"), 8000);
  await W("refreshOrgConfig(); true");
  await sleep(2500);
  const control = (await ev(pop, shown("enrolBtn"))) && (await ev(opt, shown("enrolBtn")));
  ok("0. the mouse is on and not enrolled: \"Finish enrolment\" is offered in the popup and the settings (the control)", control);

  // ---- 1. the organisation turns the mouse off
  state.mouseOn = false;
  await W("refreshOrgConfig(); true");
  await sleep(2500);
  ok("1. the mouse turned off by the organisation: no \"Finish enrolment\" in the popup nor in the settings",
    (await ev(pop, shown("enrolBtn"))) === false && (await ev(opt, shown("enrolBtn"))) === false, `disabled: ${JSON.stringify(await W("JSON.stringify(state.disabled)"))}`);
  state.mouseOn = true;
  await W("refreshOrgConfig(); true");
  await sleep(2500);
  ok("…switched back on: offered again", (await ev(pop, shown("enrolBtn"))) && (await ev(opt, shown("enrolBtn"))));

  // ---- 2. locked
  await W("engageLock('keystroke'); true");
  await sleep(2500);
  ok("2. locked: no \"Finish enrolment\" in the popup nor in the settings", (await ev(pop, shown("enrolBtn"))) === false && (await ev(opt, shown("enrolBtn"))) === false);
  const out = await ev(opt, "({ disabled: document.getElementById('signOutBtn').disabled, note: document.getElementById('lockNote').textContent })");
  ok("…\"Sign out\" is off and says why", out && out.disabled === true && /locked/.test(out.note), JSON.stringify(out));
  // the study's settings: any text in the fields, saved, made the "user" someone else and the lock went with the account
  await ev(opt, `document.getElementById('studyBox').open = true; document.getElementById('studyOn').checked = true; document.getElementById('studyGateway').value = "${GW}";
    document.getElementById('studyKey').value = "anything"; document.getElementById('studyParticipant').value = "P09"; true`);
  const st2 = await ev(opt, "({ disabled: document.getElementById('studySave').disabled, note: (document.getElementById('studyLockNote') || {}).textContent || '' })");
  await ev(opt, "document.getElementById('studySave').click(), true");
  await sleep(1200);
  const sent2 = await ev(opt, `new Promise((r) => { setTimeout(() => r(null), 3000); chrome.runtime.sendMessage({ type: "cg:save-study", study: { on: true, gateway: "${GW}", siteKey: "anything", participant: "P09" } }, (x) => { void chrome.runtime.lastError; r(x || null); }); })`);
  await sleep(800);
  const saved2 = await ev(opt, "new Promise((r) => chrome.storage.local.get('cg_study', (d) => r((d && d.cg_study) || null)))");
  const still2 = { locked: await W("state.locked"), overlay: await ev(site, "!!document.getElementById('__cgVerifyBtn')") };
  ok("…the study's \"Save\" is off and says why; pressed or sent anyway, nothing is saved and the lock stays", st2 && st2.disabled === true && /locked/.test(st2.note)
    && !!sent2 && sent2.ok === false && sent2.error === "locked" && saved2 === null && still2.locked === true && still2.overlay === true,
    JSON.stringify({ button: st2, answer: sent2, saved: saved2, still: still2 }));
  await W("releaseLock(); true");
  await sleep(2500);
  ok("…unlocked: both back", (await ev(pop, shown("enrolBtn"))) && (await ev(opt, "!document.getElementById('signOutBtn').disabled && !document.getElementById('lockNote').textContent")));
  ok("…and the study's \"Save\" is on again", await ev(opt, "!document.getElementById('studySave').disabled && !document.getElementById('studyLockNote').textContent"));

  // ---- 3. the server cannot be reached
  state.down = true;
  await W("setOffline('test'); true");
  await sleep(1500);
  ok("3. the server cannot be reached: no \"Finish enrolment\" in the popup nor in the settings", (await ev(pop, shown("enrolBtn"))) === false && (await ev(opt, shown("enrolBtn"))) === false);
  state.down = false;
  await W("probeGateway().then(() => true)");
  ok("…reachable again: offered again", await waitFor(pop, shown("enrolBtn"), 8000));

  // ---- 4. "Exclude this site"
  const own = await ev(pop, shown("exclude"));
  await ev(pop, `curUrl = "${SITE}/page.html"; curOrigin = "${SITE}"; curRestricted = false; refresh(); true`);
  await sleep(600);
  const onSite = await ev(pop, shown("exclude"));
  await ev(pop, `curUrl = "${GW}/connect.html"; curOrigin = "${GW}"; curRestricted = false; refresh(); true`);
  await sleep(600);
  const onGateway = await ev(pop, shown("exclude"));
  ok("4. \"Exclude this site\" on a website, not on the extension's own page nor on the gateway's", own === false && onSite === true && onGateway === false,
    `own page ${own}, website ${onSite}, gateway ${onGateway}`);

  // ---- 5. study mode on: the display switch. Saved with the page's own button, which goes through the worker.
  const saveStudy = async (on) => {
    await ev(opt, `document.getElementById('studyOn').checked = ${on}; document.getElementById('studyGateway').value = "${GW}"; document.getElementById('studyKey').value = "SK_STUDY";
      document.getElementById('studyParticipant').value = "P01"; document.getElementById('studySave').click(); true`);
    return waitFor(opt, `document.getElementById('studyMsg').textContent.startsWith("Saved. Study mode is ${on ? "ON" : "off"}")`, 6000);
  };
  const on5 = await saveStudy(true);
  await sleep(800);
  const s5 = await ev(opt, "({ disabled: document.getElementById('showVerdict').disabled, note: !document.getElementById('verdictNote').classList.contains('hidden') })");
  const user5 = await W("connKey()");
  const off5 = await saveStudy(false);
  await sleep(800);
  const s5off = await ev(opt, "({ disabled: document.getElementById('showVerdict').disabled, note: !document.getElementById('verdictNote').classList.contains('hidden') })");
  ok("5. not locked, the study's \"Save\" works: the participant becomes the user, and back", on5 && off5 && /^study\|/.test(user5 || "") && /^personal\|/.test((await W("connKey()")) || ""),
    `on ${on5}, user ${user5}; off ${off5}, user ${await W("connKey()")}`);
  ok("…study mode on: \"Show the live verdict\" is off with a note; study mode off: back", s5 && s5.disabled && s5.note && s5off && !s5off.disabled && !s5off.note,
    `${JSON.stringify(s5)} / ${JSON.stringify(s5off)}`);

  // ---- 6. the study's enrolment page with study mode off
  const before6 = (await targets()).filter((t) => t.type === "page").length;
  await ev(opt, "document.getElementById('studyEnrol').click(), true");
  await sleep(1500);
  const after6 = (await targets()).filter((t) => t.type === "page").length;
  const m6 = await ev(opt, "document.getElementById('studyMsg').textContent");
  ok("6. the study's \"Open enrolment page\" with study mode off: says to save first, opens nothing", after6 === before6 && /study mode on first/.test(m6 || ""), `${m6} · ${after6 - before6} pages opened`);

  // ---- 7. locked with a dead sign-in
  state.dead = true;
  await W("session = null; engageLock('mouse'); true");
  const overlay = await waitFor(site, "!!document.getElementById('__cgVerifyBtn')", 8000);
  await ev(site, "document.getElementById('__cgVerifyBtn').click(), true");
  const offered = await waitFor(site, "!!document.getElementById('__cgSignInBtn')", 8000);
  const text7 = await ev(site, "document.getElementById('__cgErr').textContent");
  ok("7. locked with a dead sign-in: the overlay says the sign-in expired and offers \"Sign in again\"", overlay && offered && /expired/.test(text7 || "") && !/Can't reach/.test(text7 || ""), text7);
  ok("…the settings page offers it too, and keeps \"Sign out\" off", await waitFor(opt, `${shown("reSignInBtn")} && document.getElementById('signOutBtn').disabled`, 8000));
  await ev(site, "document.getElementById('__cgSignInBtn').click(), true");
  let link = null;
  for (let i = 0; i < 40 && !link; i++) { link = (await targets()).find((t) => t.type === "page" && t.url.startsWith(GW + "/connect.html?mode=link&k=SK_EXT")); if (!link) await sleep(250); }
  ok("…\"Sign in again\" opens the sign-in of the same server and organisation", !!link, link ? link.url.split("&cc=")[0] : "no sign-in window");
  ok("…and the account stays locked meanwhile", (await W("state.locked")) === true);

  // ---- 8. "Test connection" at another address than the server's own
  state.publicUrl = "http://localhost:8080";
  await ev(opt, `document.getElementById('gateway').value = "${GW}"; document.getElementById('test').click(); true`);
  const other8 = await waitFor(opt, "document.getElementById('probe').textContent.includes('own address is http://localhost:8080')", 6000);
  state.publicUrl = GW;
  await sleep(3500);   // the first check's 3-s timer
  await ev(opt, "document.getElementById('test').click(), true");
  const own8 = await waitFor(opt, "document.getElementById('probe').textContent === '✓ Reachable'", 6000);
  ok("8. \"Test connection\" at another address than the server's own names the right one; at its own address, reachable", other8 && own8,
    await ev(opt, "document.getElementById('probe').textContent"));
  ok("no script error in the extension or the pages", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (e) {
  ok("run completed", false, e.stack || e.message);
} finally {
  ws.close(); chrome.kill(); await sleep(400); try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* a lock on Windows */ }
}
console.log(bad ? `\n${bad} check(s) FAILED` : "\nall checks passed");
process.exit(bad ? 1 : 0);
