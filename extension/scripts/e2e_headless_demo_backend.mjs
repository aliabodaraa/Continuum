// End-to-end check of the demo app as a TENANT BACKEND: its server calls Continuum only through the
// gateway's tenant API (/v1/server/*), with its site key and identity tokens, never an internal service.
// Real headless Chrome (a throwaway profile, a virtual authenticator) on the demo's own pages:
//   1. a new demo user registers a passkey through the demo's routes; it is stored under the user's
//      CONTINUUM id (the gateway maps the demo's own user number), not the demo's number
//   2. a passkey step-up through the demo's routes; the demo's Continuum reads (typing status, config,
//      history, decisions, metrics, mouse status) answer through the tenant API
//   3. the tenant API itself: identity tokens must be signed with the tenant secret and short-lived;
//      passkeys only for the tenant's own websites; adaptive retraining only with a step-up token from a
//      passkey verified through Continuum, once
//   3b. an impostor at the unlocked session: the browser's own identity token (/continuum/identity, for
//      the SDK) is refused by the tenant API, and so is every call from a browser page; the lock and
//      the passkey stay as they were
//   4. the demo container cannot reach ca-service or passkey-service at all
//   5. a passkey reset through the demo removes the user's credentials
// Everything the test made is removed (the demo user, its passkeys).
//
//   node extension/scripts/e2e_headless_demo_backend.mjs
//   (side-by-side stack: CONTINUUM_GATEWAY=http://localhost:18080 CONTINUUM_DEMO=http://localhost:13000
//    CONTINUUM_CONTAINER_PREFIX=continuum-next)
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080";
const DEMO = process.env.CONTINUUM_DEMO || "http://localhost:3000";
const PREFIX = process.env.CONTINUUM_CONTAINER_PREFIX || "continuum";
const SECRET = process.env.CA_SIGNING_SECRET || "dev-continuum-risk-secret";   // pk_demo's tenant secret in dev
const SITE_KEY = "pk_demo";
const PORT = 9341;
const RUN = crypto.randomBytes(4).toString("hex");
const USER = `zzdemo_${RUN}`, PASS = "e2e-" + crypto.randomBytes(9).toString("hex");
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-demo-e2e-"));

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (x) => Buffer.from(x).toString("base64url");
// A tenant API token by default (aud "continuum-server"); { aud: null } gives a token without one.
function identityToken(sub, { secret = SECRET, exp = Math.floor(Date.now() / 1000) + 120, aud = "continuum-server" } = {}) {
  const payload = { sub: String(sub) };
  if (exp != null) payload.exp = exp;
  if (aud != null) payload.aud = aud;
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" })), p = b64u(JSON.stringify(payload));
  return h + "." + p + "." + crypto.createHmac("sha256", secret).update(h + "." + p).digest("base64url");
}
// The tenant API as the demo's backend calls it.
async function server(method, p, demoUserId, body, tokenOpts, { token, origin } = {}) {
  const headers = { "Content-Type": "application/json", "X-Continuum-Site-Key": SITE_KEY, Authorization: "Bearer " + (token || identityToken(demoUserId, tokenOpts)) };
  if (origin) headers.Origin = origin;
  const r = await fetch(GW + "/v1/server" + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, d };
}
// What the passkey service holds for a user id (read-only, inside its own container).
function credentialsOf(userId) {
  const out = execFileSync("docker", ["exec", "-w", "/app", `${PREFIX}-passkey-service-1`, "node", "-e",
    `const db=require('better-sqlite3')(process.env.DB_PATH||'/app/passkey.db',{readonly:true});console.log(db.prepare('SELECT count(*) n FROM passkey_credentials WHERE user_id=?').get(${Number(userId)}).n)`],
    { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  return Number(out.trim());
}

// ---------- Chrome + a minimal CDP client (as the other e2e suites) ----------
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
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
async function evaluate(sessionId, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(sessionId, expression, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(sessionId, expression)) return true; } catch {} await sleep(300); } return false; }
// fetch on the demo's own origin, with its session cookie
const pageFetch = (sid, p, method = "GET", body) => evaluate(sid, `fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json" }${body !== undefined ? `, body: ${JSON.stringify(JSON.stringify(body))}` : ""} })
  .then(async (r) => ({ status: r.status, d: await r.json().catch(() => ({})) }))`);

