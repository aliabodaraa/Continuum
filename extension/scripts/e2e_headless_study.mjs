// End-to-end check of the extension's USER-STUDY MODE (recovery plan T4.3) in real headless Chrome,
// with a throwaway profile, against the running stack (gateway :8080, ca-service with
// STUDY_LOGGING=1, model-api, passkey-service). LOGGING_SPEC.md §5, "checks before the first
// participant":
//   1. a study tenant that admits the extension; a test participant registered and enrolled on the
//      SERVER (keystroke: 5 samples of seeded KeyRecs account 26; mouse: 8 samples of SapiMouse
//      user1's 3-min session), and a passkey created on the study page with a virtual authenticator
//   2. a scripted GENUINE session: account 26's held-out typing and user1's 1-min movement replayed
//      as real key and pointer events on a test page, scored by the server through the extension
//   3. a scripted IMPOSTOR session: account 29's typing and user2's movement; the lock, then the
//      passkey step-up on the study page (the virtual authenticator's credential)
//   4. privacy (LOGGING_SPEC §5): with the participant's pause on, typing and movement create nothing;
//      after resume, only post-resume windows are scored; typing in a password field creates nothing
//   5. the export: both channels and conditions and clients, every threshold-source score, model
//      hashes, the prompt events; the privacy scan passes and the replay reproduces every live verdict
// Everything the test created is removed at the end (study rows, enrolments, the passkey); one
// "study-e2e" tenant is kept and reused.
//
//   STUDY_LOGGING=1 docker compose up -d --no-deps ca-service     (once, before the run)
//   node extension/scripts/e2e_headless_study.mjs
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const ROOT = path.resolve(EXT, "..");
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080";
// Containers the test acts on directly; defaults are the running stack's. For the side-by-side stack
// (project continuum-next) set CONTINUUM_CONTAINER_PREFIX=continuum-next.
const PREFIX = process.env.CONTINUUM_CONTAINER_PREFIX || "continuum";
const CA = `${PREFIX}-ca-service-1`, GW_CONTAINER = `${PREFIX}-gateway-1`;
const PORT = 9338;
// A fresh test participant per run (the tenant is reused), so nothing of an earlier run can leak in.
const P = "ZZE2E" + Math.random().toString(36).slice(2, 7).toUpperCase(), TYPIST = "ZZE2F";
const KS_GENUINE = 26, KS_IMPOSTOR = 29;        // seeded KeyRecs accounts (typing source)
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-study-e2e-"));

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Runs `code` (it may await) in the ca-service container with `db` = the service's own data layer (db.js), so
// the test reads and writes whichever store the service uses: its SQLite file or its PostgreSQL database.
const caNode = (code) => execFileSync("docker", ["exec", "-w", "/app", CA, "node", "-e",
  `const db=require('/app/db');(async()=>{${code}})().then(()=>db.close(),(e)=>{console.error(e);process.exitCode=1;return db.close();})`],
  { encoding: "utf8", maxBuffer: 1 << 28 });
