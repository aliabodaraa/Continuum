// End-to-end check that typing enrolment never holds the user and survives a reload (2026-10-06), in real
// headless Chrome against the running stack (gateway :8080, ca-service, model-api, passkey-service):
//   1. a throwaway participant of the "study-e2e" tenant with 4 of 5 typing samples already on file
//   2. the SDK on a page served at the gateway's own origin (as an organisation's site loads it): passkey
//      (virtual authenticator), then the 5th typing sample typed as real key events in the SDK's wizard
//   3. the wizard moves on at once while ca-service builds the model from its training queue
//   4. a reload while the model is being built does not ask for typing again, and the typing row says
//      "building your model"; once the model exists the row changes without a reload
// The participant's enrolments, passkey and any lock are removed at the end; the tenant is kept (run
// e2e_headless_study.mjs once first, it creates it).
//
//   node extension/scripts/e2e_headless_enrol_reload.mjs
import { spawn, execFileSync } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { inService } from "./lib/stack.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Containers the test acts on directly; defaults are the running stack's. For the side-by-side stack
// (project continuum-next) set CONTINUUM_CONTAINER_PREFIX=continuum-next.
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080", PORT = 9360;
const CHROME = path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN_KEY = (fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^GATEWAY_ADMIN_KEY=(.*?)\s*$/m) || [])[1] || "";
let token = null, userId = null, bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };
// The operator area (operator page, /v1/tenants, /v1/admin/*): the gateway itself (Compose), or, behind an edge
// that never routes it (Kubernetes: Envoy marks every request it forwards), a private port-forward to the
// gateway (scripts/k8s-local.sh operator => CONTINUUM_OPERATOR=http://localhost:28081).
const OP = process.env.CONTINUUM_OPERATOR || GW;
async function gw(p, body, method = "POST") {
  const r = await fetch((p.startsWith("/v1/tenants") ? OP : GW) + p, { method, headers: { "Content-Type": "application/json", Origin: GW, ...(token ? { Authorization: "Bearer " + token } : {}),
    ...(p.startsWith("/v1/tenants") ? { "X-Admin-Key": ADMIN_KEY } : {}) }, body: method === "GET" ? undefined : JSON.stringify(body || {}) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}
// synthetic but plausible typing: letters and spaces, dwell ~70-130 ms, flight ~60-200 ms
function typing(n, seed) {
  let t = 0, s = seed; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const text = "the quick brown fox jumps over the lazy dog while a small bird sings near the old river bank today ".repeat(3).slice(0, n);
  const ev = [];
  for (const ch of text) {
    const kc = ch === " " ? 32 : ch.toUpperCase().charCodeAt(0);
    const dwell = 70 + rnd() * 60;
    ev.push({ keyCode: kc, eventType: "keydown", timestampRelative: Math.round(t), fieldName: "e2e", fieldType: "textarea" });
    ev.push({ keyCode: kc, eventType: "keyup", timestampRelative: Math.round(t + dwell), fieldName: "e2e", fieldType: "textarea" });
    t += dwell + 60 + rnd() * 140;
  }
  return { text, ev };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-reload-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), handlers = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); } else if (m.method) handlers.forEach((h) => h(m)); });
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(s, expr)) return true; await sleep(300); } return false; };
const SH = "document.getElementById('continuum-guard-host') && document.getElementById('continuum-guard-host').shadowRoot";
const WIZ = `(() => { const r = ${SH}; return r ? [...r.querySelectorAll('.ov')].find((o) => o.style.display === 'flex') || null : null; })()`;
const wizTitle = `(() => { const o = ${WIZ}; const t = o && o.querySelector('.t'); return t ? t.textContent : ''; })()`;
const ksRow = `(() => { const r = ${SH}; if (!r) return ''; const e = [...r.querySelectorAll('*')].find((x) => x.children.length === 0 && /^keystroke:/.test(x.textContent || '')); return e ? e.textContent : ''; })()`;

