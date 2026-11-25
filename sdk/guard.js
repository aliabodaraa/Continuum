/*
 * Continuum Guard — drop-in continuous-authentication SDK.
 *
 * Two modes, selected automatically:
 *  • GATEWAY / product mode — when `data-site-key` is present. The SDK loads from
 *    Continuum's origin, mints its own Continuum identity/session against the
 *    gateway, and INJECTS the whole lifecycle UI (passkey registration, keystroke
 *    enrollment, mouse enrollment, step-up). The host app writes ONE script tag.
 *        <script src="https://cdn.continuum/guard.js"
 *                data-api-base="https://cdn.continuum" data-site-key="pk_demo"></script>
 *  • DEMO mode — no site-key: talks to same-origin /api/* (the reference app).
 *
 * All UI is rendered inside a Shadow DOM so the host's CSS/JS can never collide.
 * Public API on window.Continuum: getRiskToken(), riskHeader(), isLocked(),
 * identify(externalId), onReady(cb).
 */
(function () {
  "use strict";
  if (window.__continuumGuard) return;
  window.__continuumGuard = true;

  var script = document.currentScript || (function () { var s = document.getElementsByTagName("script"); return s[s.length - 1]; })();
  var cfg = {
    apiBase: (script && script.getAttribute("data-api-base")) || "",
    siteKey: (script && script.getAttribute("data-site-key")) || "",
    externalId: (script && script.getAttribute("data-external-id")) || "",
    identity: (script && script.getAttribute("data-identity")) || "",
    identityUrl: (script && script.getAttribute("data-identity-url")) || "", // SDK auto-fetches the signed identity here (same-origin → the app's session cookie flows)
    // A session minted elsewhere (the browser extension, which signed its user in): used as is,
    // instead of asking /v1/sdk/session for one. Only the gateway's own pages set it.
    session: (script && script.getAttribute("data-session")) || "",
    defer: (script && script.getAttribute("data-defer")) === "1", // wait for identify()
    keystroke: (script && script.getAttribute("data-keystroke")) || "on",
    mouse: (script && script.getAttribute("data-mouse")) || "optional",
    // Onboarding strategy: "eager" (enroll everything missing at load) or "lazy"
    // (passkey only at load; a modality enrolls when its toggle is turned on).
    // Page attr wins; otherwise the server's deployment config (docker env) applies.
    onboarding: (script && script.getAttribute("data-onboarding")) || "",
    panel: (script && script.getAttribute("data-panel")) || "",   // "show" | "hide"
    lang: (script && script.getAttribute("data-lang")) || "",     // "auto" | "en" | "ar"
    theme: (script && script.getAttribute("data-theme")) || "",   // "auto" | "light" | "dark"
    // The × in mandatory popups signs the user out through the organisation's own pages, so it is shown only when the
    // page names its sign-in page (data-login-url). data-logout-url is optional: the address to call first, if any.
    logoutUrl: (script && script.getAttribute("data-logout-url")) || "",
    loginUrl: (script && script.getAttribute("data-login-url")) || "",
  };
  var MODE = cfg.siteKey ? "gateway" : "demo";
  if (MODE === "demo") {   // our demo app's own pages (no site key) have these two
    cfg.logoutUrl = cfg.logoutUrl || "/api/auth/logout";
    cfg.loginUrl = cfg.loginUrl || "/login.html";
  }
  // Which of the managed settings this page chose itself. The organisation's console and the
  // operator page override a page's choice; a deployment default does not (see loadConfig).
  var PAGE_SET = { keystroke: !!(script && script.hasAttribute("data-keystroke")), mouse: !!(script && script.hasAttribute("data-mouse")),
                   onboarding: !!cfg.onboarding, panel: !!cfg.panel, panelLanguage: !!cfg.lang, panelTheme: !!cfg.theme };
  var LS_MOUSE = "continuumGuardMouse";
  var LS_KEYSTROKE = "continuumGuardKeystroke";
  var LS_EXT = "continuumExternalId";
  var LS_POS = "continuumGuardPos";
  var LS_COLLAPSE = "continuumGuardCollapsed";

  // ---------- language and colours ----------
  // Chosen by the organisation (its console, or the operator's default): panelLanguage auto | en | ar and
  // panelTheme auto | light | dark, from /config (loadConfig). A page may set its own with data-lang and
  // data-theme; the organisation's explicit choice overrides it, as for the other managed settings. "auto" is the
  // page's own language (<html lang>, else the browser's) and the device's light or dark mode. Every phrase is
  // written in English in this file and looked up in /js/guard-ar.js, which loads only when Arabic is used. The
  // enrolment passages stay English in both languages: they are what the typing model is trained on.
  var LANG_PREF = cfg.lang || "auto", THEME_PREF = cfg.theme || "auto", LANG = "en", THEME = "light";
  var darkMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  var reduceMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  function resolveLang(pref) {
    if (pref === "en" || pref === "ar") return pref;
    var page = String(document.documentElement.getAttribute("lang") || "");
    return (page || String(navigator.language || "")).toLowerCase().indexOf("ar") === 0 ? "ar" : "en";
  }
  function resolveTheme(pref) { return pref === "light" || pref === "dark" ? pref : darkMq && darkMq.matches ? "dark" : "light"; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function phrase(s) { var d = LANG === "ar" ? window.continuumGuardAR : null; return d && typeof d[s] === "string" ? d[s] : s; }
  // t() is plain text (textContent), its {slots} filled as given; h() goes into innerHTML, its slots escaped
  // (the phrases themselves are this file's own, a few with <b>).
  function t(s, vars) { var out = phrase(s); return vars ? out.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] == null ? "" : String(vars[k]); }) : out; }
  function h(s, vars) { var out = phrase(s); return vars ? out.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] == null ? "" : esc(vars[k]); }) : out; }
  function loadLang() {
    if (resolveLang(LANG_PREF) !== "ar" || window.continuumGuardAR) return Promise.resolve();
    return loadScript(url("/js/guard-ar.js")).catch(function () {});   // without it the panel stays English
  }
  // A short animation (Web Animations API), skipped when the device asks for less motion.
  function play(node, frames, opts) { if (!reduceMotion && node && node.animate) { try { node.animate(frames, opts); } catch (e) {} } }

  // window math (overwritten from config)
  var WINDOW_SIZE = 50, WINDOW_STRIDE = 10, RECENT_WINDOW_COUNT = 20, SAMPLE_WINDOWS = 20, KS_MIN_CHARS = 80;
  // MOUSE_MIN_WINDOWS = the number of windows the server's vote decides on (ca-service
  // lib/mouse.js VOTE_N, 60 = ~17 s of movement). Sending fewer leaves every check in warm-up, so
  // the value is taken from the server's own replies (bufferMax) whenever it reports one.
  var MOUSE_CHECK_MS = 1600, MOUSE_MIN_WINDOWS = 60;
  // Enrolment for the adopted pipeline (continuum/artifacts/repr_arch_study, S1), in SAMPLES: one
  // sample = MOUSE_SAMPLE_WINDOWS windows (a few of the pad's tasks), MOUSE_SAMPLES_REQUIRED of them
  // (8 x 55 = 440 windows). /status reports both; these are the defaults.
  var MOUSE_SAMPLE_WINDOWS = 55, MOUSE_SAMPLES_REQUIRED = 8;
  // The model is built by the server's training queue (F2: about 6 s; S1 took 2-3 min), not inside the request
  // that saves the last sample; the wizard polls /status this often until it exists, says so when
  // it takes unusually long, and stops waiting (the job itself carries on) after the last bound.
  var MOUSE_TRAIN_POLL_MS = 3000, MOUSE_TRAIN_SLOW_MS = 5 * 60000, MOUSE_TRAIN_GIVE_UP_MS = 15 * 60000;
  // What the pad asks for (mouseTasks). A sample is saved once it holds MOUSE_SAMPLE_WINDOWS windows and this many
  // finished tasks, so moving about without doing them saves nothing. A task still open after MOUSE_TASK_SKIP_MS can be
  // skipped, and then does not count.
  var MOUSE_TASKS_PER_SAMPLE = 4, MOUSE_TASK_SKIP_MS = 18000;
  // Adaptive learning: after this many consecutive clean (genuine, high-confidence)
  // checks — the SDK analogue of the demo's "3 clean packets" — offer to add the run
  // to the user's training set. The CA retrains every N contributions (val-gated).
  var ADAPT_CONFIDENCE_MIN = 0.9, ADAPT_CLEAN_RUN = 3, ADAPT_RETRAIN_EVERY = 3;
  // The organisation can switch adaptive retraining off, and sets the minimum gap between two
  // accepted samples (default 3 h). contribUntil: no offer before this time (null = not asked yet).
  var ADAPT_ENABLED = true, ADAPT_GAP_H = 3, contribUntil = null, contribFetching = false;
  // The cycle (owner's design, 2026-10-04): three samples, then the user retrains with a passkey, then a
  // pause of ADAPT_GAP_H hours. What is sent for a sample is only the typing since the previous one, after a
  // gap of one window's keys, so no two samples share a keystroke (no window is learned twice). The server
  // keeps the last SAMPLE_WINDOWS windows of it (2026-10-19), judges all of them and stores only them.
  // sampleProbe: the server's last answer to "would this sample be accepted now?", asked once per new window.
  var SAMPLE_GAP_KEYS = 50, SAMPLE_MAX_EVENTS = 1400;
  var contribEndIdx = 0, adaptPending = 0, adaptReady = false, learnMode = "", retrainDismissed = false;
  var sampleProbe = { busy: false, forWindows: -1, eligible: false };
  // The floating panel: shown unless the page or the organisation hides it.
  var PANEL = cfg.panel === "hide" ? "hide" : "show", panelEl = null, ksAddEl = null, msAddEl = null;
  // Field types never watched: the organisation's setting (from /config), else the deployment's
  // MONITOR_EXCLUDE_TYPES. Their keys leave no event and their text is not counted.
  var EXCLUDE_TYPES = ["hidden"];

  var sessionToken = null, userId = null, latestRiskToken = null, locked = false, ready = false;
  var identityToken = cfg.identity || null, started = false, ksInputHandler = null, ksPasteHandler = null;
  var readyCbs = [];
  var ONBOARD_MODE = cfg.onboarding || "eager"; // may be overridden by server config
  var ksBuilding = false, ksBuildTimer = null;   // typing model being built on the server's queue
  var obState = null;                            // {passkey, keystroke, mouse} for THIS user

  // ---------- transport ----------
  function url(p) { return cfg.apiBase + p; }
  function req(path, method, body) {
    var headers = { "Content-Type": "application/json" };
    if (MODE === "gateway" && sessionToken) headers["Authorization"] = "Bearer " + sessionToken;
    return fetch(url(path), { method: method || "GET", headers: headers, body: body ? JSON.stringify(body) : undefined });
  }
  async function reqJson(path, method, body) { var r = await req(path, method, body); var d = await r.json().catch(function () { return {}; }); return { status: r.status, ok: r.ok, d: d }; }

  // endpoint map per mode
  var EP = MODE === "gateway" ? {
    config: "/v1/sdk/keystroke/config", ksStatus: "/v1/sdk/keystroke/status", ksEnroll: "/v1/sdk/keystroke/enroll", ksCheck: "/v1/sdk/keystroke/check", ksContribute: "/v1/sdk/keystroke/contribute",
    mouseEnroll: "/v1/sdk/mouse/enroll", mouseCheck: "/v1/sdk/mouse/check", mouseStatus: "/v1/sdk/mouse/status", onboarding: "/v1/sdk/onboarding",
    ksReset: "/v1/sdk/keystroke/reset", mouseReset: "/v1/sdk/mouse/reset",
    pkRegOpts: "/v1/sdk/passkey/register/options", pkRegDone: "/v1/sdk/passkey/register/complete",
    pkAuthOpts: "/v1/sdk/passkey/auth/options", pkAuthDone: "/v1/sdk/passkey/auth/complete",
    lockStatus: "/v1/sdk/lock/status", adaptiveRetrain: "/v1/sdk/keystroke/adaptive/retrain",
    mouseUseSample: "/v1/sdk/mouse/use-sample",
  } : {
    config: "/api/text/config", ksStatus: "/api/text/typing-status", ksEnroll: "/api/text/enroll", ksCheck: "/api/text/check", ksContribute: "/api/text/contribute",
    mouseEnroll: "/api/mouse/enroll", mouseCheck: "/api/mouse/check", mouseStatus: "/api/mouse/status",
    ksReset: "/api/text/typing-reset", mouseReset: "/api/mouse/reset", adaptiveRetrain: "/api/text/adaptive-retrain",
    mouseUseSample: "/api/mouse/use-sample",
  };

  // ---------- dependency loader ----------
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement("script"); s.src = src; s.async = true; s.onload = res; s.onerror = function () { rej(new Error("load " + src)); }; document.head.appendChild(s); }); }
  function ensureDeps() {
    var j = [];
    if (!window.continuumKeystrokes) j.push(loadScript(url("/js/keystroke-tracker.js")));
    if (!window.mouseFeatures) j.push(loadScript(url("/js/mouse-features.js")));
    if (!window.SimpleWebAuthnBrowser) j.push(loadScript(url("/vendor/simplewebauthn/index.umd.min.js")));
    j.push(loadLang());   // Arabic from the start when the page asks for it (the organisation's choice follows in loadConfig)
    return Promise.all(j);
  }

  // ---------- Shadow-DOM UI ----------
  var shadow, rootEl, logoEl, sumEl, sumDotEl, KS = null, MS = null;
  var kbEl, ksToggleEl, mouseEl, toggleEl, modalEl, modalErrEl, modalBtnEl, wizEl, learnEl, useEl, cfmEl;
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  // Line icons (24 x 24, stroked), the same family as the gateway's pages.
  var ICON = {
    logo: '<path class="beat" d="M3 12h4l3-8 4 16 3-8h4"/>',
    keyboard: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
    mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    finger: '<path d="M12 10a2 2 0 0 0-2 2c0 1-.1 2.5-.3 4M14 13.1c0 2.4 0 6.4-1 8.9M17.3 21c.1-.6.4-2.3.5-3M2 12a10 10 0 0 1 18-6M2 16h.01M21.8 16c.2-2 .1-5.4 0-6M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .3-2M8.7 22c.2-.7.4-1.3.6-2M9 6.8a6 6 0 0 1 9 5.2v2"/>',
    door: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    // the mouse enrolment tasks
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
    text: '<path d="M5 7V4h14v3M12 4v16M9 20h6"/>',
    slider: '<path d="M3 12h4M13 12h8"/><circle cx="10" cy="12" r="3"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    move: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
    pointer: '<path d="M5 3l14 9-7 1.5L8.5 20z"/>',
  };
  function svg(name, cls) { return '<svg viewBox="0 0 24 24" aria-hidden="true"' + (cls ? ' class="' + cls + '"' : "") + ">" + ICON[name] + "</svg>"; }
  // Light by default, dark under data-theme="dark" (applyLook); right-to-left under dir="rtl". Sides are written as
  // inline-start/end so the layout mirrors by itself. Every animation stops under prefers-reduced-motion.
  var CSS = [
    ".cg{--font:system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans Arabic',Tahoma,Arial,sans-serif;",
    "--glass:rgba(255,255,255,.84);--card:#fff;--card2:#f5f7fb;--row:rgba(15,23,42,.035);--text:#0f172a;--text2:#334155;--muted:#64748b;--faint:#94a3b8;",
    "--line:rgba(15,23,42,.08);--line2:rgba(15,23,42,.14);--track:rgba(15,23,42,.09);--acc:#6366f1;--acc2:#8b5cf6;--accw:rgba(99,102,241,.14);",
    "--ok:#16a34a;--okw:rgba(22,163,74,.12);--warn:#d97706;--warnw:rgba(217,119,6,.14);--bad:#dc2626;--badw:rgba(220,38,38,.1);--mut:#94a3b8;",
    "--veil:rgba(15,23,42,.42);--shadow:0 22px 48px -18px rgba(15,23,42,.42),0 3px 10px rgba(15,23,42,.08);--pop:0 40px 90px -28px rgba(15,23,42,.55);",
    "font:500 12.5px/1.45 var(--font);color:var(--text);-webkit-font-smoothing:antialiased;text-align:start}",
    ".cg[data-theme=dark]{--glass:rgba(15,23,42,.82);--card:#111a2e;--card2:#0b1324;--row:rgba(255,255,255,.04);--text:#e5e9f5;--text2:#cbd5e1;--muted:#94a3b8;--faint:#64748b;",
    "--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.15);--track:rgba(255,255,255,.1);--acc:#818cf8;--acc2:#a78bfa;--accw:rgba(129,140,248,.18);",
    "--ok:#4ade80;--okw:rgba(74,222,128,.13);--warn:#fbbf24;--warnw:rgba(251,191,36,.14);--bad:#f87171;--badw:rgba(248,113,113,.14);--mut:#64748b;",
    "--veil:rgba(2,6,23,.64);--shadow:0 22px 48px -18px rgba(0,0,0,.75),0 3px 10px rgba(0,0,0,.35);--pop:0 40px 90px -28px rgba(0,0,0,.85)}",
    ".cg *{box-sizing:border-box}.cg svg{display:block}",
    // ---- the panel ----
    ".panel{width:276px;background:var(--glass);-webkit-backdrop-filter:blur(16px) saturate(1.5);backdrop-filter:blur(16px) saturate(1.5);border:1px solid var(--line2);border-radius:20px;box-shadow:var(--shadow);overflow:hidden;animation:cg-in .55s cubic-bezier(.2,.9,.25,1.1) both;transition:width .4s cubic-bezier(.2,.8,.2,1),box-shadow .3s}",
    ".panel:hover{box-shadow:var(--shadow),0 0 0 4px var(--accw)}",
    ".panel.collapsed{width:216px}",
    ".hd{display:flex;align-items:center;gap:10px;padding:11px;cursor:grab;user-select:none}.hd:active{cursor:grabbing}",
    ".logo{position:relative;width:34px;height:34px;flex:none;border-radius:11px;display:grid;place-items:center;background:linear-gradient(135deg,var(--acc),var(--acc2));box-shadow:0 8px 18px -8px var(--acc)}",
    ".logo svg,.b2 svg{width:20px;height:20px;fill:none;stroke:#fff;stroke-width:2.3;stroke-linecap:round;stroke-linejoin:round}",
    ".logo .beat{stroke-dasharray:44;stroke-dashoffset:0}",
    ".logo .rp{position:absolute;inset:-3px;border-radius:13px;border:2px solid var(--acc);opacity:0;pointer-events:none}",
    ".ttl{flex:1;min-width:0}.ttl b{display:block;font-size:13.5px;font-weight:800;letter-spacing:-.01em;color:var(--text)}",
    ".sum{display:flex;align-items:center;gap:6px;margin-top:1px;font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden}",
    ".sum span:last-child{overflow:hidden;text-overflow:ellipsis}",
    ".sdot{position:relative;width:7px;height:7px;flex:none;border-radius:50%;background:var(--mut);transition:background .3s}",
    ".sdot::after{content:'';position:absolute;inset:0;border-radius:50%;background:inherit;opacity:0}",
    ".sdot.ok{background:var(--ok)}.sdot.ok::after{animation:cg-breathe 2.4s ease-out infinite}.sdot.col{background:var(--acc)}.sdot.col::after{animation:cg-breathe 1.8s ease-out infinite}",
    ".sdot.warn{background:var(--warn)}.sdot.bad{background:var(--bad)}.sdot.bad::after{animation:cg-breathe 1.1s ease-out infinite}",
    ".cx{width:28px;height:28px;flex:none;border:0;border-radius:9px;background:transparent;color:var(--muted);display:grid;place-items:center;cursor:pointer;padding:0;transition:background .2s,color .2s}",
    ".cx:hover{background:var(--row);color:var(--text)}",
    ".cx svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;transition:transform .4s cubic-bezier(.2,.8,.2,1)}",
    ".panel.collapsed .cx svg{transform:rotate(180deg)}",
    ".pbody{display:grid;grid-template-rows:1fr;transition:grid-template-rows .4s cubic-bezier(.2,.8,.2,1)}.panel.collapsed .pbody{grid-template-rows:0fr}",
    // minmax(0, 1fr): the column may be narrower than a row's longest status text, which then ends in an ellipsis
    // (with the default auto track the rows grew to that text and their switches were cut off at the panel's edge)
    ".pin{min-height:0;overflow:hidden}.rows{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;padding:0 10px 10px}",
    ".row{display:flex;align-items:center;gap:9px;min-width:0;padding:8px 9px;border-radius:14px;background:var(--row);border:1px solid var(--line);transition:background .35s,border-color .35s}",
    ".row.ok{--c:var(--ok)}.row.col{--c:var(--acc)}.row.warn{--c:var(--warn)}.row.mut{--c:var(--mut)}",
    ".row.bad{--c:var(--bad);background:var(--badw);border-color:color-mix(in srgb,var(--bad) 32%,transparent)}",
    ".ring{position:relative;width:38px;height:38px;flex:none}",
    ".ring .r{width:38px;height:38px;transform:rotate(-90deg)}",
    ".ring circle{fill:none;stroke-width:3}.ring .tr{stroke:var(--track)}",
    ".ring .pr{stroke:var(--c,var(--mut));stroke-linecap:round;stroke-dasharray:100;transition:stroke-dashoffset .8s cubic-bezier(.2,.8,.2,1),stroke .35s}",
    ".row.busy .r{animation:cg-turn 1s linear infinite}.row.busy .pr{stroke-dasharray:26 74;stroke:var(--acc)}",
    ".ring .ic{position:absolute;inset:0;display:grid;place-items:center;color:var(--c,var(--mut));transition:color .35s}",
    ".ring .ic svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}",
    ".info{flex:1;min-width:0}.lbl{display:block;font-weight:700;font-size:12.5px;color:var(--text)}",
    // a long status wraps to a second line (it used to end in an ellipsis: "type 80 characters to st…")
    ".st{position:relative;display:block;margin-top:1px;font-size:11.5px;line-height:1.35;color:var(--muted);overflow-wrap:anywhere;transition:color .35s}",
    ".st::first-letter{text-transform:uppercase}.st b{font-weight:800}.st .pct{font-variant-numeric:tabular-nums}",
    ".st.ok{color:var(--ok)}.st.col{color:var(--acc)}.st.warn{color:var(--warn)}.st.bad{color:var(--bad)}",
    ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
    ".add{width:28px;height:28px;flex:none;border-radius:9px;border:1px solid var(--line2);background:transparent;color:var(--acc);display:grid;place-items:center;cursor:pointer;padding:0;transition:background .2s,transform .2s}",
    ".add:hover{background:var(--accw);transform:translateY(-1px)}",
    ".add svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round}",
    ".tgl{position:relative;width:36px;height:21px;flex:none;border:0;border-radius:999px;background:var(--track);cursor:pointer;padding:0;font-size:0;color:transparent;transition:background .3s}",
    ".tgl::before{content:'';position:absolute;top:2.5px;inset-inline-start:2.5px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 2px 5px rgba(0,0,0,.25);transition:transform .35s cubic-bezier(.3,1.5,.5,1)}",
    ".tgl.on{background:var(--ok)}.tgl.on::before{transform:translateX(15px)}.cg[dir=rtl] .tgl.on::before{transform:translateX(-15px)}",
    ".tgl:focus-visible,.add:focus-visible,.cx:focus-visible,.b:focus-visible,.wizx:focus-visible{outline:3px solid var(--accw);outline-offset:1px}",
    // ---- windows: the step-up, the onboarding wizard, the training popups, a confirmation ----
    ".ov{position:fixed;inset:0;display:none;align-items:center;justify-content:center;padding:16px;background:var(--veil);-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px);animation:cg-fade .3s ease both}",
    ".card{position:relative;width:100%;max-width:480px;max-height:calc(100vh - 32px);overflow:auto;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:24px;padding:28px 30px;font:500 14px/1.6 var(--font);box-shadow:var(--pop);animation:cg-pop .5s cubic-bezier(.2,.9,.25,1.15) both}",
    // Mouse enrolment gets a much larger card. The click target spawns inside the pad, so its size sets how far apart
    // consecutive hops can be, and a 480px card taught the model one cramped amplitude that never matched full-page movement.
    // Since the tasks (2026-11-24) the pad is a little lower, so the whole card fits a laptop screen without scrolling:
    // a task sets its own distances.
    // The mouse samples' card is as tall as the window: one row above the pad (.mtop) and one below it (.mbot), and the
    // pad has all the height between them. Its width follows its height, about as a screen's does: until 2026-11-25
    // the pad was a strip up to 1100 px wide and half the window high (three times as wide as high on a laptop), and
    // movement between targets on a strip runs sideways.
    ".card.wide{max-width:min(96vw,1500px,calc((100vh - 230px)*1.8));height:calc(100vh - 32px);display:flex;flex-direction:column;padding:20px 24px}.card.wide>*{flex:0 0 auto}",
    ".card.wide .brand{margin-bottom:10px}.card.wide .pad{flex:1 1 0;height:auto;min-height:260px;margin-bottom:0}.card.wide .bar{margin:10px 0 8px}",
    ".mtop{display:flex;align-items:flex-end;justify-content:space-between;gap:6px 24px;flex-wrap:wrap;margin-bottom:10px}.mtop .mtt{flex:1 1 320px;min-width:0}",
    ".mtop .t{margin-bottom:2px}.mtop .d{margin:0;line-height:1.5}.mtop .msamp{margin:0}",
    ".mbot{display:flex;align-items:center;justify-content:space-between;gap:8px 18px;flex-wrap:wrap}.mbot .diag{margin:0}",
    ".mact{display:flex;align-items:center;gap:18px;margin-inline-start:auto}.mact .foot{margin:0}.mact .row2 .b{flex:0 0 auto;width:auto;padding:10px 30px}",
    ".card.center .t,.card.center .d{text-align:center}",
    ".wizx{position:absolute;top:12px;inset-inline-end:12px;width:32px;height:32px;border:0;border-radius:10px;background:transparent;color:var(--faint);display:grid;place-items:center;cursor:pointer;padding:0;transition:background .2s,color .2s,transform .3s}",
    ".wizx:hover{background:var(--card2);color:var(--text);transform:rotate(90deg)}",
    ".wizx svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round}",
    ".brand{display:flex;align-items:center;gap:8px;margin-bottom:16px;font-size:11px;font-weight:800;letter-spacing:.06em;color:var(--acc)}.cg[dir=rtl] .brand{letter-spacing:0}",
    ".brand .b2{width:22px;height:22px;flex:none;border-radius:7px;display:grid;place-items:center;background:linear-gradient(135deg,var(--acc),var(--acc2))}.brand .b2 svg{width:14px;height:14px;stroke-width:2.6}",
    ".hero{display:grid;place-items:center;margin:4px 0 18px}",
    ".orb{position:relative;width:76px;height:76px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 32% 28%,var(--acc2),var(--acc));box-shadow:0 16px 34px -12px var(--acc)}",
    ".orb svg{position:relative;width:36px;height:36px;fill:none;stroke:#fff;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}",
    ".orb::before,.orb::after{content:'';position:absolute;inset:-10px;border-radius:50%;border:2px solid var(--acc);opacity:0;animation:cg-ring 2.4s ease-out infinite}.orb::after{animation-delay:1.2s}",
    ".orb .scan{position:absolute;inset:0;border-radius:50%;overflow:hidden}",
    ".orb .scan::after{content:'';position:absolute;left:0;right:0;top:-30%;height:30%;background:linear-gradient(180deg,transparent,rgba(255,255,255,.5),transparent);animation:cg-scan 2.2s ease-in-out infinite}",
    ".orb.bad{background:radial-gradient(circle at 32% 28%,#fb7185,var(--bad));box-shadow:0 16px 34px -12px var(--bad)}.orb.bad::before,.orb.bad::after{border-color:var(--bad)}",
    ".orb.ok{background:radial-gradient(circle at 32% 28%,#4ade80,#16a34a);box-shadow:0 16px 34px -12px #16a34a}.orb.ok::before,.orb.ok::after{border-color:#16a34a;animation-iteration-count:2}",
    ".orb.ok svg path{stroke-dasharray:24;stroke-dashoffset:24;animation:cg-draw .7s .2s ease forwards}",
    ".t{font-size:20px;font-weight:800;letter-spacing:-.01em;color:var(--text);margin-bottom:6px}.cg[dir=rtl] .t{letter-spacing:0}",
    ".d{font-size:13.5px;color:var(--muted);line-height:1.7;margin-bottom:18px}.d b{color:var(--text)}.d a{color:var(--acc);font-weight:700;text-decoration:none}",
    ".b{position:relative;overflow:hidden;width:100%;border:0;border-radius:13px;padding:13px 16px;background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff;font:700 14.5px var(--font);cursor:pointer;box-shadow:0 12px 26px -12px var(--acc);transition:transform .18s,filter .2s,opacity .2s}",
    ".b::after{content:'';position:absolute;top:0;bottom:0;left:-60%;width:40%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.38),transparent);transform:skewX(-18deg)}",
    ".b:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.06)}.b:hover:not(:disabled)::after{animation:cg-shine .9s ease}",
    ".b:active:not(:disabled){transform:scale(.99)}.b:disabled{opacity:.55;cursor:default}",
    ".b.sec{background:var(--card2);color:var(--text2);box-shadow:none;border:1px solid var(--line2)}",
    ".b.bad{background:linear-gradient(135deg,#f43f5e,var(--bad));box-shadow:0 12px 26px -12px var(--bad)}",
    ".row2{display:flex;gap:8px}.row2 .b{flex:1}",
    ".e{display:none;margin-top:12px;padding:10px 12px;border-radius:11px;background:var(--badw);color:var(--bad);font-size:12.5px;line-height:1.5}",
    ".foot{text-align:center;margin-top:12px}",
    ".danger{display:inline-flex;align-items:center;gap:6px;color:var(--bad);font-size:12px;font-weight:700;text-decoration:none}",
    ".danger svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    ".wizload{position:absolute;inset:0;z-index:2;border-radius:24px;display:none;align-items:center;justify-content:center;gap:10px;background:color-mix(in srgb,var(--card) 86%,transparent);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);font-weight:800;color:var(--acc)}",
    ".wizload.on{display:flex;animation:cg-fade .25s ease both}",
    ".wizspin{width:22px;height:22px;flex:none;border-radius:50%;border:3px solid var(--accw);border-top-color:var(--acc);animation:cg-spin .7s linear infinite}",
    ".steps{display:flex;gap:8px;margin:0 0 18px}.steps .s{flex:1;min-width:0}",
    ".steps .s i{position:relative;display:block;height:5px;border-radius:999px;background:var(--track);overflow:hidden}",
    ".steps .s i::after{content:'';position:absolute;inset:0;border-radius:inherit;background:linear-gradient(90deg,var(--acc),var(--acc2));transform:scaleX(0);transform-origin:left}",
    ".cg[dir=rtl] .steps .s i::after{transform-origin:right}",
    ".steps .s.done i::after{background:var(--ok);transform:scaleX(1)}.steps .s.on i::after{animation:cg-grow 1.2s cubic-bezier(.2,.8,.2,1) forwards}",
    ".steps .s span{display:block;margin-top:6px;font-size:11px;font-weight:700;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".steps .s.on span{color:var(--acc)}.steps .s.done span{color:var(--ok)}",
    // the typing passage and the box stay left-to-right: they are English text to copy
    ".passage{direction:ltr;text-align:left;unicode-bidi:isolate;margin-bottom:10px;padding:13px 15px;border-radius:13px;background:var(--card2);border:1px solid var(--line);font-size:13.5px;line-height:1.75;color:var(--text2);user-select:none}",
    ".ta{display:block;width:100%;min-height:104px;direction:ltr;text-align:left;padding:12px 13px;border:1px solid var(--line2);border-radius:13px;background:var(--card);color:var(--text);font:inherit;resize:none;transition:border-color .2s,box-shadow .2s}",
    ".ta:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 4px var(--accw)}.ta::placeholder{color:var(--faint)}",
    ".bar{height:8px;margin:12px 0;border-radius:999px;background:var(--track);overflow:hidden}",
    ".bar>i{position:relative;display:block;height:100%;width:0;border-radius:inherit;overflow:hidden;background:linear-gradient(90deg,var(--acc),var(--acc2));transition:width .4s cubic-bezier(.2,.8,.2,1)}",
    ".bar>i::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.42),transparent);animation:cg-shim 1.6s linear infinite}",
    ".diag{font-size:11.5px;color:var(--faint);margin:6px 0 10px;font-variant-numeric:tabular-nums}",
    ".samplecount{font-size:12.5px;font-weight:700;color:var(--muted);margin-bottom:8px}.samplecount b{color:var(--acc)}",
    ".pad{position:relative;overflow:hidden;height:260px;margin-bottom:12px;border-radius:16px;border:2px dashed color-mix(in srgb,var(--acc) 40%,transparent);background:radial-gradient(120% 120% at 50% 0%,var(--accw),transparent 70%),var(--card2);display:flex;align-items:center;justify-content:center;text-align:center;color:var(--acc);font-weight:700}",
    // the target jumps (no glide): how the user moves to it is what the mouse model learns
    ".pt{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:radial-gradient(circle at 35% 30%,var(--acc2),var(--acc));box-shadow:0 0 0 6px var(--accw),0 8px 18px -6px var(--acc);cursor:pointer;animation:cg-pt 1.2s ease-in-out infinite}",
    ".pt::after{content:'';position:absolute;inset:-6px;border-radius:50%;border:2px solid var(--acc);animation:cg-ring 1.6s ease-out infinite}",
    ".pt.sm{width:16px;height:16px;margin:-8px 0 0 -8px;box-shadow:0 0 0 5px var(--accw),0 6px 14px -6px var(--acc)}",
    // ---- the enrolment tasks (mouseTasks): a line that says what to do, and a stage the task is drawn on ----
    ".pad.tasks{display:block;text-align:start;color:var(--text);font-weight:500;-webkit-user-select:none;user-select:none}",
    ".tk-top{position:absolute;top:0;inset-inline:0;z-index:3;display:flex;align-items:center;gap:10px;padding:10px 14px;pointer-events:none}",
    ".tk-ic{width:32px;height:32px;flex:none;border-radius:10px;display:grid;place-items:center;background:var(--accw);color:var(--acc)}",
    ".tk-ic svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    ".tk-say{flex:1;min-width:0;font-size:16px;font-weight:800;line-height:1.35;color:var(--text)}",
    ".tk-n{flex:none;display:flex;gap:5px}.tk-n i{width:10px;height:10px;border-radius:50%;background:var(--track);transition:background .3s,transform .3s}.tk-n i.on{background:var(--ok);transform:scale(1.15)}",
    ".tk-stage{position:absolute;inset:54px 0 0 0}",
    ".tk-skip{position:absolute;bottom:6px;inset-inline-end:10px;z-index:3;display:none;border:0;background:none;padding:4px 6px;font:600 12px var(--font);color:var(--muted);text-decoration:underline;cursor:pointer}.tk-skip:hover{color:var(--text)}",
    ".tk-ok{position:absolute;z-index:4;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;display:grid;place-items:center;background:var(--ok);pointer-events:none;animation:cg-popin .35s cubic-bezier(.3,1.6,.5,1)}",
    ".tk-ok svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}",
    ".tk-chip{position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;display:grid;place-items:center;font:800 12.5px var(--font);font-variant-numeric:tabular-nums;background:var(--card);color:var(--muted);border:2px solid var(--line2);cursor:pointer;transition:background .25s,border-color .25s,color .25s,box-shadow .25s}",
    ".tk-chip.next{border-color:var(--acc);color:var(--acc);box-shadow:0 0 0 5px var(--accw)}.tk-chip.done{background:var(--ok);border-color:var(--ok);color:#fff}",
    ".tk-text{position:absolute;font-size:17px;line-height:2.05;font-weight:500;color:var(--text);cursor:text}",
    ".tk-w{display:inline-block;padding:0 4px;border-radius:6px;transition:background .15s,color .15s,box-shadow .15s}",
    ".tk-text.col .tk-w{display:block;width:max-content}",   // the list form: one word a line
    ".tk-w.mark{background:var(--accw);box-shadow:inset 0 -2px 0 var(--acc)}.tk-w.sel{background:var(--acc);color:#fff;box-shadow:none}",
    ".tk-w.lit{background:var(--okw);color:var(--ok)}.tk-w.cur{box-shadow:inset 0 -3px 0 var(--acc)}",
    ".tk-track{position:absolute;height:6px;border-radius:999px;background:var(--track)}.tk-track.v{width:6px}",
    ".tk-track::before{content:'';position:absolute;inset:-9px 0}.tk-track.v::before{inset:0 -9px}",
    ".tk-mark{position:absolute;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:7px;background:var(--accw);border:2px dashed var(--acc);pointer-events:none}.tk-track.v .tk-mark{left:50%}",
    ".tk-knob{position:absolute;top:50%;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:var(--card);border:3px solid var(--acc);box-shadow:0 4px 10px -3px var(--acc);cursor:grab;transition:transform .15s,background .25s,border-color .25s}.tk-track.v .tk-knob{left:50%}",
    ".tk-knob.drag{cursor:grabbing;transform:scale(1.12)}.tk-knob.ok{background:var(--ok);border-color:var(--ok)}.tk-track.seek{cursor:pointer}.tk-track.seek .tk-knob{width:14px;height:14px;margin:-7px 0 0 -7px;cursor:pointer}",
    ".tk-btn{position:absolute;display:inline-flex;align-items:center;gap:6px;padding:8px 13px;border-radius:10px;border:1px solid var(--line2);background:var(--card);color:var(--text);font:700 13px var(--font);cursor:pointer;box-shadow:0 2px 6px rgba(15,23,42,.1)}",
    ".tk-btn svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}",
    ".tk-menu{position:absolute;z-index:2;display:none;min-width:176px;padding:6px;border-radius:12px;border:1px solid var(--line2);background:var(--card);box-shadow:var(--shadow)}.tk-menu.open{display:block;animation:cg-up .2s ease-out both}",
    ".tk-mi{height:34px;display:flex;align-items:center;padding:0 10px;border-radius:8px;font:600 13px var(--font);color:var(--text2);cursor:pointer}.tk-mi:hover{background:var(--row)}",
    ".tk-mi.want{color:var(--acc);font-weight:800}.tk-mi.want::before{content:'';width:7px;height:7px;margin-inline-end:8px;border-radius:50%;background:var(--acc)}",
    ".tk-zone{position:absolute;width:120px;height:86px;margin:-43px 0 0 -60px;border-radius:14px;border:2px dashed var(--acc);background:var(--accw);display:grid;place-items:center;font:700 12px var(--font);color:var(--acc);transition:background .2s}.tk-zone.over{background:color-mix(in srgb,var(--acc) 30%,transparent)}",
    ".tk-card{position:absolute;z-index:2;width:74px;height:50px;margin:-25px 0 0 -37px;border-radius:12px;display:grid;place-items:center;font:800 12px var(--font);color:#fff;background:linear-gradient(135deg,var(--acc),var(--acc2));box-shadow:0 10px 20px -8px var(--acc);cursor:grab;transition:left .25s,top .25s}.tk-card.drag{cursor:grabbing;transition:none}",
    ".tk-ghost{position:absolute;left:0;top:0;z-index:5;width:22px;height:22px;margin:-3px 0 0 -4px;pointer-events:none;opacity:0}.tk-ghost svg{width:22px;height:22px;fill:var(--text);stroke:var(--card);stroke-width:1.6;stroke-linejoin:round}",
    ".tk-tap{position:absolute;z-index:5;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid var(--acc);pointer-events:none;opacity:0;animation:cg-dbl 1.3s ease-out .3s 2}",
    ".msamp{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:4px 0 12px}.msamp .mhead{font-size:15px;font-weight:800;color:var(--text)}",
    ".msamp .mpips{display:flex;gap:6px}.msamp .mpip{width:14px;height:14px;border-radius:50%;border:2px solid var(--acc);background:transparent;transition:background .3s}",
    ".msamp .mpip.on{background:var(--acc);animation:cg-popin .45s cubic-bezier(.3,1.6,.5,1)}.msamp .msub{font-size:12px;color:var(--muted)}",
    ".learn{position:fixed;z-index:2147483646;display:none;width:300px;max-width:calc(100vw - 16px);padding:12px 13px;border-radius:16px;background:var(--glass);-webkit-backdrop-filter:blur(14px) saturate(1.4);backdrop-filter:blur(14px) saturate(1.4);border:1px solid color-mix(in srgb,var(--ok) 45%,transparent);box-shadow:var(--shadow);font:500 12.5px/1.5 var(--font);color:var(--text);animation:cg-up .45s cubic-bezier(.2,.9,.25,1.1) both}",
    ".learn .lt{display:flex;align-items:center;gap:8px;margin-bottom:3px;font-weight:800;color:var(--text)}",
    ".learn .li{width:24px;height:24px;flex:none;border-radius:8px;display:grid;place-items:center;background:var(--okw);color:var(--ok)}",
    ".learn .li svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}",
    ".learn .lm{color:var(--muted);font-size:12px}",
    ".learn .lp{height:6px;margin-top:10px;border-radius:999px;background:var(--track);overflow:hidden}",
    ".learn .lp>i{display:block;height:100%;width:0;border-radius:inherit;background:linear-gradient(90deg,var(--ok),#22d3ee);transition:width .5s cubic-bezier(.2,.8,.2,1)}",
    ".learn .lb{display:flex;gap:8px;margin-top:11px}",
    ".learn button{border:0;border-radius:10px;padding:7px 13px;font:800 11.5px var(--font);cursor:pointer;transition:transform .15s,filter .2s}",
    ".learn button:hover:not(:disabled){transform:translateY(-1px)}.learn .go{background:var(--ok);color:#fff}.cg[data-theme=dark] .learn .go{color:#052e16}",
    ".learn .go:disabled{opacity:.6;cursor:default}.learn .gh{background:transparent;color:var(--muted);border:1px solid var(--line2)}",
    "@keyframes cg-in{from{opacity:0;transform:translateY(14px) scale(.97)}}@keyframes cg-up{from{opacity:0;transform:translateY(10px)}}",
    "@keyframes cg-fade{from{opacity:0}}@keyframes cg-pop{from{opacity:0;transform:translateY(16px) scale(.96)}}",
    "@keyframes cg-spin{to{transform:rotate(360deg)}}@keyframes cg-turn{from{transform:rotate(-90deg)}to{transform:rotate(270deg)}}",
    "@keyframes cg-breathe{0%{opacity:.6;transform:scale(1)}100%{opacity:0;transform:scale(2.7)}}",
    "@keyframes cg-ring{0%{opacity:.55;transform:scale(.86)}100%{opacity:0;transform:scale(1.35)}}",
    "@keyframes cg-scan{0%{top:-30%}100%{top:100%}}@keyframes cg-draw{to{stroke-dashoffset:0}}",
    "@keyframes cg-shine{to{left:130%}}@keyframes cg-shim{from{transform:translateX(-100%)}to{transform:translateX(100%)}}",
    "@keyframes cg-grow{to{transform:scaleX(.55)}}@keyframes cg-pt{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}",
    "@keyframes cg-popin{0%{transform:scale(.4)}100%{transform:scale(1)}}",
    "@keyframes cg-dbl{0%{opacity:.85;transform:scale(.45)}22%{opacity:0;transform:scale(1.2)}30%{opacity:.85;transform:scale(.45)}52%{opacity:0;transform:scale(1.2)}100%{opacity:0;transform:scale(1.2)}}",
    "@media (prefers-reduced-motion:reduce){.cg *,.cg *::before,.cg *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}",
  ].join("");

  function buildUI() {
    var host = el("div"); host.id = "continuum-guard-host";
    // The HOST is the fixed anchor (bottom-right); the panel inside is normal-flow.
    // This way the panel's position never depends on its own `fixed` resolving
    // against a transformed ancestor (which put it up in the header before).
    host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px";
    // Attach to <html>, not <body>: a page whose <body> (or a wrapper) has a
    // transform/filter/backdrop-filter would otherwise become the containing block
    // for our position:fixed panel and pin it to that element (top-left) instead of
    // the viewport's bottom-right. <html> can't be a fixed-positioning containing block.
    (document.documentElement || document.body).appendChild(host);
    shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var st = el("style"); st.textContent = CSS; shadow.appendChild(st);
    // One root carries the language (lang, dir) and the colours (data-theme); the host, which the page's own CSS can
    // reach, carries nothing but its position.
    rootEl = el("div", "cg"); shadow.appendChild(rootEl);
    applyLook();

    var panel = el("div", "panel"); panelEl = panel;
    panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "Continuum");
    var hd = el("div", "hd");
    logoEl = el("span", "logo"); logoEl.innerHTML = svg("logo") + '<span class="rp"></span>';
    var ttl = el("span", "ttl"), sum = el("span", "sum");
    ttl.appendChild(el("b", null, "Continuum"));
    sumDotEl = el("span", "sdot"); sumEl = el("span"); sum.appendChild(sumDotEl); sum.appendChild(sumEl);
    sum.setAttribute("aria-live", "polite"); ttl.appendChild(sum);
    var cx = el("button", "cx"); cx.type = "button"; cx.innerHTML = svg("chevron");
    hd.appendChild(logoEl); hd.appendChild(ttl); hd.appendChild(cx);
    panel.appendChild(hd);
    var pbody = el("div", "pbody"), pin = el("div", "pin"), rows = el("div", "rows");
    KS = channelRow("keyboard", "Typing", "keystroke:", reinforceKeystroke, "Add typing samples", toggleKeystrokeCtl, "Typing protection");
    MS = channelRow("mouse", "Mouse", "mouse:", reinforceMouse, "Add mouse samples", toggleMouseCtl, "Mouse protection");
    kbEl = KS.st; ksAddEl = KS.add; ksToggleEl = KS.tgl; mouseEl = MS.st; msAddEl = MS.add; toggleEl = MS.tgl;
    rows.appendChild(KS.row); rows.appendChild(MS.row);
    pin.appendChild(rows); pbody.appendChild(pin); panel.appendChild(pbody); rootEl.appendChild(panel);
    setKb("mut", "idle"); setMouseRow("mut", "off");
    applyPanel();

    // ---- collapse / expand (persisted) ----
    var collapsed = false; try { collapsed = localStorage.getItem(LS_COLLAPSE) === "1"; } catch (e) {}
    function applyCollapse() {
      panel.classList[collapsed ? "add" : "remove"]("collapsed");
      var k = collapsed ? "Expand" : "Collapse";
      cx.setAttribute("data-tt", k); cx.setAttribute("data-ta", k); cx.title = t(k); cx.setAttribute("aria-label", t(k));
      cx.setAttribute("aria-expanded", String(!collapsed));
    }
    cx.addEventListener("click", function (e) { e.stopPropagation(); collapsed = !collapsed; try { localStorage.setItem(LS_COLLAPSE, collapsed ? "1" : "0"); } catch (e2) {} applyCollapse(); setTimeout(clampPos, 450); });
    applyCollapse();

    // ---- drag by the header (persisted) ----
    // A placed panel stays whole inside the window: a position saved for a narrower panel (or a smaller window)
    // used to leave its switches past the right edge.
    function inside(l, tp) {
      var w = host.offsetWidth || 276, hh = host.offsetHeight || 60;
      return { left: Math.max(4, Math.min(window.innerWidth - w - 4, l)), top: Math.max(4, Math.min(window.innerHeight - hh - 4, tp)) };
    }
    function clampPos() {
      if (!host.style.left || host.style.left === "auto") return;   // still anchored to the corner
      var p = inside(parseFloat(host.style.left) || 0, parseFloat(host.style.top) || 0);
      host.style.left = p.left + "px"; host.style.top = p.top + "px";
    }
    try { var sp = JSON.parse(localStorage.getItem(LS_POS) || "null"); if (sp && sp.left != null) { host.style.left = sp.left + "px"; host.style.top = sp.top + "px"; host.style.right = "auto"; host.style.bottom = "auto"; clampPos(); } } catch (e) {}
    window.addEventListener("resize", clampPos);
    var dragging = false, ox = 0, oy = 0, sx = 0, sy = 0;
    hd.addEventListener("mousedown", function (e) {
      if (cx.contains(e.target)) return;
      var r = host.getBoundingClientRect(); ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      host.style.right = "auto"; host.style.bottom = "auto"; host.style.left = ox + "px"; host.style.top = oy + "px";
      dragging = true; e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var p = inside(ox + (e.clientX - sx), oy + (e.clientY - sy));
      host.style.left = p.left + "px"; host.style.top = p.top + "px";
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return; dragging = false;
      try { var r = host.getBoundingClientRect(); localStorage.setItem(LS_POS, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) })); } catch (e) {}
    });

    // ---- the passkey step-up ----
    modalEl = el("div", "ov");
    modalEl.innerHTML = '<div class="card center" role="dialog" aria-modal="true"><button class="wizx" type="button">' + svg("x") + "</button>"
      + '<div class="brand"><span class="b2">' + svg("logo") + '</span>CONTINUUM</div><div class="hero"><div class="orb"></div></div>'
      + '<div class="t"></div><div class="d"></div><button class="b" type="button"></button><div class="e"></div></div>';
    modalBtnEl = modalEl.querySelector(".b"); modalErrEl = modalEl.querySelector(".e");
    var modalX = modalEl.querySelector(".wizx");
    modalX.addEventListener("click", doLogout);
    if (!cfg.loginUrl) modalX.style.display = "none";   // nowhere to send the user: the passkey is the way out
    modalBtnEl.addEventListener("click", stepUp); rootEl.appendChild(modalEl);
    modalText("Identity check required", "Your recent activity no longer matches your profile. Verify with your passkey to continue.", "Verify with passkey", "finger");

    wizEl = el("div", "ov"); rootEl.appendChild(wizEl); // onboarding wizard overlay

    // Floating adaptive-learning prompt (positioned above the active text field).
    learnEl = el("div", "learn"); learnEl.setAttribute("role", "status");
    learnEl.innerHTML = '<div class="lt"><span class="li">' + svg("refresh") + "</span><span>" + h("Your typing looks like you") + "</span></div>"
      + '<div class="lm">' + h("Add this clean sample so your model keeps learning your rhythm.") + '</div><div class="lp"><i></i></div>'
      + '<div class="lb"><button class="go" type="button">' + h("Contribute sample") + '</button><button class="gh" type="button" data-t="Not now">' + h("Not now") + "</button></div>";
    learnEl.querySelector(".go").addEventListener("click", function () { if (learnMode === "retrain") retrainWithPasskey(); else contributeSample(); });
    learnEl.querySelector(".gh").addEventListener("click", function () { dismissLearn(); });
    rootEl.appendChild(learnEl);
    // The real-use mouse sample question (learning from real use, stage 1), bottom right, after a verified passkey.
    useEl = el("div", "learn"); useEl.setAttribute("role", "status");
    useEl.style.right = "16px"; useEl.style.bottom = "16px";
    useEl.innerHTML = '<div class="lt"><span class="li">' + svg("mouse") + "</span><span>" + h("Record your real mouse use?") + '</span></div><div class="lm"></div>'
      + '<div class="lp"><i></i></div><div class="lb"><button class="go" type="button">' + h("Record") + '</button><button class="gh" type="button">' + h("Not now") + "</button></div>";
    useEl.querySelector(".go").addEventListener("click", startUseSample);
    useEl.querySelector(".gh").addEventListener("click", function () { useOffer = null; hideUse(); });
    rootEl.appendChild(useEl);
    // Keep the prompt glued to the field as the page scrolls/resizes.
    window.addEventListener("scroll", positionLearn, true);
    window.addEventListener("resize", positionLearn);
  }

  // One channel's line in the panel: a ring (its progress, in the colour of its state) around the channel's icon,
  // the label, the status, "+" (add samples) and the switch. The status starts with the channel's name for screen
  // readers ("keystroke: verified"), hidden on screen where the label says it.
  function channelRow(icon, label, prefix, onAdd, addTitle, onToggle, toggleLabel) {
    var row = el("div", "row mut"), ring = el("span", "ring");
    ring.innerHTML = '<svg class="r" viewBox="0 0 36 36" aria-hidden="true"><circle class="tr" cx="18" cy="18" r="15.9155"/>'
      + '<circle class="pr" cx="18" cy="18" r="15.9155" pathLength="100"/></svg><span class="ic">' + svg(icon) + "</span>";
    var info = el("span", "info"), lbl = el("span", "lbl", t(label)), stEl = el("span", "st mut");
    lbl.setAttribute("data-t", label);
    info.appendChild(lbl); info.appendChild(stEl);
    var add = el("button", "add"); add.type = "button"; add.innerHTML = svg("plus");
    add.setAttribute("data-tt", addTitle); add.setAttribute("data-ta", addTitle); add.title = t(addTitle); add.setAttribute("aria-label", t(addTitle));
    add.addEventListener("click", onAdd);
    var tg = el("button", "tgl", "off"); tg.type = "button"; tg.setAttribute("role", "switch"); tg.setAttribute("aria-checked", "false");
    tg.setAttribute("data-ta", toggleLabel); tg.setAttribute("aria-label", t(toggleLabel));
    tg.addEventListener("click", onToggle);
    row.appendChild(ring); row.appendChild(info); row.appendChild(add); row.appendChild(tg);
    var pr = ring.querySelector(".pr"); pr.style.strokeDashoffset = "100";
    return { row: row, pr: pr, st: stEl, add: add, tgl: tg, prefix: prefix, state: null };
  }

  function applyLook() {
    LANG = resolveLang(LANG_PREF); THEME = resolveTheme(THEME_PREF);
    if (!rootEl) return;
    rootEl.setAttribute("lang", LANG); rootEl.setAttribute("dir", LANG === "ar" ? "rtl" : "ltr"); rootEl.setAttribute("data-theme", THEME);
  }
  // The language or the colours changed (the organisation's settings arrived, or the device changed mode): load the
  // Arabic when needed, then redraw the panel's own words. A window already open keeps its words until it redraws.
  function relook() {
    return loadLang().then(function () {
      applyLook();
      if (!rootEl) return;
      var each = function (sel, f) { var n = rootEl.querySelectorAll(sel); for (var i = 0; i < n.length; i++) f(n[i]); };
      each("[data-t]", function (n) { n.textContent = t(n.getAttribute("data-t")); });
      each("[data-tt]", function (n) { n.title = t(n.getAttribute("data-tt")); });
      each("[data-ta]", function (n) { n.setAttribute("aria-label", t(n.getAttribute("data-ta"))); });
      if (KS && KS.state) drawRow(KS);
      if (MS && MS.state) drawRow(MS);
      updateSummary();
    });
  }
  if (darkMq) {
    var onScheme = function () { if (THEME_PREF === "auto") applyLook(); };
    if (darkMq.addEventListener) darkMq.addEventListener("change", onScheme); else if (darkMq.addListener) darkMq.addListener(onScheme);
  }

  // The panel's one-line summary under its title, from the two channels.
  function updateSummary() {
    if (!sumEl) return;
    var k = KS && KS.state ? KS.state.cls : "mut", m = MS && MS.state ? MS.state.cls : "mut", has = function (c) { return k === c || m === c; };
    var cls = signedOut || locked || has("bad") ? "bad" : has("warn") ? "warn" : has("ok") ? "ok" : has("col") ? "col" : "mut";
    var key = signedOut ? "Signed out" : locked ? "Locked: verify it's you" : cls === "bad" ? "Attention needed" : cls === "warn" ? "Watching closely"
      : cls === "ok" ? "Protected" : cls === "col" ? "Getting ready" : "Standing by";
    sumDotEl.className = "sdot " + cls; sumEl.setAttribute("data-t", key); sumEl.textContent = t(key);
  }

  // A check is on its way: the logo's line runs once and a ring goes out from it.
  function pulse() {
    if (!logoEl) return;
    play(logoEl.querySelector(".beat"), [{ strokeDashoffset: 44 }, { strokeDashoffset: 0 }], { duration: 900, easing: "ease-out" });
    play(logoEl.querySelector(".rp"), [{ opacity: 0.7, transform: "scale(.9)" }, { opacity: 0, transform: "scale(1.5)" }], { duration: 900, easing: "ease-out" });
  }
  // Last scored verdict per channel, kept so TRANSIENT states ("analyzing…", "checking…")
  // can still show it. Dropping the number mid-check made the panel look like it had lost
  // track of the user, when in fact the previous verdict is exactly what is still in force
  // until the next one lands.
  var lastKsPct = null, lastMousePct = null;
  // A channel's state. cls: ok | col (collecting) | warn | bad | mut; text: English with {slots}, shown in the panel's
  // language; o.vars fill the slots, o.pct is the last score (after the text), o.prog 0..1 fills the ring, o.busy
  // spins it while a check is on its way, o.keep stays in the previous colour and ring (between checks the last
  // verdict still holds). Kept, so a change of language redraws it.
  function setRow(ch, cls, text, o) {
    if (!ch) return;
    o = o || {};
    var prev = ch.state;
    if (o.keep && prev) { cls = prev.cls; if (o.prog == null) o.prog = prev.prog; }
    var prog = o.prog != null ? o.prog : cls === "ok" || cls === "bad" ? 1 : cls === "mut" ? 0 : prev ? prev.prog : 0;
    ch.state = { cls: cls, text: text, o: o, prog: Math.max(0, Math.min(1, Number(prog) || 0)) };
    drawRow(ch, prev);
    if (cls === "bad" && (!prev || prev.cls !== "bad")) {
      play(panelEl, [{ transform: "translateX(0)" }, { transform: "translateX(-5px)" }, { transform: "translateX(5px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" }], { duration: 420, easing: "ease-in-out" });
    }
    updateSummary();
  }
  function drawRow(ch, prev) {
    var s = ch.state, o = s.o;
    ch.st.className = "st " + s.cls;
    ch.st.innerHTML = '<span class="sr">' + esc(t(ch.prefix)) + " </span>" + h(s.text, o.vars) + (o.pct != null ? ' · <b class="pct">' + Number(o.pct) + "%</b>" : "");
    ch.row.className = "row " + s.cls + (o.busy ? " busy" : "");
    ch.pr.style.strokeDashoffset = String(100 - s.prog * 100);
    if (prev && prev.cls !== s.cls) play(ch.st, [{ opacity: 0.2, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: "ease-out" });
  }
  function setKb(cls, text, o) { setRow(KS, cls, text, o); }
  function setMouseRow(cls, text, o) { setRow(MS, cls, text, o); }
  // The step-up window's words (English, shown in the panel's language) and its picture (finger: a passkey check;
  // door: signed out).
  function modalText(title, text, button, pic) {
    if (!modalEl) return;
    modalEl.querySelector(".t").textContent = t(title);
    modalEl.querySelector(".d").textContent = t(text);
    modalBtnEl.textContent = t(button);
    var x = modalEl.querySelector(".wizx"); x.title = t("Sign out"); x.setAttribute("aria-label", t("Sign out"));
    var orb = modalEl.querySelector(".orb");
    orb.className = "orb" + (pic === "door" ? " bad" : "");
    orb.innerHTML = (pic === "door" ? "" : '<span class="scan"></span>') + svg(pic === "door" ? "door" : "finger");
  }
  // A question in the panel's own window (window.confirm cannot follow its language or colours). Resolves true when
  // the user confirms.
  function confirmBox(title, text, ok) {
    return new Promise(function (resolve) {
      if (!cfmEl) { cfmEl = el("div", "ov"); rootEl.appendChild(cfmEl); }
      cfmEl.innerHTML = '<div class="card center" role="alertdialog" aria-modal="true"><div class="hero"><div class="orb bad">' + svg("trash") + "</div></div>"
        + '<div class="t">' + h(title) + '</div><div class="d">' + h(text) + '</div><div class="row2"><button class="b sec" type="button" id="cfmNo">'
        + h("Cancel") + '</button><button class="b bad" type="button" id="cfmYes">' + h(ok) + "</button></div></div>";
      function done(v) { cfmEl.style.display = "none"; cfmEl.innerHTML = ""; resolve(v); }
      cfmEl.querySelector("#cfmNo").addEventListener("click", function () { done(false); });
      cfmEl.querySelector("#cfmYes").addEventListener("click", function () { done(true); });
      cfmEl.style.display = "flex";
    });
  }
  var stepUpOnSuccess = null; // optional callback for external step-up requests
  function chain(a, b) { if (!a) return b || null; if (!b) return a; return function (x) { try { a(x); } catch (e) {} b(x); }; }
  var stepUpOnFail = null;    // optional callback for a failed attempt (requireStepUp's onFail)
  var onProbation = false;    // after a step-up: any suspicious verdict re-challenges (no grace) until a genuine one clears it
  // Show the single passkey step-up modal, with the REASON (which modality flagged it).
  // verdict: the check's answer, when there is one (a paste lock says so instead of blaming the rhythm).
  function showModal(modality, verdict) {
    // A lock: no movement from here on is the user's until the passkey says so.
    abortUseSample();
    stepUpReason = modality === "mouse" ? "mouse" : "keystroke";
    if (!modalEl) return;
    if (signedOut) { modalEl.style.display = "flex"; updateSummary(); return; }   // a passkey cannot help until the user signs in again
    var pasted = !!(verdict && verdict.typingEvaluation && verdict.typingEvaluation.modelType === "paste-policy");
    modalText("Identity check required", pasted ? "Text was pasted into this field more times than allowed. Verify with your passkey to continue."
      : modality === "mouse" ? "Your mouse movement no longer matches your profile. Verify with your passkey to continue."
      : modality ? "Your typing rhythm no longer matches your profile. Verify with your passkey to continue."
      : "Your recent activity no longer matches your profile. Verify with your passkey to continue.", "Verify with passkey", "finger");
    modalEl.style.display = "flex";
    updateSummary();
  }
  function hideModal() { if (modalEl) { modalEl.style.display = "none"; modalErrEl.style.display = "none"; } }
  // Demo mode: the app's own sign-in has ended (its API answers 401, as after a restart of a server that keeps its
  // sessions in memory). No check can run until the user signs in again, so the checks stop, the panel says so instead
  // of a stale verdict, and the modal offers the sign-in page instead of a passkey that cannot be verified.
  var signedOut = false;
  function sessionEnded() {
    if (signedOut) return;
    signedOut = true;
    stopMouse(); abortUseSample();
    setKb("bad", "signed out — sign in again");
    if (mouseOn) setMouseRow("bad", "signed out — sign in again");
    if (!modalEl) return;
    modalText("Signed out", "Your session has ended. Sign in again to continue.", "Sign in again", "door");
    modalErrEl.style.display = "none";
    modalEl.style.display = "flex";
  }

  // ---------- passkey WebAuthn (mode-aware) ----------
  function webauthn() { var w = window.SimpleWebAuthnBrowser; if (!w || !w.startAuthentication) throw new Error(t("Passkey library unavailable")); return w; }

  async function registerPasskey() {
    var W = webauthn();
    var opt = MODE === "gateway"
      ? await reqJson(EP.pkRegOpts, "POST", {})
      : await (async function () { var me = await req("/api/auth/me").then(function (r) { return r.json(); }); return reqJson("/api/webauthn/register/options", "POST", {}); })();
    if (!opt.ok) throw new Error(opt.d.error || t("Could not start registration"));
    var att = await W.startRegistration(opt.d);
    var done = MODE === "gateway"
      ? await reqJson(EP.pkRegDone, "POST", { credential: att })
      : await reqJson("/api/webauthn/register/complete", "POST", { credential: att });
    if (!done.ok) throw new Error(done.d.error || t("Registration failed"));
    return true;
  }

  // A bare passkey ceremony for authorising a DESTRUCTIVE action (profile reset). Deliberately
  // separate from stepUp(): that one is bound to the lock modal's UI and also resets the
  // trackers/counters to resume monitoring, none of which applies here. Resolves to the verified
  // answer only on a verified assertion. The server re-checks independently: the demo's backend its
  // fresh verification (middleware/requireFreshPasskey), the gateway the step-up token this answer
  // carries (2 minutes, once). This call exists to PROMPT the user, not to be the authorisation.
  async function verifyPasskeyForAction() {
    var W = webauthn(), opt, ver;
    if (MODE === "gateway") {
      opt = await reqJson(EP.pkAuthOpts, "POST", {});
      if (!opt.ok) throw new Error((opt.d && opt.d.error) || t("Could not start verification"));
      var as1 = await W.startAuthentication(opt.d);
      ver = await reqJson(EP.pkAuthDone, "POST", { challengeId: opt.d.challengeId, assertion: as1 });
    } else {
      var me = await req("/api/auth/me").then(function (r) { return r.json(); });
      opt = await reqJson("/api/webauthn/auth/options", "POST", { userId: me.userId });
      if (!opt.ok) throw new Error((opt.d && opt.d.error) || t("Could not start verification"));
      var as2 = await W.startAuthentication(opt.d);
      ver = await reqJson("/api/webauthn/auth/complete", "POST", { userId: me.userId, challengeId: opt.d.challengeId, assertion: as2 });
    }
    if (!ver.ok) throw new Error((ver.d && ver.d.error) || t("Verification failed"));
    return ver.d || {};
  }

  // Shared by both training popups. Order matters: confirm, then verify, then delete — the
  // user is told exactly what is about to be destroyed before the ceremony, and nothing is
  // deleted if they cancel the prompt or the assertion fails.
  async function resetProfile(kind, errEl, onDone) {
    var ask = kind === "mouse" ? "Delete your enrolled mouse movement profile?" : "Delete your enrolled typing rhythm profile?";
    if (!(await confirmBox(ask, "This cannot be undone: you will need to train again from scratch. You will be asked for your passkey to confirm.", "Delete"))) return;
    errEl.style.display = "none";
    try {
      var verified = await verifyPasskeyForAction();
      // Gateway mode: the gateway deletes a profile only with the step-up token of that verification.
      var r = await reqJson(kind === "mouse" ? EP.mouseReset : EP.ksReset, "POST", MODE === "gateway" ? { stepUpToken: verified.stepUpToken } : {});
      if (!r.ok) throw new Error((r.d && r.d.error) || t("Reset failed"));
      if (onDone) onDone(r.d);
    } catch (err) {
      errEl.textContent = (err && err.message) || t("Reset failed");
      errEl.style.display = "block";
    }
  }

  async function stepUp() {
    if (signedOut) { location.href = cfg.loginUrl; return; }
    modalErrEl.style.display = "none"; modalBtnEl.disabled = true; modalBtnEl.textContent = t("Verifying…");
    try {
      var W = webauthn(), opt, ver;
      if (MODE === "gateway") {
        opt = await reqJson(EP.pkAuthOpts, "POST", {}); if (!opt.ok) throw new Error(opt.d.error || t("Could not start verification"));
        var assertion = await W.startAuthentication(opt.d);
        ver = await reqJson(EP.pkAuthDone, "POST", { challengeId: opt.d.challengeId, assertion: assertion, reason: stepUpReason });
      } else {
        var me = await reqJson("/api/auth/me");
        if (me.status === 401 || !me.d.userId) { sessionEnded(); return; }
        opt = await reqJson("/api/webauthn/auth/options", "POST", { userId: me.d.userId }); if (!opt.ok) throw new Error(opt.d.error || t("Could not start verification"));
        var a2 = await W.startAuthentication(opt.d);
        ver = await reqJson("/api/webauthn/auth/complete", "POST", { userId: me.d.userId, challengeId: opt.d.challengeId, assertion: a2, reason: stepUpReason });
      }
      if (!ver.ok) throw new Error(ver.d.error || t("Verification failed"));
      // Clean resume after step-up: reset BOTH the trackers AND the per-modality
      // check counters, so the window baseline restarts from zero with the tracker.
      // (Resetting the tracker alone left lastCheckedWindowCount stale-high, which
      // silently froze keystroke checks until ~200 more keystrokes caught up.)
      if (ksTracker) ksTracker.reset();
      contribEndIdx = 0;
      lastCheckedWindowCount = 0; checkInFlight = false; ksMissedWindow = false; ksPastePending = false;
      if (mouseTracker) mouseTracker.reset(); lastMouseEvents = 0;
      lastKsPct = null; lastMousePct = null;   // the verdict that caused the lock is over: no stale score beside the next "analyzing"
      locked = false; onProbation = true; hideModal(); setKb("ok", "verified ✓"); if (mouseOn) setMouseRow("ok", "watching");
      stepUpOnFail = null;
      var verified = ver.d || {};
      if (stepUpOnSuccess) { var cb = stepUpOnSuccess; stepUpOnSuccess = null; try { cb(verified); } catch (e2) {} }
      offerUseSample(verified.mouseUseSample);
    } catch (e) {
      modalErrEl.textContent = e.message || t("Verification failed"); modalErrEl.style.display = "block";
      if (stepUpOnFail) { try { stepUpOnFail(e.message || t("Verification failed")); } catch (e3) {} }
    }
    finally { modalBtnEl.disabled = false; modalBtnEl.textContent = t(signedOut ? "Sign in again" : "Verify with passkey"); }
  }

  // `force` (post-step-up probation): re-challenge on a raw suspicious verdict too,
  // not only when the server flags requiresPasskeyChallenge (which it suppresses
  // during the warmup that a step-up's tracker reset re-enters).
  function maybeChallenge(d, modality, force) {
    if (d && d.enrolled === false) return false;
    // Probation (force) re-challenges on any suspicious verdict backed by REAL
    // scored windows — even during warmup. After a step-up the tracker resets and
    // re-enters warmup; the check then returns isSuspicious:true either because
    //   (a) no scorable window exists yet — a PLACEHOLDER (scoredWindowCount 0):
    //       firing here would loop a genuine user forever, so we must NOT; or
    //   (b) real windows scored low (scoredWindowCount > 0): a genuine user scores
    //       HIGH here, so a low score means the impostor is back — re-challenge at
    //       once with no grace, which is the whole point of probation.
    // A clean verdict clears probation (see runKsCheck).
    var scored = d && Number(d.scoredWindowCount) > 0;
    var trigger = (d && d.requiresPasskeyChallenge) || (force && d && d.isSuspicious && scored);
    if (trigger && !locked) { locked = true; showModal(modality, d); return true; }
    return false;
  }

  // ================= LEARNING FROM REAL USE (stage 1) =================
  // A passkey just verified means the movement right after it is the user's. When the server says a sample may be
  // recorded (ca-service lib/mouseUse.js: a trained mouse profile, at most one sample every few hours), the user is
  // asked; if they agree, a fresh recorder takes the next MOUSE_SAMPLE_WINDOWS windows of ordinary use and sends them.
  // They are stored for the evaluation and train nothing. The recorder starts only after the answer and is dropped at
  // any lock, so no movement from before the passkey or around a lock is ever sent.
  var stepUpReason = "keystroke", useOffer = null, useRec = null, useHideT = null;
  function hideUse() { clearTimeout(useHideT); if (useEl) useEl.style.display = "none"; }
  function showUse(mode, text) {
    if (!useEl) return;
    clearTimeout(useHideT);
    var m = useEl.querySelector(".lm"), b = useEl.querySelector(".lb"), p = useEl.querySelector(".lp>i");
    if (mode === "ask") {
      m.textContent = t("You just confirmed it's you. If you agree, keep using the page as usual: Continuum records about 16 s of your mouse movement (only how the pointer moves, nothing you type or click on). It is kept to test whether learning from real use lowers false passkey requests. Your profile does not change.");
      b.style.display = "flex"; p.style.width = "0";
      useHideT = setTimeout(function () { useOffer = null; hideUse(); }, Math.max(0, useOffer.until - Date.now()));
    } else if (mode === "rec") {
      m.textContent = t("Recording your movement… {s} of 16 s. Keep using the page as usual.", { s: text });
      b.style.display = "none";
    } else {
      m.textContent = text; b.style.display = "none"; p.style.width = "0";
      useHideT = setTimeout(hideUse, 6000);
    }
    useEl.style.display = "block";
  }
  function offerUseSample(o) {
    // Both modes: on a tenant's own pages its backend passes the offer and the sample on (the demo app: /api/mouse/use-sample).
    if (!EP.mouseUseSample || !o || !o.offer || !mouseOn || !window.mouseFeatures || !useEl) return;
    abortUseSample();
    // A few seconds short of the server's limit, so a sample that completes is never refused for arriving late.
    useOffer = { until: Date.now() + Math.max(0, Number(o.expiresInMs) || 0) - 5000, need: Number(o.sampleWindows) || MOUSE_SAMPLE_WINDOWS };
    showUse("ask");
  }
  function startUseSample() {
    var o = useOffer; useOffer = null;
    if (!o || Date.now() > o.until || locked) { hideUse(); return; }
    useRec = { tracker: window.mouseFeatures.createMouseTracker(document.documentElement), until: o.until, need: o.need, sending: false };
    useRec.iv = setInterval(useTick, 400);
    showUse("rec", 0);
  }
  function useTick() {
    var r = useRec;
    if (!r || r.sending) return;
    if (locked) { abortUseSample(); return; }
    if (Date.now() > r.until) { abortUseSample(); showUse("done", t("Not saved: the time for this sample ran out.")); return; }
    var w = window.mouseFeatures.stepsToWindows(window.mouseFeatures.eventsToSteps(r.tracker.getEvents()));
    var n = w ? w.length : 0;
    var bar = useEl.querySelector(".lp>i"); if (bar) bar.style.width = Math.min(100, Math.round((100 * n) / r.need)) + "%";
    if (n < r.need) { showUse("rec", Math.min(16, Math.floor((16 * n) / r.need))); return; }
    r.sending = true; clearInterval(r.iv); r.tracker.stop();
    reqJson(EP.mouseUseSample, "POST", { windows: w.slice(0, r.need) }).then(function (res) {
      if (useRec !== r) return;
      useRec = null;
      showUse("done", res.ok ? t("Saved, thank you.") : t("Not saved: {why}.", { why: (res.d && (res.d.note || res.d.error)) || t("refused") }));
    }).catch(function () { if (useRec === r) { useRec = null; showUse("done", t("Not saved: Continuum could not be reached.")); } });
  }
  function abortUseSample() {
    if (useRec) { clearInterval(useRec.iv); try { useRec.tracker.stop(); } catch (e) {} useRec = null; }
    useOffer = null;
    hideUse();
  }

  // ================= ONBOARDING WIZARD =================
  var KS_ENROLL_SAMPLES = 5;
  // Enrolment passages: a fixed pool in A1 (beginner) English, the same as the browser extension's
  // own enrolment had. Enrolment must capture the user's NATURAL rhythm, so the text must never make
  // them stop to read, think or hunt for an unfamiliar word; fetched text (a random Wikipedia
  // summary, used here until Oct 2026) still did, and it made every enrolling page call a third
  // party. A local pool is simple every time, works offline, and sends nothing anywhere. The order
  // is shuffled per page, so the five samples get five different passages ("new text" moves on).
  // Each is long enough for the 100-keystroke gate below.
  // Sharing passages between users is harmless: the model's negatives come from the Aalto dataset,
  // not from other users (ca-service keystrokeSecurity.js), and duplicate-text refusal applies only
  // to free-typing contributions, not to these samples.
  var ENROL_PASSAGES = [
    "I get up early every day. I make a cup of tea and open the window. The birds sing in the tree near my house. I like to sit and drink my tea in the morning. After that I walk to work. I say hello to my friends on the way. We talk about the day and the weather. At night I read a book and go to sleep.",
    "My family is small but we are happy. My mum cooks good food for us. We eat dinner at the table every night. After we eat, we talk and we laugh. My dad likes to watch films. My sister plays with the dog in the garden. On the weekend we go to the park. We take some food and sit on the grass in the sun.",
    "I like to cook easy food at home. Today I make rice and eggs for lunch. First I wash the rice and put it in a pot. Then I cook the eggs in a pan. I add some salt and a little oil. When the food is ready, I sit down to eat. I drink a glass of water with my meal. Cooking is easy and fun for me every day.",
    "My friend and I like to walk in the park. We go there when the sun is out. We see many dogs and children play. The trees are tall and green. Some people sit on the grass and read. We walk near the lake and feed the birds. Then we buy ice cream from a small shop. We sit on a bench and talk for a long time.",
    "I work in a small shop near my home. I open the shop at nine in the morning. People come in to buy bread, milk, and fruit. I help them find the things they need. I like to talk to the people who come in. At noon I stop and eat a sandwich for lunch. In the afternoon more people come to the shop to buy things.",
    "The weather is nice today. The sun is out and the sky is blue. There are no clouds and there is no rain. I want to go for a walk in the park. I put on my shoes and a light coat. The air is warm and the wind is soft. I see many people out today. Some ride bikes and some walk their dogs on the long path.",
    "I like to read books in my free time. I have many books at home on a shelf. Some are about animals and some are about far away places. In the evening I sit in my chair and read. I make a cup of tea and turn on the lamp. The house is quiet and calm at night. I read for one hour and then I go to sleep.",
    "On Saturday I clean my house. First I open all the windows for fresh air. Then I wash the floor and the dishes. I put my clothes in the machine to wash. I make the bed and I clean the shelves. When the house is clean, I feel very good. After that I sit down and rest for a while and watch a film with my tea.",
    "I have a small garden behind my house. I grow flowers and some green plants. Every morning I give them water. The flowers are red, yellow, and white. Bees and birds come to the garden too. I like to sit outside and look at my plants. In the summer the garden is full of colour. I pick some flowers for the table.",
    "My town is small and quiet. There is one shop, one school, and a park. The people here are kind and friendly. In the morning I hear the birds and the wind. I walk to the shop to buy bread and milk. On the way I meet my neighbours and say hello. The streets are clean and there are many green trees on them.",
  ];
  var passageOrder = ENROL_PASSAGES.map(function (_, i) { return i; });
  for (var pi = passageOrder.length - 1; pi > 0; pi--) { var pj = Math.floor(Math.random() * (pi + 1)), pt = passageOrder[pi]; passageOrder[pi] = passageOrder[pj]; passageOrder[pj] = pt; }
  var passageAt = 0;
  function nextPassage() { return ENROL_PASSAGES[passageOrder[passageAt++ % passageOrder.length]]; }

  function wizStepBar(active, total, doneN) {
    var names = ["Passkey", "Typing", "Mouse"], s = '<div class="steps">';
    for (var i = 0; i < total; i++) s += '<div class="s ' + (i < doneN ? "done" : i === active ? "on" : "") + '"><i></i><span>' + h(names[i] || "") + "</span></div>";
    return s + "</div>";
  }
  // Sign the user out (the × on mandatory popups). Same-origin so the app's session
  // cookie is cleared; a consumer overrides the endpoints via data-logout-url/login-url.
  function doLogout() {
    var toSignIn = function () { location.href = cfg.loginUrl; };
    if (!cfg.logoutUrl) { toSignIn(); return; }
    try { fetch(cfg.logoutUrl, { method: "POST", credentials: "include" }).finally(toSignIn); }
    catch (e) { toSignIn(); }
  }
  // onClose defaults to logout (onboarding/step-up can only be escaped by signing
  // out, so there is no × when the page names no sign-in page); optional popups (reinforcement) pass closeWiz to just dismiss.
  // cls: optional extra class on the card. "wide" is used by the mouse steps — the click
  // target spawns inside the pad, so a narrow pad confines every hop to a small area and
  // teaches the model one cramped amplitude. A wide pad lets the target land far apart, which
  // is what produces the range of movement the guard actually sees on a full page.
  function openWiz(html, onClose, cls) {
    var canClose = (onClose && onClose !== doLogout) || !!cfg.loginUrl;
    var x = esc(t(!onClose || onClose === doLogout ? "Sign out" : "Close"));
    wizEl.innerHTML = '<div class="card' + (cls ? " " + cls : "") + '" role="dialog" aria-modal="true">'
      + (canClose ? '<button class="wizx" type="button" title="' + x + '" aria-label="' + x + '">' + svg("x") + "</button>" : "")
      + '<div class="brand"><span class="b2">' + svg("logo") + "</span>CONTINUUM · " + h("secure onboarding") + "</div>" + html + "</div>";
    if (canClose) wizEl.querySelector(".wizx").addEventListener("click", onClose || doLogout);
    wizEl.style.display = "flex";
  }
  function closeWiz() { wizEl.style.display = "none"; wizEl.innerHTML = ""; }

  // ---- Mouse enrolment tasks (2026-11-24) ----
  // Until now the pad showed one dot to chase. That teaches long, fast hops, and ordinary use is smaller and slower: in
  // the owner's browsing of 22-24 Nov the median step was 5.4 px against 10.6 px in his dot samples, a window covered
  // half the path, and his own profile turned 31% of those windows down (2% once they were rescaled to the size of his
  // enrolment). So the pad now asks for the small things people do on a page: click a dot near or far, click numbers
  // in a row, double-click a word, select words by dragging, drag a handle, click a thin bar, follow a line of text,
  // pick from a menu, drag a card. Tasks come in shuffled rounds of every kind, so a sample holds several kinds and no
  // kind is left to one sample (the threshold is leave-one-sample-out). Recording is unchanged: the same tracker on the
  // whole page and the same windows. Only what the user is asked to do is new.
  // 2026-11-25: that pad ran sideways. In the owner's seven samples from it 64% of the steps were sideways, 24% slanted
  // and 12% up or down, a window travelled 63 px up and down and 3% of the steps were 25 px or longer; his real use the
  // same day was 41 / 35 / 24, 188 px and 9%. The text, the bars and the hops (a hop that did not fit the low, wide
  // stage was drawn again, so it came out sideways) made it so. Now the direction of a hop is drawn first and the hop
  // shortened to fit, half the texts are set as a list (one word a line), both bars stand upright every other time,
  // and half the cards are dropped a good way above or below. The pad itself is as tall as the window and at most 1.8
  // times as wide as high (the CSS, ".card.wide"). The test's robot, whose straight moves show what the tasks ask for,
  // went from 68% sideways and 7% up or down to 45% and 18% (docs/MOUSE_MODALITY.md). A person's samples on this pad
  // are not measured yet.
  // Each task marks its start with data-tk-a and its end with data-tk-b (the headless test reads them).
  var TASK_TEXTS = [
    "The quiet river carries small boats past the old stone bridge every morning before the market opens.",
    "A good map shows the high mountains, the long roads and the small villages that lie between them.",
    "She opened the window and listened to the soft rain falling on the garden below.",
    "Fresh bread and warm tea make a simple breakfast for the whole family on cold days.",
    "The library keeps thousands of old and new books on wooden shelves under a soft yellow light.",
    "Children fly bright kites over the green hill when the afternoon wind is strong.",
  ];
  var TASK_MENU = ["Open", "Rename", "Share", "Download", "Move", "Archive"];
  var SHAKE = [{ transform: "translateX(0)" }, { transform: "translateX(-5px)" }, { transform: "translateX(5px)" }, { transform: "translateX(-3px)" }, { transform: "translateX(0)" }];
  function mouseTasks(pad) {
    var KINDS = ["dots", "chips", "word", "phrase", "slider", "seek", "line", "menu", "drop"], TASKS = {};
    var bag = [], kind = "", seq = 0, done = 0, stopped = false, offs = [], timers = [], shown = {}, flip = Math.random() < 0.5;
    var px = null, py = null;   // the pointer inside the stage: the next target is put a chosen distance from it
    pad.classList.add("tasks");
    pad.innerHTML = '<div class="tk-top"><span class="tk-ic"></span><span class="tk-say" aria-live="polite"></span><span class="tk-n"></span></div>'
      + '<div class="tk-stage"></div><button type="button" class="tk-skip">' + h("Skip this task") + "</button>";
    var icEl = pad.querySelector(".tk-ic"), sayEl = pad.querySelector(".tk-say"), nEl = pad.querySelector(".tk-n"),
      stage = pad.querySelector(".tk-stage"), skipEl = pad.querySelector(".tk-skip");
    function rnd(a, b) { return a + Math.random() * (b - a); }
    function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
    function on(node, type, fn) { node.addEventListener(type, fn); offs.push(function () { node.removeEventListener(type, fn); }); }
    function later(fn, ms) { timers.push(setTimeout(function () { if (!stopped) fn(); }, ms)); }
    function clear() { for (var i = 0; i < offs.length; i++) { try { offs[i](); } catch (e) {} } offs = []; timers.forEach(clearTimeout); timers = []; skipEl.style.display = "none"; }
    function size() { return { w: stage.clientWidth, h: stage.clientHeight }; }
    function at(node, x, y) { node.style.left = Math.round(x) + "px"; node.style.top = Math.round(y) + "px"; return node; }
    function add(cls, text) { var n = el("div", cls, text); stage.appendChild(n); return n; }
    function local(e) { var r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function mid(node) { var r = node.getBoundingClientRect(), s = stage.getBoundingClientRect(); return { x: r.left + r.width / 2 - s.left, y: r.top + r.height / 2 - s.top }; }
    function pips() { var s = ""; for (var i = 0; i < MOUSE_TASKS_PER_SAMPLE; i++) s += "<i" + (i < done ? ' class="on"' : "") + "></i>"; nEl.innerHTML = s; }
    function say(key, icon, vars) {
      sayEl.textContent = t(key, vars); icEl.innerHTML = svg(icon);
      play(sayEl, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "ease-out" });
    }
    // The task is done: a tick where it ended, then the next one.
    function finish(x, y) {
      clear();
      done += 1; pips();
      var s = size(), k = add("tk-ok"); k.innerHTML = svg("check");
      at(k, Math.max(20, Math.min(s.w - 20, x)), Math.max(20, Math.min(s.h - 20, y)));
      later(next, 430);
    }
    function next() {
      if (stopped) return;
      clear(); stage.innerHTML = "";
      if (!bag.length) {   // a new round: every kind once, in a new order, and never the same kind twice in a row
        bag = KINDS.slice();
        for (var i = bag.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), x = bag[i]; bag[i] = bag[j]; bag[j] = x; }
        if (bag[bag.length - 1] === kind) bag.unshift(bag.pop());
      }
      kind = bag.pop();
      shown[kind] = (shown[kind] || 0) + 1;
      stage.setAttribute("data-kind", kind); stage.setAttribute("data-seq", String(++seq));
      TASKS[kind]();
      later(function () { skipEl.style.display = "block"; }, MOUSE_TASK_SKIP_MS);
    }
    // A spot some way from the pointer, inside the stage (m px from its edges). Short, medium and long hops in fixed
    // shares: a spot drawn uniformly in a wide pad is 400 px away on average, and every hop then looks like the last
    // one. The direction is drawn first (sideways, slanted, up or down) and a hop too long for it is shortened to fit:
    // drawn again until it fitted, as before, the hops of a low, wide stage all ran sideways.
    function hop(m) {
      var s = size(), mx = Math.min(m, s.w / 2), my = Math.min(m, s.h / 2);
      var cx = Math.max(mx, Math.min(s.w - mx, px == null ? s.w / 2 : px)), cy = Math.max(my, Math.min(s.h - my, py == null ? s.h / 2 : py));
      var best = null;
      for (var i = 0; i < 12; i++) {
        var r = Math.random(), d = r < 0.4 ? rnd(60, 150) : r < 0.75 ? rnd(150, 330) : rnd(330, Math.max(340, Math.max(s.w, s.h) * 0.8));
        var k = Math.random(), a = (k < 0.25 ? rnd(0, 20) : k < 0.6 ? rnd(25, 65) : rnd(70, 90)) * Math.PI / 180;
        var ux = (Math.random() < 0.5 ? -1 : 1) * Math.cos(a), uy = (Math.random() < 0.5 ? -1 : 1) * Math.sin(a);
        // the room the stage leaves in that direction
        var room = Math.min(ux > 0 ? (s.w - mx - cx) / ux : ux < 0 ? (mx - cx) / ux : 1e9, uy > 0 ? (s.h - my - cy) / uy : uy < 0 ? (my - cy) / uy : 1e9);
        var len = Math.max(0, Math.min(d, room)), p = { x: cx + ux * len, y: cy + uy * len, len: len };
        if (len >= Math.min(d, 60)) return p;
        if (!best || len > best.len) best = p;
      }
      return best;
    }
    // A short text, one <span> a word, somewhere on the stage: a block of three to six lines, or (half the time) a
    // list, one word a line. Following or selecting a list goes down, a wide line only across, and a pad whose every
    // text was one wide line taught sideways movement alone.
    function passage() {
      var s = size(), words = t(pick(TASK_TEXTS)).split(/\s+/), box = add("tk-text"), widest = Math.max(180, s.w - 40);
      var list = Math.random() < 0.5 && s.h >= 300, width = Math.min(rnd(230, 470), widest);
      if (list) { words = words.slice(0, Math.max(5, Math.min(9, Math.floor((s.h - 60) / 36)))); box.classList.add("col"); }   // as many lines as the stage takes
      else box.style.width = width + "px";
      var spans = words.map(function (w) { var sp = el("span", "tk-w", w); box.appendChild(sp); box.appendChild(document.createTextNode(" ")); return sp; });
      if (list) width = box.offsetWidth;
      for (var g = 0; !list && g < 12 && box.offsetHeight > s.h - 44 && width < widest; g++) { width = Math.min(widest, width + 70); box.style.width = width + "px"; }   // a low stage: wider, fewer lines
      at(box, rnd(16, Math.max(16, s.w - width - 16)), rnd(8, Math.max(8, s.h - box.offsetHeight - 30)));
      return { box: box, spans: spans };
    }
    // The word under a point of the page, else the nearest one within `reach` px (a line apart counts four times).
    function wordAt(spans, x, y, reach) {
      var best = -1, bd = reach || 0;
      for (var i = 0; i < spans.length; i++) {
        var r = spans[i].getBoundingClientRect();
        var dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0, dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        if (!dx && !dy) return i;
        if (dx + dy * 4 <= bd) { bd = dx + dy * 4; best = i; }
      }
      return best;
    }
    // Shown the first two times a kind comes up: a pointer that makes the drag, or a double ring for a double click.
    function hintDrag(aEl, bEl) {
      if (reduceMotion || shown[kind] > 2) return;
      var a = mid(aEl), b = mid(bEl), g = add("tk-ghost"); g.innerHTML = svg("pointer");
      var A = "translate(" + Math.round(a.x) + "px," + Math.round(a.y) + "px)", B = "translate(" + Math.round(b.x) + "px," + Math.round(b.y) + "px)";
      try {
        g.animate([{ opacity: 0, transform: A + " scale(1.2)" }, { opacity: 0.9, transform: A + " scale(.92)", offset: 0.2 }, { opacity: 0.9, transform: B + " scale(.92)", offset: 0.8 },
          { opacity: 0, transform: B + " scale(1.2)" }], { duration: 1500, delay: 350, iterations: 2, easing: "ease-in-out" }).onfinish = function () { g.remove(); };
      } catch (e) { g.remove(); }
    }
    function hintTap(aEl) {
      if (reduceMotion || shown[kind] > 2) return;
      var a = mid(aEl), g = add("tk-tap"); at(g, a.x, a.y);
      later(function () { g.remove(); }, 3200);
    }

    // 1. Three dots, each a chosen distance from the pointer; some of them small.
    TASKS.dots = function () {
      say("Click the dot", "target");
      var hits = 0, dot = add("pt");
      function place() { dot.className = "pt" + (Math.random() < 0.4 ? " sm" : ""); var p = hop(24); at(dot, p.x, p.y); }
      on(dot, "mousedown", function (e) { hits += 1; var q = local(e); if (hits >= 3) { dot.remove(); finish(q.x, q.y); } else place(); });
      place();
    };
    // 2. Four numbered chips close together, clicked in order: short, exact hops.
    TASKS.chips = function () {
      say("Click the numbers in order", "target");
      var c = hop(140), pts = [], chips = [], want = 0;
      for (var i = 0; i < 4; i++) {
        var p = null;
        for (var k = 0; k < 40 && !p; k++) {
          var a = rnd(0, 2 * Math.PI), d = rnd(20, 118), q = { x: c.x + d * Math.cos(a), y: c.y + d * Math.sin(a) };
          if (pts.every(function (o) { return Math.hypot(o.x - q.x, o.y - q.y) >= 48; })) p = q;
        }
        pts.push(p || { x: c.x + (i - 1.5) * 52, y: c.y });
      }
      pts.forEach(function (p, i) {
        var chip = add("tk-chip" + (i === 0 ? " next" : ""), String(i + 1)); at(chip, p.x, p.y); chips.push(chip);
        on(chip, "mousedown", function (e) {
          if (i !== want) { if (i > want) play(chip, SHAKE, { duration: 300 }); return; }
          chip.className = "tk-chip done"; want += 1;
          if (want >= chips.length) { var m = local(e); finish(m.x, m.y - 30); } else chips[want].classList.add("next");
        });
      });
    };
    // 3. Double-click one word of a text.
    TASKS.word = function () {
      say("Double-click the highlighted word", "text");
      var p = passage(), cands = [];
      p.spans.forEach(function (sp, i) { if (sp.textContent.length >= 4) cands.push(i); });
      var want = pick(cands.length ? cands : [0]), target = p.spans[want];
      target.classList.add("mark"); target.setAttribute("data-tk-a", "");
      on(stage, "dblclick", function (e) {
        var i = wordAt(p.spans, e.clientX, e.clientY, 0);
        if (i === want) { target.className = "tk-w sel"; var q = mid(target); finish(q.x, q.y - 30); }
        else if (i >= 0) play(p.spans[i], SHAKE, { duration: 300 });
      });
      hintTap(target);
    };
    // 4. Select three to five words by dragging over them, as a text selection is made (drawn here, so it looks and
    // behaves the same in every browser and inside the shadow root).
    TASKS.phrase = function () {
      say("Select the highlighted words by dragging over them", "text");
      var p = passage(), n = p.spans.length, len = Math.min(n, 3 + Math.floor(Math.random() * 3)), from = Math.floor(Math.random() * (n - len + 1)), to = from + len - 1;
      for (var i = from; i <= to; i++) p.spans[i].classList.add("mark");
      p.spans[from].setAttribute("data-tk-a", ""); p.spans[to].setAttribute("data-tk-b", "");
      var anchor = -1, focus = -1;
      function paint() {
        var lo = Math.min(anchor, focus), hi = Math.max(anchor, focus);
        p.spans.forEach(function (sp, k) { sp.classList.toggle("sel", anchor >= 0 && k >= lo && k <= hi); });
      }
      on(stage, "mousedown", function (e) { var k = wordAt(p.spans, e.clientX, e.clientY, 30); if (k < 0) return; anchor = focus = k; paint(); e.preventDefault(); });
      on(window, "mousemove", function (e) { if (anchor < 0) return; var k = wordAt(p.spans, e.clientX, e.clientY, 1e9); if (k >= 0 && k !== focus) { focus = k; paint(); } });
      on(window, "mouseup", function () {
        if (anchor < 0) return;
        var lo = Math.min(anchor, focus), hi = Math.max(anchor, focus), dragged = lo !== hi;
        // the words asked for, and at most one more at either end
        if (lo >= from - 1 && lo <= from && hi >= to && hi <= to + 1) { var q = mid(p.spans[to]); finish(q.x, q.y - 30); return; }
        anchor = focus = -1; paint();
        if (dragged) play(p.box, SHAKE, { duration: 320 });
      });
      hintDrag(p.spans[from], p.spans[to]);
    };
    // 5 and 6. A bar with a mark: drag its handle to the mark, or click the thin bar at the mark (the seek bar of a
    // recording, a scroll bar). Each lies across one time and stands upright the next.
    function bar(seek) {
      say(seek ? "Click the bar exactly at the mark" : "Drag the handle to the mark", "slider");
      flip = !flip;
      var s = size(), vert = flip && s.h >= 260, len = vert ? Math.min(420, s.h - 90) : Math.min(520, Math.max(200, s.w * 0.5));
      var track = add("tk-track" + (vert ? " v" : "") + (seek ? " seek" : ""));
      at(track, vert ? rnd(60, Math.max(60, s.w - 60)) : rnd(30, Math.max(30, s.w - len - 30)), vert ? rnd(30, Math.max(30, s.h - len - 40)) : rnd(50, Math.max(50, s.h - 50)));
      track.style[vert ? "height" : "width"] = len + "px";
      var a = rnd(0.04, 0.96), b = rnd(0.04, 0.96);
      for (var i = 0; i < 40 && Math.abs(b - a) * len < Math.min(110, len * 0.4); i++) b = rnd(0.04, 0.96);
      var mark = el("div", "tk-mark"), knob = el("div", "tk-knob"), pos = a;
      track.appendChild(mark); track.appendChild(knob);
      function put(node, f) { node.style[vert ? "top" : "left"] = Math.round(f * len) + "px"; }
      put(mark, b); put(knob, a);
      knob.setAttribute("data-tk-a", ""); mark.setAttribute("data-tk-b", "");
      function frac(e) { var r = track.getBoundingClientRect(); return (vert ? e.clientY - r.top : e.clientX - r.left) / len; }
      function check() { if (Math.abs(pos - b) * len > 11) return false; knob.classList.add("ok"); var q = mid(knob); finish(q.x + (vert ? 36 : 0), q.y - (vert ? 0 : 32)); return true; }
      if (seek) {
        on(track, "mousedown", function (e) { pos = Math.max(0, Math.min(1, frac(e))); put(knob, pos); if (!check()) play(knob, SHAKE, { duration: 300 }); e.preventDefault(); });
        return;
      }
      var drag = false, off = 0;
      on(knob, "mousedown", function (e) { drag = true; off = frac(e) - pos; knob.classList.add("drag"); e.preventDefault(); });
      on(window, "mousemove", function (e) { if (!drag) return; pos = Math.max(0, Math.min(1, frac(e) - off)); put(knob, pos); });
      on(window, "mouseup", function () { if (!drag) return; drag = false; knob.classList.remove("drag"); check(); });
      hintDrag(knob, mark);
    }
    TASKS.slider = function () { bar(false); };
    TASKS.seek = function () { bar(true); };
    // 7. Follow a text with the pointer, word by word, as some people do while they read.
    TASKS.line = function () {
      say("Move the pointer along the text, word by word", "text");
      var p = passage(), reached = 0;
      p.spans[0].setAttribute("data-tk-a", ""); p.spans[p.spans.length - 1].setAttribute("data-tk-b", "");
      function cur() { p.spans.forEach(function (sp, k) { sp.classList.toggle("cur", k === reached); }); }
      on(stage, "mousemove", function (e) {
        var k = wordAt(p.spans, e.clientX, e.clientY, 36);
        if (k < reached || k > reached + 2) return;   // in order; a short word may be passed over
        for (var j = reached; j <= k; j++) p.spans[j].classList.add("lit");
        reached = k + 1;
        if (reached >= p.spans.length) { var q = mid(p.spans[k]); finish(q.x, q.y - 30); } else cur();
      });
      cur();
      hintDrag(p.spans[0], p.spans[Math.min(3, p.spans.length - 1)]);
    };
    // 8. Open a menu and choose one item: a short way down a list.
    TASKS.menu = function () {
      var s = size(), labels = TASK_MENU.slice(0, s.h < 300 ? 4 : 6).map(function (k) { return t(k); }), want = Math.floor(Math.random() * labels.length);
      say("Open the menu and choose “{item}”", "menu", { item: labels[want] });
      var mh = labels.length * 34 + 14, roomBelow = s.h - mh - 52, up = roomBelow < 10 || (Math.random() < 0.35 && s.h - 46 > mh + 12);
      var bx = rnd(16, Math.max(16, s.w - 200)), by = up ? rnd(Math.min(mh + 12, s.h - 46), s.h - 46) : rnd(8, Math.max(8, roomBelow));
      var btn = add("tk-btn"); btn.innerHTML = esc(t("Options")) + svg("chevron"); at(btn, bx, by); btn.setAttribute("data-tk-a", "");
      var menu = add("tk-menu"); at(menu, bx, up ? by - mh - 6 : by + 42);
      labels.forEach(function (label, i) {
        var it = el("div", "tk-mi" + (i === want ? " want" : ""), label); menu.appendChild(it);
        if (i === want) it.setAttribute("data-tk-b", "");
        on(it, "click", function (e) { if (i === want) { var q = local(e); finish(q.x, q.y); } else play(it, SHAKE, { duration: 300 }); });
      });
      on(btn, "click", function () { menu.classList.toggle("open"); });
    };
    // 9. Drag a card into a box some way off, in any direction.
    TASKS.drop = function () {
      say("Drag the card into the box", "move");
      var s = size(), a, b, far = Math.min(240, s.w * 0.4), rise = Math.random() < 0.5 ? Math.min(170, s.h * 0.4) : 0;   // half of them a good way up or down
      for (var i = 0; i < 80; i++) {
        a = { x: rnd(48, Math.max(48, s.w - 48)), y: rnd(34, Math.max(34, s.h - 34)) }; b = { x: rnd(70, Math.max(70, s.w - 70)), y: rnd(52, Math.max(52, s.h - 52)) };
        if (Math.hypot(a.x - b.x, a.y - b.y) >= far && Math.abs(a.y - b.y) >= rise) break;
      }
      var zone = add("tk-zone", t("Drop here")); at(zone, b.x, b.y); zone.setAttribute("data-tk-b", "");
      var card = add("tk-card", t("File")); at(card, a.x, a.y); card.setAttribute("data-tk-a", "");
      var drag = false, ox = 0, oy = 0;
      function inZone(x, y) { return Math.abs(x - b.x) <= 60 && Math.abs(y - b.y) <= 43; }
      on(card, "mousedown", function (e) { var q = local(e); drag = true; ox = q.x - a.x; oy = q.y - a.y; card.classList.add("drag"); e.preventDefault(); });
      on(window, "mousemove", function (e) { if (!drag) return; var q = local(e); at(card, q.x - ox, q.y - oy); zone.classList.toggle("over", inZone(q.x - ox, q.y - oy)); });
      on(window, "mouseup", function (e) {
        if (!drag) return;
        drag = false; card.classList.remove("drag");
        var q = local(e);
        if (inZone(q.x - ox, q.y - oy)) { at(card, b.x, b.y); finish(b.x, b.y - 58); } else { at(card, a.x, a.y); zone.classList.remove("over"); }
      });
      hintDrag(card, zone);
    };

    function track(e) { var q = local(e); px = q.x; py = q.y; }
    pad.addEventListener("mousemove", track);
    skipEl.addEventListener("click", function () { if (!stopped) next(); });   // a skipped task is not counted
    pips(); next();
    return {
      need: MOUSE_TASKS_PER_SAMPLE,
      done: function () { return done; },                 // tasks finished since the last saved sample
      saved: function () { done = 0; pips(); },           // a sample was sent: count again for the next one
      stop: function () { stopped = true; clear(); pad.removeEventListener("mousemove", track); },
    };
  }

  // Step 1 — passkey registration
  function wizPasskey() {
    return new Promise(function (resolve) {
      openWiz(wizStepBar(0, 3, 0) + '<div class="hero"><div class="orb"><span class="scan"></span>' + svg("finger") + '</div></div><div class="t">' + h("Create your passkey") + '</div><div class="d">'
        + h("This device becomes your key. It is used to verify you if your typing or mouse rhythm ever looks off.") + '</div><button class="b" id="cw">' + h("Set up passkey") + '</button><div class="e"></div>', null, "center");
      var b = wizEl.querySelector("#cw"), e = wizEl.querySelector(".e");
      b.addEventListener("click", async function () {
        e.style.display = "none"; b.disabled = true; b.textContent = t("Waiting for device…");
        try { await registerPasskey(); resolve(); }
        catch (err) { e.textContent = err.message; e.style.display = "block"; b.disabled = false; b.textContent = t("Set up passkey"); }
      });
    });
  }

  // Step 2 — keystroke enrollment (N samples). A different fixed passage per sample (ENROL_PASSAGES).
  // `optional`: lazy-mode standalone use — dismissable × (no logout), no step bar.
  function wizKeystroke(optional) {
    return new Promise(function (resolve) {
      var got = 0;               // seeded from samples already on file (below)
      async function render() {
        openWiz((optional ? "" : wizStepBar(1, 3, 1)) + '<div class="t">' + h("Teach your typing rhythm") + '</div><div class="d">' + h("Type the passage below naturally.") + " <b>"
          + h("Sample {n} of {total}", { n: got + 1, total: KS_ENROLL_SAMPLES }) + '</b> · <a href="#" id="cnew">' + h("new text") + '</a></div><div class="passage" id="cpass" lang="en"></div>'
          + '<textarea class="ta" id="cta" lang="en" placeholder="' + esc(t("Type it here…")) + '"></textarea><div class="bar"><i id="cbar"></i></div><div class="diag" id="cdiag">'
          + h("typed {chars} · captured {keys} keystrokes", { chars: 0, keys: 0 }) + '</div><button class="b" id="cs" disabled>' + h("Submit sample") + '</button><div class="e"></div>', optional ? function () { closeWiz(); resolve(false); } : null);
        var ta = wizEl.querySelector("#cta"), bar = wizEl.querySelector("#cbar"), btn = wizEl.querySelector("#cs"), e = wizEl.querySelector(".e"), diag = wizEl.querySelector("#cdiag"), pass = wizEl.querySelector("#cpass"), newBtn = wizEl.querySelector("#cnew");
        var tracker = window.continuumKeystrokes.createTracker(ta);
        var NEED_KEYS = 100, NEED_CHARS = 120;
        function loadPassage() { pass.textContent = nextPassage(); }
        newBtn.addEventListener("click", function (ev) { ev.preventDefault(); loadPassage(); });
        function refresh() {
          var chars = ta.value.trim().length;
          var keys = window.continuumKeystrokes.analyze(tracker.getEvents()).keyCount || 0;
          bar.style.width = Math.min(100, Math.round((keys / NEED_KEYS) * 100)) + "%";
          diag.textContent = t("typed {chars} · captured {keys} keystrokes", { chars: chars, keys: keys });
          // Gate on CAPTURED keystrokes so a sample with no real timing is never
          // submitted (which would be silently rejected server-side).
          btn.disabled = keys < NEED_KEYS || chars < NEED_CHARS;
        }
        ta.addEventListener("input", refresh);
        ta.addEventListener("keyup", refresh);
        btn.addEventListener("click", async function () {
          e.style.display = "none"; btn.disabled = true; btn.textContent = t("Saving…");
          var events = tracker.getEvents(), timings = window.continuumKeystrokes.analyze(events);
          var r = await reqJson(EP.ksEnroll, "POST", { textContent: ta.value.trim(), keystrokeEvents: events, keystrokeTimings: timings, sourcePath: "onboarding" });
          console.debug("[continuum] keystroke enroll", r.status, r.d);
          if (!r.ok) { e.textContent = "(" + r.status + ") " + ((r.d && r.d.error) || t("rejected")); e.style.display = "block"; btn.disabled = false; btn.textContent = t("Submit sample"); return; }
          got += 1;
          if (r.d.training) watchKsBuild();   // the model is built from the queue: no waiting here
          if ((r.d.typingStatus && r.d.typingStatus.trained) || r.d.training || got >= KS_ENROLL_SAMPLES) return resolve();
          render();
        });
        await loadPassage();
      }
      // Continue the count from samples already collected (so a user who did 3
      // resumes at 4/5 rather than restarting at 1/5). If already enough, finish.
      (async function () {
        try {
          var st = await reqJson(EP.ksStatus); got = Math.min(Number((st.d && st.d.sampleCount) || 0), KS_ENROLL_SAMPLES);
          if (st.d && st.d.training) { watchKsBuild(); return resolve(); }   // e.g. after a reload: already being built
          if (st.d && st.d.trainingError) got = Math.min(got, KS_ENROLL_SAMPLES - 1);   // one more sample queues a new build
        } catch (e) {}
        if (got >= KS_ENROLL_SAMPLES) return resolve();
        render();
      })();
    });
  }

  // ---- Mouse enrolment, in SAMPLES (the unit the typing channel also shows as "sample 2 / 5") ----
  // One sample = MOUSE_SAMPLE_WINDOWS windows holding MOUSE_TASKS_PER_SAMPLE finished tasks (mouseTasks); a profile is built
  // once MOUSE_SAMPLES_REQUIRED samples are on file (8 x 55 = 440 windows).
  // Each sample saves itself the moment it is complete, so the user only ever sees a counter.
  // The server enforces the same numbers (ca-service lib/mouse.js) and reports them in /status.
  // It builds the model in its training queue (F2 since T3.4: a logistic head per leave-one-sample-out
  // fold on the frozen embedding, about 6 s; S1's nine networks took 2-3 minutes), so the sample that completes the set comes back with
  // `training: true` and the wizard polls /status until the build is done.
  // One sample recorder at a time, and a closed one stops recording. Until 2026-10-24 a second flow (the "+ train"
  // button pressed again) ran beside the first: both trackers recorded the same movement and both saved it, which put
  // two copies into the owner's profile on 2026-09-19 and raised his threshold. A flow closed with × or covered by
  // another popup also kept its page-wide tracker and its timer, and went on saving samples in the background.
  var endSampleFlow = null;
  function mouseSampleFlow(opts) {
    // opts: { title, intro, stepBar, onClose, dismissLabel, allowReset, onEnrolled, resolveOnTrained(result), onAlreadyEnrolled }
    if (endSampleFlow) endSampleFlow();
    var st = { onFile: 0, required: MOUSE_SAMPLES_REQUIRED, perSample: MOUSE_SAMPLE_WINDOWS, enrolled: false };
    var tracker = null, tasks = null, iv = null, saving = false, addedNow = 0, building = false, pollT = null, note = "", ended = false;
    function end() {
      ended = true; stop(); clearTimeout(pollT);
      if (tracker) { tracker.stop(); tracker = null; }
      if (tasks) { tasks.stop(); tasks = null; }
      if (endSampleFlow === end) endSampleFlow = null;
    }
    endSampleFlow = end;
    function close() { end(); opts.onClose(); }
    // The profile exists: it takes no more enrolment samples, so the flow ends here.
    function finish(d) { end(); if (opts.resolveOnTrained) opts.resolveOnTrained(d); }
    function pips() {
      var h = "";
      for (var i = 0; i < st.required; i++) h += '<span class="mpip' + (i < st.onFile ? " on" : "") + '"></span>';
      return h;
    }
    function headline() {
      if (building) return t(st.enrolled ? "Updating your mouse model…" : "Building your mouse model…");
      if (st.onFile >= st.required) return t(st.enrolled ? "Mouse protection is on ✓" : "Building your mouse model…");
      return t("Sample {n} of {total}", { n: st.onFile + 1, total: st.required });
    }
    function subline() {
      if (building) return t("Training on your samples, usually under a minute. You can leave this open.");
      if (note) return note;
      if (st.onFile >= st.required) return st.enrolled ? t("All {n} samples on file.", { n: st.required }) : "";
      return t("{n} more to go · about {m} min", { n: st.required - st.onFile, m: Math.max(1, Math.round((st.required - st.onFile) * 0.5)) });
    }
    // The reset deletes the samples on file and the model: with neither, the link has nothing to do and is not shown.
    function canReset() { return st.onFile > 0 || st.enrolled || building; }
    function render() {
      openWiz((opts.stepBar || "") + '<div class="wizload" id="mwl"><span class="wizspin"></span><span id="mwlt">' + h("Saving sample…") + "</span></div>"
        // one row above the pad and one below it, so the pad has the height of the window (the CSS, ".card.wide")
        + '<div class="mtop"><div class="mtt"><div class="t">' + opts.title + '</div><div class="d">' + opts.intro + "</div></div>"
        + '<div class="msamp"><div class="mhead" id="mhead">' + esc(headline()) + '</div><div class="mpips">' + pips() + "</div>"
        + '<div class="msub" id="msub">' + esc(subline()) + "</div></div></div>"
        + '<div class="pad" id="cpad"></div><div class="bar"><i id="mbar"></i></div>'
        + '<div class="mbot"><div class="diag" id="mdiag"></div><div class="mact">'
        + (opts.allowReset ? '<div class="foot" id="mresetrow"' + (canReset() ? "" : ' style="display:none"') + '><a href="#" id="mreset" class="danger">' + svg("trash") + h("Reset my mouse profile") + "</a></div>" : "")
        + (opts.dismissLabel ? '<div class="row2"><button class="b sec" id="mdone">' + opts.dismissLabel + "</button></div>" : "")
        + "</div></div>"
        + '<div class="e"></div>', close, "wide");
      var pad = wizEl.querySelector("#cpad"), bar = wizEl.querySelector("#mbar"), diag = wizEl.querySelector("#mdiag"),
        e = wizEl.querySelector(".e"), load = wizEl.querySelector("#mwl"), loadT = wizEl.querySelector("#mwlt");
      var doneBtn = wizEl.querySelector("#mdone");
      if (doneBtn) doneBtn.addEventListener("click", close);
      if (opts.allowReset) {
        wizEl.querySelector("#mreset").addEventListener("click", function (ev) {
          ev.preventDefault();
          resetProfile("mouse", e, function () {
            stop();
            try { stopMouse(); } catch (e3) {}
            mouseOn = false; updateToggle(); setMouseRow("mut", "not enrolled");
            st.onFile = 0; st.enrolled = false; addedNow = 0; building = false; note = ""; clearTimeout(pollT); render();
          });
        });
      }
      // Track on documentElement, NOT the pad: the live guard scores motion across the whole page,
      // so the sample must be the same kind of movement. The pad is only a visual target.
      if (tracker) tracker.stop();
      tracker = window.mouseFeatures.createMouseTracker(document.documentElement);
      if (tasks) tasks.stop();
      tasks = mouseTasks(pad);
      function tick() {
        if (ended || saving) return;
        if (!pad.isConnected) { end(); return; }   // closed, or replaced by another popup: stop recording
        var w = window.mouseFeatures.stepsToWindows(window.mouseFeatures.eventsToSteps(tracker.getEvents()));
        var n = w ? w.length : 0, k = tasks ? tasks.done() : 0, need = tasks ? tasks.need : 0;
        // Both are needed, enough movement and the tasks done; the bar follows whichever is behind.
        bar.style.width = Math.round(Math.min(1, n / st.perSample, need ? k / need : 1) * 100) + "%";
        diag.textContent = t("this sample: tasks {k} / {j} · movement {n} / {m} windows", { k: Math.min(k, need), j: need, n: Math.min(n, st.perSample), m: st.perSample });
        // Its last windows: the sample ends with the tasks just done, and movement made before them falls away.
        if (n >= st.perSample && k >= need) save(w.slice(-st.perSample));
      }
      async function save(windows) {
        saving = true; e.style.display = "none";
        var last = st.onFile + 1 >= st.required;
        loadT.textContent = t(last && !st.enrolled ? "Saving sample {n} and building your model…" : "Saving sample {n}…", { n: st.onFile + 1 });
        load.classList.add("on");
        var r = await reqJson(EP.mouseEnroll, "POST", { windows: windows });
        if (ended) return;
        load.classList.remove("on");
        tracker.reset();
        if (tasks) tasks.saved();
        saving = false;
        if (r.status === 409 && r.d && r.d.error === "already_enrolled") {
          // The profile exists (built meanwhile, or from another page) and takes no more enrolment samples.
          end();
          if (opts.onAlreadyEnrolled) opts.onAlreadyEnrolled(); else if (opts.resolveOnTrained) opts.resolveOnTrained(null);
          return;
        }
        if (!r.ok) {
          // e.g. the step-size gate: a mechanical or jittering movement is not stored. Redo it.
          e.textContent = t("{why} — this sample starts again.", { why: (r.d && r.d.error) || t("This sample was not accepted") });
          e.style.display = "block";
          return;
        }
        addedNow += 1; note = "";
        var total = Number((r.d && r.d.totalWindows) || 0);
        st.onFile = Math.min(st.required, Math.floor(total / st.perSample)) || (st.onFile + 1);
        if (r.d && r.d.trained) { if (!st.enrolled && opts.onEnrolled) opts.onEnrolled(); st.enrolled = true; }
        if (r.d && r.d.training) { waitForModel(); return; }
        if (st.enrolled) { finish(r.d); return; }
        refresh();
      }
      function refresh() {
        wizEl.querySelector("#mhead").textContent = headline();
        wizEl.querySelector("#msub").textContent = subline();
        var p = wizEl.querySelectorAll(".mpip");
        for (var i = 0; i < p.length; i++) p[i].className = "mpip" + (i < st.onFile ? " on" : "");
        var rr = wizEl.querySelector("#mresetrow");
        if (rr) rr.style.display = canReset() ? "" : "none";
      }
      // The server is building (or rebuilding) the model: stop collecting and poll /status until
      // the job is finished, then either finish enrolment or explain what went wrong.
      function waitForModel() {
        building = true; stop(); clearTimeout(pollT); refresh();
        loadT.textContent = headline(); load.classList.add("on");
        var since = Date.now();
        (async function poll() {
          // Wizard closed or re-rendered. isConnected, not document.body.contains(): the wizard lives in the
          // shadow root, which contains() never looks into, so this wait used to stop at its first poll.
          if (ended || !load.isConnected) return;
          var d = {};
          try { var s = await reqJson(EP.mouseStatus); d = (s && s.d) || {}; } catch (e4) {}
          var waited = Date.now() - since;
          if (d.training && waited >= MOUSE_TRAIN_GIVE_UP_MS) {
            // Never a spinner forever: the job stays queued on the server and finishes on its own.
            building = false; load.classList.remove("on"); refresh();
            e.textContent = t("Your model is still being built. You can close this: nothing is lost, and mouse protection starts once it is ready.");
            e.style.display = "block";
            return;
          }
          if (d.training) {
            if (waited >= MOUSE_TRAIN_SLOW_MS) loadT.textContent = headline() + " " + t("(taking longer than usual)");
            pollT = setTimeout(poll, MOUSE_TRAIN_POLL_MS); return;
          }
          building = false; load.classList.remove("on");
          if (d.enrolled) {
            if (!st.enrolled && opts.onEnrolled) opts.onEnrolled();
            st.enrolled = true;
            finish(d);
            return;
          }
          e.textContent = (d.trainingError ? t("Building your model failed ({why})", { why: d.trainingError }) : t("Your model could not be built"))
            + " — " + t("save one more sample to try again.");
          e.style.display = "block";
          refresh();
          iv = setInterval(tick, 400);
        })();
      }
      stop();
      if (building) waitForModel(); else iv = setInterval(tick, 400);
    }
    function stop() { if (iv) clearInterval(iv); iv = null; }
    // Start from what is already on file, so a user who saved two samples resumes at 3 of 8, and a
    // user who left while the model was being built rejoins the wait.
    (async function () {
      try {
        var s = await reqJson(EP.mouseStatus); var d = (s && s.d) || {};
        if (d.samplesRequired) st.required = d.samplesRequired;
        if (d.sampleWindows) st.perSample = d.sampleWindows;
        st.onFile = Number(d.samplesOnFile != null ? d.samplesOnFile : Math.floor((d.totalWindows || 0) / st.perSample));
        st.enrolled = !!d.enrolled;
        building = !!d.training;
      } catch (e) {}
      if (ended) return;   // a newer flow took over while the status was being read
      if (st.enrolled && !building && opts.resolveOnTrained && !opts.allowReset) { finish(null); return; }
      render();
    })();
  }

  // Step 3 — mouse enrollment: samples until the profile is built.
  // `optional`: lazy-mode standalone use — dismissable × (no logout), no step bar.
  function wizMouse(optional) {
    return new Promise(function (resolve) {
      mouseSampleFlow({
        title: h("Teach your mouse motion"),
        intro: h("Do each small task at your natural speed, as you would when using the site: click, select text, drag. Each <b>sample</b> saves itself after a few tasks; your mouse model is built after the last one. Until then the mouse channel does not judge you."),
        stepBar: optional ? "" : wizStepBar(2, 3, 2),
        onClose: optional ? function () { closeWiz(); resolve(false); } : doLogout,
        dismissLabel: optional ? h("Continue later") : null,
        allowReset: false,
        resolveOnTrained: function () { resolve(); },
        onAlreadyEnrolled: function () { resolve(); },
      });
    });
  }

  // Demo mode has no single onboarding endpoint — derive it from the app's own
  // status routes (same identity the SDK monitors on, via req.caUid).
  async function fetchOnboardingDemo() {
    var ob = { passkey: false, keystroke: false, mouse: false };
    try { var me = await req("/api/auth/me").then(function (r) { return r.ok ? r.json() : {}; }); ob.passkey = !!me.passkeysRegistered && !me.passkeySetupRequired; } catch (e) {}
    try { var ts = await reqJson(EP.ksStatus); ob.keystroke = !!(ts.d && ts.d.trained); ob.keystrokeTraining = !!(ts.d && ts.d.training); } catch (e) {}
    try { var ms = await reqJson(EP.mouseStatus); ob.mouse = !!(ms.d && ms.d.enrolled); } catch (e) {}
    return ob;
  }

  async function runOnboarding(ob) {
    if (!ob.passkey) { await wizPasskey(); ob.passkey = true; }
    // Lazy strategy: only the passkey (step-up anchor) is enrolled up-front; each
    // modality enrolls the moment its toggle is enabled. A keystroke-only
    // deployment therefore never asks the user for mouse samples.
    if (ONBOARD_MODE !== "lazy") {
      if (cfg.keystroke !== "off" && ob.keystrokeTraining && !ob.keystroke) watchKsBuild();
      else if (cfg.keystroke !== "off" && !ob.keystroke) { await wizKeystroke(); ob.keystroke = true; }
      if (cfg.mouse !== "off" && !ob.mouse) { await wizMouse(); ob.mouse = true; }
    }
    // brief "all set" then close
    openWiz('<div class="hero"><div class="orb ok">' + svg("check") + '</div></div><div class="t">' + h("You're verified") + '</div><div class="d">' + h(ksBuilding
      ? "Your typing model is being built (about a minute). Carry on: typing protection starts by itself once it is ready."
      : "Continuum is now protecting this session. It will quietly confirm it's you as you use the app.") + '</div><button class="b" id="cd">' + h("Continue") + "</button>", closeWiz, "center");
    await new Promise(function (res) { wizEl.querySelector("#cd").addEventListener("click", res); });
    closeWiz();
  }

  // ---- reinforcement: let an enrolled user add more samples on demand ----
  function reinforceKeystroke() {
    if (!window.continuumKeystrokes) return;
    var added = 0, total = null;
    // A trained model learns more only through the adaptive popup (the retrain asks for the passkey);
    // the server refuses enrolment samples once the model exists. What is left here: reset and start over.
    function renderTrained() {
      openWiz('<div class="t">' + h("Your typing rhythm is trained") + '</div><div class="d">' + h("Samples on file: {n}.", { n: total }) + " "
        + h(ADAPT_ENABLED ? "It learns more only from the popup that offers clean stretches of your typing, and the retrain asks for your passkey."
          : "Adaptive retraining is off for this organisation, so the model stays as it was trained.")
        + '</div><div class="row2"><button class="b" id="cdone">' + h("Close") + '</button></div><div class="foot"><a href="#" id="creset" class="danger">' + svg("trash") + h("Reset my typing profile") + '</a></div><div class="e"></div>', closeWiz);
      var e = wizEl.querySelector(".e");
      wizEl.querySelector("#cdone").addEventListener("click", closeWiz);
      wizEl.querySelector("#creset").addEventListener("click", function (ev) {
        ev.preventDefault();
        resetProfile("keystroke", e, function () { setKb("mut", "not enrolled — add samples"); total = 0; added = 0; render(); });
      });
    }
    function renderBuilding() {
      openWiz('<div class="t">' + h("Your typing model is being built") + '</div><div class="d">' + h("This takes about a minute. You can close this and carry on: typing protection starts by itself once the model is ready.") + '</div><button class="b" id="cdone">' + h("Close") + "</button>", closeWiz);
      wizEl.querySelector("#cdone").addEventListener("click", closeWiz);
    }
    function render() {
      openWiz('<div class="wizload" id="cwl"><span class="wizspin"></span>' + h("Saving sample…") + '</div><div class="t">' + h("Strengthen your typing rhythm") + '</div><div class="d">'
        + h("Type the passage naturally, then save it as a training sample.") + ' <a href="#" id="cnew">' + h("new text") + '</a></div><div class="samplecount">'
        + h("Samples on file: {n} · added now: {m}", { n: total == null ? "…" : total, m: added }) + '</div><div class="passage" id="cpass" lang="en"></div><textarea class="ta" id="cta" lang="en" placeholder="'
        + esc(t("Type it here…")) + '"></textarea><div class="bar"><i id="cbar"></i></div><div class="diag" id="cdiag">' + h("typed {chars} · captured {keys} keystrokes", { chars: 0, keys: 0 })
        + '</div><div class="row2"><button class="b" id="cs" disabled>' + h("Save sample") + '</button><button class="b sec" id="cdone" style="flex:0 0 96px">' + h("Done")
        + '</button></div><div class="foot"' + (total > 0 ? "" : ' style="display:none"') + '><a href="#" id="creset" class="danger">' + svg("trash") + h("Reset my typing profile") + '</a></div><div class="e"></div>', closeWiz);
      var ta = wizEl.querySelector("#cta"), bar = wizEl.querySelector("#cbar"), btn = wizEl.querySelector("#cs"), done = wizEl.querySelector("#cdone"), e = wizEl.querySelector(".e"), diag = wizEl.querySelector("#cdiag"), pass = wizEl.querySelector("#cpass"), newBtn = wizEl.querySelector("#cnew"), load = wizEl.querySelector("#cwl");
      var tracker = window.continuumKeystrokes.createTracker(ta);
      var NEED_KEYS = 100, NEED_CHARS = 120;
      function loadPassage() { pass.textContent = nextPassage(); }
      newBtn.addEventListener("click", function (ev) { ev.preventDefault(); loadPassage(); });
      done.addEventListener("click", closeWiz);
      wizEl.querySelector("#creset").addEventListener("click", function (ev2) {
        ev2.preventDefault();
        resetProfile("keystroke", e, function () {
          setKb("mut", "not enrolled — add samples");
          total = 0; added = 0; render();
        });
      });
      function refresh() { var chars = ta.value.trim().length, keys = window.continuumKeystrokes.analyze(tracker.getEvents()).keyCount || 0; bar.style.width = Math.min(100, Math.round((keys / NEED_KEYS) * 100)) + "%"; diag.textContent = t("typed {chars} · captured {keys} keystrokes", { chars: chars, keys: keys }); btn.disabled = keys < NEED_KEYS || chars < NEED_CHARS; }
      ta.addEventListener("input", refresh); ta.addEventListener("keyup", refresh);
      btn.addEventListener("click", async function () {
        e.style.display = "none"; load.classList.add("on");
        var events = tracker.getEvents(), r = await reqJson(EP.ksEnroll, "POST", { textContent: ta.value.trim(), keystrokeEvents: events, keystrokeTimings: window.continuumKeystrokes.analyze(events), sourcePath: "reinforce" });
        load.classList.remove("on");
        if (r.status === 409 && r.d && r.d.error === "already_enrolled") { renderTrained(); return; }
        if (!r.ok) { e.textContent = "(" + r.status + ") " + ((r.d && r.d.error) || t("rejected")); e.style.display = "block"; return; }
        added += 1; if (total != null) total += 1;
        if (r.d && r.d.typingStatus && r.d.typingStatus.trained) { renderTrained(); return; }
        if (r.d && r.d.training) { watchKsBuild(); renderBuilding(); return; }
        render();
      });
      loadPassage();
    }
    // Load the current sample count first so the popup shows how many are on file.
    (async function () {
      var trained = false, building = false;
      try { var st = await reqJson(EP.ksStatus); total = Number((st.d && st.d.sampleCount) || 0); trained = !!(st.d && st.d.trained); building = !!(st.d && st.d.training); } catch (e) { total = 0; }
      if (trained) renderTrained(); else if (building) { watchKsBuild(); renderBuilding(); } else render();
    })();
  }
  // A trained mouse profile takes no more enrolment samples (the server answers 409 already_enrolled since
  // 2026-10-24; until then every extra sample rebuilt the profile, with no passkey). The panel then offers only the
  // reset, as it does for typing.
  function reinforceMouse() {
    if (!window.mouseFeatures) return;
    (async function () {
      var d = {};
      try { var s = await reqJson(EP.mouseStatus); d = (s && s.d) || {}; } catch (e) {}
      if (d.enrolled && !d.training) renderMouseTrained(d); else mouseSamples();
    })();
  }
  function renderMouseTrained(d) {
    if (endSampleFlow) endSampleFlow();
    openWiz('<div class="t">' + h("Your mouse movement is trained") + '</div><div class="d">' + h("Samples on file: {n}.", { n: Number((d && d.samplesOnFile) || MOUSE_SAMPLES_REQUIRED) })
      + " " + h("A trained mouse model takes no more samples from this page. To enrol again, reset it; you will be asked for your passkey.") + "</div>"
      + '<div class="row2"><button class="b" id="mdone">' + h("Close") + "</button></div>"
      + '<div class="foot"><a href="#" id="mreset" class="danger">' + svg("trash") + h("Reset my mouse profile") + '</a></div><div class="e"></div>', closeWiz);
    var e = wizEl.querySelector(".e");
    wizEl.querySelector("#mdone").addEventListener("click", closeWiz);
    wizEl.querySelector("#mreset").addEventListener("click", function (ev) {
      ev.preventDefault();
      resetProfile("mouse", e, function () {
        try { stopMouse(); } catch (e3) {}
        mouseOn = false; updateToggle(); setMouseRow("mut", "not enrolled");
        mouseSamples();
      });
    });
  }
  function mouseSamples() {
    mouseSampleFlow({
      title: h("Mouse samples"),
      intro: h("Do each small task at your natural speed: click, select text, drag. Each <b>sample</b> saves itself after a few tasks. Your mouse model is built after the last required sample."),
      onClose: closeWiz,
      dismissLabel: h("Done"),
      allowReset: true,
      // First model just built from these samples: start protecting the session straight away.
      onEnrolled: function () { if (obState) obState.mouse = true; if (!mouseOn) setMouse(true); },
      resolveOnTrained: function (d) { renderMouseTrained(d || {}); },
      onAlreadyEnrolled: function () { renderMouseTrained({}); },
    });
  }

  // ================= GUARD LOOPS =================
  var ksTracker = null, ksOn = false, lastCheckedWindowCount = 0, checkInFlight = false, ksMissedWindow = false, ksPastePending = false;
  var cleanRun = 0, lastContributeKeys = -1e9, activeField = null, contributing = false, learnVisible = false;
  // Password fields ARE watched unless excluded: their timing is captured with keyCode 0 (the
  // tracker), and only their length counts toward the typed length.
  // A field's type for "fields never watched": an input's type, "textarea", or "contenteditable".
  function fieldTypeOf(n) { return n && n.tagName && (n.tagName === "INPUT" || n.tagName === "TEXTAREA") ? (n.type || "text").toLowerCase() : "contenteditable"; }
  function fieldExcluded(n) { return EXCLUDE_TYPES.indexOf(fieldTypeOf(n)) >= 0; }
  // The typed text, read ONLY to measure its length on this page: it is never sent (the server gets the
  // length). Rich-text editors count by their visible text (the outermost editable element).
  function currentTypedText() {
    var t = "", ns = document.querySelectorAll("input, textarea");
    for (var i = 0; i < ns.length; i++) {
      var n = ns[i]; if (fieldExcluded(n) || typeof n.value !== "string") continue;
      t += (n.type === "password" ? new Array(n.value.length + 1).join("x") : n.value) + " ";
    }
    if (EXCLUDE_TYPES.indexOf("contenteditable") < 0) {
      var eds = document.querySelectorAll("[contenteditable]");
      for (var j = 0; j < eds.length; j++) {
        var e = eds[j]; if (!e.isContentEditable || (e.parentElement && e.parentElement.isContentEditable)) continue;
        t += (e.innerText || "") + " ";
      }
    }
    return t.trim();
  }
  function ksKeyCount(ev) { return window.continuumKeystrokes.analyze(ev).keyCount || 0; }
  function currentKeys() { return ksTracker ? ksKeyCount(ksTracker.getEvents()) : 0; }
  function ksWindowCount(k) { var s = Math.max(k - 1, 0); return s >= WINDOW_SIZE ? Math.floor((s - WINDOW_SIZE) / WINDOW_STRIDE) + 1 : 0; }
  // What counts toward the minimum before a check: the text still in the fields or the printable keys typed, whichever
  // is more (2026-11-08). A chat box emptied at every send never held 70 characters, so its typing was never checked.
  // The same printable keys as the server's printableKeyCount (space, digits, letters, keypad, punctuation).
  function printableKeys(ev) {
    var n = 0;
    for (var i = 0; i < ev.length; i++) {
      var k = ev[i].keyCode;
      if (ev[i].eventType === "keydown" && (k === 32 || (k >= 48 && k <= 90) || (k >= 96 && k <= 111) || (k >= 186 && k <= 222))) n++;
    }
    return n;
  }
  function typedLength(text) { return Math.max(text.length, ksTracker ? printableKeys(ksTracker.getEvents()) : 0); }

  // Trigger policy mirrors the opinion.html reference: on any text input, fire a
  // check the moment a NEW sliding window forms (no debounce), gated on a minimum
  // amount of text. If a check is already in flight, remember the window and catch
  // up the instant it returns — so a window is never skipped, never double-fired.
  function onKsInput(e) {
    // Remember which field is being typed in — the adaptive prompt floats above it.
    if (e && e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") && e.target.type !== "password" && e.target.type !== "hidden") activeField = e.target;
    else if (e && e.target && e.target.isContentEditable) { var ed = e.target; while (ed.parentElement && ed.parentElement.isContentEditable) ed = ed.parentElement; activeField = ed; }
    if (locked || signedOut || !ksOn || !ksTracker) return;
    var typed = typedLength(currentTypedText());
    if (typed < KS_MIN_CHARS) { setKb("col", "type {n}/{m} characters to start", { vars: { n: typed, m: KS_MIN_CHARS }, prog: typed / KS_MIN_CHARS }); return; }
    // Live feedback while the user keeps writing between verdicts (feels engaged
    // instead of frozen on the last "verified ✓").
    if (!checkInFlight) setKb("mut", "analyzing…", { pct: lastKsPct, keep: true });
    if (ksWindowCount(ksKeyCount(ksTracker.getEvents())) <= lastCheckedWindowCount) return; // no new window yet
    if (checkInFlight) { ksMissedWindow = true; return; }
    runKsCheck();
  }
  // A paste is judged at once: the server counts the pastes in each field against the organisation's allowance.
  // Before 2026-10-25 a check waited for a new typing window, so a paste that no typing followed was never judged.
  function onKsPaste() {
    setTimeout(function () {   // after the tracker has recorded the paste
      if (locked || !ksOn || !ksTracker) return;
      if (checkInFlight) { ksPastePending = true; return; }
      runKsCheck(true);
    }, 0);
  }
  // force: a paste's check, sent without a new window and before the text reaches the minimum length.
  async function runKsCheck(force) {
    if (locked || signedOut || !ksOn || !ksTracker) return;
    var events = ksTracker.getEvents(), typed = typedLength(currentTypedText());
    if (!force && typed < KS_MIN_CHARS) return;
    checkInFlight = true; ksMissedWindow = false; pulse(); setKb("mut", "checking…", { pct: lastKsPct, keep: true, busy: true });
    try {
      var timings = window.continuumKeystrokes.analyze(events);
      // The text's LENGTH only: what the user typed never leaves the page.
      var r = await reqJson(EP.ksCheck, "POST", { textLength: typed, keystrokeEvents: events.slice(-1400), keystrokeTimings: timings, sourcePath: location.pathname });
      if (r.status === 401 && MODE === "demo") { sessionEnded(); return; }
      var d = r.d; if (d && d.riskToken) latestRiskToken = d.riskToken;
      lastCheckedWindowCount = ksWindowCount(ksKeyCount(events));
      var ev = d.typingEvaluation || {};
      var wc = ev.windowCount || 0, pct = d.modelConfidence != null ? Math.round(d.modelConfidence * 100) : null;
      if (pct != null) lastKsPct = pct;   // survives into the next transient state
      // demo mode: its own gate answers 423 until the model exists; that is not a lock
      if (d.rhythmEnrollmentRequired) { setKb("mut", ksBuilding ? "building your model…" : "not enrolled — add samples"); cleanRun = 0; return; }
      if (r.status === 423) { setKb("bad", "locked — verify"); maybeChallenge(d, "keystroke", onProbation); return; }
      // During post-step-up probation, ANY suspicious verdict re-challenges — even a
      // warmup one — so passing step-up grants no grace window to a persisting impostor.
      if (maybeChallenge(d, "keystroke", onProbation)) { setKb("bad", "rhythm mismatch"); cleanRun = 0; hideLearn(); return; }
      if (d.checked === false) { setKb("mut", "gathering…", { pct: lastKsPct, keep: true }); return; }
      // No trained model for THIS identity yet → not "warming", it needs enrollment.
      // (Otherwise the row sat forever at "warming 0/7 · 0%".)
      if (ev.modelAvailable === false) { setKb("mut", ksBuilding ? "building your model…" : "not enrolled — add samples"); cleanRun = 0; return; }
      if (d.warmup) { setKb("col", "warming {n}/{m} windows", { vars: { n: wc, m: RECENT_WINDOW_COUNT + 1 }, pct: pct, prog: wc / (RECENT_WINDOW_COUNT + 1) }); cleanRun = 0; }
      else if (d.isSuspicious) { setKb("bad", "suspicious", { pct: pct, prog: pct != null ? pct / 100 : 1 }); cleanRun = 0; }
      else { setKb("ok", "verified", { pct: pct, prog: pct != null ? pct / 100 : 1 }); onProbation = false; cleanRun = (d.modelConfidence == null || d.modelConfidence >= ADAPT_CONFIDENCE_MIN) ? cleanRun + 1 : 0; }
      evalAdaptive(); // a clean run may now qualify to contribute a training sample
    } catch (e) { setKb("mut", "offline"); }
    finally {   // catch up on a paste or a window that came mid-check
      checkInFlight = false;
      if (ksPastePending) { ksPastePending = false; runKsCheck(true); } else if (ksMissedWindow) onKsInput();
    }
  }

  // ---- adaptive learning (SDK port of the demo's "Contribute" panel) ----
  // Eligible after a clean run of high-confidence checks + a keystroke cooldown;
  // the prompt floats directly above the field the user is typing in.
  function evalAdaptive() {
    if (!ADAPT_ENABLED || !ksOn || locked || contributing) { hideLearn(); return; }
    // Ask the server once where this user is in the cycle, then follow it quietly.
    if (contribUntil === null) { fetchContribWindow(); hideLearn(); return; }
    if (Date.now() < contribUntil) { hideLearn(); return; }
    if (adaptReady) { if (!retrainDismissed && activeField) { setLearnMode("retrain"); showLearn(); } else hideLearn(); return; }
    // The popup shows only when a click would be accepted: after a clean run of checks, once the sample has
    // its windows, the server's dry run says so.
    if (cleanRun >= ADAPT_CLEAN_RUN && activeField && sampleWindowsNow() >= SAMPLE_WINDOWS) {
      probeSample();
      if (sampleProbe.eligible) { setLearnMode("contribute"); showLearn(); } else hideLearn();
    } else hideLearn();
  }
  // The windows of the typing since the previous sample, counted from its key presses (the server counts exactly).
  function sampleWindowsNow() { return ksWindowCount(ksKeyCount(sampleSegment().events)); }
  // Ask the server whether the sample, as it is now, would be accepted. Nothing is stored. Asked once per new
  // window, and the answer decides whether the popup shows.
  async function probeSample() {
    var seg = sampleSegment(), w = ksWindowCount(ksKeyCount(seg.events));
    if (sampleProbe.busy || sampleProbe.forWindows === w) return;
    sampleProbe.busy = true; sampleProbe.forWindows = w;
    try {
      var r = await reqJson(EP.ksContribute, "POST", { keystrokeEvents: seg.events, textLength: seg.keys, dryRun: true });
      var d = r.ok && r.d ? r.d : {};
      sampleProbe.eligible = d.eligible === true;
      if (d.error === "adaptive_disabled") ADAPT_ENABLED = false;
      else if (d.error === "adaptive_paused") { var until = Date.parse(d.nextContributionAt); contribUntil = isFinite(until) ? until : Date.now() + ADAPT_GAP_H * 3600000; }
      else if (d.error === "ready_to_retrain") { adaptReady = true; adaptPending = Number(d.pending || ADAPT_RETRAIN_EVERY); }
    } catch (e) { sampleProbe.eligible = false; }
    finally { sampleProbe.busy = false; }
    evalAdaptive();
  }
  // The typing since the previous sample, after a gap of SAMPLE_GAP_KEYS key presses.
  function sampleSegment() {
    var all = ksTracker ? ksTracker.getEvents() : [], start = contribEndIdx;
    if (contribEndIdx > 0) { var seen = 0; while (start < all.length && seen < SAMPLE_GAP_KEYS) { if (all[start].eventType === "keydown") seen++; start++; } }
    var seg = all.slice(start); if (seg.length > SAMPLE_MAX_EVENTS) seg = seg.slice(-SAMPLE_MAX_EVENTS);
    var keys = 0;
    for (var i = 0; i < seg.length; i++) { var k = seg[i].keyCode; if (seg[i].eventType === "keydown" && (k === 32 || (k >= 48 && k <= 90) || (k >= 96 && k <= 111) || (k >= 186 && k <= 222))) keys++; }
    return { events: seg, end: all.length, keys: keys };
  }
  function setLearnMode(mode) {
    if (!learnEl || learnMode === mode) return;
    learnMode = mode;
    var tl = learnEl.querySelector(".lt span:last-child"), m = learnEl.querySelector(".lm"), go = learnEl.querySelector(".go"), bar = learnEl.querySelector(".lp > i");
    if (mode === "retrain") {
      if (tl) tl.textContent = t("Ready to update your model");
      if (m) m.textContent = t("You added {n} samples. Retrain your model now; your passkey confirms it's you.", { n: ADAPT_RETRAIN_EVERY });
      if (go) go.textContent = t("Retrain with passkey");
      if (bar) bar.style.width = "100%";
    } else {
      if (tl) tl.textContent = t("Your typing looks like you");
      if (m) m.textContent = t("Add this clean sample so your model keeps learning your rhythm ({k} of {n} so far).", { k: adaptPending, n: ADAPT_RETRAIN_EVERY });
      if (go) go.textContent = t("Contribute sample");
      if (bar) bar.style.width = Math.min(100, (adaptPending / ADAPT_RETRAIN_EVERY) * 100) + "%";
    }
  }
  async function fetchContribWindow() {
    if (contribFetching) return;
    contribFetching = true;
    try {
      var r = await reqJson(EP.ksStatus);
      if (r.ok && r.d && r.d.adaptiveEnabled === false) ADAPT_ENABLED = false;
      if (r.ok && r.d) { adaptPending = Number(r.d.adaptivePending || 0); adaptReady = !!r.d.adaptiveReady; }
      var t = r.ok && r.d && r.d.nextContributionAt ? Date.parse(r.d.nextContributionAt) : 0;
      contribUntil = isFinite(t) ? t : 0;
    } catch (e) { contribUntil = 0; }
    finally { contribFetching = false; }
  }
  function positionLearn() {
    if (!learnEl || !learnVisible || !activeField) return;
    var r = activeField.getBoundingClientRect();
    var lw = learnEl.offsetWidth || 290, lh = learnEl.offsetHeight || 96;
    var top = r.top - lh - 8; if (top < 8) top = r.bottom + 8; // flip below if no room above
    var left = r.left; if (left + lw > window.innerWidth - 8) left = window.innerWidth - lw - 8; if (left < 8) left = 8;
    learnEl.style.top = top + "px"; learnEl.style.left = left + "px";
  }
  function showLearn() {
    if (!learnEl) return;
    if (!learnVisible) {
      var go = learnEl.querySelector(".go"); if (go) { go.disabled = false; go.textContent = t(learnMode === "retrain" ? "Retrain with passkey" : "Contribute sample"); }
      learnEl.style.display = "block"; learnVisible = true;
    }
    positionLearn();
  }
  function hideLearn() { if (learnEl && learnVisible) { learnEl.style.display = "none"; learnVisible = false; } }
  function dismissLearn() { hideLearn(); lastContributeKeys = currentKeys(); cleanRun = 0; sampleProbe.eligible = false; if (learnMode === "retrain") retrainDismissed = true; }
  async function contributeSample() {
    if (contributing || !ksTracker) return;
    contributing = true;
    var go = learnEl.querySelector(".go"), msg = learnEl.querySelector(".lm"), bar = learnEl.querySelector(".lp > i");
    if (go) { go.disabled = true; go.textContent = t("Adding…"); }
    var seg = sampleSegment();
    try {
      // the segment and how many characters it typed; never the field's text
      var r = await reqJson(EP.ksContribute, "POST", { keystrokeEvents: seg.events, textLength: seg.keys });
      if (r.ok && r.d && r.d.ok !== false) {
        contribEndIdx = seg.end;                      // the next sample starts after this one (plus the gap)
        sampleProbe.forWindows = -1; sampleProbe.eligible = false;
        adaptPending = Number(r.d.pending || adaptPending + 1); adaptReady = !!r.d.ready;
        if (bar) bar.style.width = Math.min(100, (adaptPending / ADAPT_RETRAIN_EVERY) * 100) + "%";
        if (msg) msg.textContent = t(adaptReady ? "Added — {n} of {n}. Your model is ready to retrain." : "Added! {k} of {n}.", { k: adaptPending, n: ADAPT_RETRAIN_EVERY });
        setKb("ok", "learning ✓");
        lastContributeKeys = currentKeys(); cleanRun = 0;
        setTimeout(function () { hideLearn(); if (adaptReady) { learnMode = ""; } }, 2600);
      } else if (r.status === 429 && r.d) {
        var until = Date.parse(r.d.nextContributionAt);
        contribUntil = isFinite(until) ? until : Date.now() + ADAPT_GAP_H * 3600000;
        if (msg) msg.textContent = r.d.message || t("Please add samples again later.");
        lastContributeKeys = currentKeys(); cleanRun = 0;
        setTimeout(hideLearn, 4000);
      } else if (r.status === 409 && r.d && r.d.error === "ready_to_retrain") {
        adaptReady = true; adaptPending = Number(r.d.pending || ADAPT_RETRAIN_EVERY); learnMode = ""; setLearnMode("retrain");
      } else if (r.status === 409 && r.d && r.d.error === "adaptive_disabled") {
        ADAPT_ENABLED = false; hideLearn();
      } else if (msg) { msg.textContent = (r.d && (r.d.message || r.d.error)) || t("Couldn't add this sample."); }
    } catch (e) { if (msg) msg.textContent = t("Offline — try again."); }
    finally { contributing = false; if (go) { go.disabled = false; go.textContent = t(learnMode === "retrain" ? "Retrain with passkey" : "Contribute sample"); } }
  }
  // Retrain with the samples collected: the passkey first, in the same request as the retrain.
  async function retrainWithPasskey() {
    if (contributing) return;
    contributing = true;
    var go = learnEl.querySelector(".go"), msg = learnEl.querySelector(".lm");
    if (go) { go.disabled = true; go.textContent = t("Waiting for passkey…"); }
    try {
      var W = webauthn(), r;
      if (MODE === "gateway") {
        var opt = await reqJson(EP.pkAuthOpts, "POST", {}); if (!opt.ok) throw new Error(opt.d.error || t("Could not start verification"));
        var a = await W.startAuthentication(opt.d);
        r = await reqJson(EP.adaptiveRetrain, "POST", { challengeId: opt.d.challengeId, assertion: a });
      } else {
        var me = await req("/api/auth/me").then(function (x) { return x.json(); });
        var o2 = await reqJson("/api/webauthn/auth/options", "POST", { userId: me.userId }); if (!o2.ok) throw new Error(o2.d.error || t("Could not start verification"));
        var a2 = await W.startAuthentication(o2.d);
        var v = await reqJson("/api/webauthn/auth/complete", "POST", { userId: me.userId, challengeId: o2.d.challengeId, assertion: a2 });
        if (!v.ok) throw new Error(v.d.error || t("Verification failed"));
        r = await reqJson(EP.adaptiveRetrain, "POST", {});
      }
      if (!r.ok || (r.d && r.d.ok === false)) throw new Error((r.d && (r.d.message || r.d.error)) || t("Retrain failed"));
      adaptPending = 0; adaptReady = false; retrainDismissed = false;
      var until = Date.parse(r.d.nextContributionAt);
      contribUntil = isFinite(until) ? until : Date.now() + ADAPT_GAP_H * 3600000;
      if (msg) msg.textContent = t("Retraining your model now. New samples can be added again in {h} h.", { h: ADAPT_GAP_H });
      setKb("ok", "retraining ✓");
      setTimeout(function () { hideLearn(); learnMode = ""; }, 3500);
    } catch (e) {
      var name = e && e.name;
      if (msg) msg.textContent = name === "NotAllowedError" ? t("The passkey prompt was closed. Try again when you're ready.") : ((e && e.message) || t("Retrain failed."));
    } finally { contributing = false; if (go) { go.disabled = false; go.textContent = t("Retrain with passkey"); } }
  }


  // Enable/disable keystroke monitoring at runtime (panel toggle + persisted),
  // mirroring the mouse toggle. When on, a single delegated input listener covers
  // EVERY text field on the page; when off, the listener is removed entirely.
  function updateKsToggle() { if (ksToggleEl) { ksToggleEl.className = "tgl" + (ksOn ? " on" : ""); ksToggleEl.textContent = ksOn ? "on" : "off"; ksToggleEl.setAttribute("aria-checked", String(ksOn)); } }
  function setKeystroke(on) {
    ksOn = !!on;
    try { localStorage.setItem(LS_KEYSTROKE, ksOn ? "1" : "0"); } catch (e) {}
    if (ksOn) startKeystroke(); else stopKeystroke();
    updateKsToggle();
  }
  function startKeystroke() {
    if (!window.continuumKeystrokes) return;
    if (!ksTracker) ksTracker = window.continuumKeystrokes.createTracker(document.documentElement, { skip: fieldExcluded });
    if (!ksInputHandler) { ksInputHandler = onKsInput; document.addEventListener("input", ksInputHandler, true); }
    if (!ksPasteHandler) { ksPasteHandler = onKsPaste; document.addEventListener("paste", ksPasteHandler, true); document.addEventListener("drop", ksPasteHandler, true); }
    if (ksBuilding) setKb("mut", "building your model…"); else setKb("col", "type {n} characters to start", { vars: { n: KS_MIN_CHARS }, prog: 0 });
  }
  // Typing enrolment trains on the server's queue (about a minute; since 2026-10-06). Meanwhile the user
  // carries on and the typing row says so; a reload picks the state up again from the server
  // (onboarding.keystrokeTraining / status.training). Checks start by themselves once the model exists.
  function watchKsBuild() {
    ksBuilding = true;
    setKb("mut", "building your model…");
    if (ksBuildTimer) return;
    ksBuildTimer = setInterval(async function () {
      var st = null;
      try { st = (await reqJson(EP.ksStatus)).d; } catch (e) {}
      if (!st || st.training) return;
      clearInterval(ksBuildTimer); ksBuildTimer = null; ksBuilding = false;
      if (st.trained) { if (obState) obState.keystroke = true; setKb("mut", ksOn ? "ready — type {n} characters to start" : "off", { vars: { n: KS_MIN_CHARS } }); }
      else setKb("bad", st.trainingError ? "model not built — add one more sample" : "not enrolled — add samples");
    }, 8000);
  }
  function stopKeystroke() {
    if (ksInputHandler) { document.removeEventListener("input", ksInputHandler, true); ksInputHandler = null; }
    if (ksPasteHandler) { document.removeEventListener("paste", ksPasteHandler, true); document.removeEventListener("drop", ksPasteHandler, true); ksPasteHandler = null; }
    checkInFlight = false; ksMissedWindow = false; ksPastePending = false; lastCheckedWindowCount = 0;
    cleanRun = 0; hideLearn();
    setKb("mut", "off");
  }

  // Toggle handlers with the LAZY onboarding strategy: turning an unenrolled
  // modality ON first runs that single enrollment step (dismissable ×), then
  // starts monitoring. A keystroke-only user simply never enables mouse.
  var lazyEnrolling = false;
  async function toggleKeystrokeCtl() {
    if (!ksOn && ONBOARD_MODE === "lazy" && obState && !obState.keystroke) {
      if (lazyEnrolling) return;
      lazyEnrolling = true;
      try {
        var done = await wizKeystroke(true);
        if (done === false) return; // dismissed — leave the toggle off
        closeWiz(); obState.keystroke = true; setKeystroke(true);
      } finally { lazyEnrolling = false; }
      return;
    }
    setKeystroke(!ksOn);
  }
  async function toggleMouseCtl() {
    if (!mouseOn && ONBOARD_MODE === "lazy" && obState && !obState.mouse) {
      if (lazyEnrolling) return;
      lazyEnrolling = true;
      try {
        var done = await wizMouse(true);
        if (done === false) return; // dismissed — leave the toggle off
        closeWiz(); obState.mouse = true; setMouse(true);
      } finally { lazyEnrolling = false; }
      return;
    }
    setMouse(!mouseOn);
  }

  var mouseTracker = null, mouseOn = false, mouseTimer = null, lastMouseEvents = 0;
  function updateToggle() { if (toggleEl) { toggleEl.className = "tgl" + (mouseOn ? " on" : ""); toggleEl.textContent = mouseOn ? "on" : "off"; toggleEl.setAttribute("aria-checked", String(mouseOn)); } }
  function setMouse(on) { mouseOn = !!on; try { localStorage.setItem(LS_MOUSE, mouseOn ? "1" : "0"); } catch (e) {} if (mouseOn) { startMouse(); setMouseRow("col", "warming up…", { prog: 0 }); } else { stopMouse(); abortUseSample(); setMouseRow("mut", "off"); } updateToggle(); }
  function startMouse() { stopMouse(); if (mouseTracker) mouseTracker.reset(); lastMouseEvents = 0; mouseTimer = setInterval(mouseTick, MOUSE_CHECK_MS); }
  function stopMouse() { if (mouseTimer) clearInterval(mouseTimer); mouseTimer = null; }
  async function mouseTick() {
    if (locked || signedOut || !mouseTracker) return;
    var count = mouseTracker.eventCount(); if (count <= lastMouseEvents) return; lastMouseEvents = count;
    var windows; try { windows = window.mouseFeatures.stepsToWindows(window.mouseFeatures.eventsToSteps(mouseTracker.getEvents())); } catch (e) { return; }
    if (!windows || windows.length < MOUSE_MIN_WINDOWS) {
      var wn = windows ? windows.length : 0;
      setMouseRow("col", "warming {n}/{m}", { vars: { n: wn, m: MOUSE_MIN_WINDOWS }, pct: lastMousePct, prog: wn / MOUSE_MIN_WINDOWS }); return;
    }
    pulse();
    try {
      // Send at least MOUSE_MIN_WINDOWS: the server's sustained vote needs a full buffer, and
      // sending fewer (this was 18, sized for the old packet rule) leaves it in warmup forever
      // — mouse would silently never challenge.
      var r = await reqJson(EP.mouseCheck, "POST", { windows: windows.slice(-MOUSE_MIN_WINDOWS) });
      if (r.status === 401 && MODE === "demo") { sessionEnded(); return; }
      var d = r.d; if (d && d.riskToken) latestRiskToken = d.riskToken;
      if (d && d.bufferMax) MOUSE_MIN_WINDOWS = d.bufferMax;   // the server's vote length is authoritative
      if (d && d.enrolled === false) { setMouseRow("mut", "not enrolled"); stopMouse(); mouseOn = false; updateToggle(); return; }
      if (maybeChallenge(d, "mouse", onProbation)) { setMouseRow("bad", "mouse mismatch"); return; }
      if (d.checked === false) { setMouseRow("mut", "move to check", { pct: lastMousePct, keep: true }); return; }
      var pct = d.meanScore != null ? Math.round(d.meanScore * 100) : null;
      if (pct != null) lastMousePct = pct;   // shown during transient states, same as keystroke
      if (d.isSuspicious) setMouseRow("warn", "suspicious {n}/{m}", { vars: { n: d.suspiciousStreak || 1, m: d.strikesToLock || 1 }, prog: (d.suspiciousStreak || 1) / (d.strikesToLock || 1) });
      else if (d.warmup) { setMouseRow("col", "warming {n}/{m}", { vars: { n: d.windowCount || 0, m: d.bufferMax || MOUSE_MIN_WINDOWS }, pct: lastMousePct, prog: (d.windowCount || 0) / (d.bufferMax || MOUSE_MIN_WINDOWS) }); }
      else {
        onProbation = false;
        // Same reading the extension panel shows: how much of the sustained buffer is low,
        // against the count that triggers the step-up. That is the number which actually
        // predicts a challenge; a per-window mean does not.
        // The ring: what is left before the lock (full with no low window, empty at the lock).
        if (d.lowWindows != null && d.bufferMax) setMouseRow("ok", "{low}/{max} low · locks at {lock}", { vars: { low: d.lowWindows, max: d.bufferMax, lock: d.lockAt }, prog: d.lockAt ? 1 - d.lowWindows / d.lockAt : 1 });
        else setMouseRow("ok", "watching", { pct: pct, prog: pct != null ? pct / 100 : 1 });
      }
    } catch (e) { setMouseRow("mut", "offline"); }
  }

  async function loadConfig() {
    try { var r = await reqJson(EP.config); if (!r.ok) return; var c = r.d;
      if (c.windowSize) WINDOW_SIZE = c.windowSize; if (c.windowStride) WINDOW_STRIDE = c.windowStride;
      if (c.recentWindowCount) RECENT_WINDOW_COUNT = c.recentWindowCount; if (c.sampleWindowCount) SAMPLE_WINDOWS = c.sampleWindowCount; if (c.checkMinTextChars) KS_MIN_CHARS = c.checkMinTextChars;
      if (c.adaptiveConfidenceMin != null) ADAPT_CONFIDENCE_MIN = c.adaptiveConfidenceMin;
      if (c.adaptiveRetrainEvery != null) ADAPT_RETRAIN_EVERY = c.adaptiveRetrainEvery;
      if (Array.isArray(c.excludeFieldTypes)) EXCLUDE_TYPES = c.excludeFieldTypes.map(function (x) { return String(x).toLowerCase(); });
      // A setting chosen in the organisation's console or on the operator page ("managed") overrides
      // the page's own attribute; a deployment default only fills in what the page left unset.
      var managed = Array.isArray(c.managed) ? c.managed : [];
      var wins = function (k) { return managed.indexOf(k) >= 0 || !PAGE_SET[k]; };
      if ((c.panel === "show" || c.panel === "hide") && wins("panel")) PANEL = c.panel;
      if ((c.keystroke === "on" || c.keystroke === "off") && wins("keystroke")) cfg.keystroke = c.keystroke;
      if ((c.mouse === "on" || c.mouse === "off") && wins("mouse")) cfg.mouse = c.mouse === "off" ? "off" : "optional";
      if (PANEL === "hide" && cfg.mouse === "optional") cfg.mouse = "on";   // no panel, no switch: on means on
      if (c.onboardingMode && wins("onboarding")) ONBOARD_MODE = c.onboardingMode;
      if (PANEL === "hide" && ONBOARD_MODE === "lazy") ONBOARD_MODE = "eager"; // "enrol when you switch it on" needs the switch
      if (c.adaptiveEnabled != null) ADAPT_ENABLED = !!c.adaptiveEnabled;
      if (c.adaptiveMinGapHours != null && isFinite(Number(c.adaptiveMinGapHours))) ADAPT_GAP_H = Number(c.adaptiveMinGapHours);
      if (["auto", "en", "ar"].indexOf(c.panelLanguage) >= 0 && wins("panelLanguage")) LANG_PREF = c.panelLanguage;
      if (["auto", "light", "dark"].indexOf(c.panelTheme) >= 0 && wins("panelTheme")) THEME_PREF = c.panelTheme;
      applyPanel();
      await relook();
    } catch (e) {}
  }

  // Show the panel and its controls as the settings allow.
  function applyPanel() {
    if (!panelEl) return;
    panelEl.style.display = PANEL === "hide" ? "none" : "";
    var ksOff = cfg.keystroke === "off", msOff = cfg.mouse === "off";
    if (ksAddEl) ksAddEl.style.display = ksOff ? "none" : "";
    if (ksToggleEl) ksToggleEl.style.display = ksOff ? "none" : "";
    if (msAddEl) msAddEl.style.display = msOff ? "none" : "";
    if (toggleEl) toggleEl.style.display = cfg.mouse === "optional" ? "" : "none";
    if (ksOff) setKb("mut", "off for this site");
    if (msOff) setMouseRow("mut", "off for this site");
  }

  function startGuard() {
    if (cfg.keystroke !== "off" && window.continuumKeystrokes) {
      if (ONBOARD_MODE === "lazy" && obState && !obState.keystroke) {
        // Lazy: unenrolled modality starts OFF; the toggle runs enrollment on demand.
        setKeystroke(false); setKb("mut", "off — enable to enroll");
      } else {
        // Default ON; respect the user's persisted toggle choice across reloads.
        var ksPref = null; try { ksPref = localStorage.getItem(LS_KEYSTROKE); } catch (e) {}
        // Without the panel the user has no switch, so an earlier "off" no longer applies.
        setKeystroke(PANEL === "hide" || ksPref === null ? true : ksPref === "1");
      }
    }
    if (cfg.mouse !== "off" && window.mouseFeatures) {
      mouseTracker = window.mouseFeatures.createMouseTracker(document.documentElement);
      if (ONBOARD_MODE === "lazy" && obState && !obState.mouse) {
        setMouse(false); setMouseRow("mut", "off — enable to enroll");
      } else {
        var want; if (cfg.mouse === "on") want = true; else { var s = null; try { s = localStorage.getItem(LS_MOUSE); } catch (e) {} want = s === null ? true : s === "1"; }
        setMouse(want);
      }
    }
    started = true; ready = true; readyCbs.forEach(function (cb) { try { cb(); } catch (e) {} }); readyCbs = [];
  }

  // Tear the guard down (used when re-identifying as a different user).
  function stopGuard() {
    stopKeystroke();
    stopMouse();
    abortUseSample();
    if (ksTracker) ksTracker.reset(); contribEndIdx = 0; sampleProbe.forWindows = -1; sampleProbe.eligible = false; if (mouseTracker) mouseTracker.reset();
    checkInFlight = false; locked = false; ready = false; lastKsPct = null; lastMousePct = null;
  }

  // ---------- bootstrap (gateway mode) ----------
  async function bootstrapGateway() {
    if (cfg.session) {
      sessionToken = cfg.session;
      try { userId = JSON.parse(atob(sessionToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub; } catch (e) {}
      var o = await reqJson(EP.onboarding);
      if (!o.ok) throw new Error(o.d.error || "session failed");
      return o.d;
    }
    var body = { siteKey: cfg.siteKey };
    if (identityToken) body.identityToken = identityToken; // backend-vouched, account-bound
    else { var ext = cfg.externalId; if (!ext) { try { ext = localStorage.getItem(LS_EXT); } catch (e) {} } body.externalId = ext || ""; }
    var r = await reqJson("/v1/sdk/session", "POST", body);
    if (!r.ok) throw new Error(r.d.error || "session failed");
    sessionToken = r.d.token; userId = r.d.userId;
    if (!cfg.onboarding && r.d.onboardingMode) ONBOARD_MODE = r.d.onboardingMode; // set before the onboarding decision (loadConfig refines it)
    if (!identityToken) { try { localStorage.setItem(LS_EXT, r.d.externalId); } catch (e) {} } // persist only the anon id
    return r.d.onboarding;
  }

  function needOnboarding(ob) {
    if (!ob.passkey) return true;
    if (ONBOARD_MODE === "lazy") return false; // modalities enroll on toggle
    return (cfg.keystroke !== "off" && !ob.keystroke && !ob.keystrokeTraining) || (cfg.mouse !== "off" && !ob.mouse);
  }

  // A misused site key — unknown to this gateway, or loaded from a domain it isn't
  // registered for (i.e. another app reusing the same key) — must NOT run the guard.
  // Remove the panel and show a visible warning popup so the integrator sees the
  // problem instead of the guard silently doing nothing.
  function guardBlocked(message) {
    try { var host = document.getElementById("continuum-guard-host"); if (host) host.remove(); } catch (e) {}
    console.error("[continuum] guard not started — " + message);
    try {
      if (document.getElementById("continuum-guard-warning")) return;
      var w = document.createElement("div");
      w.id = "continuum-guard-warning";
      w.dir = LANG === "ar" ? "rtl" : "ltr";
      w.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;background:linear-gradient(135deg,#991b1b,#7f1d1d);color:#fff;border:1px solid #fca5a5;border-radius:16px;padding:14px 16px;font:600 13px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Tahoma,sans-serif;box-shadow:0 18px 40px -12px rgba(127,29,29,.7)";
      w.innerHTML = "<div style=\"display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:5px;font-size:14px\"><span></span><span id=\"cgwx\" style=\"cursor:pointer;opacity:.8\">✕</span></div><div style=\"font-weight:400;opacity:.95\"></div>";
      w.firstChild.firstChild.textContent = "⚠ " + t("Continuum guard not active");
      w.lastChild.textContent = message;
      if (w.animate && !reduceMotion) w.animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 400, easing: "ease-out" });
      (document.documentElement || document.body).appendChild(w);
      var x = w.querySelector("#cgwx"); if (x) x.addEventListener("click", function () { w.remove(); });
    } catch (e) {}
  }

  async function gatewayFlow() {
    var lockedAtLoad = false;
    try {
      var ob = await bootstrapGateway();
      // A pending step-up survives page loads only on the server (this lock is
      // in-memory and just reset above) — a host app has no gate of its own to
      // enforce this like apps/demo does, so the SDK is the only place any page,
      // in any app, can catch a reload/navigation during a locked session. It puts the passkey prompt back. Signing
      // the user out would not help: the lock outlives the sign-in, so they would return here locked, again and again,
      // with no way to reach the passkey. If this cannot be read, the server still answers 423 to every check.
      var ls = await reqJson(EP.lockStatus);
      lockedAtLoad = !!(ls.ok && ls.d && ls.d.locked);
      await loadConfig(); // now authed
      obState = ob;
      if (ob && ob.keystrokeTraining && !ob.keystroke) watchKsBuild();
      // Locked: the passkey before anything else, then any missing enrolment (the server refuses enrolment on a
      // locked account too). Otherwise the person the lock is about could enrol their own typing or mouse for the owner.
      if (lockedAtLoad) { promptLockedAtLoad(ob); return; }
      if (needOnboarding(ob)) await runOnboarding(ob);
    } catch (e) {
      var reason = e && e.message;
      if (reason === "invalid_site_key")
        return guardBlocked(t("Invalid site key “{key}” — it isn't registered on this gateway.", { key: cfg.siteKey }));
      if (reason === "origin_not_allowed")
        return guardBlocked(t("This site key is already in use for another domain — it is not authorized for {origin}.", { origin: location.origin }));
      console.warn("[continuum] bootstrap failed:", reason); setKb("bad", "offline"); return;
    }
    startGuard();
  }

  // A page opened on a locked account: the passkey prompt first; once it is verified, the missing enrolment and the
  // guard, as on any other load.
  function promptLockedAtLoad(ob) {
    locked = true; setKb("bad", "locked — verify");
    stepUpOnSuccess = async function () {
      try { if (needOnboarding(ob)) await runOnboarding(ob); } catch (e) { console.warn("[continuum] onboarding:", e && e.message); }
      startGuard();
    };
    showModal();
    // The page may wait for onReady to ask for this step-up with callbacks of its own (connect.html and study.html,
    // the extension's verify pages): it gets onReady now, so one verification serves both. Held back until after the
    // passkey, those pages asked for a second one and the extension never heard of the first (2026-11-10).
    ready = true; var cbs = readyCbs; readyCbs = []; cbs.forEach(function (cb) { try { cb(); } catch (e) {} });
  }

  // Public: the host app vouches for its logged-in user with a backend-signed token.
  // Safe to call before or after load; re-establishes the session as that user.
  async function identify(token) {
    identityToken = token || null;
    if (MODE !== "gateway") return;
    if (started) { stopGuard(); closeWiz(); hideModal(); }
    await gatewayFlow();
  }

  async function init() {
    // Always expose the API FIRST, so a Save button's consumer code (attach the
    // risk header, then run its normal action) works regardless. The SDK never
    // intercepts the button — the app's own handler still fires.
    window.Continuum = {
      getRiskToken: function () { return latestRiskToken; },
      riskHeader: function () { return latestRiskToken ? { "X-Continuum-Risk": latestRiskToken } : {}; },
      isLocked: function () { return locked; },
      userId: function () { return userId; },
      identify: identify,
      onReady: function (cb) { if (ready) cb(); else readyCbs.push(cb); },
      // Trigger the ONE passkey step-up modal from anywhere (e.g. a page that runs
      // its own keystroke check). modality ("keystroke"|"mouse") sets the reason;
      // onSuccess fires after a verified passkey. Keeps all passkey UI inside the SDK.
      // onFail (optional) fires on each failed verification attempt, with the error message; the
      // modal stays open for another try (the user-study page reports these as `failed`).
      // Already locked (the SDK's own check got there first): the page's callbacks are kept all the same, so its own
      // state is released by the verification too (the demo's lab page stayed blocked for good without this).
      requireStepUp: function (modality, onSuccess, onFail) {
        if (locked) { stepUpOnSuccess = chain(stepUpOnSuccess, onSuccess); stepUpOnFail = chain(stepUpOnFail, onFail); return; }
        locked = true; stepUpOnSuccess = onSuccess || null; stepUpOnFail = onFail || null; showModal(modality || "keystroke");
      },
      // No contribute(): adaptive samples come only from the popup the user answers (removed 2026-10-05;
      // it let a page's own Save add samples silently).
    };
    // Show the fixed "Continuum GUARD" panel on every page the SDK is on (bottom-right).
    buildUI();
    await loadConfig();
    if (MODE === "gateway") {
      // Zero-frontend-code identity: fetch the signed identity from the app's own
      // same-origin endpoint (its session cookie is sent automatically). If the
      // user isn't logged in it 401s and we fall back to defer/anonymous.
      if (cfg.identityUrl && !identityToken) {
        try {
          var t = await fetch(cfg.identityUrl, { credentials: "include" }).then(function (r) { return r.ok ? r.json() : null; });
          if (t && t.token) identityToken = t.token;
        } catch (e) {}
      }
      if (cfg.defer && !identityToken) { setKb("mut", "waiting for sign-in"); setMouseRow("mut", "waiting for sign-in"); return; }
      await gatewayFlow(); return;
    }
    // Demo mode (same-origin): run the SAME onboarding popup as gateway mode when the
    // logged-in user isn't fully enrolled — so the app needs no enrollment pages.
    try {
      var ob = await fetchOnboardingDemo();
      obState = ob;
      if (ob.keystrokeTraining && !ob.keystroke) watchKsBuild();
      if (needOnboarding(ob)) await runOnboarding(ob);
    } catch (e) { console.warn("[continuum] onboarding:", e.message); }
    startGuard();
  }

  function boot() { ensureDeps().then(function () { if (document.body) init(); else document.addEventListener("DOMContentLoaded", init); }).catch(function (e) { console.warn("[continuum-guard]", e.message); }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