const caScript = (...args) => { try { return { code: 0, out: execFileSync("docker", ["exec", "-w", "/app", CA, "node", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; } };

// ---------- preflight ----------
if (execFileSync("docker", ["exec", CA, "node", "-e", "console.log(process.env.STUDY_LOGGING||'0')"], { encoding: "utf8" }).trim() !== "1") {
  console.error("ca-service runs with STUDY_LOGGING off. Start it with: STUDY_LOGGING=1 docker compose up -d --no-deps ca-service");
  process.exit(2);
}

// ---------- gateway client (Origin = the study page's origin, which the tenant admits) ----------
let siteKey = null, token = null, userId = null;
// The operator key for /v1/tenants: the environment, else the repository's git-ignored .env (none = dev, open).
const ADMIN_KEY = process.env.GATEWAY_ADMIN_KEY
  || ((() => { try { return fs.readFileSync(path.join(ROOT, ".env"), "utf8"); } catch { return ""; } })().match(/^GATEWAY_ADMIN_KEY=(.*?)\s*$/m) || [])[1] || "";
async function gw(p, body, method = "POST") {
  const r = await fetch(GW + p, { method, headers: { "Content-Type": "application/json", Origin: GW, ...(token ? { Authorization: "Bearer " + token } : {}),
    ...(p.startsWith("/v1/tenants") && ADMIN_KEY ? { "X-Admin-Key": ADMIN_KEY } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}

// ---------- test data ----------
const textsOf = (uid) => JSON.parse(caNode(`const ids=await db.all('SELECT id FROM keystroke_texts WHERE user_id=? AND is_training=1 ORDER BY id', ${uid});
  const out=[];for(const r of ids)out.push(await db.all('SELECT key_code k, event_type e, timestamp_relative t FROM keystroke_events WHERE keystroke_text_id=? ORDER BY timestamp_relative, id', r.id));
  console.log(JSON.stringify(out))`));
const genuineTexts = textsOf(KS_GENUINE), impostorTexts = textsOf(KS_IMPOSTOR);
const printable = (k) => k === 32 || (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 96 && k <= 111) || (k >= 186 && k <= 192) || (k >= 219 && k <= 222);
const sapi = (u, s) => fs.readFileSync(path.join(ROOT, "data", "sapimouse", u, s), "utf8").trim().split(/\r?\n/).slice(1)
  .map((l) => l.split(",")).map(([t, , st, x, y]) => ({ t: +t, state: st, x: +x, y: +y }));

// ---------- test page ----------
const pageServer = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" });
  res.end('<!doctype html><title>study e2e</title><input type="password" id="pw" style="width:400px"><textarea id="t" style="width:1800px;height:900px"></textarea>'); });
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const PAGE = `http://127.0.0.1:${pageServer.address().port}/`;

// ---------- Chrome + a minimal CDP client ----------
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, "--window-size=1920,1080",
  "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
async function version() { for (let i = 0; i < 60; i++) { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } } throw new Error("chrome did not start"); }
const { webSocketDebuggerUrl } = await version();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
const exceptions = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
async function attach(targetId) { const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }); await send("Runtime.enable", {}, sessionId); return sessionId; }
async function evaluate(sessionId, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function target(pred, tries = 80) { for (let i = 0; i < tries; i++) { const { targetInfos } = await send("Target.getTargets"); const t = targetInfos.find(pred); if (t) return t; await sleep(250); } throw new Error("target not found"); }
async function waitFor(sessionId, expression, ms = 60000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(sessionId, expression)) return true; } catch {} await sleep(400); } return false; }
// A page is ready when its document is the one navigated to. Target.createTarget and Page.reload return before
// the navigation commits, and until then the initial about:blank (or the old document) already reports
// readyState "complete": waiting on readyState alone let the test act on the wrong document (a script load that
// failed with a bare Event, or a promise that never settled).
const loadedAt = (url) => `location.href.startsWith(${JSON.stringify(url)}) && document.readyState === 'complete'`;
async function reloadPage(sessionId, url) {
  await evaluate(sessionId, "window.__cgE2eOld = true").catch(() => {});
  await send("Page.reload", {}, sessionId);
  return waitFor(sessionId, "!window.__cgE2eOld && " + loadedAt(url));
}
const SR = "document.getElementById('continuum-guard-host') && document.getElementById('continuum-guard-host').shadowRoot";
const visibleButton = (sel) => `(() => { const sr = ${SR}; if (!sr) return false; const b = [...sr.querySelectorAll('${sel}')].find(x => x.offsetParent !== null && !x.disabled); if (!b) return false; b.click(); return true; })()`;

