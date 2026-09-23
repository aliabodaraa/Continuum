// End-to-end check of the extension's mouse channel in real (headless) Chrome, with a throwaway
// profile -- never the user's own. Drives the shipped pages through the DevTools protocol:
//   1. enrolment page, mouse mode: a replayed SapiMouse visit (real-time pointer events) is saved
//      below the 330-window total and reported as such
//   2. windows stored by the retired 7-feature extractor are converted exactly and the profile is
//      rebuilt from them on the device (FCN embedding + head), saved with its threshold
//   3. offscreen document loads that profile; the service worker's k-of-n vote runs on genuine
//      windows and on an impostor's
// Any uncaught exception in an extension page fails the run.
//
//   node extension/scripts/e2e_headless_mouse.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const ROOT = path.resolve(EXT, "..");
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const PORT = 9337;
const ACCT = "e2e-acct";
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-e2e-"));
const G = JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts", "final_eval", "g_inputs.json")));

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, "--window-size=1920,1080",
  "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });

async function version() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  throw new Error("chrome did not start");
}

// ---- minimal CDP client over the browser websocket (flattened sessions) ----
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
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = nextId++; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
async function attach(targetId) {
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  return sessionId;
}
async function evaluate(sessionId, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function target(pred, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const t = targetInfos.find(pred);
    if (t) return t;
    await sleep(250);
  }
  throw new Error("target not found");
}
async function waitFor(sessionId, expression, ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evaluate(sessionId, expression)) return true; } catch {}   // page may still be navigating
    await sleep(500);
  }
  return false;
}

