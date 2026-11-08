// Scrolling must not become mouse movement in the SDK's trackers (2026-11-08). Until then both trackers recorded
// positions relative to the tracked element's box; the live guard tracks document.documentElement, whose box moves
// with scrolling, so a 300 px wheel scroll followed by a 3 px move was recorded as a 300 px step.
// Headless Chrome, no running stack: a 6000 px page loads sdk/js/mouse-features.js and sdk/js/mouse-actions.js,
// trackers on document.documentElement, and TRUSTED input from CDP: small moves, a wheel scroll with the pointer
// still, small moves again. Every recorded step must stay small.
//   node extension/scripts/e2e_headless_sdk_scroll.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHROME = process.env.CHROME || path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const PORT = 9403, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const src = (f) => fs.readFileSync(path.join(ROOT, "sdk", "js", f), "utf8");
const page = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;height:6000px}</style>
<script>${src("mouse-features.js")}</script><script>${src("mouse-actions.js")}</script></head><body><p>long page</p>
<script>window.__f = window.mouseFeatures.createMouseTracker(document.documentElement);
window.__a = window.mouseActions.createActionTracker(document.documentElement);</script></body></html>`;

let failed = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); if (!ok) failed++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-scroll-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--window-size=1000,800", "--no-first-run", "about:blank"], { stdio: "ignore" });
try {
  let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
  const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 1; const pend = new Map();
  const send = (method, params = {}, s) => new Promise((res) => { const i = id++; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error || {}); pend.delete(m.id); } });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, s); await send("Runtime.enable", {}, s);
  const tree = await send("Page.getFrameTree", {}, s);
  await send("Page.setDocumentContent", { frameId: tree.frameTree.frame.id, html: page }, s); await sleep(400);
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true }, s)).result?.value;
  let x = 400; const y = 300;
  for (let i = 0; i < 12; i++) { x += 3; await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, s); await sleep(20); }
  await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: 300 }, s); await sleep(400);
  for (let i = 0; i < 12; i++) { x += 3; await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, s); await sleep(20); }
  const scrolled = await ev("window.scrollY");
  check("the page scrolled 300 px with the pointer still", scrolled === 300, `scrollY ${scrolled}`);
  const steps = JSON.parse(await ev("JSON.stringify(window.mouseFeatures.eventsToSteps(window.__f.getEvents()))"));
  const maxF = Math.max(...steps.map(([dx, dy]) => Math.max(dx, dy)));
  check("mouse-features: no step carries the scroll (every step at most 3 px)", steps.length >= 20 && maxF <= 3, `${steps.length} steps, largest ${maxF} px`);
  const ys = JSON.parse(await ev("JSON.stringify(window.__a.getEvents().map((e) => e.y))"));
  check("mouse-actions: positions do not jump with the scroll", ys.length >= 20 && Math.max(...ys) - Math.min(...ys) <= 3, `y from ${Math.min(...ys)} to ${Math.max(...ys)}`);
  const ts = JSON.parse(await ev("JSON.stringify(window.__f.getEvents().map((e) => e.t))"));
  check("times are increasing event timestamps", ts.every((t, i) => i === 0 || t >= ts[i - 1]), `${ts.length} events`);
  ws.close();
} finally {
  chrome.kill(); await sleep(300); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL SCROLL CHECKS PASSED");
process.exit(failed ? 1 : 0);