// A virtual platform authenticator on a page; `creds` (from an earlier one) are copied in.
async function authenticator(sessionId, creds = []) {
  await send("WebAuthn.enable", { enableUI: false }, sessionId);
  const { authenticatorId } = await send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }, sessionId);
  for (const c of creds) await send("WebAuthn.addCredential", { authenticatorId, credential: c }, sessionId);
  return authenticatorId;
}
async function typeReplay(page, texts, stopWhen) {
  for (const events of texts) {
    const t0 = events[0].t, wall = Date.now();
    for (const e of events) {
      const due = wall + (e.t - t0) - Date.now();
      if (due > 0) await sleep(due);
      await send("Input.dispatchKeyEvent", { type: e.e === "keydown" ? "rawKeyDown" : "keyUp", windowsVirtualKeyCode: e.k, nativeVirtualKeyCode: e.k }, page);
    }
    await sleep(2500);   // a composition pause between texts (dropped by the feature builder)
    if (stopWhen && (await stopWhen())) return true;
  }
  return false;
}
async function mouseReplay(page, csv, seconds, stopWhen) {
  const t0 = csv[0].t, wall = Date.now();
  let held = false, n = 0;
  for (const e of csv.filter((x) => x.t - t0 <= seconds * 1000)) {
    const due = wall + (e.t - t0) - Date.now();
    if (due > 0) await sleep(due);
    const type = e.state === "Pressed" ? "mousePressed" : e.state === "Released" ? "mouseReleased" : "mouseMoved";
    if (type === "mousePressed") held = true;
    if (type === "mouseReleased") held = false;
    await send("Input.dispatchMouseEvent", { type, x: Math.min(e.x, 1919), y: Math.min(e.y, 1079), button: type === "mouseMoved" ? (held ? "left" : "none") : "left", buttons: held ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 }, page);
    if (++n % 200 === 0 && stopWhen && (await stopWhen())) return true;
  }
  return false;
}

