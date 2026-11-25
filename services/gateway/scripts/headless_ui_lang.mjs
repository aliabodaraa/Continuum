// The console and operator pages in Arabic, in real headless Chrome, without a server: the pages are served from
// this checkout and the gateway's API is simulated here (http://gw.test), so nothing is written anywhere. For each
// screen it checks the direction and that no English is left (apart from names, codes and addresses), exercises
// the modals, toasts and the switch back to English, and saves screenshots for a look.
//   node services/gateway/scripts/headless_ui_lang.mjs [screenshot dir]
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PUB = path.join(ROOT, "services", "gateway", "public");
const SHOTS = process.argv[2] || path.join(os.tmpdir(), "continuum-ui-lang");
fs.mkdirSync(SHOTS, { recursive: true });
const GW = "http://gw.test", PORT = 9391;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- the simulated gateway: three organisations, every kind of activity, every settings source
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const ORGS = [
  { siteKey: "pk_acme", name: "Acme Notes", status: "active", origins: ["https://app.acme.com", "chrome-extension://abc"], allowExtension: true, signInUrl: "https://app.acme.com/continuum/link",
    webhookUrl: "https://app.acme.com/continuum/events", owner: "dev@acme.example", builtIn: false, serverManaged: false, createdAt: ago(3 * 1440), secretRotatedAt: ago(90) },
  { siteKey: "pk_beta", name: "Beta Shop", status: "pending", origins: ["https://shop.beta.example"], allowExtension: false, signInUrl: null, webhookUrl: null, owner: "dev@acme.example", builtIn: false, serverManaged: false, createdAt: ago(25), secretRotatedAt: null },
  { siteKey: "pk_old", name: "Old Corp", status: "revoked", origins: [], allowExtension: true, signInUrl: null, webhookUrl: null, owner: "x@old.example", builtIn: false, serverManaged: false, createdAt: ago(40 * 1440), secretRotatedAt: null },
  { siteKey: "pk_personal", name: "Personal accounts", status: "active", origins: ["chrome-extension://abc"], allowExtension: true, signInUrl: null, webhookUrl: null, owner: null, builtIn: true, serverManaged: true, createdAt: ago(60 * 1440), secretRotatedAt: null },
];
const STATS = { users: 12, anonymous: 3, passkey: 9, typing: 7, mouse: 5, counted: 12 };
const SETTINGS = [
  { key: "panel", value: "show", source: "default", envValue: null, builtIn: "show", operatorDefault: "show", choices: ["show", "hide"], range: null, list: false },
  { key: "panelLanguage", value: "ar", source: "organisation", envValue: null, builtIn: "auto", operatorDefault: "auto", choices: ["auto", "en", "ar"], range: null, list: false },
  { key: "panelTheme", value: "auto", source: "default", envValue: null, builtIn: "auto", operatorDefault: "auto", choices: ["auto", "light", "dark"], range: null, list: false },
  { key: "keystroke", value: "on", source: "organisation", envValue: null, builtIn: "on", operatorDefault: "on", choices: ["on", "off"], range: null, list: false },
  { key: "keystrokeDecisionWindows", value: 10, source: "operator", envValue: null, builtIn: 20, operatorDefault: 10, choices: [2, 4, 6, 10, 20], range: null, list: false },
  { key: "pasteAllowance", value: "unlimited", source: "env", envValue: "unlimited", builtIn: "unlimited", operatorDefault: "unlimited", choices: ["0", "1", "2", "3", "5", "unlimited"], range: null, list: false },
  { key: "mouse", value: "on", source: "default", envValue: null, builtIn: "on", operatorDefault: "on", choices: ["on", "off"], range: null, list: false },
  { key: "onboarding", value: "eager", source: "default", envValue: null, builtIn: "eager", operatorDefault: "eager", choices: ["eager", "lazy"], range: null, list: false },
  { key: "adaptive", value: "on", source: "default", envValue: null, builtIn: "on", operatorDefault: "on", choices: ["on", "off"], range: null, list: false },
  { key: "adaptiveRetrainEvery", value: 2, source: "operator", envValue: null, builtIn: 3, operatorDefault: 2, choices: [1, 2, 3], range: null, list: false },
  { key: "adaptiveSampleFrom", value: "end", source: "default", envValue: null, builtIn: "end", operatorDefault: "end", choices: ["end", "any"], range: null, list: false },
  { key: "adaptiveGapHours", value: 2.5, source: "operator", envValue: null, builtIn: 3, operatorDefault: 2.5, choices: null, range: [0, 168], list: false },
  { key: "excludeFieldTypes", value: ["hidden"], source: "default", envValue: null, builtIn: ["hidden"], operatorDefault: ["hidden"], choices: null, range: null, list: true },
];
const acct = { type: "account", email: "dev@acme.example" }, op = { type: "operator" }, sys = { type: "system" };
const ENTRIES = [
  { at: ago(2), actor: acct, action: "organisation.settings_changed", siteKey: "pk_acme", name: "Acme Notes", detail: { changed: ["keystroke"] } },
  { at: ago(12), actor: sys, action: "webhook.undeliverable", siteKey: "pk_acme", name: "Acme Notes", detail: { attempts: 5, error: "ECONNREFUSED" } },
  { at: ago(50), actor: acct, action: "webhook.tested", siteKey: "pk_acme", name: "Acme Notes", detail: { ok: true } },
  { at: ago(130), actor: op, action: "organisation.approved", siteKey: "pk_acme", name: "Acme Notes" },
  { at: ago(25), actor: acct, action: "organisation.created", siteKey: "pk_beta", name: "Beta Shop" },
  { at: ago(3 * 1440), actor: acct, action: "secret.rotated", siteKey: "pk_acme", name: "Acme Notes" },
  { at: ago(9 * 1440), actor: op, action: "organisation.revoked", siteKey: "pk_old", name: "Old Corp" },
  { at: ago(10 * 1440), actor: acct, action: "account.created", siteKey: null, name: null, detail: { email: "dev@acme.example" } },
  { at: ago(11 * 1440), actor: op, action: "operator.locked_out", siteKey: null, name: null },
  { at: ago(12 * 1440), actor: op, action: "settings.changed", siteKey: null, name: null, detail: { changed: ["defaults.keystrokeDecisionWindows"] } },
];
const ENV = [
  { service: "gateway", name: "GATEWAY_PUBLIC_URL", set: true, value: GW, secret: false, setting: null },
  { service: "gateway", name: "GATEWAY_ADMIN_KEY", set: true, value: null, secret: true, setting: null },
  { service: "gateway", name: "CONTINUUM_PANEL", set: false, value: null, secret: false, setting: "defaults.panel" },
  { service: "ca-service", name: "STUDY_LOGGING", set: true, value: "1", secret: false, setting: "study.studyLogging" },
];
function api(method, p) {
  if (p === "/v1/console/config") return { extensionId: null, autoApprove: false, operatorKeyRequired: true, publicUrl: GW };
  if (p === "/v1/console/me") return { email: "dev@acme.example" };
  if (p === "/v1/console/tenants" && method === "GET") return { tenants: ORGS.filter((t) => t.owner === "dev@acme.example") };
  if (p === "/v1/tenants") return { tenants: ORGS };
  if (/^\/v1\/(console|admin)\/tenants\/[^/]+\/stats$/.test(p)) return STATS;
  if (/^\/v1\/console\/tenants\/[^/]+\/settings$/.test(p) && method === "GET") return { settings: SETTINGS };
  if (p === "/v1/console/activity") return { entries: ENTRIES.filter((e) => e.siteKey !== "pk_old" && e.action !== "settings.changed") };   // own organisations and account only, as the server filters
  if (p === "/v1/admin/activity") return { entries: ENTRIES };
  if (p === "/v1/admin/settings" && method === "GET") return { defaults: SETTINGS, caReachable: true, environment: ENV,
    server: [{ key: "autoApproveTenants", value: false, source: "default", envValue: null, builtIn: false }, { key: "allowPrivateWebhooks", value: true, source: "operator", envValue: null, builtIn: false }],
    study: { studyLogging: { value: true, source: "env", envValue: true, builtIn: false } } };
  return null;
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
function file(p) {
  if (p === "/vendor/simplewebauthn/index.umd.min.js") return { type: TYPES[".js"], body: fs.readFileSync(path.join(ROOT, "sdk", "vendor", "simplewebauthn", "index.umd.min.js")) };
  const f = path.join(PUB, p.replace(/^\//, ""));
  if (!f.startsWith(PUB) || !fs.existsSync(f)) return null;
  return { type: TYPES[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) };
}

// ---- Chrome + a minimal CDP client (as extension/scripts/e2e_headless_ext_offline.mjs)
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ui-lang-"));
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
    const d = api(request.method, u.pathname);
    if (d) return reply(200, "application/json", JSON.stringify(d));
    const f = file(u.pathname);
    if (f) return reply(200, f.type, f.body);
    return reply(404, "application/json", JSON.stringify({ error: "not_found" }));
  }
});
async function page(url) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, s);
  await send("Page.navigate", { url }, s);
  return s;
}
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
async function waitFor(s, expression, ms = 10000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(s, expression)) return true; } catch {} await sleep(150); } return false; }
const settled = (s) => waitFor(s, "!!document.querySelector('#app .page, #app .auth, #app .center') && !document.querySelector('#app .spinner')", 10000);
async function shot(s, name) { const { data } = await send("Page.captureScreenshot", { format: "png" }, s); const f = path.join(SHOTS, name + ".png"); fs.writeFileSync(f, Buffer.from(data, "base64")); return f; }
const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`;
const fill = (sel, value) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`;

