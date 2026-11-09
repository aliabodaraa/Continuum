// The SDK's panel and windows in each language and colour scheme (2026-11-04), in real headless Chrome. Everything is
// simulated by this script at http://look.test: the page, the working copy of the SDK (sdk/guard.js, sdk/js/*) and every
// /v1/sdk/ answer, so nothing real is needed and nothing is stored. For English and Arabic, light and dark, as the
// organisation sets them (panelLanguage, panelTheme), it checks the panel's direction, colours and words (no English
// left in Arabic apart from names), drives it to a verdict, opens the adaptive popup, the passkey step-up and the typing
// wizard, and saves screenshots; then "auto": the page's own language and the device's dark mode.
//   node extension/scripts/e2e_headless_sdk_look.mjs [screenshot dir]
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = process.argv[2] || path.join(os.tmpdir(), "continuum-sdk-look");
fs.mkdirSync(SHOTS, { recursive: true });
const SITE = "http://look.test", PORT = 9377;
const CHROME = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const ok = (n, c, d) => { console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? " — " + d : "")); if (!c) bad++; };

// ---- the simulated server; `look` is what the organisation chose, `onboarding` what the user has
let look = { lang: "en", theme: "light" }, onboarding = { passkey: true, keystroke: true, mouse: true }, dry = { eligible: false };
const win = (keys) => { const s = Math.max(keys - 1, 0); return s >= 50 ? Math.floor((s - 50) / 10) + 1 : 0; };
function api(p, body) {
  if (p === "/v1/sdk/onboarding") return { ...onboarding, keystrokeTraining: false };
  if (p === "/v1/sdk/lock/status") return { locked: false };
  if (p === "/v1/sdk/keystroke/config") return { windowSize: 50, windowStride: 10, recentWindowCount: 20, sampleWindowCount: 20, checkMinTextChars: 80,
    adaptiveConfidenceMin: 0.8, adaptiveRetrainEvery: 3, adaptiveEnabled: true, adaptiveMinGapHours: 3, panel: "show", keystroke: "on", mouse: "on",
    onboardingMode: "eager", excludeFieldTypes: ["hidden"], panelLanguage: look.lang, panelTheme: look.theme,
    managed: look.lang === "auto" ? [] : ["panelLanguage", "panelTheme"] };
  if (p === "/v1/sdk/keystroke/status") return { trained: onboarding.keystroke, sampleCount: onboarding.keystroke ? 5 : 2, adaptiveEnabled: true, adaptivePending: 1, adaptiveReady: false, nextContributionAt: null };
  if (p === "/v1/sdk/mouse/status") return { enrolled: true, samplesOnFile: 8, samplesRequired: 8, sampleWindows: 55 };
  if (p === "/v1/sdk/keystroke/check") {
    const keys = (body.keystrokeEvents || []).filter((e) => e.eventType === "keydown").length;
    return { checked: true, warmup: false, isSuspicious: false, modelConfidence: 0.93, riskToken: "rt", typingEvaluation: { windowCount: win(keys), modelAvailable: true } };
  }
  if (p === "/v1/sdk/keystroke/contribute") return body.dryRun ? { ok: true, dryRun: true, ...dry } : { ok: true, pending: 2, ready: false };
  if (p === "/v1/sdk/mouse/check") return { checked: false, warmup: true, windowCount: 0, bufferMax: 60 };
  return {};
}
const TYPES = { ".js": "application/javascript; charset=utf-8" };
function file(p) {
  const map = { "/guard.js": "sdk/guard.js", "/js/guard-ar.js": "sdk/js/guard-ar.js", "/js/keystroke-tracker.js": "sdk/js/keystroke-tracker.js",
    "/js/mouse-features.js": "sdk/js/mouse-features.js", "/vendor/simplewebauthn/index.umd.min.js": "sdk/vendor/simplewebauthn/index.umd.min.js" };
  if (p === "/guard.js" && process.env.GUARD_FILE) return fs.readFileSync(process.env.GUARD_FILE);   // another copy of the SDK under test
  return map[p] ? fs.readFileSync(path.join(ROOT, map[p])) : null;
}
const token = "x." + Buffer.from(JSON.stringify({ sub: "look-test-user" })).toString("base64url") + ".y";
const page = (lang) => `<!doctype html><html lang="${lang}"><meta charset="utf-8"><title>look</title>
  <body style="margin:0;font:15px system-ui;background:linear-gradient(135deg,#e0e7ff,#fdf2f8);min-height:100vh">
  <div style="padding:40px;max-width:640px"><h2 style="margin:0 0 12px">An organisation's page</h2><textarea id="host" rows="8" style="width:100%"></textarea></div>
  <script src="/guard.js" data-site-key="SK_LOOK" data-session="${token}" data-onboarding="eager"></script></body></html>`;

// ---- Chrome + a minimal CDP client
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-look-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1280,860",
  "--lang=en-US", "about:blank"], { stdio: "ignore" });