let sw = null;
try {
  const swT = await target((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
  const extId = new URL(swT.url).host;
  sw = await attach(swT.targetId);
  console.log(`extension ${extId}; gateway ${GW}; test page ${PAGE}`);

  // ---- 1. tenant, participant, server enrolment, passkey ----
  // one "study-e2e" tenant is reused across runs (same origins); created on the first run
  const origins = [GW, `chrome-extension://${extId}`];
  const known = ((await gw("/v1/tenants", null, "GET")).d.tenants || [])
    .find((t) => t.name === "study-e2e" && origins.every((o) => (t.origins || []).includes(o)));
  const ten = known ? { status: 200, d: { siteKey: known.siteKey } } : await gw("/v1/tenants", { name: "study-e2e", origins });
  siteKey = ten.d.siteKey;
  check("a study tenant admits the gateway page and the extension", ten.status === 200 && !!siteKey, `${siteKey}${known ? " (reused)" : ""}`);
  const ses = await gw("/v1/sdk/session", { siteKey, externalId: "study:" + P });
  token = ses.d.token; userId = ses.d.userId;
  const reg = await gw("/v1/sdk/study/register", { participant: P });
  check("the participant is registered before enrolment", reg.status === 200 && reg.d.ok === true, `user ${userId}`);

  let lastEvents = [];
  for (let i = 0; i < 5; i++) {
    const a = genuineTexts[2 * i], b = genuineTexts[2 * i + 1];
    const off = a[a.length - 1].t + 3000;
    const events = a.concat(b.map((e) => ({ ...e, t: e.t + off }))).map((e) => ({ keyCode: e.k, eventType: e.e, timestampRelative: e.t, fieldName: "e2e", fieldType: "textarea" }));
    const n = events.filter((e) => e.eventType === "keydown" && printable(e.keyCode)).length;
    // a unique stand-in text of the typed length: the server keeps only its hash and length
    const text = (`e2e sample ${i} ${Date.now()} ` + "lorem ipsum dolor sit amet ".repeat(40)).slice(0, Math.max(n, 120));
    const r = await gw("/v1/sdk/keystroke/enroll", { textContent: text, keystrokeEvents: events });
    if (r.status >= 300) { check(`keystroke enrolment sample ${i + 1}`, false, JSON.stringify(r.d).slice(0, 200)); break; }
    lastEvents = events;
  }
  // The last sample returns at once; the model is built from the queue (2026-10-06).
  const ksNow = (await gw("/v1/sdk/keystroke/status", null, "GET")).d;
  check("typing enrolment returns at once and the model is built from the queue", ksNow.training === true || ksNow.trained === true,
    `training ${ksNow.training}, trained ${ksNow.trained}`);

  const { targetId: gid } = await send("Target.createTarget", { url: GW + "/study.html" });
  const gpage = await attach(gid);
  await waitFor(gpage, loadedAt(GW + "/study.html"));
  const win = await evaluate(gpage, `new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/js/mouse-features.js';
    s.onload = () => { const ev = ${JSON.stringify(sapi("user1", "session_2020_05_14_3min.csv"))};
      res(window.mouseFeatures.stepsToWindows(window.mouseFeatures.eventsToSteps(ev)).slice(0, 440)); }; s.onerror = rej; document.head.appendChild(s); })`);
  check("440 mouse enrolment windows from SapiMouse user1 (3-min session), built by the SDK's own features", win.length === 440, String(win.length));
  for (let i = 0; i < 8; i++) {
    const r = await gw("/v1/sdk/mouse/enroll", { windows: win.slice(55 * i, 55 * (i + 1)) });
    if (r.status >= 300) { check(`mouse enrolment sample ${i + 1}`, false, JSON.stringify(r.d).slice(0, 200)); break; }
  }
  await send("Target.closeTarget", { targetId: gid });

  const tTrain = Date.now();
  let ks = null, ms = null;
  while (Date.now() - tTrain < 8 * 60000) {
    ks = (await gw("/v1/sdk/keystroke/status", null, "GET")).d;
    ms = (await gw("/v1/sdk/mouse/status", null, "GET")).d;
    if (ks.trained && ms.enrolled && !ms.training) break;
    await sleep(5000);
  }
  check("both server models train (keystroke on the Aalto negatives, mouse on the live rule)", !!(ks && ks.trained && ms && ms.enrolled), `${((Date.now() - tTrain) / 1000).toFixed(0)} s`);
  // Once the typing model exists only the adaptive popup adds samples (2026-10-05): enrolment is closed.
  const more = await gw("/v1/sdk/keystroke/enroll", { textContent: (`e2e extra ${Date.now()} ` + "lorem ipsum dolor sit amet ".repeat(40)).slice(0, 400), keystrokeEvents: lastEvents });
  check("a trained typing model takes no more enrolment samples (only the popup adds any)", more.status === 409 && more.d.error === "already_enrolled",
    `6th sample → ${more.status} ${more.d.error}`);
  // regression: the gateway's onboarding lookup once lacked the service key and assertion, so every
  // user read as not enrolled and the SDK offered enrolment again
  const ob = await gw("/v1/sdk/onboarding", null, "GET");
  check("the gateway's onboarding sees both enrolments", ob.d.keystroke === true && ob.d.mouse === true, JSON.stringify(ob.d));

  const { targetId: vid } = await send("Target.createTarget", { url: `${GW}/study.html?mode=verify&p=${P}&k=${siteKey}` });
  const vpage = await attach(vid);
  const authId = await authenticator(vpage);
  await send("Page.reload", {}, vpage);
  const regClicked = await waitFor(vpage, visibleButton("#cw"), 30000);
  // the onboarding ends on a "You're verified" screen whose button (#cd) closes it; then the step-up
  const doneClicked = regClicked && (await waitFor(vpage, visibleButton("#cd"), 30000));
  const stepClicked = doneClicked && (await waitFor(vpage, visibleButton(".ov .b"), 30000));
  const verified = stepClicked && (await waitFor(vpage, "document.getElementById('status').className === 'ok'", 30000));
  const creds = (await send("WebAuthn.getCredentials", { authenticatorId: authId }, vpage)).credentials;
  check("a passkey is created and verified on the study page (virtual authenticator)", verified && creds.length === 1, `${creds.length} credential(s)`);
  // regression: the gateway's passkey lookup once lacked the service key, so this read false for everyone
  const pkStatus = await gw("/v1/sdk/passkey/status", null, "GET");
  check("the gateway sees the participant's passkey (step-ups can fire)", pkStatus.d.hasPasskey === true, JSON.stringify(pkStatus.d));
  await send("Target.closeTarget", { targetId: vid });

  // ---- 2. genuine session ----
  const setStudy = (condition, client = "extension-study") => evaluate(sw, `new Promise(r => chrome.storage.local.set({ cg_study: { on: true, gateway: ${JSON.stringify(GW)},
    siteKey: ${JSON.stringify(siteKey)}, participant: ${JSON.stringify(P)}, condition: ${JSON.stringify(condition)}, client: ${JSON.stringify(client)} } }, () => r(true)))`);
  const setPaused = (v) => evaluate(sw, `new Promise(r => chrome.storage.local.set({ cg_paused: ${v ? "true" : "false"} }, () => r(true)))`);
  await setPaused(false);
  await setStudy("genuine");
  await sleep(800);
  const { targetId: pid } = await send("Target.createTarget", { url: PAGE });
  const page = await attach(pid);
  await waitFor(page, loadedAt(PAGE));
  await sleep(1500);   // the content script's handshake brings the study settings
  await evaluate(page, "document.getElementById('t').focus(); true");
  const locked = () => evaluate(sw, "state.locked");
  const tg = Date.now();
  await mouseReplay(page, sapi("user1", "session_2020_05_14_1min.csv"), 45);
  await typeReplay(page, genuineTexts.slice(10, 14));
  await sleep(4000);
  const genLocked = await locked();
  const gen = JSON.parse(caNode(`console.log(JSON.stringify(await db.all("SELECT channel, verdict, COUNT(*) n FROM study_decisions WHERE user_id=? AND condition='genuine' GROUP BY channel, verdict", ${userId})))`));
  console.log(`    genuine session (${((Date.now() - tg) / 1000).toFixed(0)} s): ${JSON.stringify(gen)}; locked: ${genLocked}`);
  check("genuine typing is scored by the server and logged, with verdicts past warm-up", gen.some((r) => r.channel === "keystroke" && r.verdict !== "warmup"));
  check("genuine movement is scored by the server and logged", gen.some((r) => r.channel === "mouse" && r.verdict !== "warmup"));
  check("the recording indicator shows REC", (await evaluate(sw, "badgeForState().text")) === "REC");

  // ---- 3. impostor session ----
  let stepUps = 0;
  async function stepUp() {
    await evaluate(page, "(() => { const b = document.getElementById('__cgVerifyBtn'); if (b) b.click(); return !!b; })()");
    const pop = await target((t) => t.type === "page" && t.url.includes("/study.html?mode=verify"), 60);
    const ps = await attach(pop.targetId);
    stepUps += 1;
    await authenticator(ps, creds.map((c) => ({ ...c, signCount: (c.signCount || 0) + 100 * stepUps })));
    await send("Page.reload", {}, ps);
    const clicked = await waitFor(ps, visibleButton(".ov .b"), 30000);
    let released = false;
    for (let i = 0; clicked && i < 60 && !released; i++) { released = !(await locked()); if (!released) await sleep(500); }
    return { clicked, released };
  }
  if (genLocked) { console.log("    note: the genuine session was locked (a false lock); clearing it through the step-up"); await stepUp(); }
  await setStudy("impostor:" + TYPIST, "lab");
  await sleep(800);
  await reloadPage(page, PAGE);   // a new page visit = a new study session
  await sleep(1500);
  await evaluate(page, "document.getElementById('t').focus(); true");
  const ti = Date.now();
  let impLocked = await typeReplay(page, impostorTexts.slice(0, 5), locked);
  if (!impLocked) impLocked = await mouseReplay(page, sapi("user2", "session_2020_10_22_1min.csv"), 50, locked);
  await sleep(3000);
  impLocked = impLocked || (await locked());
  console.log(`    impostor session (${((Date.now() - ti) / 1000).toFixed(0)} s): locked=${impLocked} by ${await evaluate(sw, "state.lockReason")}`);
  check("the impostor session is locked by a server verdict", impLocked);
  if (impLocked) {
    const su = await stepUp();
    check("the lock is cleared by the passkey step-up on the study page", su.clicked && su.released);
  }
  await sleep(2000);

  // ---- 4. privacy: the participant's pause, and password fields ----
  const decisionCount = () => Number(caNode(`console.log((await db.get('SELECT COUNT(*) n FROM study_decisions WHERE user_id=?', ${userId})).n)`).trim());
  const maxDecision = () => Number(caNode(`console.log((await db.get('SELECT COALESCE(MAX(id),0) m FROM study_decisions WHERE user_id=?', ${userId})).m)`).trim());
  await setStudy("genuine");
  await setPaused(true);
  await sleep(800);
  await reloadPage(page, PAGE);
  await sleep(1500);
  await evaluate(page, "document.getElementById('t').focus(); true");
  check("the recording indicator shows the pause", (await evaluate(sw, "badgeForState().text")) === "II");
  const n0 = decisionCount();
  await typeReplay(page, genuineTexts.slice(14, 17));
  await mouseReplay(page, sapi("user1", "session_2020_05_14_1min.csv"), 25);
  await sleep(4000);
  check("while paused, typing and movement create nothing", decisionCount() === n0, `${decisionCount() - n0} new decision(s)`);
  const lastBefore = maxDecision();
  const resumedAt = await evaluate(page, "performance.now()");
  await setPaused(false);
  await sleep(1500);
  await evaluate(page, "document.getElementById('t').focus(); true");
  await typeReplay(page, genuineTexts.slice(17, 19), locked);
  await sleep(4000);
  const after = JSON.parse(caNode(`console.log(JSON.stringify((await db.all("SELECT w.window_key k FROM study_windows w JOIN study_decisions d ON d.id=w.decision_id WHERE d.user_id=? AND d.id>? AND d.channel='keystroke'", ${userId}, ${lastBefore})).map(r=>r.k)))`));
  const earliest = Math.min(...after.map((k) => Number(k.split("-")[0])));
  check("after resume, checks resume, and every scored window starts after the resume", after.length > 0 && earliest >= resumedAt - 1500,
    `${after.length} window(s), earliest start ${earliest.toFixed(0)} ms vs resume at ${resumedAt.toFixed(0)} ms (page clock)`);
  if (await locked()) { console.log("    note: probation re-challenged after resume; clearing it"); await stepUp(); }
  await reloadPage(page, PAGE);
  await sleep(1500);
  await evaluate(page, "document.getElementById('pw').focus(); true");
  const p0 = decisionCount();
  await typeReplay(page, genuineTexts.slice(0, 3));
  await sleep(4000);
  check("typing in a password field creates nothing (no key event is sent)", decisionCount() === p0, `${decisionCount() - p0} new decision(s)`);

  // ---- 5. export, privacy scan, replay ----
  caScript("-e", "require('fs').rmSync('/tmp/e2e_study_export',{recursive:true,force:true})");
  const ex = caScript("scripts/study_export.js", "--out", "/tmp/e2e_study_export");
  check("the export runs and its privacy scan is clean", ex.code === 0, ex.out.trim().split("\n").filter((l) => /privacy|re-scored/.test(l)).join(" | "));
  const lines = caScript("-e", `process.stdout.write(require('fs').readFileSync('/tmp/e2e_study_export/${P}.jsonl','utf8'))`).out.trim().split("\n").map((l) => JSON.parse(l));
  const profs = lines.filter((l) => l.type === "profile");
  check("profile records for both channels with all threshold-source scores and model hashes",
    profs.some((p) => p.channel === "mouse" && p.thresholdScores.length === 440 && /^[0-9a-f]{64}$/.test(p.modelSha256 || ""))
      && profs.some((p) => p.channel === "keystroke" && p.thresholdScores.length > 0 && /^[0-9a-f]{64}$/.test(p.modelSha256 || "")),
    profs.map((p) => `${p.channel}:${p.thresholdScores.length}`).join(", "));
  const decs = lines.filter((l) => l.type === "decision");
  const conds = new Set(decs.map((d) => `${d.channel}/${d.condition}`));
  check("decisions of both channels under both conditions", ["keystroke/genuine", "mouse/genuine"].every((c) => conds.has(c)) && [...conds].some((c) => c.endsWith(`impostor:${TYPIST}`)), [...conds].join(", "));
  check("every decision's windows carry keys (none unkeyed)", decs.every((d) => d.windowKeys.every((k) => !k.startsWith("unkeyed"))));
  check("client per decision: extension-study for the genuine sessions, lab for the impostor session",
    decs.every((d) => (d.condition === "genuine" ? d.client === "extension-study" : d.client === "lab")),
    [...new Set(decs.map((d) => `${d.condition}/${d.client}`))].join(", "));
  check("the keystroke profile's version names its negatives", profs.some((p) => p.channel === "keystroke" && /aalto-A200/.test(p.ruleVersion)),
    profs.map((p) => p.ruleVersion).join(", "));
  check("sessions: one per page visit", new Set(decs.map((d) => d.sessionId)).size >= 2);
  const prompts = lines.filter((l) => l.type === "prompt").map((p) => p.event);
  check("prompt events logged (shown, then passed)", !impLocked || (prompts.includes("shown") && prompts.includes("passed")), prompts.join(","));
  const rp = caScript("scripts/study_replay.js", "--in", "/tmp/e2e_study_export");
  check("the replay reproduces every live verdict", rp.code === 0 && /REPRODUCES EVERY/.test(rp.out), rp.out.trim().split("\n").slice(-2).join(" | "));
  check("no uncaught exception in extension pages", exceptions.length === 0, exceptions.slice(0, 2).join(" / "));
} catch (e) {
  check("run completed", false, e.message);
} finally {
  // ---- cleanup: the test participant's study rows and server enrolments; Chrome; temp files ----
  try {
    if (token) {
      for (const p of ["/v1/sdk/keystroke/reset", "/v1/sdk/mouse/reset"]) {
        const r = await gw(p);
        if (r.status !== 200) check(`cleanup: ${p}`, false, `HTTP ${r.status}`);
      }
    }
    // a server lock left by an interrupted run would outlive the test user's reset
    if (userId) caNode(`await db.run('DELETE FROM session_locks WHERE user_id=?', ${userId}); console.log('lock cleared')`);
    // the test passkey, cleared from inside the gateway container (its service key stays there)
    if (userId) execFileSync("docker", ["exec", GW_CONTAINER, "node", "-e", `fetch(process.env.PASSKEY_API_URL+'/v1/users/${userId}/reset',{method:'POST',headers:{'X-Api-Key':process.env.PASSKEY_API_KEY||''}}).then(r=>console.log('passkey reset',r.status))`], { encoding: "utf8" });
    if (userId) caNode(`for (const t of ['study_windows','study_decisions','study_prompts','study_profiles','study_participants']) await db.run('DELETE FROM '+t+' WHERE user_id=?', ${userId}); console.log('cleaned')`);
    caScript("-e", "require('fs').rmSync('/tmp/e2e_study_export',{recursive:true,force:true})");
  } catch (e) { console.log("  cleanup: " + e.message); }
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  pageServer.close();
  await sleep(500);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL STUDY-MODE CHECKS PASSED");
process.exit(failures ? 1 : 0);