// Latin words in what the page shows (text, placeholders, titles, labels), outside codes, keys and addresses.
const ALLOWED = new Set(["Continuum", "Guard", "PIN", "IP", "JWKS", "CONTINUUM_SECRET", "CA_SIGNING_SECRET", "GATEWAY_ADMIN_KEY", "webhook", "middleware", "protect",
  "localhost", "https", "http", "chrome", "extensions", "password", "email", "textarea", "contenteditable", "env", "Acme", "Notes", "Beta", "Shop", "Old", "Corp",
  "Personal", "accounts", "dev", "acme", "example", "old", "app", "shop", "beta", "ECONNREFUSED", "keystroke", "defaults", "keystrokeDecisionWindows", "gateway", "ca-service",
  "company", "com", "you", "gw", "test", "IBM", "data-site-key", "script", "src", "text", "hidden"]);
const LEFTOVERS = `(() => {
  const skip = (e) => e && e.closest && e.closest('.mono, code, pre, script, style, [dir="ltr"], .lang-btn, option, .avatar, .chip-item');
  const words = (s) => (s.match(/[A-Za-z][A-Za-z'’_-]{1,}/g) || []);
  const out = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) { if (skip(n.parentElement)) continue; words(n.nodeValue).forEach((x) => out.add(x)); }
  document.querySelectorAll('[placeholder], [title], [aria-label]').forEach((e) => { if (skip(e)) return; ['placeholder', 'title', 'aria-label'].forEach((a) => words(e.getAttribute(a) || '').forEach((x) => out.add('@' + x))); });
  return [...out];
})()`;
async function english(s, screen) {
  const found = (await ev(s, LEFTOVERS)).filter((w) => !ALLOWED.has(w.replace(/^@/, "")));
  ok(`${screen}: no English left`, found.length === 0, found.join(", "));
  const arabic = await ev(s, "/[\\u0600-\\u06FF]/.test(document.body.innerText)");
  ok(`${screen}: Arabic on the page`, arabic);
}
const rtl = (s) => ev(s, "document.documentElement.dir === 'rtl' && document.documentElement.lang === 'ar'");