let v; for (let i = 0; i < 60 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 1; const pend = new Map(), handlers = [], errors = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || { error: m.error }); pend.delete(m.id); } else if (m.method) handlers.forEach((h) => h(m)); });
const send = (method, params = {}, s) => new Promise((r) => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId: s })); });
const ev = async (s, expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s); return r.result ? r.result.value : undefined; };
const waitFor = async (s, expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(s, expr)) return true; await sleep(150); } return false; };
const SH = "document.getElementById('continuum-guard-host').shadowRoot";
const shot = async (s, name, clip) => { const { data } = await send("Page.captureScreenshot", clip ? { format: "png", clip: { ...clip, scale: 1 } } : { format: "png" }, s); fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(data, "base64")); };
const PASSAGE = "the quick brown fox jumps over the lazy dog while a small bird sings near the old river bank today ";
async function type(s, n) {
  for (let i = 0; i < n; i++) {
    const ch = PASSAGE[i % PASSAGE.length], code = ch === " " ? 32 : ch.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, windowsVirtualKeyCode: code }, s); await sleep(4);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: code }, s); await sleep(4);
  }
  await sleep(600);
}
// Latin words the shadow DOM shows in Arabic, outside the English passage and the brand
const LEFT = `(() => { const r = ${SH}; const out = new Set(); const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const p = n.parentElement; if (!p || p.closest('.passage, textarea, style, .sr, .tgl') || getComputedStyle(p).display === 'none' || !p.getClientRects().length) continue;
    (n.nodeValue.match(/[A-Za-z]{2,}/g) || []).forEach((x) => out.add(x)); }
  return [...out].filter((x) => !/^(Continuum|CONTINUUM)$/.test(x)); })()`;

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
let pageLang = "en";
handlers.push((m) => {
  if (m.method === "Runtime.exceptionThrown" && m.sessionId === s) errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method !== "Fetch.requestPaused" || m.sessionId !== s) return;
  const { requestId, request } = m.params, url = new URL(request.url);
  const reply = (code, type, body) => send("Fetch.fulfillRequest", { requestId, responseCode: code, responseHeaders: [{ name: "Content-Type", value: type }], body: Buffer.from(body).toString("base64") }, s);
  if (url.host !== "look.test") return reply(204, "text/plain", "");
  if (url.pathname === "/") return reply(200, "text/html; charset=utf-8", page(pageLang));
  const f = file(url.pathname); if (f) return reply(200, TYPES[".js"], f);
  let body = {}; try { body = request.postData ? JSON.parse(request.postData) : {}; } catch { /* not JSON */ }
  return reply(200, "application/json", JSON.stringify(api(url.pathname, body)));
});
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, s);
await send("Runtime.enable", {}, s); await send("Page.enable", {}, s);
async function load() {
  await send("Page.navigate", { url: SITE + "/" }, s);
  await waitFor(s, `!!document.getElementById('continuum-guard-host') && !!${SH}.querySelector('.panel')`, 15000);
  await sleep(1500);
}
const panelBox = async () => ev(s, `(() => { const r = ${SH}.querySelector('.panel').getBoundingClientRect(); return { x: r.left - 24, y: r.top - 24, width: r.width + 48, height: r.height + 48 }; })()`);

