// Buttons on the gateway's pages whose action the server would refuse (2026-11-25), in real headless Chrome without a
// server: the pages are served from this checkout and every request is answered here (http://gw.test), so nothing is
// written anywhere. Each check names the finding it covers.
//   node services/gateway/scripts/headless_page_actions.mjs
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PUB = path.join(ROOT, "services", "gateway", "public");
const GW = "http://gw.test", PORT = 9415;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d != null && !c ? " — " + d : "")); if (!c) bad++; };

// ---- the simulated gateway; each scenario changes `sim` before it opens a page
const EXT = "abcdefghijklmnopabcdefghijklmnop";
const org = (k, o) => Object.assign({ siteKey: k, name: k.slice(3), status: "active", origins: ["https://" + k.slice(3) + ".example"], allowExtension: false, signInUrl: null,
  webhookUrl: null, webhookPublic: null, owner: "dev@acme.example", builtIn: false, serverManaged: false, createdAt: new Date().toISOString(), secretRotatedAt: null }, o || {});
const sim = { config: {}, tenants: [], answers: {}, guard: "", seen: [] };
const baseConfig = () => ({ extensionId: null, autoApprove: false, operatorKeyRequired: true, publicUrl: GW, tenantLimit: 10 });
function api(method, p) {
  const a = sim.answers[method + " " + p];
  if (a) return a;
  if (p === "/v1/console/config") return { status: 200, body: Object.assign(baseConfig(), sim.config) };
  if (p === "/v1/console/me") return { status: 200, body: { email: "dev@acme.example" } };
  if (p === "/v1/console/tenants" && method === "GET") return { status: 200, body: { tenants: sim.tenants } };
  if (/^\/v1\/console\/tenants\/[^/]+\/stats$/.test(p)) return { status: 200, body: { users: 0, anonymous: 0, passkey: 0, typing: 0, mouse: 0, counted: 0 } };
  if (p === "/v1/console/activity") return { status: 200, body: { entries: [] } };
  return null;
}
const SESSION_END = { status: 401, body: { error: "invalid_console_session" } };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
function file(p) {
  // no passkey prompt is reached in these checks: a stand-in for the WebAuthn library
  if (p === "/vendor/simplewebauthn/index.umd.min.js") return { type: TYPES[".js"], body: "window.SimpleWebAuthnBrowser = { startRegistration: () => Promise.reject(new Error('not here')), startAuthentication: () => Promise.reject(new Error('not here')) };" };
  if (p === "/guard.js") return { type: TYPES[".js"], body: sim.guard };
  const f = path.join(PUB, p.replace(/^\//, ""));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return null;
  return { type: TYPES[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) };
}

// ---- Chrome + a minimal CDP client (as headless_ui_lang.mjs)
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-page-actions-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, "--window-size=1366,900",
  "--no-first-run", "--no-default-browser-check", "--lang=en-US", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), errors = [];
const send = (method, params = {}, s) => new Promise((res, rej) => { const i = id++; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return; }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === "Fetch.requestPaused") {
    const { requestId, request } = m.params, u = new URL(request.url), s = m.sessionId;
    const reply = (code, type, body) => send("Fetch.fulfillRequest", { requestId, responseCode: code, body: Buffer.from(body).toString("base64"),
      responseHeaders: [{ name: "Content-Type", value: type }] }, s);
    if (u.host !== "gw.test") return reply(200, "text/css", "");                                   // Google Fonts: none offline
    if (u.pathname.startsWith("/v1/")) sim.seen.push({ call: request.method + " " + u.pathname, auth: request.headers.Authorization || request.headers.authorization || "" });
    const d = api(request.method, u.pathname);
    if (d) return reply(d.status, "application/json", JSON.stringify(d.body));
    const f = file(u.pathname);
    if (f) return reply(200, f.type, f.body);
    return reply(404, "application/json", JSON.stringify({ error: "not_found" }));
  }
});
let current = null;
async function page(url) {
  if (current) await send("Target.closeTarget", { targetId: current }).catch(() => {});
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  current = targetId;
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, s);
  await send("Page.navigate", { url }, s);
  return s;
}
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
async function waitFor(s, expression, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(s, expression)) return true; } catch {} await sleep(100); } return false; }
// a check that cannot be evaluated (an element missing) is a failed check, not the end of the run
const chk = async (s, expression) => { try { return await ev(s, expression); } catch (e) { return false; } };
const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`;
const fill = (sel, value) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
const has = (sel) => `!!document.querySelector(${JSON.stringify(sel)})`;
// The console, signed in, at a route.
async function consoleAt(hash) {
  const s = await page(GW + "/console.html");
  await waitFor(s, has("#authBtn"));
  await ev(s, `sessionStorage.setItem('continuumConsole', 'test-token'); location.hash = ${JSON.stringify(hash)}; location.reload(); true`);
  await waitFor(s, "!!document.querySelector('.shell') && !document.querySelector('#app .spinner')");
  return s;
}
const toasts = "document.querySelectorAll('.toasts .toast').length";

try {
  // ---- 5. the console opened on another host name than the public URL
  sim.config = { publicUrl: "http://localhost:8080" };
  let s = await page(GW + "/console.html#/organisations");
  await waitFor(s, has("#authBtn"));
  ok("5. another address: the sign-in button is off", await chk(s, "document.getElementById('authBtn').disabled"));
  ok("5. …and the page names the public address, as a link", await chk(s, "(() => { const a = document.querySelector('#authElsewhere a'); return !!a && a.href === 'http://localhost:8080/console.html#/organisations' && a.textContent === 'http://localhost:8080'; })()"),
    await chk(s, "document.querySelector('#authElsewhere') && document.querySelector('#authElsewhere').innerHTML"));
  await ev(s, click("#authSwitch")); await sleep(100);
  ok("5. …on the create-account form too", await chk(s, "document.getElementById('authBtn').disabled && !!document.getElementById('authElsewhere')"));
  sim.config = {};
  s = await page(GW + "/console.html");
  await waitFor(s, has("#authBtn"));
  ok("5. on the public address: the button is on, no notice", await chk(s, "!document.getElementById('authBtn').disabled && !document.getElementById('authElsewhere')"));

  // ---- 8. the organisation limit
  sim.tenants = Array.from({ length: 10 }, (_, i) => org("pk_org" + i));
  s = await consoleAt("#/organisations");
  await waitFor(s, has("tbody tr"));
  ok("8. ten organisations: 'New organisation' is off, with the reason", await chk(s, "(() => { const b = document.getElementById('newOrgBtn'); return !b.hasAttribute('href') && b.getAttribute('aria-disabled') === 'true' && !!document.getElementById('limitNote'); })()"));
  ok("8. …the reason names the limit and the way out", await chk(s, "/limit of organisations/.test(document.getElementById('limitNote').textContent) && /Delete or revoke one/.test(document.getElementById('limitNote').textContent)"));
  await ev(s, "location.hash = '#/organisations/new'; true"); await sleep(400);
  ok("8. …and the wizard's address leads back to the list", await chk(s, "location.hash === '#/organisations' && !document.getElementById('wName') && !!document.getElementById('limitNote')"));
  sim.tenants = Array.from({ length: 9 }, (_, i) => org("pk_org" + i)).concat(org("pk_gone", { status: "revoked" }));
  s = await consoleAt("#/organisations");
  await waitFor(s, has("tbody tr"));
  ok("8. nine, and one revoked (not counted): the button works", await chk(s, "document.getElementById('newOrgBtn').getAttribute('href') === '#/organisations/new' && !document.getElementById('limitNote')"));

  // ---- 11. websites: an empty list with the extension off can't be saved
  sim.tenants = [org("pk_one"), org("pk_ext", { origins: ["https://ext.example", "chrome-extension://" + EXT], allowExtension: true, signInUrl: "https://ext.example/continuum/link" })];
  s = await consoleAt("#/organisations/pk_one/websites");
  await waitFor(s, has("#sitesSave"));
  await ev(s, click(".chip-item button")); await sleep(50);
  ok("11. the last website removed, no extension: Save stays off", await chk(s, "document.getElementById('sitesSave').disabled"));
  await ev(s, fill("#siteInput", "https://new.example")); await ev(s, click("#siteAdd")); await sleep(50);
  ok("11. …a website added: Save is on", await chk(s, "!document.getElementById('sitesSave').disabled"));
  s = await consoleAt("#/organisations/pk_ext/websites");
  await waitFor(s, has("#sitesSave"));
  await ev(s, click(".chip-item button")); await sleep(50);
  ok("11. the extension allowed: an empty website list may be saved", await chk(s, "!document.getElementById('sitesSave').disabled"));

  // ---- 1. the Extension tab shows the id the organisation has (the server keeps it when the field is left as it is)
  s = await consoleAt("#/organisations/pk_ext/extension");
  await waitFor(s, has("#extId"));
  ok("1. Extension tab: the field shows the stored id", await chk(s, `document.getElementById('extId').value === '${EXT}'`), await chk(s, "document.getElementById('extId').value"));

  // ---- 1. the wizard asks for the extension's id on its own step
  s = await consoleAt("#/organisations/new");
  await waitFor(s, has("#wName"));
  await ev(s, fill("#wName", "Acme")); await ev(s, click("#wNext")); await waitFor(s, has("#wSiteInput"));
  await ev(s, fill("#wSiteInput", "https://app.acme.example")); await ev(s, click("#wSiteAdd")); await ev(s, click("#wNext")); await waitFor(s, has("#wExt"));
  await ev(s, "(() => { const c = document.getElementById('wExt'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()");
  await ev(s, fill("#wSignIn", "https://app.acme.example/continuum/link")); await ev(s, click("#wNext")); await sleep(100);
  ok("1. wizard: no id and none on the server, the step says so and stays", await chk(s, "/extension's id/.test(document.getElementById('wErr').textContent) && !!document.getElementById('wExt') && !document.getElementById('wHook')"),
    await chk(s, "document.getElementById('wErr').textContent"));
  await ev(s, fill("#wExtId", EXT)); await ev(s, click("#wNext")); await sleep(100);
  ok("1. …with the id it goes on", await chk(s, has("#wHook")));

  // ---- 9. a stored webhook that isn't public: no test button
  sim.tenants = [org("pk_hook", { webhookUrl: "http://receiver.internal/events", webhookPublic: false }), org("pk_pub", { webhookUrl: "https://hooks.example.com/x", webhookPublic: true })];
  s = await consoleAt("#/organisations/pk_hook/alerts");
  await waitFor(s, has("#hookTest"));
  ok("9. not public: 'Send test alert' is off, with a note", await chk(s, "document.getElementById('hookTest').disabled && /only to public/.test(document.getElementById('hookNotPublic').textContent)"));
  s = await consoleAt("#/organisations/pk_pub/alerts");
  await waitFor(s, has("#hookTest"));
  ok("9. public: the button is on, no note", await chk(s, "!document.getElementById('hookTest').disabled && !document.getElementById('hookNotPublic')"));

  // ---- 7. the console's session ends
  sim.tenants = [org("pk_one")];
  s = await consoleAt("#/organisations/pk_one/keys");
  await waitFor(s, has("#rotateBtn"));
  await ev(s, click("#rotateBtn")); await waitFor(s, has(".modal-back"));
  sim.answers["POST /v1/console/tenants/pk_one/rotate"] = SESSION_END;
  await ev(s, click("#rotateConfirm"));
  await waitFor(s, has("#authBtn"));
  await sleep(500);
  ok("7. a session that ends under an open window: the window closes, the sign-in shows", await chk(s, "!document.querySelector('.modal-back') && !!document.getElementById('authBtn')"));
  ok("7. …with one message", (await chk(s, toasts)) === 1, await chk(s, toasts));
  s = await consoleAt("#/organisations/pk_one/settings");
  await waitFor(s, has("#deleteBtn"));
  await ev(s, click("#deleteBtn")); await waitFor(s, has("#deleteConfirm"));
  await ev(s, fill("#deleteConfirm", "one"));
  sim.answers["POST /v1/console/tenants/pk_one/delete"] = SESSION_END;
  sim.seen = [];
  await ev(s, click("#deleteGo"));
  await waitFor(s, has("#authBtn"));
  await sleep(800);
  ok("7. the delete window: closed, one message", await chk(s, "!document.querySelector('.modal-back')") && (await chk(s, toasts)) === 1, await chk(s, toasts));
  ok("7. …and the page asks the server nothing more after the session ended", sim.seen.filter((x) => x.call.startsWith("GET /v1/console")).length === 0, JSON.stringify(sim.seen.map((x) => x.call)));
  delete sim.answers["POST /v1/console/tenants/pk_one/rotate"]; delete sim.answers["POST /v1/console/tenants/pk_one/delete"];
  // an expired token found at load: the account and the list both get 401, one message
  sim.answers["GET /v1/console/me"] = SESSION_END; sim.answers["GET /v1/console/tenants"] = SESSION_END;
  s = await page(GW + "/console.html");
  await waitFor(s, has("#authBtn"));
  await ev(s, "sessionStorage.setItem('continuumConsole', 'old-token'); location.hash = '#/organisations'; location.reload(); true");
  await sleep(300); await waitFor(s, has("#authBtn")); await sleep(500);
  ok("7. an expired session at load: two refused calls, one message", (await chk(s, toasts)) === 1 && (await chk(s, "sessionStorage.getItem('continuumConsole')")) === null, await chk(s, toasts));
  delete sim.answers["GET /v1/console/me"]; delete sim.answers["GET /v1/console/tenants"];

  // ---- 4. the extension's enrolment page asks only for the channels that are on
  const token = "x." + Buffer.from(JSON.stringify({ sub: 1, sk: "pk_demo" })).toString("base64url") + ".y";
  sim.guard = "(function () { var s = document.currentScript; window.__attrs = { ks: s.getAttribute('data-keystroke'), ms: s.getAttribute('data-mouse'), ob: s.getAttribute('data-onboarding') }; window.Continuum = { onReady: function () {} }; })();";
  sim.answers["GET /v1/sdk/keystroke/config"] = { status: 200, body: { keystroke: "off", mouse: "on", managed: [] } };
  sim.seen = [];
  s = await page(GW + "/connect.html?mode=enrol#s=" + encodeURIComponent(token));
  await waitFor(s, "!!window.__attrs");
  const a1 = await ev(s, "window.__attrs");
  ok("4. typing off: the SDK is loaded with typing off and the mouse on", a1 && a1.ks === "off" && a1.ms === "on" && a1.ob === "eager", JSON.stringify(a1));
  ok("4. …the plan lists the passkey and the mouse only", await chk(s, "[...document.querySelectorAll('#plan li b')].map((b) => b.textContent).join('|') === 'A passkey|Your mouse'"), await chk(s, "document.getElementById('plan').textContent"));
  ok("4. …asked with the session the extension passed", sim.seen.some((x) => x.call === "GET /v1/sdk/keystroke/config" && x.auth === "Bearer " + token), JSON.stringify(sim.seen));
  sim.answers["GET /v1/sdk/keystroke/config"] = { status: 503, body: { error: "upstream_unreachable" } };
  s = await page(GW + "/connect.html?mode=enrol#s=" + encodeURIComponent(token));
  await waitFor(s, "!!window.__attrs");
  const a2 = await ev(s, "window.__attrs");
  ok("4. settings unreadable: both channels, as before", a2 && a2.ks === "on" && a2.ms === "on" && (await chk(s, "document.querySelectorAll('#plan li').length")) === 3, JSON.stringify(a2));
  delete sim.answers["GET /v1/sdk/keystroke/config"];
  s = await page(GW + "/connect.html?mode=verify&reason=mouse#s=" + encodeURIComponent(token));
  await waitFor(s, "!!window.__attrs");
  const a3 = await ev(s, "window.__attrs");
  ok("4. the verify page still loads the SDK with both channels off", a3 && a3.ks === "off" && a3.ms === "off", JSON.stringify(a3));

  // ---- 13. the offer to record real mouse use goes when it lapses
  sim.guard = "window.Continuum = { onReady: function (cb) { setTimeout(cb, 10); }, requireStepUp: function (r, ok) { setTimeout(function () { ok({ verified: true, mouseUseSample: { offer: true, expiresInMs: 6500 } }); }, 10); } };";
  s = await page(GW + "/connect.html?mode=verify&reason=mouse#s=" + encodeURIComponent(token));
  await waitFor(s, "!document.getElementById('useAsk').classList.contains('hidden')", 5000);
  ok("13. after the passkey the page asks whether to record", await chk(s, "!document.getElementById('useAsk').classList.contains('hidden')"));
  await sleep(2200);
  ok("13. …and the question goes when the extension would no longer take a yes", await chk(s, "document.getElementById('useAsk').classList.contains('hidden') && /Your session is unlocked; you can close this tab/.test(document.getElementById('lead').textContent)"),
    await chk(s, "document.getElementById('lead').textContent"));

  // ---- 6. the extension's sign-in page after its link expired
  sim.answers["POST /v1/link/start"] = { status: 200, body: { linkId: "L1", kind: "personal", tenantName: "Continuum Personal", signInUrl: null } };
  sim.answers["POST /v1/accounts/register/options"] = { status: 400, body: { error: "link_expired" } };
  s = await page(GW + "/connect.html?mode=link&k=pk_personal&cc=" + "A".repeat(43));
  await waitFor(s, "!document.getElementById('personal').classList.contains('hidden')");
  await ev(s, fill("#email", "me@example.com")); await ev(s, click("#accountBtn"));
  await waitFor(s, "/expired/.test(document.getElementById('status').textContent)");
  ok("6. the link expired: the message, and the button stays off", await chk(s, "document.getElementById('accountBtn').disabled"), await chk(s, "document.getElementById('status').textContent"));
  sim.answers["POST /v1/accounts/register/options"] = { status: 409, body: { error: "email_taken" } };
  s = await page(GW + "/connect.html?mode=link&k=pk_personal&cc=" + "A".repeat(43));
  await waitFor(s, "!document.getElementById('personal').classList.contains('hidden')");
  await ev(s, fill("#email", "me@example.com")); await ev(s, click("#accountBtn"));
  await waitFor(s, "/already an account/.test(document.getElementById('status').textContent)");
  ok("6. another refusal (email taken): the button is on again", await chk(s, "!document.getElementById('accountBtn').disabled"));
  delete sim.answers["POST /v1/link/start"]; delete sim.answers["POST /v1/accounts/register/options"];

  // ---- 12. the operator's sign-in during the pause after wrong keys
  sim.answers["GET /v1/tenants"] = { status: 429, body: { error: "too_many_attempts", retryAfterSec: 2 } };
  s = await page(GW + "/operator.html");
  await waitFor(s, has("#opSignIn"));
  await ev(s, fill("#opKey", "wrong")); await ev(s, click("#opSignIn"));
  await waitFor(s, "/paused/.test(document.getElementById('opMsg').textContent)");
  ok("12. paused: the button stays off", await chk(s, "document.getElementById('opSignIn').disabled"));
  await sleep(2400);
  ok("12. …and comes back when the pause ends", await chk(s, "!document.getElementById('opSignIn').disabled"));
  sim.answers["GET /v1/tenants"] = { status: 401, body: { error: "invalid_admin_key", attemptsLeft: 3 } };
  s = await page(GW + "/operator.html");
  await waitFor(s, has("#opSignIn"));
  await ev(s, fill("#opKey", "wrong")); await ev(s, click("#opSignIn"));
  await waitFor(s, "/not right/.test(document.getElementById('opMsg').textContent)");
  ok("12. a wrong key outside a pause: the button is on at once", await chk(s, "!document.getElementById('opSignIn').disabled"));

  ok("no script errors on the pages", errors.length === 0, errors.join(" | "));
} catch (e) {
  bad++; console.log("  FAIL  " + (e && e.stack || e));
} finally {
  try { ws.close(); } catch (e) { /* closed */ }
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* Chrome may still hold it */ }
}
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