try {
  // ---- a throwaway participant of the study tenant, 4 typing samples already on file ----
  const ten = ((await gw("/v1/tenants", null, "GET")).d.tenants || []).find((t) => t.name === "study-e2e");
  if (!ten) throw new Error("study-e2e tenant missing: run e2e_headless_study.mjs once first");
  const P = "RLD" + Date.now().toString(36).toUpperCase();
  const ses = await gw("/v1/sdk/session", { siteKey: ten.siteKey, externalId: "study:" + P });
  token = ses.d.token; userId = ses.d.userId;
  for (let i = 0; i < 4; i++) {
    const { text, ev: events } = typing(140, 7 + i);
    const r = await gw("/v1/sdk/keystroke/enroll", { textContent: `${text} ${i}`, keystrokeEvents: events });
    if (r.status !== 200) throw new Error("enrol " + i + ": " + JSON.stringify(r.d));
  }
  ok("4 of 5 typing samples on file before the page opens", true, `user ${userId}`);

  // ---- the page, served on the gateway's own origin (a tenant origin) by request interception ----
  const html = `<!doctype html><meta charset="utf-8"><title>reload test</title><p>An organisation's page.</p><textarea id="host"></textarea>
    <script src="/guard.js" data-site-key="${ten.siteKey}" data-session="${token}" data-onboarding="eager" data-keystroke="on" data-mouse="on"></script>`;
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  handlers.push((m) => { if (m.method === "Fetch.requestPaused" && m.sessionId === s) send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: Buffer.from(html).toString("base64") }, s); });
  await send("Fetch.enable", { patterns: [{ urlPattern: GW + "/__reload_test.html*", requestStage: "Request" }] }, s);
  await send("WebAuthn.enable", { enableUI: false }, s);
  await send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }, s);
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  await send("Page.navigate", { url: GW + "/__reload_test.html" }, s);

  // passkey step, then the typing step at sample 5 / 5
  ok("the SDK opens its enrolment, passkey first", await waitFor(s, `${wizTitle}.includes('passkey')`, 20000), await ev(s, wizTitle));
  await ev(s, `${WIZ}.querySelector('#cw').click()`);
  ok("…then typing, continuing at sample 5 of 5", await waitFor(s, `/typing/i.test(${wizTitle}) && /5 \\/ 5/.test((${WIZ} || {}).textContent)`, 20000), await ev(s, wizTitle));

  // type the passage (about 130 keys) into the wizard's box
  await ev(s, `${WIZ}.querySelector('#cta').focus()`);
  const passage = ((await ev(s, `${WIZ}.querySelector('#cpass') ? ${WIZ}.querySelector('#cpass').textContent : ''`)) || "").slice(0, 135) || "the quick brown fox jumps over the lazy dog ".repeat(4).slice(0, 135);
  for (const ch of passage) {
    const code = ch === " " ? 32 : /[a-z]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 190;
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, windowsVirtualKeyCode: code }, s);
    await sleep(60 + Math.random() * 50);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: code }, s);
    await sleep(50 + Math.random() * 90);
  }
  ok("the sample is ready to submit", await waitFor(s, `!${WIZ}.querySelector('#cs').disabled`, 5000));
  const t0 = Date.now();
  await ev(s, `${WIZ}.querySelector('#cs').click()`);
  const moved = await waitFor(s, `!/typing/i.test(${wizTitle})`, 15000);
  const secs = (Date.now() - t0) / 1000;
  ok("the last sample does not hold the user: the wizard moves on at once", moved && secs < 8, `${secs.toFixed(1)} s, now: ${await ev(s, wizTitle)}`);
  const st1 = (await gw("/v1/sdk/keystroke/status", null, "GET")).d;
  ok("the server is building the model from its queue", st1.training === true && !st1.trained, `training ${st1.training}, trained ${st1.trained}`);

  // ---- reload while the model is being built ----
  await send("Page.reload", {}, s);
  await sleep(1500);
  await waitFor(s, `!!(${SH})`, 15000);
  await sleep(4000);
  const titleAfter = await ev(s, wizTitle), rowAfter = await ev(s, ksRow);
  const st2 = (await gw("/v1/sdk/keystroke/status", null, "GET")).d;
  ok("after a reload typing is not asked again", !/typing/i.test(titleAfter), `wizard: "${titleAfter}"`);
  ok("…the typing row says the model is being built", /building your model/.test(rowAfter) || st2.trained === true, `row: "${rowAfter}", trained ${st2.trained}`);

  // ---- the model arrives; the page notices by itself ----
  let st3 = st2; const t1 = Date.now();
  while (!st3.trained && Date.now() - t1 < 4 * 60000) { await sleep(4000); st3 = (await gw("/v1/sdk/keystroke/status", null, "GET")).d; if (st3.trainingError) break; }
  ok("the model is built", st3.trained === true, `${((Date.now() - t0) / 1000).toFixed(0)} s after the last sample${st3.trainingError ? ", error " + st3.trainingError : ""}`);
  ok("…and the page's typing row leaves 'building' without a reload", await waitFor(s, `!/building your model/.test(${ksRow})`, 15000), await ev(s, ksRow));
} catch (e) {
  ok("run completed", false, e.message);
} finally {
  try {
    if (token) for (const p of ["/v1/sdk/keystroke/reset", "/v1/sdk/mouse/reset"]) await gw(p);
    if (userId) inService("gateway", ["node", "-e", `fetch(process.env.PASSKEY_API_URL+'/v1/users/${userId}/reset',{method:'POST',headers:{'X-Api-Key':process.env.PASSKEY_API_KEY||''}}).then(r=>console.log('passkey reset',r.status))`]);
    // through the service's own data layer, so it reaches whichever store the service uses (SQLite or PostgreSQL)
    if (userId) inService("ca-service", ["node", "-e", `const db=require('/app/db');db.run('DELETE FROM session_locks WHERE user_id=?', ${userId}).finally(()=>db.close());`]);
    console.log("  cleanup done");
  } catch (e) { console.log("  cleanup: " + e.message); }
  ws.close(); chrome.kill(); await sleep(400); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log(bad ? `\n${bad} CHECK(S) FAILED` : "\nALL RELOAD CHECKS PASSED");
process.exit(bad ? 1 : 0);