try {
  const sw = await target((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
  const extId = new URL(sw.url).host;
  console.log(`extension ${extId} loaded (${sw.url})`);
  const base = `chrome-extension://${extId}/src/`;

  // ---------- 1. a replayed visit, saved below the total ----------
  const { targetId: pageId } = await send("Target.createTarget", { url: base + "enroll.html?mode=mouse" });
  let page = await attach(pageId);
  await waitFor(page, "location.href.includes('enroll.html') && document.readyState === 'complete'");
  // A throwaway profile has no Google account; enter the wizard as the account would.
  const enter = `currentAccountId = ${JSON.stringify(ACCT)}; document.getElementById('noAccountBlock').style.display='none';
                 document.getElementById('wizardRoot').style.display='block'; initWizard(); true`;
  // Wait for the page's own account lookup to finish (no account here), then enter.
  await waitFor(page, "document.getElementById('noAccountBlock').style.display === 'block'", 20000);
  await evaluate(page, enter);
  check("mouse stage shows the sample counter", /Sample 1 of 6/.test(await evaluate(page, "document.getElementById('mstatus').textContent")));

  const csv = fs.readFileSync(path.join(ROOT, "data", "sapimouse", "user1", "session_2020_05_14_1min.csv"), "utf8").trim().split(/\r?\n/).slice(1)
    .map((l) => l.split(",")).map(([t, , st, x, y]) => ({ t: +t, st, x: +x, y: +y }));
  const t0 = csv[0].t;
  const replay = csv.filter((e) => e.t - t0 <= 25000);
  const wall = Date.now();
  let held = false;
  for (const e of replay) {
    const due = wall + (e.t - t0) - Date.now();
    if (due > 0) await sleep(due);
    const type = e.st === "Pressed" ? "mousePressed" : e.st === "Released" ? "mouseReleased" : "mouseMoved";
    if (type === "mousePressed") held = true;
    if (type === "mouseReleased") held = false;
    await send("Input.dispatchMouseEvent", { type, x: Math.min(e.x, 1919), y: Math.min(e.y, 1079), button: type === "mouseMoved" ? (held ? "left" : "none") : "left", buttons: held ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 }, page);
  }
  await sleep(600);
  await sleep(1500);
  const status1 = await evaluate(page, "document.getElementById('mstatus').textContent");
  check("25 s of replayed movement completes sample 1, which saves itself; the counter moves to sample 2", /Sample 2 of 6/.test(status1), status1);
  const saved = await evaluate(page, `new Promise(r => chrome.storage.local.get(['cg_enroll_mouse_${ACCT}'], d => r((d['cg_enroll_mouse_${ACCT}'] || []).map(w => w[0].length))))`);
  check("exactly one sample (55 windows) is stored as 2-column windows, no model trained yet", saved.length === 55 && saved.every((c) => c === 2), `${saved.length} windows`);
  check("the page confirms the saved sample", /Sample 1 of 6 saved/.test(await evaluate(page, "document.getElementById('mtrainStatus').textContent")));

  // ---------- 2. retired 7-feature windows -> exact conversion -> on-device rebuild ----------
  const target8 = G.targets.find((t) => t.participant === "user8");
  const retired = target8.enrol.map((w) => w.map(([ax, ay]) => [ax / 1920, -ay / 1920, 0.5, 0.2, 0.1, 0.02, 0]));
  await evaluate(page, `new Promise(r => chrome.storage.local.set({'cg_enroll_mouse_${ACCT}': ${JSON.stringify(retired)}}, () => r(true)))`);
  await send("Page.reload", {}, page);
  await sleep(1000);
  await waitFor(page, "document.readyState === 'complete' && document.getElementById('noAccountBlock').style.display === 'block'", 20000);
  await evaluate(page, enter);
  await sleep(1500);
  const conv = await evaluate(page, `new Promise(r => chrome.storage.local.get(['cg_enroll_mouse_${ACCT}'], d => r(d['cg_enroll_mouse_${ACCT}'])))`);
  let maxDiff = 0;
  conv.forEach((w, i) => w.forEach((row, j) => { maxDiff = Math.max(maxDiff, Math.abs(row[0] - target8.enrol[i][j][0]), Math.abs(row[1] - target8.enrol[i][j][1])); }));
  check("retired windows converted back to |dx|, |dy| px exactly", conv[0][0].length === 2 && maxDiff < 1e-9, `max |diff| ${maxDiff.toExponential(1)}`);
  check("with >= 330 saved windows and no current model, a rebuild is offered", await evaluate(page, "getComputedStyle(document.getElementById('mrebuild')).display !== 'none'"));
  const tb = Date.now();
  await evaluate(page, "document.getElementById('mrebuild').click(); true");
  const built = await waitFor(page, "getComputedStyle(document.getElementById('done')).display === 'block'", 240000);
  check("the profile is built on the device", built, `${((Date.now() - tb) / 1000).toFixed(0)} s in headless Chrome`);
  const meta = await evaluate(page, `tf.loadLayersModel('indexeddb://cg-personal-mouse-fcn-${ACCT}').then(m => m.getUserDefinedMetadata())`);
  check("saved with its per-user threshold (2nd percentile), the mean-of-60 rule and the percentile table",
    meta && meta.threshold > 0 && meta.threshold < 1 && meta.thresholdQ === 2 && meta.voteN === 60 && meta.voteRule === "mean"
      && meta.enrolPercentiles && meta.threshold === meta.enrolPercentiles["2"] && meta.windows === 330, JSON.stringify(meta).slice(0, 400));

  // ---------- 3. offscreen loads it; the worker's vote on genuine vs impostor windows ----------
  await sleep(2000);   // let the worker's own post-enrolment reload (no account here) settle first
  const off = await target((t) => t.url.startsWith(base + "offscreen.html"));
  const offS = await attach(off.targetId);
  await evaluate(offS, `loadBestModel(${JSON.stringify(ACCT)}).then(() => true)`);
  const offState = await evaluate(offS, "({ mouseReady, meta: ContinuumScoring.mouseMeta() })");
  check("offscreen document loads the profile", offState.mouseReady && Math.abs(offState.meta.threshold - meta.threshold) < 1e-12);

  const swS = await attach(sw.targetId);
  const runVote = (wins) => evaluate(swS, `(async () => {
      state.accountId = ${JSON.stringify(ACCT)}; state.mouseReady = true; state.mouseTracking = true;
      state.locked = false; mouseScores = [];
      const wins = ${JSON.stringify(wins)};
      let lockedAt = null;
      for (let i = 0; i < wins.length; i++) { await onMouseWindow(wins[i]); if (state.locked && lockedAt === null) lockedAt = i + 1; }
      return { lockedAt, verdict: state.mouseVerdict, threshold: state.mouseThreshold, pct: state.mouseSustainPct };
    })()`);
  const gen = await runVote(target8.genuine.slice(0, 60));
  console.log(`    genuine (user8, 60 windows): mean ${gen.verdict.bufferMean}% vs threshold ${gen.verdict.threshold}%, low ${gen.verdict.low}/${gen.verdict.bufferMax}, locked after ${gen.lockedAt ?? "never"}`);
  check("the worker uses the profile's threshold and its mean-of-60 rule", Math.abs(gen.threshold - meta.threshold) < 1e-12 && gen.verdict.rule === "mean" && gen.verdict.bufferMax === 60 && gen.verdict.lockAt === null);
  const impId = Object.keys(G.impostorRuns).find((u) => u !== "user8");
  const imp = await runVote(G.impostorRuns[impId].slice(0, 60));
  console.log(`    impostor (${impId}, 60 windows): mean ${imp.verdict.bufferMean}% vs threshold ${imp.verdict.threshold}%, low ${imp.verdict.low}/${imp.verdict.bufferMax}, locked after ${imp.lockedAt ?? "never"}`);
  check("an impostor's movement scores lower on average than the genuine user's", imp.verdict.bufferMean < gen.verdict.bufferMean || (imp.lockedAt !== null && gen.lockedAt === null));

  check("no uncaught exception in any extension page", exceptions.length === 0, exceptions.slice(0, 3).join(" | "));
} catch (e) {
  console.error(e);
  failures++;
} finally {
  try { await send("Browser.close"); } catch {}
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
console.log(`\n${failures === 0 ? "ALL EXTENSION MOUSE CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures ? 1 : 0);