try {
  // ---- the console, signed out
  const con = await page(GW + "/console.html");
  ok("console: English by default, with a button offering Arabic", await waitFor(con, "document.documentElement.dir === 'ltr' && /Sign in/.test(document.getElementById('authBtn').textContent) && document.querySelector('.lang-btn').textContent.includes('العربية')"));
  await ev(con, click(".lang-btn"));
  ok("console: the button turns the page Arabic and right-to-left", await waitFor(con, "document.documentElement.dir === 'rtl' && /بمفتاح مرورك/.test(document.getElementById('authBtn').textContent)"), await ev(con, "document.getElementById('authBtn').textContent"));
  ok("console: the title is Arabic and the choice is kept", await ev(con, "document.title.includes('لوحة التحكم') && localStorage.getItem('continuumLang') === 'ar'"));
  ok("console: the picture side moved to the right of the sign-in card", await ev(con, "document.querySelector('.auth-art').getBoundingClientRect().left > document.querySelector('.auth-side').getBoundingClientRect().left"));
  await english(con, "console sign-in");
  await ev(con, click("#authSwitch")); await sleep(200);
  await english(con, "console create account");
  console.log("  shot", await shot(con, "01-console-signin-ar"));
  await ev(con, fill("#authEmail", "not-an-email")); await ev(con, "document.getElementById('authBtn').click(); true"); await sleep(100);
  ok("console: a validation message in Arabic", await ev(con, "document.getElementById('authMsg').textContent === 'هذا لا يبدو بريداً إلكترونياً.'"), await ev(con, "document.getElementById('authMsg').textContent"));

  // ---- signed in: the Arabic choice survives a reload
  await ev(con, "sessionStorage.setItem('continuumConsole', 'test-token'); location.hash = '#/organisations'; location.reload(); true");
  ok("console list: still Arabic after a reload", await waitFor(con, "document.documentElement.dir === 'rtl' && !!document.getElementById('newOrgBtn') && !!document.querySelector('tbody tr')"));
  ok("console list: the sidebar sits on the right, its border on its left", await ev(con, "parseFloat(getComputedStyle(document.querySelector('.sidebar')).borderLeftWidth) > 0 && getComputedStyle(document.querySelector('.sidebar')).borderRightWidth === '0px' && document.querySelector('.sidebar').getBoundingClientRect().left > innerWidth / 2"));
  ok("console list: Arabic plurals in the table", await ev(con, "[...document.querySelectorAll('tbody td:nth-child(3)')].map((e) => e.textContent).join('|') === 'موقع واحد|موقع واحد'"), await ev(con, "[...document.querySelectorAll('tbody td:nth-child(3)')].map((e) => e.textContent).join('|')"));
  ok("console list: the pending notice counts in Arabic", await ev(con, "document.querySelector('.callout.warn strong').textContent.trim() === 'مؤسسة واحدة بانتظار الموافقة.'"), await ev(con, "document.querySelector('.callout.warn strong').textContent"));
  await english(con, "console list");
  console.log("  shot", await shot(con, "02-console-list-ar"));

  // ---- the wizard, step by step
  await ev(con, "location.hash = '#/organisations/new'; true");
  await waitFor(con, "!!document.getElementById('wName')");
  await english(con, "wizard details");
  console.log("  shot", await shot(con, "03-console-wizard-ar"));
  await ev(con, fill("#wName", "Acme Notes")); await ev(con, click("#wNext")); await waitFor(con, "!!document.getElementById('wSiteInput')");
  await ev(con, click("#wNext")); await sleep(100);
  ok("wizard: the websites error is Arabic", await ev(con, "document.getElementById('wErr').textContent.startsWith('أضف موقعاً واحداً')"), await ev(con, "document.getElementById('wErr').textContent"));
  await ev(con, fill("#wSiteInput", "https://app.acme.com")); await ev(con, click("#wSiteAdd")); await sleep(50);
  await english(con, "wizard websites");
  await ev(con, click("#wNext")); await waitFor(con, "!!document.getElementById('wExt')");
  await ev(con, "(() => { const c = document.getElementById('wExt'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()");
  await ev(con, click("#wNext")); await sleep(100);
  ok("wizard: the sign-in page error is Arabic", await ev(con, "document.getElementById('wErr').textContent.startsWith('أضف صفحة تسجيل الدخول')"), await ev(con, "document.getElementById('wErr').textContent"));
  await english(con, "wizard extension");
  await ev(con, fill("#wSignIn", "https://app.acme.com/continuum/link")); await ev(con, click("#wNext")); await sleep(100);
  // this server knows no extension id, so the step asks for it (2026-11-25)
  ok("wizard: the extension id error is Arabic", await ev(con, "document.getElementById('wErr').textContent.startsWith('لا يعرف هذا الخادم معرّف الإضافة')"), await ev(con, "document.getElementById('wErr').textContent"));
  await ev(con, fill("#wExtId", "abcdefghijklmnopabcdefghijklmnop")); await ev(con, click("#wNext")); await waitFor(con, "!!document.getElementById('wHook')");
  ok("wizard: the review line is Arabic", await ev(con, "document.querySelector('.callout strong').nextSibling.textContent === 'Acme Notes · موقع واحد · الإضافة مسموحة'"), await ev(con, "document.querySelector('.callout strong').nextSibling.textContent"));
  await english(con, "wizard alerts");
  console.log("  shot", await shot(con, "04-console-wizard-review-ar"));

  // ---- one organisation, every tab
  for (const tab of ["overview", "keys", "websites", "extension", "protection", "alerts", "activity", "settings"]) {
    await ev(con, `location.hash = '#/organisations/pk_acme/${tab}'; true`);
    ok(`org ${tab}: rendered`, await waitFor(con, `document.getElementById('tab-${tab}').classList.contains('active') && !document.querySelector('#app .spinner') && document.querySelectorAll('#app .card').length > 0`));
    await english(con, `org ${tab}`);
    if (tab === "overview") { ok("overview: the stat tiles count in Arabic", await ev(con, "document.querySelector('.stat .small').textContent === '3 زوّار مجهولون'"), await ev(con, "document.querySelector('.stat .small').textContent")); console.log("  shot", await shot(con, "05-console-overview-ar")); }
    if (tab === "keys") ok("keys: the rotation time is Arabic", await ev(con, "document.body.innerText.includes('آخر تغيير قبل ساعة.')"));
    if (tab === "protection") {
      ok("protection: a source badge and the switch knob sit right-to-left", await ev(con, "document.querySelector('.setting-row .badge').textContent === 'الافتراضي المدمج' && getComputedStyle(document.querySelector('.switch input:checked + span'), '::before').transform.includes('-18')"));
      // adaptive retraining sits inside typing protection, and every one of its figures shows the real cycle (2026-11-12)
      ok("protection: adaptive retraining is a section inside typing protection", await ev(con, "document.getElementById('set-adaptive').closest('.setting-group').parentElement.closest('.setting-group') === document.getElementById('set-keystroke').closest('.setting-group')"));
      ok("protection: the three adaptive figures show the chosen 2 samples and 2.5 h", await ev(con, "['adaptive','adaptiveRetrainEvery','adaptiveGapHours'].every((k) => { const f = document.getElementById('set-' + k).closest('.setting-row').querySelector('.illus'); return f.querySelectorAll('circle.il-fill').length === 2 && /2\\.5 h/.test(f.textContent); })"),
        await ev(con, "['adaptive','adaptiveRetrainEvery','adaptiveGapHours'].map((k) => { const f = document.getElementById('set-' + k).closest('.setting-row').querySelector('.illus'); return f.querySelectorAll('circle.il-fill').length + ' ' + f.textContent.trim(); }).join(' | ')"));
      await ev(con, "document.getElementById('set-keystroke').click(); true"); await sleep(150);
      ok("protection: typing off hides adaptive retraining with its settings", await ev(con, "['adaptive','adaptiveRetrainEvery','adaptiveSampleFrom','adaptiveGapHours'].every((k) => document.getElementById('set-' + k).closest('.setting-row').offsetParent === null)"));
      await ev(con, "document.getElementById('set-keystroke').click(); true"); await sleep(150);
      ok("…and typing on shows them again", await ev(con, "['adaptive','adaptiveGapHours'].every((k) => document.getElementById('set-' + k).closest('.setting-row').offsetParent !== null)"));
      await ev(con, click("#protectionSave"));
      ok("protection: the 'nothing changed' toast is Arabic", await waitFor(con, "!!document.querySelector('.toast') && document.querySelector('.toast').textContent === 'لم يتغيّر شيء.'", 3000), await ev(con, "(document.querySelector('.toast') || {}).textContent"));
      console.log("  shot", await shot(con, "06-console-protection-ar"));
      await ev(con, "document.getElementById('set-keystroke').closest('.setting-group').scrollIntoView(); true"); await sleep(300);
      console.log("  shot", await shot(con, "06b-console-typing-section-ar"));
    }
    if (tab === "activity") ok("activity: the timeline reads Arabic", await ev(con, "document.querySelector('.timeline .when').textContent === 'بواسطة dev@acme.example · قبل دقيقتين' && document.body.innerText.includes('توقّف بعد 5 محاولات (ECONNREFUSED)')"), await ev(con, "document.querySelector('.timeline .when').textContent"));
    if (tab === "settings") {
      await ev(con, click("#deleteBtn"));
      ok("settings: the delete modal is Arabic, the name stays", await waitFor(con, "!!document.querySelector('.modal') && document.querySelector('.modal h3').textContent === 'حذف Acme Notes؟' && document.querySelector('#deleteConfirm').placeholder === 'Acme Notes'", 3000), await ev(con, "(document.querySelector('.modal h3') || {}).textContent"));
      await english(con, "delete modal");
      console.log("  shot", await shot(con, "07-console-delete-modal-ar"));
      await ev(con, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true");
      ok("settings: Escape closes the modal", await waitFor(con, "!document.querySelector('.modal')", 2000));
    }
  }
  await ev(con, "location.hash = '#/quickstart/pk_acme'; true"); await waitFor(con, "document.querySelectorAll('#app .card').length >= 4");
  await english(con, "quickstart");
  console.log("  shot", await shot(con, "08-console-quickstart-ar"));
  await ev(con, "location.hash = '#/activity'; true"); await waitFor(con, "!!document.querySelector('.timeline')");
  await english(con, "console activity");

  // ---- back to English from the sidebar
  await ev(con, click(".sidebar .lang-btn"));
  ok("console: the sidebar button switches back to English", await waitFor(con, "document.documentElement.dir === 'ltr' && document.querySelector('.nav-item.active').textContent === 'Activity' && document.title === 'Continuum Console'"));
  ok("console: English again, without a reload", await ev(con, "localStorage.getItem('continuumLang') === 'en' && document.querySelector('.timeline .when').textContent.startsWith('by dev@acme.example · ')"), await ev(con, "document.querySelector('.timeline .when').textContent"));

  // ---- the operator page
  const opr = await page(GW + "/operator.html");
  ok("operator: English sign-in with the button", await waitFor(con, "true") && await waitFor(opr, "!!document.getElementById('opKey') && document.documentElement.dir === 'ltr' && !!document.querySelector('.lang-btn')"));
  await ev(opr, click(".lang-btn"));
  ok("operator: Arabic sign-in", await waitFor(opr, "document.documentElement.dir === 'rtl' && document.getElementById('opSignIn').textContent.includes('فتح واجهة المشغّل')"));
  await english(opr, "operator sign-in");
  console.log("  shot", await shot(opr, "09-operator-signin-ar"));
  await ev(opr, "sessionStorage.setItem('continuumOperator', 'k'); location.reload(); true");
  ok("operator list: Arabic, with the pending count", await waitFor(opr, "document.documentElement.dir === 'rtl' && document.querySelectorAll('tbody tr').length === 4 && document.querySelector('.nav-item .count').textContent === '1'"));
  ok("operator list: filters and actions in Arabic", await ev(opr, "document.getElementById('filter-pending').textContent === 'بالانتظار' && document.querySelector('[data-act=approve]').textContent.trim() === 'موافقة' && document.querySelector('[data-act=reactivate]').textContent === 'إعادة التفعيل'"));
  await english(opr, "operator list");
  console.log("  shot", await shot(opr, "10-operator-list-ar"));
  await ev(opr, click("tr[data-key=pk_acme]"));
  ok("operator: the details modal keeps the name and translates the rest", await waitFor(opr, "!!document.querySelector('.modal') && document.querySelector('.modal h3').textContent === 'Acme Notes' && document.body.innerText.includes('12 مستخدم · 9 بمفتاح مرور · 7 سجّلوا الكتابة · 5 سجّلوا الفأرة')", 3000));
  await english(opr, "operator details modal");
  await ev(opr, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true"); await waitFor(opr, "!document.querySelector('.modal')", 2000);
  await ev(opr, click("[data-act=revoke]"));
  ok("operator: the revoke modal is Arabic", await waitFor(opr, "!!document.querySelector('.modal') && document.querySelector('.modal h3').textContent === 'إيقاف Acme Notes؟' && document.getElementById('opRevokeGo').textContent === 'إيقاف'", 3000), await ev(opr, "(document.querySelector('.modal h3') || {}).textContent"));
  await ev(opr, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true"); await waitFor(opr, "!document.querySelector('.modal')", 2000);
  await ev(opr, "location.hash = '#/activity'; true"); await waitFor(opr, "!!document.querySelector('.timeline')");
  await english(opr, "operator activity");
  await ev(opr, "location.hash = '#/settings'; true"); await waitFor(opr, "document.querySelectorAll('#app .card').length >= 4 && !document.querySelector('#app .spinner')");
  ok("operator settings: switches, badges and the environment table in Arabic", await ev(opr, "document.body.innerText.includes('الموافقة على المؤسسات الجديدة تلقائياً') && document.body.innerText.includes('محدد (مخفي)') && document.body.innerText.includes('في ‎.env ثم أعد التشغيل')"));
  await english(opr, "operator settings");
  console.log("  shot", await shot(opr, "11-operator-settings-ar"));
  await ev(opr, click(".sidebar .lang-btn"));
  ok("operator: back to English", await waitFor(opr, "document.documentElement.dir === 'ltr' && document.querySelector('.nav-item.active').textContent === 'Settings' && document.title === 'Continuum Operator'"));

  ok("no page errors", errors.length === 0, errors.join(" | ").slice(0, 400));
} catch (e) { console.log("  FAIL  harness error:", e.message); bad++; }
finally { ws.close(); chrome.kill(); await sleep(300); try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {} }
console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed"); console.log("screenshots:", SHOTS);
process.exit(bad ? 1 : 0);