let demoUserId = null, continuumId = null;
try {
  console.log(`gateway ${GW}; demo ${DEMO}; run ${RUN}`);
  const { targetId } = await send("Target.createTarget", { url: DEMO + "/login.html" });
  const { sessionId: pg } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, pg);
  await send("WebAuthn.enable", { enableUI: false }, pg);
  await send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }, pg);
  await waitFor(pg, "document.readyState === 'complete' && !!window.SimpleWebAuthnBrowser", 30000);

  console.log("1. a passkey through the demo's routes");
  const reg = await pageFetch(pg, "/api/auth/register", "POST", { username: USER, password: PASS });
  demoUserId = reg.d.userId;
  check("a new demo user signs up", reg.status === 200 && demoUserId, `${reg.status} user ${demoUserId}`);
  const resolved = await fetch(GW + "/v1/resolve", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteKey: SITE_KEY, identityToken: identityToken(demoUserId) }) }).then((r) => r.json());
  continuumId = resolved.continuumUserId;
  const created = await evaluate(pg, `(async () => {
    const o = await fetch("/api/webauthn/register/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((r) => r.json());
    const att = await SimpleWebAuthnBrowser.startRegistration(o);
    const r = await fetch("/api/webauthn/register/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential: att }) });
    return { status: r.status, d: await r.json().catch(() => ({})), rpId: o.rp && o.rp.id };
  })()`);
  check("the demo registers a passkey (its backend through the tenant API)", created.status === 200 && created.d.ok, `${created.status} rp ${created.rpId}`);
  const underContinuum = credentialsOf(continuumId), underDemoNumber = credentialsOf(demoUserId);
  check("the passkey is stored under the user's Continuum id, not the demo's own number", underContinuum === 1 && underDemoNumber === 0,
    `Continuum ${continuumId}: ${underContinuum}, demo ${demoUserId}: ${underDemoNumber}`);

  console.log("2. step-up and reads through the demo's routes");
  const stepUp = await evaluate(pg, `(async () => {
    const o = await fetch("/api/webauthn/auth/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: ${Number(demoUserId)} }) }).then((r) => r.json());
    const a = await SimpleWebAuthnBrowser.startAuthentication(o);
    const r = await fetch("/api/webauthn/auth/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: ${Number(demoUserId)}, challengeId: o.challengeId, assertion: a }) });
    return { status: r.status, d: await r.json().catch(() => ({})) };
  })()`);
  check("a passkey step-up through the demo's routes", stepUp.status === 200 && stepUp.d.ok, `${stepUp.status}`);
  const reads = {};
  for (const p of ["/api/text/config", "/api/text/typing-status", "/api/text/history", "/api/text/stats", "/api/text/decisions", "/api/text/metrics", "/api/mouse/status"]) {
    reads[p] = (await pageFetch(pg, p)).status;
  }
  check("the demo's Continuum reads answer through the tenant API", Object.values(reads).every((s) => s === 200), JSON.stringify(reads));
  const me = await pageFetch(pg, "/api/auth/me");
  check("the demo sees the passkey and the typing status", me.status === 200 && me.d.passkeysRegistered === true && me.d.typingStatus && "trained" in me.d.typingStatus,
    `${me.status} passkey ${me.d.passkeysRegistered}, trained ${me.d.typingStatus && me.d.typingStatus.trained}`);

  console.log("3. the tenant API's own rules");
  const okCall = await server("GET", "/keystroke/status", demoUserId);
  const forged = await server("GET", "/keystroke/status", demoUserId, undefined, { secret: "not-the-tenant-secret" });
  const noExp = await server("GET", "/keystroke/status", demoUserId, undefined, { exp: null });
  const longLived = await server("GET", "/keystroke/status", demoUserId, undefined, { exp: Math.floor(Date.now() / 1000) + 3600 });
  check("the tenant API needs the tenant's signature and a short-lived token", okCall.status === 200 && forged.status === 401 && noExp.status === 401 && longLived.status === 401,
    `signed ${okCall.status}, forged ${forged.status}, no expiry ${noExp.status}, an hour ${longLived.status}`);
  const noSuchRoute = await server("GET", "/admin/settings", demoUserId);
  check("ca-service's operator routes are not part of it", noSuchRoute.status === 404, String(noSuchRoute.status));
  const foreign = await server("POST", "/passkey/auth/options", demoUserId, { origin: "https://evil.example" });
  check("passkeys only for the organisation's own websites", foreign.status === 400 && foreign.d.error === "origin_not_allowed", `${foreign.status} ${foreign.d.error}`);
  const noToken = await server("POST", "/keystroke/adaptive/confirm", demoUserId, {});
  const bogus = await server("POST", "/keystroke/adaptive/confirm", demoUserId, { stepUpToken: "made-up" });
  check("adaptive retraining needs a step-up token", noToken.status === 403 && bogus.status === 403 && bogus.d.error === "passkey_required", `${noToken.status}, ${bogus.status}`);
  // A passkey verified through the tenant API gives a token that works once.
  const own = new URL(DEMO).origin;
  const opts = await server("POST", "/passkey/auth/options", demoUserId, { origin: own });
  const assertion = await evaluate(pg, `SimpleWebAuthnBrowser.startAuthentication(${JSON.stringify(opts.d)})`);
  const done = await server("POST", "/passkey/auth/complete", demoUserId, { origin: own, challengeId: opts.d.challengeId, assertion });
  const first = await server("POST", "/keystroke/adaptive/confirm", demoUserId, { stepUpToken: done.d.stepUpToken });
  const again = await server("POST", "/keystroke/adaptive/confirm", demoUserId, { stepUpToken: done.d.stepUpToken });
  check("a step-up token is accepted once (ca-service answers), then refused", done.status === 200 && !!done.d.stepUpToken
    && first.d.error !== "passkey_required" && again.status === 403 && again.d.error === "passkey_required",
    `verify ${done.status}; first ${first.status} ${first.d.error || ""}; again ${again.status}`);

  console.log("3b. an impostor at the unlocked session");
  const browserToken = (await pageFetch(pg, "/continuum/identity")).d.token;
  const viaBrowserToken = await Promise.all(["/lock/clear", "/passkey/reset", "/keystroke/reset"].map((p) => server("POST", p, demoUserId, {}, undefined, { token: browserToken })));
  check("the browser's own identity token is refused by the tenant API (lock, passkey, profile)", !!browserToken && viaBrowserToken.every((r) => r.status === 401 && r.d.error === "wrong_audience"),
    viaBrowserToken.map((r) => `${r.status} ${r.d.error}`).join(", "));
  const withOrigin = await server("GET", "/passkey/status", demoUserId, undefined, undefined, { origin: DEMO });
  check("a call that comes from a browser page is refused, even with a valid server token", withOrigin.status === 403 && withOrigin.d.error === "browser_not_allowed", `${withOrigin.status} ${withOrigin.d.error}`);
  const fromPage = await evaluate(pg, `fetch(${JSON.stringify(GW + "/v1/server/passkey/reset")}, { method: "POST", headers: { "Content-Type": "application/json", "X-Continuum-Site-Key": "pk_demo",
    Authorization: "Bearer " + ${JSON.stringify(browserToken)} }, body: "{}" }).then((r) => "HTTP " + r.status, (e) => "blocked: " + e.message)`);
  check("…and the page itself cannot call it", fromPage !== "HTTP 200", fromPage);
  check("the passkey is still there after all of that", credentialsOf(continuumId) === 1, `${credentialsOf(continuumId)} credential(s)`);

  console.log("4. the demo has no route to an internal service");
  const reach = execFileSync("docker", ["exec", `${PREFIX}-web-1`, "node", "-e",
    "Promise.all(['http://ca-service:4100/health','http://passkey-service:4000/health','http://gateway:8080/health'].map(u=>fetch(u).then(r=>r.status,e=>(e.cause&&e.cause.code)||e.message))).then(r=>console.log(JSON.stringify(r)))"],
    { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).trim();
  const [toCa, toPk, toGw] = JSON.parse(reach);
  check("the demo cannot reach ca-service or passkey-service; it reaches the gateway", toCa !== 200 && toPk !== 200 && toGw === 200, `ca ${toCa}, passkey ${toPk}, gateway ${toGw}`);

  console.log("5. reset");
  const reset = await pageFetch(pg, "/api/webauthn/register/reset", "POST", {});
  check("a passkey reset through the demo removes the user's credentials", reset.status === 200 && credentialsOf(continuumId) === 0, `${reset.status}, left ${credentialsOf(continuumId)}`);
  check("no uncaught exception on the page", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));
} catch (e) {
  check("run completed", false, e.message);
} finally {
  try { if (continuumId) await server("POST", "/passkey/reset", demoUserId, {}); } catch {}
  try {
    if (demoUserId) execFileSync("docker", ["exec", "-w", "/app", `${PREFIX}-web-1`, "node", "-e",
      `const db=require('better-sqlite3')(process.env.DB_PATH||'/app/db/continuum.db');db.prepare('DELETE FROM users WHERE id=? AND username=?').run(${Number(demoUserId)},${JSON.stringify(USER)});console.log('demo user removed')`],
      { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  } catch (e) { console.log("  cleanup: " + e.message); }
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  await sleep(500);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL DEMO-BACKEND CHECKS PASSED");
process.exit(failures ? 1 : 0);
