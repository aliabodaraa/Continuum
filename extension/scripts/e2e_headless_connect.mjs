// End-to-end check of how people and organisations get into Continuum, in real headless Chrome with a
// throwaway profile, against the running stack (gateway :8080, demo :3000, ca-service, passkey-service):
//   1. security: unverified "id:"/"acct:" identities are refused; the sign-in endpoints refuse foreign
//      origins, bad challenges, a wrong verifier (and burn the code), identity tokens for another link;
//      refresh and console tokens are never sessions
//   2. PERSONAL sign-in through the extension: a Continuum account (email + passkey, virtual
//      authenticator) made on the gateway's /connect.html; the extension redeems the code with PKCE,
//      opens enrolment, and the enrolment page runs as that user; sign-out revokes the refresh token;
//      signing in again with the same passkey returns the same user
//   3. ORGANISATION sign-in: "Sign in with Demo" — the demo's own login page, then @continuum/node's
//      /continuum/link; the extension ends up as the SAME Continuum user the demo itself uses for that
//      account (so that user's enrolled samples are used, without enrolling again)
//   4. the developer console (/console.html): an organisation signs up through the wizard, its tenant
//      waits for approval, the operator approves it on /operator.html (admin key; the page and the
//      admin API answer only on this machine's own address), the secret rotates, user counts and the
//      activity log are there, webhooks must be public, another account cannot touch it, revoking
//      (typing the organisation's name) stops it, the operator can hand it to another account, and
//      deleting it removes it with its users
//   5. settings: the operator's defaults and the organisation's own protection settings, their
//      precedence, the "on-demand enrolment needs the panel" rule, and the server enforcing them
//      (a channel turned off is refused; adaptive retraining off; the panel hidden in the SDK)
// Everything the test created is removed at the end (accounts, their passkeys and tenants, the demo user).
//
//   node extension/scripts/e2e_headless_connect.mjs
import { execFileSync, spawn } from "node:child_process";
import nodeHttp from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const ROOT = path.resolve(EXT, "..");
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const GW = process.env.CONTINUUM_GATEWAY || "http://localhost:8080";
const DEMO = process.env.CONTINUUM_DEMO || "http://localhost:3000";
const PORT = 9339;
const RUN = Math.random().toString(36).slice(2, 8);
const EMAIL = `e2e-personal-${RUN}@example.invalid`, EMAIL_A = `e2e-orgadmin-${RUN}@example.invalid`, EMAIL_B = `e2e-other-${RUN}@example.invalid`;
const FAKE_SUB = `e2e-nobody-${RUN}`;   // a demo user id that does not exist: the API checks touch no real account
const DEMO_USER = `zze2e_${RUN}`, DEMO_PASS = "e2e-" + crypto.randomBytes(9).toString("hex");
const DEMO_SECRET = process.env.CA_SIGNING_SECRET || "dev-continuum-risk-secret";   // the demo tenant's secret in dev
const envFile = (() => { try { return fs.readFileSync(path.join(ROOT, ".env"), "utf8"); } catch { return ""; } })();
const ADMIN_KEY = process.env.GATEWAY_ADMIN_KEY || (envFile.match(/^GATEWAY_ADMIN_KEY=(.*?)\s*$/m) || [])[1] || "";
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-connect-e2e-"));
// The gateway's identity records: identity.json (STORAGE=json), or, when CONTINUUM_GATEWAY_PG names the
// PostgreSQL container of a side-by-side stack (docker-compose.side-by-side.yml), its gw_identities table.
// Containers the test acts on directly; defaults are the running stack's. For the side-by-side stack
// (project continuum-next) set CONTINUUM_CONTAINER_PREFIX=continuum-next.
const PREFIX = process.env.CONTINUUM_CONTAINER_PREFIX || "continuum";
const GW_PG = process.env.CONTINUUM_GATEWAY_PG || "";
const GW_PG_DB = process.env.CONTINUUM_GATEWAY_PG_DB || "gateway";   // the gateway's own database (and login)
function identityKeys() {
  if (!GW_PG) return Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "services", "gateway", "identity.json"), "utf8")).users);
  const out = execFileSync("docker", ["exec", GW_PG, "psql", "-U", GW_PG_DB, "-d", GW_PG_DB, "-tAc", "SELECT key FROM gw_identities"], { encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(url, { method = "GET", body, headers = {}, form } = {}) {
  const h = { ...headers };
  let b;
  if (form) { h["Content-Type"] = "application/x-www-form-urlencoded"; b = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { h["Content-Type"] = "application/json"; b = JSON.stringify(body); }
  const r = await fetch(url, { method, headers: h, body: b, redirect: "manual" });
  const text = await r.text();
  let d = {}; try { d = JSON.parse(text); } catch {}
  return { status: r.status, d, location: r.headers.get("location") || "" };
}
// A request with another Host header (fetch cannot set it): how the gateway looks from outside this machine.
function asHost(url, host, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const r = nodeHttp.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers: { ...headers, Host: host } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    r.on("error", () => resolve({ status: 0, body: "" }));
    r.end();
  });
}
const gw = (p, opts = {}) => http(GW + p, { ...opts, headers: { Origin: GW, ...(opts.headers || {}) } });
const admin = (p, opts = {}) => gw(p, { ...opts, headers: { ...(opts.headers || {}), ...(ADMIN_KEY ? { "X-Admin-Key": ADMIN_KEY } : {}) } });
const b64u = (x) => Buffer.from(x).toString("base64url");
function identityToken(secret, payload) {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" })), p = b64u(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 120, ...payload }));
  return h + "." + p + "." + crypto.createHmac("sha256", secret).update(h + "." + p).digest("base64url");
}
const pkce = () => { const v = crypto.randomBytes(32).toString("base64url"); return { v, c: crypto.createHash("sha256").update(v).digest("base64url") }; };

// ---------- Chrome + a minimal CDP client (as e2e_headless_study.mjs) ----------
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`,
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, "--window-size=1600,1000",
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
async function waitFor(sessionId, expression, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(sessionId, expression)) return true; } catch {} await sleep(300); } return false; }
async function authenticator(sessionId, creds = []) {
  await send("WebAuthn.enable", { enableUI: false }, sessionId);
  const { authenticatorId } = await send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal",
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }, sessionId);
  for (const c of creds) await send("WebAuthn.addCredential", { authenticatorId, credential: c }, sessionId);
  return authenticatorId;
}
const fill = (sel, value) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`;
const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.disabled || e.offsetParent === null) return false; e.click(); return true; })()`;
const text = (sel) => `(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`;
const storageGet = (key) => evaluate(sw, `new Promise(r => chrome.storage.local.get(${JSON.stringify(key)}, d => r(d[${JSON.stringify(key)}] || null)))`);

let sw = null, extId = "", demoUserId = null, settingsRestore = null;
const made = [];   // account emails to delete at the end
try {
  const swT = await target((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
  extId = new URL(swT.url).host;
  sw = await attach(swT.targetId);
  console.log(`extension ${extId}; gateway ${GW}; demo ${DEMO}`);
  const cfg = (await gw("/v1/console/config")).d;
  check("the gateway knows this extension's id (CONTINUUM_EXTENSION_ID)", cfg.extensionId === extId, `${cfg.extensionId} vs ${extId}`);

  // ---- 1. security ----
  console.log("1. security");
  for (const ext of ["id:1", "acct:a_x", "ID:1"]) {
    const r = await gw("/v1/sdk/session", { method: "POST", body: { siteKey: "pk_demo", externalId: ext } });
    check(`an unverified "${ext}" is refused as a session identity`, r.status === 400 && r.d.error === "reserved_external_id", `${r.status} ${r.d.error || ""}`);
  }
  const foreign = await http(GW + "/v1/link/start", { method: "POST", body: { siteKey: "pk_demo", codeChallenge: pkce().c }, headers: { Origin: "https://evil.example" } });
  check("sign-in cannot be started from another origin", foreign.status === 403, String(foreign.status));
  const badCc = await gw("/v1/link/start", { method: "POST", body: { siteKey: "pk_demo", codeChallenge: "short" } });
  check("sign-in needs a proper S256 code challenge", badCc.status === 400, String(badCc.status));
  // A code, the right way, straight against the API (the demo's secret stands in for its backend).
  const k1 = pkce();
  const st = await gw("/v1/link/start", { method: "POST", body: { siteKey: "pk_demo", codeChallenge: k1.c } });
  check("an organisation sign-in starts and names the organisation's sign-in page", st.status === 200 && st.d.kind === "organisation" && /\/continuum\/link\?continuum_link=/.test(st.d.signInUrl || ""), st.d.signInUrl);
  const other = await gw("/v1/link/start", { method: "POST", body: { siteKey: "pk_demo", codeChallenge: pkce().c } });
  const wrongLink = await http(GW + "/v1/link/callback", { method: "POST", form: { link: st.d.linkId, identity_token: identityToken(DEMO_SECRET, { sub: FAKE_SUB, link: other.d.linkId }) } });
  check("an identity token bound to another sign-in is refused", /mode=error/.test(wrongLink.location), wrongLink.location);
  const forged = await http(GW + "/v1/link/callback", { method: "POST", form: { link: st.d.linkId, identity_token: identityToken("not-the-secret", { sub: FAKE_SUB, link: st.d.linkId }) } });
  check("an identity token not signed with the organisation's secret is refused", /mode=error/.test(forged.location), forged.location);
  const cb = await http(GW + "/v1/link/callback", { method: "POST", form: { link: st.d.linkId, identity_token: identityToken(DEMO_SECRET, { sub: FAKE_SUB, link: st.d.linkId }) } });
  const code = new URL(cb.location, GW).searchParams.get("code");
  check("the organisation's signed identity gives a one-time code", /mode=done/.test(cb.location) && !!code, cb.location.replace(/code=[^&]+/, "code=…"));
  const extO = { Origin: "chrome-extension://" + extId };
  const wrongV = await http(GW + "/v1/link/token", { method: "POST", body: { linkId: st.d.linkId, code, codeVerifier: pkce().v }, headers: extO });
  const rightV = await http(GW + "/v1/link/token", { method: "POST", body: { linkId: st.d.linkId, code, codeVerifier: k1.v }, headers: extO });
  check("a wrong PKCE verifier is refused, and burns the code", wrongV.status === 400 && rightV.status === 400, `${wrongV.status}, then ${rightV.status}`);
  const k2 = pkce();
  const st2 = await gw("/v1/link/start", { method: "POST", body: { siteKey: "pk_demo", codeChallenge: k2.c } });
  const cb2 = await http(GW + "/v1/link/callback", { method: "POST", form: { link: st2.d.linkId, identity_token: identityToken(DEMO_SECRET, { sub: FAKE_SUB, link: st2.d.linkId }) } });
  const tok = await http(GW + "/v1/link/token", { method: "POST", body: { linkId: st2.d.linkId, code: new URL(cb2.location, GW).searchParams.get("code"), codeVerifier: k2.v }, headers: extO });
  check("the right verifier redeems the code: session + refresh token", tok.status === 200 && !!tok.d.token && !!tok.d.refreshToken, `${tok.status}`);
  const again = await http(GW + "/v1/link/token", { method: "POST", body: { linkId: st2.d.linkId, code: new URL(cb2.location, GW).searchParams.get("code"), codeVerifier: k2.v }, headers: extO });
  check("a code redeems once", again.status === 400, String(again.status));
  const asSession = await gw("/v1/sdk/onboarding", { headers: { Authorization: "Bearer " + tok.d.refreshToken } });
  check("a refresh token is not a session", asSession.status === 401, String(asSession.status));
  const viaRefresh = await http(GW + "/v1/sdk/session", { method: "POST", body: { siteKey: "pk_demo", refreshToken: tok.d.refreshToken }, headers: extO });
  check("the refresh token mints a session for the same user", viaRefresh.status === 200 && viaRefresh.d.userId === tok.d.userId, `${viaRefresh.d.userId} vs ${tok.d.userId}`);
  const otherTenant = await http(GW + "/v1/sdk/session", { method: "POST", body: { siteKey: "pk_personal", refreshToken: tok.d.refreshToken }, headers: extO });
  check("a refresh token works only for its own tenant", otherTenant.status === 401, String(otherTenant.status));
  await http(GW + "/v1/link/revoke", { method: "POST", body: { refreshToken: tok.d.refreshToken } });
  const revoked = await http(GW + "/v1/sdk/session", { method: "POST", body: { siteKey: "pk_demo", refreshToken: tok.d.refreshToken }, headers: extO });
  check("a revoked refresh token is refused", revoked.status === 401, String(revoked.status));

  // ---- 2. personal sign-in through the extension ----
  console.log("2. personal account through the extension");
  const optT = await target((t) => t.type === "page" && t.url.includes(extId + "/src/options.html"), 40).catch(() => null);
  check("first install opens the settings page", !!optT);
  let opt = optT ? await attach(optT.targetId) : null;
  if (opt) check("the settings page shows the sign-in choices", await waitFor(opt, "!document.getElementById('signedOut').classList.contains('hidden')", 10000));
  await evaluate(sw, `startSignIn(${JSON.stringify(GW)}, "pk_personal").then(() => true)`);
  const linkT = await target((t) => t.type === "page" && t.url.includes("/connect.html?mode=link"));
  let pg = await attach(linkT.targetId);
  const authId = await authenticator(pg);
  check("the personal sign-in page offers an account", await waitFor(pg, "!document.getElementById('personal').classList.contains('hidden')", 15000));
  await evaluate(pg, fill("#email", EMAIL));
  made.push(EMAIL);
  await evaluate(pg, click("#accountBtn"));
  // Keep a copy of the passkey for the second sign-in: the window closes itself as soon as the
  // extension has redeemed the code, and its virtual authenticator goes with it.
  let acc = null, creds = [];
  for (let i = 0; i < 300 && !acc; i++) {
    await sleep(100);
    if (!creds.length) creds = (await send("WebAuthn.getCredentials", { authenticatorId: authId }, pg).catch(() => ({ credentials: [] }))).credentials;
    if (i % 5 === 4) acc = await storageGet("cg_account");
  }
  check("creating the account signs the extension in (code redeemed with PKCE)", !!acc && acc.kind === "personal" && acc.label === EMAIL && !!acc.refreshToken, acc ? `${acc.kind} ${acc.label} user ${acc.userId}` : "no account");
  check("the new account's passkey is registered on the server", !!acc && acc.onboarding && acc.onboarding.passkey === true, JSON.stringify(acc && acc.onboarding));
  const gone = await target((t) => t.targetId === linkT.targetId, 1).then(() => false).catch(() => true);
  check("the sign-in window closes itself", gone || (await sleep(2000), await target((t) => t.targetId === linkT.targetId, 1).then(() => false).catch(() => true)));
  const enrolT = await target((t) => t.type === "page" && t.url.includes("/connect.html?mode=enrol"), 40).catch(() => null);
  check("with typing and mouse missing, enrolment opens", !!enrolT);
  if (enrolT) {
    const ep = await attach(enrolT.targetId);
    check("the session left the address bar", !(await evaluate(ep, "location.hash")), await evaluate(ep, "location.href"));
    const who = await waitFor(ep, `window.Continuum && window.Continuum.userId && String(window.Continuum.userId()) === ${JSON.stringify(String(acc && acc.userId))}`, 20000);
    check("the enrolment page runs as the signed-in user (session handed over)", who);
    const wizard = await waitFor(ep, "(() => { const h = document.getElementById('continuum-guard-host'); return !!(h && h.shadowRoot && h.shadowRoot.querySelector('#cta')); })()", 20000);
    check("it asks for the typing samples next (the passkey is already there)", wizard);
    const passages = wizard ? await evaluate(ep, `(() => { const r = document.getElementById('continuum-guard-host').shadowRoot; const p = r.querySelector('#cpass'); const first = p.textContent; r.querySelector('#cnew').click(); return [first, p.textContent]; })()`) : ["", ""];
    check("the typing step shows a built-in simple passage at once, and “new text” gives another", passages[0].length >= 200 && passages[1].length >= 200 && passages[0] !== passages[1] && /^I |^My |^The |^On /.test(passages[0]), passages.map((p) => p.slice(0, 40)).join(" | "));
    await send("Target.closeTarget", { targetId: enrolT.targetId });
  }
  // popup and settings reflect the sign-in
  const { targetId: popId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/popup/popup.html` });
  const pop = await attach(popId);
  check("the popup shows the account", await waitFor(pop, `document.getElementById('acctLine').textContent.includes(${JSON.stringify(EMAIL)})`, 10000), await evaluate(pop, text("#acctLine")));
  check("the popup offers to finish enrolment", await waitFor(pop, "document.getElementById('enrolBtn').style.display !== 'none'", 5000));
  if (opt) check("the settings page shows who is signed in", await waitFor(opt, `document.getElementById('whoTitle').textContent.includes(${JSON.stringify(EMAIL)})`, 5000));
  // sign out, then back in with the same passkey
  const firstUser = acc && acc.userId, firstRefresh = acc && acc.refreshToken;
  if (opt) await evaluate(opt, click("#signOutBtn"));
  else await evaluate(sw, "new Promise(r => chrome.storage.local.remove('cg_account', () => r(true)))");
  let out = false;
  for (let i = 0; i < 20 && !out; i++) { await sleep(300); out = !(await storageGet("cg_account")); }
  check("sign-out forgets the account", out);
  await sleep(800);
  const oldRefresh = await http(GW + "/v1/sdk/session", { method: "POST", body: { siteKey: "pk_personal", refreshToken: firstRefresh }, headers: extO });
  check("sign-out revokes the refresh token on the server", oldRefresh.status === 401, String(oldRefresh.status));
  check("the popup asks to sign in again", await waitFor(pop, "document.getElementById('setupCard').style.display !== 'none'", 5000));
  await evaluate(sw, `startSignIn(${JSON.stringify(GW)}, "pk_personal").then(() => true)`);
  const link2 = await target((t) => t.type === "page" && t.url.includes("/connect.html?mode=link"));
  pg = await attach(link2.targetId);
  await authenticator(pg, creds.map((c) => ({ ...c, signCount: (c.signCount || 0) + 10 })));
  await waitFor(pg, "!document.getElementById('personal').classList.contains('hidden')", 15000);
  await evaluate(pg, click("#tabOld"));
  await evaluate(pg, fill("#email", EMAIL));
  await evaluate(pg, click("#accountBtn"));
  acc = null;
  for (let i = 0; i < 60 && !acc; i++) { await sleep(500); acc = await storageGet("cg_account"); }
  check("signing in again with the passkey returns the same user", !!acc && acc.userId === firstUser, `${acc && acc.userId} vs ${firstUser}`);
  const dup = await gw("/v1/accounts/register/options", { method: "POST", body: { email: EMAIL, purpose: "console" } });
  check("one account per email", dup.status === 409, String(dup.status));
  for (const t of (await send("Target.getTargets")).targetInfos) if (t.type === "page" && /connect\.html\?mode=enrol/.test(t.url)) await send("Target.closeTarget", { targetId: t.targetId });

  // ---- 3. organisation sign-in: the demo ----
  console.log("3. organisation (demo) through the extension");
  const reg = await http(DEMO + "/api/auth/register", { method: "POST", body: { username: DEMO_USER, password: DEMO_PASS } });
  demoUserId = reg.d.userId;
  check("a test user exists in the demo app", reg.status === 200 && !!demoUserId, `${reg.status} user ${demoUserId}`);
  await evaluate(sw, `startSignIn(${JSON.stringify(GW)}, "pk_demo").then(() => true)`);
  const orgT = await target((t) => t.type === "page" && t.url.includes("/connect.html?mode=link"));
  pg = await attach(orgT.targetId);
  check("the page names the organisation", await waitFor(pg, "document.getElementById('orgBtn').textContent === 'Continue to Demo'", 15000), await evaluate(pg, text("#title")));
  await evaluate(pg, click("#orgBtn"));
  check("it goes to the demo's own login page", await waitFor(pg, `location.href.startsWith(${JSON.stringify(DEMO + "/login.html?next=")})`, 15000), await evaluate(pg, "location.href").catch(() => ""));
  // wait for the page's own script: submitting before its handler is attached posts nothing
  const loginReady = await waitFor(pg, "document.readyState === 'complete' && !!document.getElementById('username')", 30000);
  if (!loginReady) console.log("    login page not ready:", JSON.stringify(await evaluate(pg, "({ url: location.href, state: document.readyState, title: document.title, body: (document.body ? document.body.innerText : '').slice(0, 300) })").catch((e) => e.message)));
  await evaluate(pg, fill("#username", DEMO_USER));
  await evaluate(pg, fill("#password", DEMO_PASS));
  await evaluate(pg, "(() => { document.getElementById('username').form.requestSubmit(); return true; })()");
  acc = null;
  for (let i = 0; i < 60 && !(acc && acc.kind === "organisation"); i++) { await sleep(500); acc = await storageGet("cg_account"); }
  check("after the demo's login the extension is signed in to the Demo organisation", !!acc && acc.kind === "organisation" && acc.tenantName === "Demo" && acc.label === DEMO_USER,
    acc ? `${acc.kind} ${acc.tenantName} ${acc.label}` : "no account");
  const resolved = await http(GW + "/v1/resolve", { method: "POST", body: { siteKey: "pk_demo", identityToken: identityToken(DEMO_SECRET, { sub: String(demoUserId) }) } });
  check("it is the same Continuum user the demo uses for that account (its samples are reused)", !!acc && resolved.d.continuumUserId === acc.userId, `${acc && acc.userId} vs ${resolved.d.continuumUserId}`);
  for (const t of (await send("Target.getTargets")).targetInfos) if (t.type === "page" && /connect\.html\?mode=enrol/.test(t.url)) await send("Target.closeTarget", { targetId: t.targetId });

  // ---- 4. the console and the operator ----
  console.log("4. developer console and operator");
  const ORG_NAME = "E2E Org " + RUN;
  const { targetId: conId } = await send("Target.createTarget", { url: GW + "/console.html" });
  const con = await attach(conId);
  await authenticator(con);
  await waitFor(con, "!!document.getElementById('authSwitch')", 10000);
  await evaluate(con, click("#authSwitch"));
  await waitFor(con, "/Create account/.test(document.getElementById('authBtn').textContent)", 5000);
  await evaluate(con, fill("#authEmail", EMAIL_A));
  made.push(EMAIL_A);
  await evaluate(con, click("#authBtn"));
  check("an organisation's developer creates an account in the console", await waitFor(con, "!!document.getElementById('newOrgBtn')", 20000), await evaluate(con, text("#authMsg")));
  // the four-step wizard
  await evaluate(con, click("#newOrgBtn"));
  await waitFor(con, "!!document.getElementById('wName')", 5000);
  await evaluate(con, fill("#wName", ORG_NAME));
  await evaluate(con, click("#wNext"));
  await waitFor(con, "!!document.getElementById('wSiteInput')", 5000);
  await evaluate(con, fill("#wSiteInput", "http://localhost:4399"));
  await evaluate(con, click("#wSiteAdd"));
  await evaluate(con, click("#wNext"));
  await waitFor(con, "!!document.getElementById('wExt')", 5000);
  await evaluate(con, "(() => { const c = document.getElementById('wExt'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()");
  await waitFor(con, "!!document.getElementById('wSignIn') && document.getElementById('wSignIn').offsetParent !== null", 5000);
  await evaluate(con, fill("#wSignIn", "http://localhost:4399/continuum/link"));
  await evaluate(con, click("#wNext"));
  await waitFor(con, "!!document.getElementById('wHook')", 5000);
  await evaluate(con, click("#wNext"));
  const shown = await waitFor(con, "!!document.querySelector('code.newSecret')", 15000);
  const orgKey = shown ? await evaluate(con, "document.querySelector('code.newSiteKey').dataset.value") : "";
  const orgSecret = shown ? await evaluate(con, "document.querySelector('code.newSecret').dataset.value") : "";
  check("the wizard shows the site key and the secret once", /^pk_[0-9a-f]{18}$/.test(orgKey || "") && /^[0-9a-f]{48}$/.test(orgSecret || ""), orgKey || await evaluate(con, text("#wErr")));
  check("the secret can't be dismissed before ticking “I saved it”", await evaluate(con, "document.getElementById('doneBtn').getAttribute('aria-disabled') === 'true'"));
  await evaluate(con, click("#savedCheck"));
  await evaluate(con, click("#doneBtn"));
  check("then the organisation's page opens", await waitFor(con, "!!document.getElementById('tab-overview')", 10000));
  const conToken = await evaluate(con, "sessionStorage.getItem('continuumConsole')");
  const bearerA = { Authorization: "Bearer " + conToken };
  const mine = await gw("/v1/console/tenants", { headers: bearerA });
  const t0 = (mine.d.tenants || []).find((t) => t.siteKey === orgKey);
  check("the new organisation waits for approval, and admits the extension", !!t0 && t0.status === "pending" && t0.allowExtension === true, t0 && `${t0.status}, ${t0.origins.join(" ")}`);
  const orgO = { Origin: "http://localhost:4399" };
  const pend = await http(GW + "/v1/sdk/session", { method: "POST", body: { siteKey: orgKey }, headers: orgO });
  check("a pending organisation's key does not work yet", pend.status === 403 && pend.d.error === "tenant_pending_approval", `${pend.status} ${pend.d.error}`);
  const noKey = await gw(`/v1/tenants/${orgKey}/status`, { method: "POST", body: { status: "active" } });
  check("approval needs the operator's admin key", !ADMIN_KEY || noKey.status === 401, String(noKey.status));
  // the operator area answers only on this machine's own address
  const opOutside = await asHost(GW + "/operator.html", "continuum.example.com");
  const apiOutside = await asHost(GW + "/v1/tenants", "continuum.example.com", ADMIN_KEY ? { "X-Admin-Key": ADMIN_KEY } : {});
  const opInside = await asHost(GW + "/operator.html", "localhost:8080");
  check("the operator page and admin API are “Not found” from any other address, even with the key", opOutside.status === 404 && apiOutside.status === 404 && opInside.status === 200, `page ${opOutside.status}, api ${apiOutside.status}, local ${opInside.status}`);
  const opProxied = await asHost(GW + "/operator.html", "localhost:8080", { "X-Forwarded-For": "203.0.113.9" });
  check("…and from anyone reaching it through a reverse proxy", opProxied.status === 404, String(opProxied.status));
  if (ADMIN_KEY) {
    // one wrong key only: ten in a row would lock the operator out for 15 minutes (checked by hand)
    const wrong = await gw("/v1/tenants", { headers: { "X-Admin-Key": "not-the-key" } });
    check("a wrong admin key is refused and says how many tries are left", wrong.status === 401 && typeof wrong.d.attemptsLeft === "number" && wrong.d.attemptsLeft < 10, `${wrong.status} ${wrong.d.attemptsLeft}`);
  }
  // the operator approves on /operator.html
  const { targetId: opId } = await send("Target.createTarget", { url: GW + "/operator.html" });
  const op = await attach(opId);
  await waitFor(op, "!!document.getElementById('opKey')", 10000);
  await evaluate(op, fill("#opKey", ADMIN_KEY));
  await evaluate(op, click("#opSignIn"));
  const rowSel = `tr[data-key=${JSON.stringify(orgKey)}]`;
  check("the operator signs in and sees the new organisation", await waitFor(op, `!!document.querySelector(${JSON.stringify(rowSel)})`, 10000), await evaluate(op, text("#opMsg")));
  const approved = await evaluate(op, click(`${rowSel} [data-act=approve]`));
  let act = { status: 0 };
  for (let i = 0; i < 20 && act.status !== 200; i++) { await sleep(300); act = await http(GW + "/v1/sdk/session", { method: "POST", body: { siteKey: orgKey }, headers: orgO }); }
  check("once the operator approves it, the key works", approved && act.status === 200, `${act.status}`);
  check("the operator's list shows it active", await waitFor(op, `/Active/.test((document.querySelector(${JSON.stringify(rowSel)}) || {}).textContent || "")`, 5000));
  // close the operator tab and bring the console back to the front: a passkey prompt needs a focused page
  await send("Target.closeTarget", { targetId: opId });
  await send("Target.activateTarget", { targetId: conId });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, con);
  const wrongOrigin = await http(GW + "/v1/sdk/session", { method: "POST", body: { siteKey: orgKey }, headers: { Origin: "http://localhost:4398" } });
  check("the key works only on the organisation's own websites", wrongOrigin.status === 403, String(wrongOrigin.status));
  const idOld = identityToken(orgSecret, { sub: "u1" });
  const rot = await gw(`/v1/console/tenants/${orgKey}/rotate`, { method: "POST", body: {}, headers: bearerA });
  const withOld = await http(GW + "/v1/sdk/session", { method: "POST", body: { siteKey: orgKey, identityToken: idOld }, headers: orgO });
  const withNew = await http(GW + "/v1/sdk/session", { method: "POST", body: { siteKey: orgKey, identityToken: identityToken(rot.d.secret || "", { sub: "u1" }) }, headers: orgO });
  check("a new secret replaces the old one at once", rot.status === 200 && rot.d.secret !== orgSecret && withOld.status === 401 && withNew.status === 200, `${withOld.status}/${withNew.status}`);
  // counts, activity, webhooks
  const stats = await gw(`/v1/console/tenants/${orgKey}/stats`, { headers: bearerA });
  check("the console counts the organisation's users", stats.status === 200 && typeof stats.d.users === "number" && stats.d.users >= 1, JSON.stringify(stats.d));
  const actA = await gw("/v1/console/activity", { headers: bearerA });
  const did = (actA.d.entries || []).filter((e) => e.siteKey === orgKey).map((e) => e.action);
  check("the activity log records creation, the operator's approval and the new secret", ["organisation.created", "organisation.approved", "secret.rotated"].every((a) => did.includes(a)), did.join(", "));
  const opAct = ADMIN_KEY ? await admin("/v1/admin/activity") : { d: { entries: [] } };
  check("the operator sees it in the whole activity log", (opAct.d.entries || []).some((e) => e.siteKey === orgKey && e.action === "organisation.approved"));
  const noHook = await gw(`/v1/console/tenants/${orgKey}/test-webhook`, { method: "POST", body: {}, headers: bearerA });
  check("“Send test alert” needs a webhook first", noHook.status === 400 && noHook.d.error === "no_webhook", `${noHook.status} ${noHook.d.error}`);
  const hooks = [];
  let allRefused = true;
  for (const w of ["https://localhost/hook", "https://10.1.2.3/hook", "https://gateway:8080/hook", "http://example.com/hook"]) {
    const r = await gw(`/v1/console/tenants/${orgKey}`, { method: "POST", body: { webhookUrl: w }, headers: bearerA });
    hooks.push(`${w} → ${r.status} ${r.d.error || ""}`);
    if (!(r.status === 400 && r.d.error === "webhook_not_public")) allRefused = false;
  }
  check("webhooks must be public https addresses (no localhost, private IPs, internal names or plain http)", allRefused, hooks.join("; "));
  const badConfirm = await gw(`/v1/console/tenants/${orgKey}/revoke`, { method: "POST", body: { confirm: "something else" }, headers: bearerA });

  // ---- 5. settings: operator defaults and the organisation's own ----
  console.log("5. settings");
  const opBefore = ADMIN_KEY ? (await admin("/v1/admin/settings")).d : null;
  const ownOperator = opBefore ? Object.fromEntries(opBefore.defaults.filter((x) => x.source === "operator").map((x) => [x.key, x.value])) : {};
  settingsRestore = () => admin("/v1/admin/settings", { method: "PUT", body: { defaults: { adaptiveGapHours: ownOperator.adaptiveGapHours ?? null } } });
  check("the operator sees defaults, server switches and the environment (secrets hidden)", !!opBefore && opBefore.defaults.length === 8 &&
    opBefore.environment.some((e) => e.name === "GATEWAY_ADMIN_KEY" && e.secret && e.value === null), opBefore && `${opBefore.defaults.length} defaults, ${opBefore.environment.length} env rows`);
  const gapSet = await admin("/v1/admin/settings", { method: "PUT", body: { defaults: { adaptiveGapHours: 2 } } });
  check("the operator changes a default for every organisation", gapSet.status === 200 && gapSet.d.defaults.find((x) => x.key === "adaptiveGapHours").value === 2, String(gapSet.status));
  const lazyHidden = await admin("/v1/admin/settings", { method: "PUT", body: { defaults: { panel: "hide", onboarding: "lazy" } } });
  check("on-demand enrolment with a hidden panel is refused", lazyHidden.status === 400 && lazyHidden.d.error === "lazy_needs_panel", `${lazyHidden.status} ${lazyHidden.d.error}`);
  const orgSet0 = await gw(`/v1/console/tenants/${orgKey}/settings`, { headers: bearerA });
  const gap0 = (orgSet0.d.settings || []).find((x) => x.key === "adaptiveGapHours");
  check("the organisation inherits the operator's default", orgSet0.status === 200 && gap0 && gap0.value === 2 && gap0.source === "operator", gap0 && `${gap0.value} from ${gap0.source}`);
  const orgSet = await gw(`/v1/console/tenants/${orgKey}/settings`, { method: "POST", body: { mouse: "off", panel: "hide", adaptive: "off" }, headers: bearerA });
  check("the organisation sets its own protection (mouse off, panel hidden, no adaptive retraining)", orgSet.status === 200 && orgSet.d.changed.length === 3, `${orgSet.status} ${JSON.stringify(orgSet.d.changed || orgSet.d)}`);
  const orgLazy = await gw(`/v1/console/tenants/${orgKey}/settings`, { method: "POST", body: { onboarding: "lazy" }, headers: bearerA });
  check("…and cannot ask for on-demand enrolment while its panel is hidden", orgLazy.status === 400 && orgLazy.d.error === "lazy_needs_panel", `${orgLazy.status} ${orgLazy.d.error}`);
  const sess = await http(GW + "/v1/sdk/session", { method: "POST", body: { siteKey: orgKey }, headers: orgO });
  const bearerS = { Authorization: "Bearer " + sess.d.token };
  const conf = await http(GW + "/v1/sdk/keystroke/config", { headers: { ...bearerS, Origin: "http://localhost:4399" } });
  check("its pages get its settings, marked as managed", conf.status === 200 && conf.d.panel === "hide" && conf.d.mouse === "off" && conf.d.adaptiveEnabled === false &&
    conf.d.adaptiveMinGapHours === 2 && ["mouse", "panel", "adaptive", "adaptiveGapHours"].every((k) => (conf.d.managed || []).includes(k)), JSON.stringify(conf.d.managed));
  const mouseOff = await http(GW + "/v1/sdk/mouse/check", { method: "POST", body: { windows: [] }, headers: { ...bearerS, Origin: "http://localhost:4399" } });
  check("the server refuses mouse data the organisation turned off", mouseOff.status === 409 && mouseOff.d.error === "mouse_disabled", `${mouseOff.status} ${mouseOff.d.error}`);
  const contribOff = await http(GW + "/v1/sdk/keystroke/contribute", { method: "POST", body: { textContent: "x", keystrokeEvents: [] }, headers: { ...bearerS, Origin: "http://localhost:4399" } });
  check("…and adaptive samples when adaptive retraining is off", contribOff.status === 409 && contribOff.d.error === "adaptive_disabled", `${contribOff.status} ${contribOff.d.error}`);
  const ksOn = await http(GW + "/v1/sdk/keystroke/check", { method: "POST", body: { textLength: 10, keystrokeEvents: [] }, headers: { ...bearerS, Origin: "http://localhost:4399" } });
  check("typing, still on, is not refused", ksOn.status !== 409, String(ksOn.status));
  // "fields never watched": the server drops those fields' keystrokes, whatever a client sends
  const orgEx = await gw(`/v1/console/tenants/${orgKey}/settings`, { method: "POST", body: { excludeFieldTypes: ["hidden", "email"] }, headers: bearerA });
  const confEx = await http(GW + "/v1/sdk/keystroke/config", { headers: { ...bearerS, Origin: "http://localhost:4399" } });
  check("the organisation excludes a field type, and its pages are told", orgEx.status === 200 && (confEx.d.excludeFieldTypes || []).includes("email"), JSON.stringify(confEx.d.excludeFieldTypes));
  const typed = (fieldType) => Array.from({ length: 120 }, (_, i) => [
    { fieldName: "f", fieldType, keyCode: 65 + (i % 26), eventType: "keydown", timestampRelative: i * 180 },
    { fieldName: "f", fieldType, keyCode: 65 + (i % 26), eventType: "keyup", timestampRelative: i * 180 + 90 },
  ]).flat();
  const asText = await http(GW + "/v1/sdk/keystroke/check", { method: "POST", body: { textLength: 120, keystrokeEvents: typed("text") }, headers: { ...bearerS, Origin: "http://localhost:4399" } });
  const asEmail = await http(GW + "/v1/sdk/keystroke/check", { method: "POST", body: { textLength: 120, keystrokeEvents: typed("email") }, headers: { ...bearerS, Origin: "http://localhost:4399" } });
  const wins = (r) => Number(((r.d || {}).typingEvaluation || {}).windowCount || 0);
  check("the server ignores keystrokes typed in an excluded field (same typing: text scored, email dropped)", wins(asText) > 0 && wins(asEmail) === 0, `text ${wins(asText)} windows, email ${wins(asEmail)}`);
  // the typing decision's packet: the organisation picks 6 windows instead of 20 (only measured lengths)
  const orgKwBad = await gw(`/v1/console/tenants/${orgKey}/settings`, { method: "POST", body: { keystrokeDecisionWindows: 7 }, headers: bearerA });
  const orgKw = await gw(`/v1/console/tenants/${orgKey}/settings`, { method: "POST", body: { keystrokeDecisionWindows: 6 }, headers: bearerA });
  const confKw = await http(GW + "/v1/sdk/keystroke/config", { headers: { ...bearerS, Origin: "http://localhost:4399" } });
  const asText6 = await http(GW + "/v1/sdk/keystroke/check", { method: "POST", body: { textLength: 120, keystrokeEvents: typed("text") }, headers: { ...bearerS, Origin: "http://localhost:4399" } });
  check("an organisation can choose a shorter typing decision (6 windows; an unmeasured 7 is refused), and its pages are told", orgKwBad.status === 400 && orgKwBad.d.error === "bad_setting" &&
    orgKw.status === 200 && confKw.d.recentWindowCount === 6 && (confKw.d.managed || []).includes("keystrokeDecisionWindows"), `7 → ${orgKwBad.status} ${orgKwBad.d.error}; 6 → ${orgKw.status}, config ${confKw.d.recentWindowCount}`);
  check("the server decides on the organisation's packet (the same 7 windows: warm-up at 20, a verdict at 6)", asText.d.warmup === true && asText6.d.warmup === false && asText6.d.packetWindows === 6,
    `20: warmup ${asText.d.warmup}; 6: warmup ${asText6.d.warmup}, packet ${asText6.d.packetWindows}`);
  const rtNoPk = await http(GW + "/v1/sdk/keystroke/adaptive/retrain", { method: "POST", body: {}, headers: { ...bearerS, Origin: "http://localhost:4399" } });
  const rtBadPk = await http(GW + "/v1/sdk/keystroke/adaptive/retrain", { method: "POST", body: { challengeId: "nope", assertion: { id: "x", rawId: "x", type: "public-key", response: {} } }, headers: { ...bearerS, Origin: "http://localhost:4399" } });
  check("adaptive retraining needs the passkey in the same request (none / a bogus one are refused)", rtNoPk.status === 400 && rtNoPk.d.error === "passkey_required" && rtBadPk.status >= 400, `${rtNoPk.status} ${rtNoPk.d.error}; bogus ${rtBadPk.status}`);
  const ksStat = await http(GW + "/v1/sdk/keystroke/status", { headers: { ...bearerS, Origin: "http://localhost:4399" } });
  check("the status reports the adaptive cycle", ksStat.status === 200 && ksStat.d.adaptivePending === 0 && ksStat.d.adaptiveReady === false && ksStat.d.adaptiveEnabled === false, JSON.stringify({ p: ksStat.d.adaptivePending, r: ksStat.d.adaptiveReady, e: ksStat.d.adaptiveEnabled }));
  // the SDK on a gateway page, for a user of this organisation: no panel
  const { targetId: sdkId } = await send("Target.createTarget", { url: "about:blank" });
  const sdkP = await attach(sdkId);
  await send("Page.enable", {}, sdkP);
  await send("Page.navigate", { url: `${GW}/connect.html?mode=enrol#s=${encodeURIComponent(sess.d.token)}` }, sdkP);
  const hidden = await waitFor(sdkP, "(() => { const h = document.getElementById('continuum-guard-host'); const p = h && h.shadowRoot && h.shadowRoot.querySelector('.panel'); return !!(p && p.style.display === 'none'); })()", 20000);
  check("the SDK hides its panel for this organisation's users", hidden);
  const noContribute = await evaluate(sdkP, "!!(window.Continuum && typeof window.Continuum.getRiskToken === 'function' && !('contribute' in window.Continuum))");
  check("the SDK offers pages no way to add training samples (only its popup does)", noContribute === true);
  await send("Target.closeTarget", { targetId: sdkId });
  const otherRead = await gw(`/v1/console/tenants/${orgKey}/settings`, { headers: { Authorization: "Bearer " + conToken.replace(/./, "x") } });
  check("settings need the organisation's own console session", otherRead.status === 401 || otherRead.status === 404, String(otherRead.status));
  const actS = await gw("/v1/console/activity", { headers: bearerA });
  check("the change is in the organisation's activity", (actS.d.entries || []).some((e) => e.siteKey === orgKey && e.action === "organisation.settings_changed"));
  const opActS = ADMIN_KEY ? await admin("/v1/admin/activity") : { d: { entries: [] } };
  check("the operator's change is in the operator's activity", (opActS.d.entries || []).some((e) => e.action === "settings.changed"));
  await settingsRestore();
  settingsRestore = null;
  check("revoking without typing the exact name does nothing", badConfirm.status === 400 && badConfirm.d.error === "confirm_name_mismatch", `${badConfirm.status} ${badConfirm.d.error}`);
  // revoke through the Settings tab: type the name, confirm
  await evaluate(con, `location.hash = ${JSON.stringify("#/organisations/" + orgKey + "/settings")}; true`);
  await waitFor(con, "!!document.getElementById('revokeBtn') && !document.getElementById('revokeBtn').disabled", 10000);
  await evaluate(con, click("#revokeBtn"));
  await waitFor(con, "!!document.getElementById('revokeConfirm')", 5000);
  await evaluate(con, fill("#revokeConfirm", ORG_NAME));
  await evaluate(con, click("#revokeGo"));
  let afterRev = { status: 0, d: {} };
  for (let i = 0; i < 20 && afterRev.status !== 403; i++) { await sleep(300); afterRev = await http(GW + "/v1/sdk/session", { method: "POST", body: { siteKey: orgKey }, headers: orgO }); }
  check("revoking in Settings (typing the name) stops the key at once", afterRev.status === 403 && afterRev.d.error === "tenant_revoked", `${afterRev.status} ${afterRev.d.error}`);
  // another account cannot see or touch it (same page and virtual authenticator: a second one would compete)
  await evaluate(con, click("#signOutBtn"));
  await waitFor(con, "!!document.getElementById('authSwitch')", 10000);
  check("sign-out goes back to the sign-in page, not the last organisation", await evaluate(con, "location.hash === '#/organisations'"), await evaluate(con, "location.hash"));
  await evaluate(con, click("#authSwitch"));
  await waitFor(con, "/Create account/.test(document.getElementById('authBtn').textContent)", 5000);
  await evaluate(con, fill("#authEmail", EMAIL_B));
  made.push(EMAIL_B);
  await evaluate(con, click("#authBtn"));
  if (!(await waitFor(con, "!!document.getElementById('newOrgBtn')", 20000)))
    console.log("    second account not signed in:", JSON.stringify(await evaluate(con, "({ msg: (document.getElementById('authMsg') || {}).textContent, btn: (document.getElementById('authBtn') || {}).textContent, email: (document.getElementById('authEmail') || {}).value, hash: location.hash })").catch((e) => e.message)));
  const tokB = await evaluate(con, "sessionStorage.getItem('continuumConsole')");
  const bearerB = { Authorization: "Bearer " + tokB };
  const listB = await gw("/v1/console/tenants", { headers: bearerB });
  const rotB = await gw(`/v1/console/tenants/${orgKey}/rotate`, { method: "POST", body: {}, headers: bearerB });
  const statsB = await gw(`/v1/console/tenants/${orgKey}/stats`, { headers: bearerB });
  const actB = await gw("/v1/console/activity", { headers: bearerB });
  check("another account sees none of it and cannot change it", listB.status === 200 && listB.d.tenants.length === 0 && rotB.status === 404 && statsB.status === 404 && !(actB.d.entries || []).some((e) => e.siteKey === orgKey),
    `${listB.d.tenants && listB.d.tenants.length} tenant(s), rotate ${rotB.status}, stats ${statsB.status}, activity ${(actB.d.entries || []).length}`);
  const conAsSession = await gw("/v1/sdk/onboarding", { headers: bearerB });
  check("a console token is not a session", conAsSession.status === 401, String(conAsSession.status));
  // the operator hands the organisation to the second account
  const given = await admin(`/v1/admin/tenants/${orgKey}/owner`, { method: "POST", body: { email: EMAIL_B } });
  const listB2 = await gw("/v1/console/tenants", { headers: bearerB });
  const listA2 = await gw("/v1/console/tenants", { headers: bearerA });
  check("the operator can hand an organisation to another account", given.status === 200 && (listB2.d.tenants || []).some((t) => t.siteKey === orgKey) && !(listA2.d.tenants || []).some((t) => t.siteKey === orgKey),
    `${given.status}, B has ${(listB2.d.tenants || []).length}, A has ${(listA2.d.tenants || []).length}`);
  // the new owner deletes it in Settings (a revoked organisation can still be deleted)
  const usersBefore = identityKeys().filter((k) => k.startsWith(orgKey + "|")).length;
  const badDelete = await gw(`/v1/console/tenants/${orgKey}/delete`, { method: "POST", body: { confirm: "nope" }, headers: bearerB });
  check("deleting without typing the exact name does nothing", badDelete.status === 400 && badDelete.d.error === "confirm_name_mismatch", `${badDelete.status} ${badDelete.d.error}`);
  await evaluate(con, `location.hash = ${JSON.stringify("#/organisations/" + orgKey + "/settings")}; true`);
  await waitFor(con, "!!document.getElementById('deleteBtn')", 10000);
  await evaluate(con, click("#deleteBtn"));
  await waitFor(con, "!!document.getElementById('deleteConfirm')", 5000);
  await evaluate(con, fill("#deleteConfirm", ORG_NAME));
  await evaluate(con, click("#deleteGo"));
  const backToList = await waitFor(con, "location.hash === '#/organisations' && !!document.getElementById('newOrgBtn')", 20000);
  const usersAfter = identityKeys().filter((k) => k.startsWith(orgKey + "|")).length;
  const statsGone = await gw(`/v1/console/tenants/${orgKey}/stats`, { headers: bearerB });
  const sessGone = await http(GW + "/v1/sdk/session", { method: "POST", body: { siteKey: orgKey }, headers: orgO });
  check("deleting in Settings removes the organisation and its users", backToList && statsGone.status === 404 && sessGone.status >= 400 && usersBefore >= 1 && usersAfter === 0,
    `list ${backToList}, stats ${statsGone.status}, session ${sessGone.status} ${sessGone.d.error || ""}, users ${usersBefore} → ${usersAfter}`);
  const actB2 = await gw("/v1/console/activity", { headers: bearerB });
  check("the deletion stays in the owner's activity", (actB2.d.entries || []).some((e) => e.siteKey === orgKey && e.action === "organisation.deleted" && e.name === ORG_NAME));

  check("no uncaught exception in extension or gateway pages", exceptions.length === 0, exceptions.slice(0, 3).join(" / "));
} catch (e) {
  check("run completed", false, e.stack || e.message);
} finally {
  // ---- cleanup ----
  if (settingsRestore) { try { await settingsRestore(); } catch (e) { console.log("  cleanup: operator settings: " + e.message); } }
  try {
    for (const email of made) {
      const r = await admin("/v1/admin/accounts/delete", { method: "POST", body: { email } });
      if (r.status !== 200 && r.status !== 404) console.log(`  cleanup: account ${email}: HTTP ${r.status}`);
    }
    if (demoUserId) {
      execFileSync("docker", ["exec", "-w", "/app", `${PREFIX}-web-1`, "node", "-e",
        `const db=require('better-sqlite3')(process.env.DB_PATH||'/app/db/continuum.db');db.prepare('DELETE FROM users WHERE id=? AND username=?').run(${Number(demoUserId)},${JSON.stringify(DEMO_USER)});console.log('demo user removed')`], { encoding: "utf8" });
    }
  } catch (e) { console.log("  cleanup: " + e.message); }
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  await sleep(500);
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL SIGN-IN CHECKS PASSED");
process.exit(failures ? 1 : 0);