try {
  for (const lang of ["en", "ar"]) for (const theme of ["light", "dark"]) {
    const tag = `${lang}-${theme}`;
    look = { lang, theme }; onboarding = { passkey: true, keystroke: true, mouse: true }; dry = { eligible: false }; pageLang = "en";
    await load();
    const root = await ev(s, `(() => { const c = ${SH}.querySelector('.cg'); return { dir: c.dir, lang: c.lang, theme: c.dataset.theme, bg: getComputedStyle(c.querySelector('.card')).backgroundColor }; })()`);
    ok(`${tag}: the panel follows the organisation`, root.dir === (lang === "ar" ? "rtl" : "ltr") && root.lang === lang && root.theme === theme, JSON.stringify(root));
    // the rows never grow past the panel, however long a status is (the switches used to be cut off)
    const fit = await ev(s, `(() => { const p = ${SH}.querySelector('.panel'), pr = p.getBoundingClientRect(); const st = p.querySelector('.row .st').textContent;
      return { st, over: p.scrollWidth - p.clientWidth, cut: [...p.querySelectorAll('.tgl')].some((t) => t.getBoundingClientRect().right > pr.right + 0.5) }; })()`);
    ok(`${tag}: every switch is inside the panel with the long starting status`, fit.over <= 0 && !fit.cut, JSON.stringify(fit));
    await ev(s, "document.getElementById('host').focus()");
    await type(s, 260);
    // the verdict (93%) stays on the row, in its green, while the user keeps typing ("analyzing…" between checks)
    const ks = await ev(s, `(() => { const r = ${SH}.querySelector('.row'); return { text: r.querySelector('.st').textContent, ok: r.classList.contains('ok') }; })()`);
    ok(`${tag}: a typing verdict, in ${lang === "ar" ? "Arabic" : "English"}`, ks.ok && /93%/.test(ks.text) && (lang === "ar" ? ks.text.startsWith("الكتابة:") && /جارٍ التحليل|تم التحقق/.test(ks.text) : /^keystroke: (verified|analyzing…)/.test(ks.text)), JSON.stringify(ks));
    const ring = await ev(s, `${SH}.querySelector('.row .pr').style.strokeDashoffset`);
    ok(`${tag}: the ring shows the score (93% filled)`, Math.abs(Number(ring) - 7) < 0.6, ring);
    dry = { eligible: true, windows: 24, sampleMean: 0.93 };
    await type(s, 30);
    await waitFor(s, `${SH}.querySelector('.learn').style.display === 'block'`, 6000);
    if (lang === "ar") { const left = await ev(s, LEFT); ok(`${tag}: no English left on the panel and the popup`, left.length === 0, left.join(", ")); }
    await shot(s, `sdk-${tag}-panel`, await panelBox());
    await shot(s, `sdk-${tag}-page`);
    await ev(s, "window.Continuum.requireStepUp('mouse'); true");
    await waitFor(s, `[...${SH}.querySelectorAll('.ov')].some((o) => o.style.display === 'flex')`, 3000);
    await sleep(700);
    const modal = await ev(s, `${SH}.querySelector('.ov .card .t').textContent`);
    ok(`${tag}: the step-up window`, lang === "ar" ? modal === "مطلوب التحقق من هويتك" : modal === "Identity check required", modal);
    if (lang === "ar") { const left = await ev(s, LEFT); ok(`${tag}: no English left in the step-up`, left.length === 0, left.join(", ")); }
    await shot(s, `sdk-${tag}-stepup`);
    // the typing wizard: a user who has not enrolled their typing yet
    onboarding = { passkey: true, keystroke: false, mouse: true };
    await load();
    const wiz = await waitFor(s, `!!${SH}.querySelector('#cpass')`, 8000);
    await sleep(700);
    const pass = await ev(s, `(() => { const p = ${SH}.querySelector('#cpass'); return { dir: getComputedStyle(p).direction, en: /^[A-Za-z]/.test(p.textContent) }; })()`);
    ok(`${tag}: the typing wizard, its passage English and left-to-right`, wiz && pass.dir === "ltr" && pass.en, JSON.stringify(pass));
    if (lang === "ar") { const left = await ev(s, LEFT); ok(`${tag}: no English left in the wizard`, left.length === 0, left.join(", ")); }
    await shot(s, `sdk-${tag}-wizard`);
  }
  // "auto": the page's language, the device's colours
  look = { lang: "auto", theme: "auto" }; onboarding = { passkey: true, keystroke: true, mouse: true }; pageLang = "ar";
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, s);
  await load();
  const auto = await ev(s, `(() => { const c = ${SH}.querySelector('.cg'); return { dir: c.dir, theme: c.dataset.theme, label: c.querySelector('.lbl').textContent }; })()`);
  ok("auto: an Arabic page and a dark device give an Arabic, dark panel", auto.dir === "rtl" && auto.theme === "dark" && auto.label === "الكتابة", JSON.stringify(auto));
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, s);
  await sleep(300);
  ok("auto: the device switches to light, the panel follows at once", (await ev(s, `${SH}.querySelector('.cg').dataset.theme`)) === "light");
  pageLang = "en"; await load();
  ok("auto: an English page gives an English panel", (await ev(s, `${SH}.querySelector('.cg').dir`)) === "ltr");
  // a position saved for a narrower panel (or a smaller window) is pulled back inside the window
  await ev(s, "localStorage.setItem('continuumGuardPos', JSON.stringify({ left: 1200, top: 100 })); true");
  await load();
  const box = await ev(s, `(() => { const r = document.getElementById('continuum-guard-host').getBoundingClientRect(); return { right: r.right, left: r.left, top: r.top, w: innerWidth }; })()`);
  ok("placed: a saved position past the right edge is pulled inside, the panel whole", box.right <= box.w - 4 && box.left >= 4 && box.top === 100, JSON.stringify(box));
  await ev(s, "localStorage.removeItem('continuumGuardPos'); true");
  await load();
  // collapse animates and is kept
  await ev(s, `${SH}.querySelector('.cx').click(); true`); await sleep(600);
  ok("collapse: the panel folds to its header", await ev(s, `${SH}.querySelector('.panel').classList.contains('collapsed') && ${SH}.querySelector('.pin').getBoundingClientRect().height < 2`));
  await shot(s, "sdk-collapsed", await panelBox());
  await ev(s, `${SH}.querySelector('.cx').click(); true`);
  ok("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
} catch (e) { console.log("  FAIL  harness error:", e.message); bad++; }
finally { ws.close(); chrome.kill(); await sleep(300); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed"); console.log("screenshots:", SHOTS);
process.exit(bad ? 1 : 0);
