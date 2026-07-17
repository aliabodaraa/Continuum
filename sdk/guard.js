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
    defer: (script && script.getAttribute("data-defer")) === "1", // wait for identify()
    keystroke: (script && script.getAttribute("data-keystroke")) || "on",
    mouse: (script && script.getAttribute("data-mouse")) || "optional",
    // Onboarding strategy: "eager" (enroll everything missing at load) or "lazy"
    // (passkey only at load; a modality enrolls when its toggle is turned on).
    // Page attr wins; otherwise the server's deployment config (docker env) applies.
    onboarding: (script && script.getAttribute("data-onboarding")) || "",
    // The × in mandatory popups signs the user out via these (same-origin; a
    // consumer overrides with data-logout-url / data-login-url).
    logoutUrl: (script && script.getAttribute("data-logout-url")) || "/api/auth/logout",
    loginUrl: (script && script.getAttribute("data-login-url")) || "/login.html",
  };
  var MODE = cfg.siteKey ? "gateway" : "demo";
  var LS_MOUSE = "continuumGuardMouse";
  var LS_KEYSTROKE = "continuumGuardKeystroke";
  var LS_EXT = "continuumExternalId";
  var LS_POS = "continuumGuardPos";
  var LS_COLLAPSE = "continuumGuardCollapsed";

  // window math (overwritten from config)
  var WINDOW_SIZE = 50, WINDOW_STRIDE = 10, RECENT_WINDOW_COUNT = 6, KS_MIN_CHARS = 80;
  var MOUSE_CHECK_MS = 1600, MOUSE_MIN_WINDOWS = 6, MOUSE_ENROLL_TARGET = 160;
  // The mouse feature vector includes is_click, so enrollment needs real clicks —
  // not just movement — or the model never learns the user's click dynamics.
  var MOUSE_ENROLL_CLICKS = 10;
  // Adaptive learning: after this many consecutive clean (genuine, high-confidence)
  // checks — the SDK analogue of the demo's "3 clean packets" — offer to add the run
  // to the user's training set. The CA retrains every N contributions (val-gated).
  var ADAPT_CONFIDENCE_MIN = 0.9, ADAPT_CLEAN_RUN = 3, ADAPT_RETRAIN_EVERY = 3;
  // Field types NOT monitored (deployment config MONITOR_EXCLUDE_TYPES). Everything
  // else — including password — is monitored (see currentTypedText).
  var EXCLUDE_TYPES = ["hidden"];

  var sessionToken = null, userId = null, latestRiskToken = null, locked = false, ready = false;
  var identityToken = cfg.identity || null, started = false, ksInputHandler = null;
  var readyCbs = [];
  var ONBOARD_MODE = cfg.onboarding || "eager"; // may be overridden by server config
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
    pkRegOpts: "/v1/sdk/passkey/register/options", pkRegDone: "/v1/sdk/passkey/register/complete",
    pkAuthOpts: "/v1/sdk/passkey/auth/options", pkAuthDone: "/v1/sdk/passkey/auth/complete",
  } : {
    config: "/api/text/config", ksStatus: "/api/text/typing-status", ksEnroll: "/api/text/enroll", ksCheck: "/api/text/check", ksContribute: "/api/text/contribute",
    mouseEnroll: "/api/mouse/enroll", mouseCheck: "/api/mouse/check", mouseStatus: "/api/mouse/status",
  };

  // ---------- dependency loader ----------
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement("script"); s.src = src; s.async = true; s.onload = res; s.onerror = function () { rej(new Error("load " + src)); }; document.head.appendChild(s); }); }
  function ensureDeps() {
    var j = [];
    if (!window.continuumKeystrokes) j.push(loadScript(url("/js/keystroke-tracker.js")));
    if (!window.mouseFeatures) j.push(loadScript(url("/js/mouse-features.js")));
    if (!window.SimpleWebAuthnBrowser) j.push(loadScript(url("/vendor/simplewebauthn/index.umd.min.js")));
    return Promise.all(j);
  }

  // ---------- Shadow-DOM UI ----------
  var shadow, dotEl, kbEl, ksToggleEl, mouseEl, toggleEl, modalEl, modalErrEl, modalBtnEl, wizEl, learnEl;
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }

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
    var st = el("style");
    st.textContent =
      ".panel{width:236px;background:#0f172a;color:#e2e8f0;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px 14px;font:500 12.5px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35)}" +
      ".hd{display:flex;align-items:center;gap:8px;font-weight:800;margin-bottom:9px;cursor:move;user-select:none}" +
      ".cx{margin-left:6px;cursor:pointer;background:transparent;border:0;color:#94a3b8;font:800 15px/1 system-ui;width:20px;height:20px;border-radius:5px;padding:0}.cx:hover{background:rgba(255,255,255,.12);color:#fff}" +
      ".panel.collapsed{width:auto}.panel.collapsed .hd{margin-bottom:0}.panel.collapsed .pbody{display:none}" +
      ".dot{width:9px;height:9px;border-radius:50%;background:#22c55e;transition:transform .15s}.dot.pulse{transform:scale(1.7);box-shadow:0 0 0 4px rgba(56,189,248,.35)}" +
      ".hd .tag{font-size:9px;font-weight:700;color:#7dd3fc;border:1px solid rgba(125,211,252,.4);border-radius:999px;padding:1px 6px;margin-left:auto}" +
      ".row{display:flex;align-items:center;gap:8px;padding:5px 0}.row .ic{width:16px;text-align:center}.row .st{flex:1;color:#cbd5e1}.row .st b{color:#fff}" +
      ".ok{color:#86efac!important}.warn{color:#fcd34d!important}.bad{color:#fca5a5!important}.mut{color:#64748b!important}" +
      ".tgl{cursor:pointer;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.06);color:#cbd5e1;border-radius:7px;padding:3px 8px;font:700 10px system-ui}.tgl.on{background:rgba(34,197,94,.18);border-color:rgba(34,197,94,.5);color:#86efac}" +
      ".tgl.add{color:#7dd3fc;border-color:rgba(125,211,252,.35)}.tgl.add:hover{background:rgba(125,211,252,.12)}" +
      ".ov{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(15,23,42,.65);backdrop-filter:blur(4px)}" +
      ".card{position:relative;background:#fff;border-radius:16px;padding:26px 30px;max-width:480px;width:92%;font-family:system-ui;box-shadow:0 24px 60px rgba(0,0,0,.4)}" +
      ".wizx{position:absolute;top:10px;right:12px;width:28px;height:28px;border:0;background:transparent;color:#94a3b8;font:400 22px/1 system-ui;cursor:pointer;border-radius:7px}.wizx:hover{background:#f1f5f9;color:#0f172a}" +
      ".wizload{position:absolute;inset:0;border-radius:16px;background:rgba(255,255,255,.82);display:none;align-items:center;justify-content:center;gap:10px;font-weight:800;color:#4f46e5;z-index:2}.wizload.on{display:flex}" +
      ".wizspin{width:20px;height:20px;border:3px solid #c7d2fe;border-top-color:#4f46e5;border-radius:50%;animation:cspin .7s linear infinite}@keyframes cspin{to{transform:rotate(360deg)}}" +
      ".samplecount{font-size:12px;font-weight:700;color:#475569;margin-bottom:8px}.samplecount b{color:#4f46e5}" +
      ".brand{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800;color:#4f46e5;letter-spacing:.4px;margin-bottom:12px}" +
      ".brand .b2{width:16px;height:16px;border-radius:5px;background:linear-gradient(135deg,#6366f1,#22d3ee)}" +
      ".t{font-size:19px;font-weight:800;color:#0f172a;margin-bottom:6px}.d{font-size:13.5px;color:#475569;line-height:1.6;margin-bottom:16px}" +
      ".b{width:100%;background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:12px;font:700 15px system-ui;cursor:pointer}.b:disabled{opacity:.55;cursor:default}" +
      ".e{display:none;color:#dc2626;font-size:12px;margin-top:10px}" +
      ".passage{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;font-size:13px;color:#334155;line-height:1.6;margin-bottom:10px;user-select:none}" +
      ".ta{width:100%;min-height:96px;border:1px solid #cbd5e1;border-radius:10px;padding:11px;font:inherit;resize:none}" +
      ".pad{position:relative;overflow:hidden;height:260px;border:2px dashed #c7d2fe;border-radius:12px;background:#eef2ff;display:flex;align-items:center;justify-content:center;color:#6366f1;font-weight:700;margin-bottom:12px;text-align:center}" +
      ".pt{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;background:#4f46e5;box-shadow:0 0 0 6px rgba(79,70,229,.18);cursor:pointer;animation:cptpulse 1s ease-in-out infinite}@keyframes cptpulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}" +
      ".bar{height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;margin:10px 0}.bar>i{display:block;height:100%;background:#4f46e5;width:0}" +
      ".steps{display:flex;gap:6px;margin-bottom:14px}.steps .s{flex:1;height:5px;border-radius:999px;background:#e2e8f0}.steps .s.on{background:#4f46e5}.steps .s.done{background:#22c55e}" +
      // Floating "adaptive learning" prompt — positioned above the active text field.
      ".learn{position:fixed;z-index:2147483646;width:290px;max-width:calc(100vw - 16px);background:#052e2b;border:1px solid rgba(34,197,94,.5);border-radius:12px;padding:11px 13px;font:500 12.5px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#d1fae5;box-shadow:0 12px 34px rgba(0,0,0,.4);display:none}" +
      ".learn .lt{font-weight:800;color:#86efac;margin-bottom:3px;display:flex;align-items:center;gap:6px}" +
      ".learn .lm{color:#a7f3d0;font-size:12px}" +
      ".learn .lp{height:5px;background:rgba(255,255,255,.12);border-radius:999px;margin-top:9px;overflow:hidden}.learn .lp>i{display:block;height:100%;width:0;background:#22c55e;transition:width .3s}" +
      ".learn .lb{display:flex;gap:8px;margin-top:10px}" +
      ".learn button{border:0;border-radius:8px;padding:6px 12px;font:800 11px system-ui;cursor:pointer}" +
      ".learn .go{background:#22c55e;color:#052e2b}.learn .go:disabled{opacity:.6;cursor:default}" +
      ".learn .gh{background:transparent;color:#86efac;border:1px solid rgba(134,239,172,.4)}";
    shadow.appendChild(st);

    var panel = el("div", "panel");
    var hd = el("div", "hd"); dotEl = el("span", "dot");
    hd.appendChild(dotEl); hd.appendChild(el("span", null, "Continuum")); hd.appendChild(el("span", "tag", "GUARD"));
    var cx = el("button", "cx", "–"); cx.title = "Collapse"; hd.appendChild(cx);
    panel.appendChild(hd);
    var pbody = el("div", "pbody");
    var kr = el("div", "row"); kr.appendChild(el("span", "ic", "⌨")); kbEl = el("span", "st mut", "keystroke: idle"); kr.appendChild(kbEl);
    if (cfg.keystroke !== "off") {
      var ksAdd = el("button", "tgl add", "+ train"); ksAdd.title = "Add typing samples"; ksAdd.addEventListener("click", reinforceKeystroke); kr.appendChild(ksAdd);
      ksToggleEl = el("button", "tgl", "off"); ksToggleEl.addEventListener("click", toggleKeystrokeCtl); kr.appendChild(ksToggleEl);
    }
    pbody.appendChild(kr);
    var mr = el("div", "row"); mr.appendChild(el("span", "ic", "🖱")); mouseEl = el("span", "st mut", "mouse: off"); mr.appendChild(mouseEl);
    var msAdd = el("button", "tgl add", "+ train"); msAdd.title = "Add mouse samples"; msAdd.addEventListener("click", reinforceMouse); mr.appendChild(msAdd);
    if (cfg.mouse === "optional") { toggleEl = el("button", "tgl", "off"); toggleEl.addEventListener("click", toggleMouseCtl); mr.appendChild(toggleEl); }
    pbody.appendChild(mr);
    panel.appendChild(pbody); shadow.appendChild(panel);

    // ---- collapse / expand (persisted) ----
    var collapsed = false; try { collapsed = localStorage.getItem(LS_COLLAPSE) === "1"; } catch (e) {}
    function applyCollapse() { panel.classList[collapsed ? "add" : "remove"]("collapsed"); cx.textContent = collapsed ? "+" : "–"; cx.title = collapsed ? "Expand" : "Collapse"; }
    cx.addEventListener("click", function (e) { e.stopPropagation(); collapsed = !collapsed; try { localStorage.setItem(LS_COLLAPSE, collapsed ? "1" : "0"); } catch (e2) {} applyCollapse(); });
    applyCollapse();

    // ---- drag by the header (persisted) ----
    try { var sp = JSON.parse(localStorage.getItem(LS_POS) || "null"); if (sp && sp.left != null) { host.style.left = sp.left + "px"; host.style.top = sp.top + "px"; host.style.right = "auto"; host.style.bottom = "auto"; } } catch (e) {}
    var dragging = false, ox = 0, oy = 0, sx = 0, sy = 0;
    hd.addEventListener("mousedown", function (e) {
      if (e.target === cx) return;
      var r = host.getBoundingClientRect(); ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      host.style.right = "auto"; host.style.bottom = "auto"; host.style.left = ox + "px"; host.style.top = oy + "px";
      dragging = true; e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var nl = Math.max(4, Math.min(window.innerWidth - 44, ox + (e.clientX - sx)));
      var nt = Math.max(4, Math.min(window.innerHeight - 24, oy + (e.clientY - sy)));
      host.style.left = nl + "px"; host.style.top = nt + "px";
    });
    window.addEventListener("mouseup", function () {
      if (!dragging) return; dragging = false;
      try { var r = host.getBoundingClientRect(); localStorage.setItem(LS_POS, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) })); } catch (e) {}
    });

    modalEl = el("div", "ov");
    modalEl.innerHTML = '<div class="card"><button class="wizx" title="Sign out">×</button><div class="brand"><span class="b2"></span>CONTINUUM</div><div class="t">Identity check required</div><div class="d">Your recent activity no longer matches your profile. Verify with your passkey to continue.</div><button class="b">Verify with passkey</button><div class="e"></div></div>';
    modalBtnEl = modalEl.querySelector(".b"); modalErrEl = modalEl.querySelector(".e");
    modalEl.querySelector(".wizx").addEventListener("click", doLogout);
    modalBtnEl.addEventListener("click", stepUp); shadow.appendChild(modalEl);

    wizEl = el("div", "ov"); shadow.appendChild(wizEl); // onboarding wizard overlay

    // Floating adaptive-learning prompt (positioned above the active text field).
    learnEl = el("div", "learn");
    learnEl.innerHTML = '<div class="lt"><span>↻</span><span>Your typing looks like you</span></div>' +
      '<div class="lm">Add this clean sample so your model keeps learning your rhythm.</div>' +
      '<div class="lp"><i></i></div>' +
      '<div class="lb"><button class="go">Contribute sample</button><button class="gh">Not now</button></div>';
    learnEl.querySelector(".go").addEventListener("click", contributeSample);
    learnEl.querySelector(".gh").addEventListener("click", function () { dismissLearn(); });
    shadow.appendChild(learnEl);
    // Keep the prompt glued to the field as the page scrolls/resizes.
    window.addEventListener("scroll", positionLearn, true);
    window.addEventListener("resize", positionLearn);
  }

  function pulse() { if (dotEl) { dotEl.classList.add("pulse"); setTimeout(function () { dotEl.classList.remove("pulse"); }, 220); } }
  function setKb(c, h) { if (kbEl) { kbEl.className = "st " + c; kbEl.innerHTML = "keystroke: " + h; } }
  function setMouseRow(c, h) { if (mouseEl) { mouseEl.className = "st " + c; mouseEl.innerHTML = "mouse: " + h; } }
  var stepUpOnSuccess = null; // optional callback for external step-up requests
  var onProbation = false;    // after a step-up: any suspicious verdict re-challenges (no grace) until a genuine one clears it
  // Show the single passkey step-up modal, with the REASON (which modality flagged it).
  function showModal(modality) {
    if (!modalEl) return;
    var d = modalEl.querySelector(".d");
    if (d) d.textContent = (modality === "mouse"
      ? "Your mouse movement no longer matches your profile."
      : "Your typing rhythm no longer matches your profile.") + " Verify with your passkey to continue.";
    modalEl.style.display = "flex";
  }
  function hideModal() { if (modalEl) { modalEl.style.display = "none"; modalErrEl.style.display = "none"; } }

  // ---------- passkey WebAuthn (mode-aware) ----------
  function webauthn() { var w = window.SimpleWebAuthnBrowser; if (!w || !w.startAuthentication) throw new Error("Passkey library unavailable"); return w; }

  async function registerPasskey() {
    var W = webauthn();
    var opt = MODE === "gateway"
      ? await reqJson(EP.pkRegOpts, "POST", {})
      : await (async function () { var me = await req("/api/auth/me").then(function (r) { return r.json(); }); return reqJson("/api/webauthn/register/options", "POST", {}); })();
    if (!opt.ok) throw new Error(opt.d.error || "Could not start registration");
    var att = await W.startRegistration(opt.d);
    var done = MODE === "gateway"
      ? await reqJson(EP.pkRegDone, "POST", { credential: att })
      : await reqJson("/api/webauthn/register/complete", "POST", { credential: att });
    if (!done.ok) throw new Error(done.d.error || "Registration failed");
    return true;
  }

  async function stepUp() {
    modalErrEl.style.display = "none"; modalBtnEl.disabled = true; modalBtnEl.textContent = "Verifying…";
    try {
      var W = webauthn(), opt, ver;
      if (MODE === "gateway") {
        opt = await reqJson(EP.pkAuthOpts, "POST", {}); if (!opt.ok) throw new Error(opt.d.error || "Could not start verification");
        var assertion = await W.startAuthentication(opt.d);
        ver = await reqJson(EP.pkAuthDone, "POST", { challengeId: opt.d.challengeId, assertion: assertion });
      } else {
        var me = await req("/api/auth/me").then(function (r) { return r.json(); });
        opt = await reqJson("/api/webauthn/auth/options", "POST", { userId: me.userId }); if (!opt.ok) throw new Error(opt.d.error || "Could not start verification");
        var a2 = await W.startAuthentication(opt.d);
        ver = await reqJson("/api/webauthn/auth/complete", "POST", { userId: me.userId, challengeId: opt.d.challengeId, assertion: a2 });
      }
      if (!ver.ok) throw new Error(ver.d.error || "Verification failed");
      // Clean resume after step-up: reset BOTH the trackers AND the per-modality
      // check counters, so the window baseline restarts from zero with the tracker.
      // (Resetting the tracker alone left lastCheckedWindowCount stale-high, which
      // silently froze keystroke checks until ~200 more keystrokes caught up.)
      if (ksTracker) ksTracker.reset();
      lastCheckedWindowCount = 0; checkInFlight = false; ksMissedWindow = false;
      if (mouseTracker) mouseTracker.reset(); lastMouseEvents = 0;
      locked = false; onProbation = true; hideModal(); setKb("ok", "verified ✓"); if (mouseOn) setMouseRow("ok", "watching");
      if (stepUpOnSuccess) { var cb = stepUpOnSuccess; stepUpOnSuccess = null; try { cb(); } catch (e2) {} }
    } catch (e) { modalErrEl.textContent = e.message || "Verification failed"; modalErrEl.style.display = "block"; }
    finally { modalBtnEl.disabled = false; modalBtnEl.textContent = "Verify with passkey"; }
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
    if (trigger && !locked) { locked = true; showModal(modality); return true; }
    return false;
  }

  // ================= ONBOARDING WIZARD =================
  var KS_ENROLL_SAMPLES = 5;
  // Same source as the demo's enroll.html: a random Wikipedia summary (varied text
  // teaches the model more of the user's rhythm), with static fallbacks offline.
  var ONBOARD_FALLBACKS = [
    "Continuous authentication works best when the system observes ordinary writing over time. I am typing this paragraph naturally so Continuum can learn my own rhythm from keydown and keyup timing. Every pair of keys I press carries a small piece of my personal pattern, and together these quick measurements describe how my hands move across the keyboard.",
    "My typing pattern is personal and quite hard to imitate. The time I hold each key down and the pause between two keys creates a behavioral signal that can support account protection after login. Just like a signature on paper, the speed and flow of my fingers form a private mark that follows me whenever I write a message or a longer document.",
    "This enrollment sample helps the application build a private rhythm profile for my account. Later, unusual typing during protected actions can require passkey verification. The more natural text I provide now, the better the model will recognize me in the future, because varied words and different letter combinations teach it the full shape of my typing.",
    "The model should learn from repeated samples collected from the real user. These samples are separate from the password and are used only after passkey setup. When somebody else types on my account, their holding times and the gaps between their keys will not match my profile, and the system can then ask for stronger proof of identity right away.",
  ];
  var fbIdx = 0;
  async function fetchRandomText() {
    for (var i = 0; i < 3; i++) {
      try {
        var res = await fetch("https://en.wikipedia.org/api/rest_v1/page/random/summary", { cache: "no-store" });
        if (!res.ok) continue;
        var data = await res.json();
        var text = (data.extract || "").replace(/\n+/g, " ").trim();
        if (text.length >= 150 && text.indexOf("<") < 0) return text.slice(0, 480);
      } catch (e) { /* retry */ }
    }
    return null;
  }
  async function nextPassage() { return (await fetchRandomText()) || ONBOARD_FALLBACKS[fbIdx++ % ONBOARD_FALLBACKS.length]; }

  function wizStepBar(active, total, doneN) {
    var s = '<div class="steps">';
    for (var i = 0; i < total; i++) s += '<span class="s ' + (i < doneN ? "done" : i === active ? "on" : "") + '"></span>';
    return s + "</div>";
  }
  // Sign the user out (the × on mandatory popups). Same-origin so the app's session
  // cookie is cleared; a consumer overrides the endpoints via data-logout-url/login-url.
  function doLogout() {
    try { fetch(cfg.logoutUrl, { method: "POST", credentials: "include" }).finally(function () { location.href = cfg.loginUrl; }); }
    catch (e) { location.href = cfg.loginUrl; }
  }
  // onClose defaults to logout (onboarding/step-up can only be escaped by signing
  // out); optional popups (reinforcement) pass closeWiz to just dismiss.
  function openWiz(html, onClose) {
    wizEl.innerHTML = '<div class="card"><button class="wizx" title="Sign out">×</button><div class="brand"><span class="b2"></span>CONTINUUM · secure onboarding</div>' + html + "</div>";
    wizEl.querySelector(".wizx").addEventListener("click", onClose || doLogout);
    wizEl.style.display = "flex";
  }
  function closeWiz() { wizEl.style.display = "none"; wizEl.innerHTML = ""; }

  // Places a single clickable target at a random spot inside `pad`, moving it to a
  // new random spot on each hit (instead of counting a click anywhere in the box) —
  // forces genuinely separate, deliberate clicks across the area. `onHit(n)` fires
  // with the running total; the target is removed once `total` hits are reached.
  // Doesn't stop propagation, so the mouse tracker's own listener on `pad` still
  // captures the click as real feature data.
  function spawnClickTarget(pad, total, onHit) {
    var hits = 0, ptEl = el("div", "pt");
    function place() {
      var size = 26, w = pad.clientWidth, h = pad.clientHeight;
      var x = size / 2 + Math.random() * Math.max(1, w - size);
      var y = size / 2 + Math.random() * Math.max(1, h - size);
      ptEl.style.left = x + "px"; ptEl.style.top = y + "px";
    }
    ptEl.addEventListener("mousedown", function () {
      hits += 1; onHit(hits);
      if (hits >= total) { ptEl.remove(); return; }
      place();
    });
    pad.appendChild(ptEl);
    place();
  }

  // Step 1 — passkey registration
  function wizPasskey() {
    return new Promise(function (resolve) {
      openWiz(wizStepBar(0, 3, 0) + '<div class="t">Create your passkey</div><div class="d">This device becomes your key. It is used to verify you if your typing or mouse rhythm ever looks off.</div><button class="b" id="cw">Set up passkey</button><div class="e"></div>');
      var b = wizEl.querySelector("#cw"), e = wizEl.querySelector(".e");
      b.addEventListener("click", async function () {
        e.style.display = "none"; b.disabled = true; b.textContent = "Waiting for device…";
        try { await registerPasskey(); resolve(); }
        catch (err) { e.textContent = err.message; e.style.display = "block"; b.disabled = false; b.textContent = "Set up passkey"; }
      });
    });
  }

  // Step 2 — keystroke enrollment (N samples). Random passage per sample (Wikipedia).
  // `optional`: lazy-mode standalone use — dismissable × (no logout), no step bar.
  function wizKeystroke(optional) {
    return new Promise(function (resolve) {
      var got = 0;               // seeded from samples already on file (below)
      async function render() {
        openWiz((optional ? "" : wizStepBar(1, 3, 1)) + '<div class="t">Teach your typing rhythm</div><div class="d">Type the passage below naturally. Sample <b>' + (got + 1) + " / " + KS_ENROLL_SAMPLES + '</b>. <a href="#" id="cnew" style="color:#4f46e5;font-weight:700;text-decoration:none">new text</a></div><div class="passage" id="cpass">Fetching text…</div><textarea class="ta" id="cta" placeholder="Type it here…"></textarea><div class="bar"><i id="cbar"></i></div><div id="cdiag" style="font-size:11px;color:#64748b;margin:6px 0 8px">typed 0 · captured 0 keystrokes</div><button class="b" id="cs" disabled>Submit sample</button><div class="e"></div>', optional ? function () { closeWiz(); resolve(false); } : null);
        var ta = wizEl.querySelector("#cta"), bar = wizEl.querySelector("#cbar"), btn = wizEl.querySelector("#cs"), e = wizEl.querySelector(".e"), diag = wizEl.querySelector("#cdiag"), pass = wizEl.querySelector("#cpass"), newBtn = wizEl.querySelector("#cnew");
        var tracker = window.continuumKeystrokes.createTracker(ta);
        var NEED_KEYS = 100, NEED_CHARS = 120;
        async function loadPassage() { pass.style.opacity = "0.4"; newBtn.style.pointerEvents = "none"; pass.textContent = await nextPassage(); pass.style.opacity = "1"; newBtn.style.pointerEvents = ""; }
        newBtn.addEventListener("click", function (ev) { ev.preventDefault(); loadPassage(); });
        function refresh() {
          var chars = ta.value.trim().length;
          var keys = window.continuumKeystrokes.analyze(tracker.getEvents()).keyCount || 0;
          bar.style.width = Math.min(100, Math.round((keys / NEED_KEYS) * 100)) + "%";
          diag.textContent = "typed " + chars + " · captured " + keys + " keystrokes";
          // Gate on CAPTURED keystrokes so a sample with no real timing is never
          // submitted (which would be silently rejected server-side).
          btn.disabled = keys < NEED_KEYS || chars < NEED_CHARS;
        }
        ta.addEventListener("input", refresh);
        ta.addEventListener("keyup", refresh);
        btn.addEventListener("click", async function () {
          e.style.display = "none"; btn.disabled = true; btn.textContent = "Saving…";
          var events = tracker.getEvents(), timings = window.continuumKeystrokes.analyze(events);
          var r = await reqJson(EP.ksEnroll, "POST", { textContent: ta.value.trim(), keystrokeEvents: events, keystrokeTimings: timings, sourcePath: "onboarding" });
          console.debug("[continuum] keystroke enroll", r.status, r.d);
          if (!r.ok) { e.textContent = "(" + r.status + ") " + ((r.d && r.d.error) || "rejected"); e.style.display = "block"; btn.disabled = false; btn.textContent = "Submit sample"; return; }
          got += 1;
          if ((r.d.typingStatus && r.d.typingStatus.trained) || got >= KS_ENROLL_SAMPLES) return resolve();
          render();
        });
        await loadPassage();
      }
      // Continue the count from samples already collected (so a user who did 3
      // resumes at 4/5 rather than restarting at 1/5). If already enough, finish.
      (async function () {
        try { var st = await reqJson(EP.ksStatus); got = Math.min(Number((st.d && st.d.sampleCount) || 0), KS_ENROLL_SAMPLES); } catch (e) {}
        if (got >= KS_ENROLL_SAMPLES) return resolve();
        render();
      })();
    });
  }

  // Step 3 — mouse enrollment (one session of ~160 windows)
  // `optional`: lazy-mode standalone use — dismissable × (no logout), no step bar.
  function wizMouse(optional) {
    return new Promise(function (resolve) {
      openWiz((optional ? "" : wizStepBar(2, 3, 2)) + '<div class="t">Teach your mouse motion</div><div class="d">Move naturally AND click the target as it appears — clicks are part of your mouse signature.</div><div class="pad" id="cpad"><span class="padlabel">move & click the dot</span></div><div class="bar"><i id="mbar"></i></div><div id="mdiag" style="font-size:11px;color:#64748b;margin:6px 0 8px">movement 0% · clicks 0/' + MOUSE_ENROLL_CLICKS + '</div><button class="b" id="ms" disabled>Finish enrollment</button><div class="e"></div>', optional ? function () { closeWiz(); resolve(false); } : null);
      var pad = wizEl.querySelector("#cpad"), label = pad.querySelector(".padlabel"), bar = wizEl.querySelector("#mbar"), btn = wizEl.querySelector("#ms"), e = wizEl.querySelector(".e"), diag = wizEl.querySelector("#mdiag");
      var tracker = window.mouseFeatures.createMouseTracker(pad);
      var clicks = 0; spawnClickTarget(pad, MOUSE_ENROLL_CLICKS, function (n) { clicks = n; });
      var iv = null;
      function tick() {
        var w = window.mouseFeatures.stepsToWindows(window.mouseFeatures.eventsToSteps(tracker.getEvents()));
        var n = w ? w.length : 0, pct = Math.min(100, Math.round((n / MOUSE_ENROLL_TARGET) * 100));
        var enoughMove = n >= MOUSE_ENROLL_TARGET, enoughClicks = clicks >= MOUSE_ENROLL_CLICKS;
        bar.style.width = pct + "%";
        label.textContent = !enoughMove ? "keep moving…" : !enoughClicks ? "now hit the dot a few more times" : "ready ✓";
        diag.textContent = "movement " + pct + "% · clicks " + Math.min(clicks, MOUSE_ENROLL_CLICKS) + "/" + MOUSE_ENROLL_CLICKS;
        btn.disabled = !(enoughMove && enoughClicks);
      }
      iv = setInterval(tick, 400);
      btn.addEventListener("click", async function () {
        e.style.display = "none"; btn.disabled = true; btn.textContent = "Saving…"; clearInterval(iv);
        var w = window.mouseFeatures.stepsToWindows(window.mouseFeatures.eventsToSteps(tracker.getEvents()));
        var r = await reqJson(EP.mouseEnroll, "POST", { windows: w });
        console.debug("[continuum] mouse enroll", r.status, r.d);
        if (!r.ok) { e.textContent = "(" + r.status + ") " + ((r.d && r.d.error) || "need more movement"); e.style.display = "block"; btn.textContent = "Finish enrollment"; iv = setInterval(tick, 400); return; }
        resolve();
      });
    });
  }

  // Demo mode has no single onboarding endpoint — derive it from the app's own
  // status routes (same identity the SDK monitors on, via req.caUid).
  async function fetchOnboardingDemo() {
    var ob = { passkey: false, keystroke: false, mouse: false };
    try { var me = await req("/api/auth/me").then(function (r) { return r.ok ? r.json() : {}; }); ob.passkey = !!me.passkeysRegistered && !me.passkeySetupRequired; } catch (e) {}
    try { var ts = await reqJson(EP.ksStatus); ob.keystroke = !!(ts.d && ts.d.trained); } catch (e) {}
    try { var ms = await reqJson(EP.mouseStatus); ob.mouse = !!(ms.d && ms.d.enrolled); } catch (e) {}
    return ob;
  }

  async function runOnboarding(ob) {
    if (!ob.passkey) { await wizPasskey(); ob.passkey = true; }
    // Lazy strategy: only the passkey (step-up anchor) is enrolled up-front; each
    // modality enrolls the moment its toggle is enabled. A keystroke-only
    // deployment therefore never asks the user for mouse samples.
    if (ONBOARD_MODE !== "lazy") {
      if (cfg.keystroke !== "off" && !ob.keystroke) { await wizKeystroke(); ob.keystroke = true; }
      if (cfg.mouse !== "off" && !ob.mouse) { await wizMouse(); ob.mouse = true; }
    }
    // brief "all set" then close
    openWiz('<div class="t">You\'re verified ✓</div><div class="d">Continuum is now protecting this session — it will quietly confirm it\'s you as you use the app.</div><button class="b" id="cd">Continue</button>', closeWiz);
    await new Promise(function (res) { wizEl.querySelector("#cd").addEventListener("click", res); });
    closeWiz();
  }

  // ---- reinforcement: let an enrolled user add more samples on demand ----
  function reinforceKeystroke() {
    if (!window.continuumKeystrokes) return;
    var added = 0, total = null;
    function render() {
      openWiz('<div class="wizload" id="cwl"><span class="wizspin"></span>Saving sample…</div><div class="t">Strengthen your typing rhythm</div><div class="d">Type the passage naturally, then save it as a training sample. <a href="#" id="cnew" style="color:#4f46e5;font-weight:700;text-decoration:none">new text</a></div><div class="samplecount">Samples on file: <b id="ctot">' + (total == null ? "…" : total) + '</b> · added now: <b>' + added + '</b></div><div class="passage" id="cpass">Fetching text…</div><textarea class="ta" id="cta" placeholder="Type it here…"></textarea><div class="bar"><i id="cbar"></i></div><div id="cdiag" style="font-size:11px;color:#64748b;margin:6px 0 8px">typed 0 · captured 0 keystrokes</div><div style="display:flex;gap:8px"><button class="b" id="cs" disabled style="flex:1">Save sample</button><button class="b" id="cdone" style="flex:0 0 96px;background:#475569">Done</button></div><div class="e"></div>', closeWiz);
      var ta = wizEl.querySelector("#cta"), bar = wizEl.querySelector("#cbar"), btn = wizEl.querySelector("#cs"), done = wizEl.querySelector("#cdone"), e = wizEl.querySelector(".e"), diag = wizEl.querySelector("#cdiag"), pass = wizEl.querySelector("#cpass"), newBtn = wizEl.querySelector("#cnew"), load = wizEl.querySelector("#cwl");
      var tracker = window.continuumKeystrokes.createTracker(ta);
      var NEED_KEYS = 100, NEED_CHARS = 120;
      async function loadPassage() { pass.style.opacity = "0.4"; pass.textContent = await nextPassage(); pass.style.opacity = "1"; }
      newBtn.addEventListener("click", function (ev) { ev.preventDefault(); loadPassage(); });
      done.addEventListener("click", closeWiz);
      function refresh() { var chars = ta.value.trim().length, keys = window.continuumKeystrokes.analyze(tracker.getEvents()).keyCount || 0; bar.style.width = Math.min(100, Math.round((keys / NEED_KEYS) * 100)) + "%"; diag.textContent = "typed " + chars + " · captured " + keys + " keystrokes"; btn.disabled = keys < NEED_KEYS || chars < NEED_CHARS; }
      ta.addEventListener("input", refresh); ta.addEventListener("keyup", refresh);
      btn.addEventListener("click", async function () {
        e.style.display = "none"; load.classList.add("on");
        var events = tracker.getEvents(), r = await reqJson(EP.ksEnroll, "POST", { textContent: ta.value.trim(), keystrokeEvents: events, keystrokeTimings: window.continuumKeystrokes.analyze(events), sourcePath: "reinforce" });
        load.classList.remove("on");
        if (!r.ok) { e.textContent = "(" + r.status + ") " + ((r.d && r.d.error) || "rejected"); e.style.display = "block"; return; }
        added += 1; if (total != null) total += 1; render();
      });
      loadPassage();
    }
    // Load the current sample count first so the popup shows how many are on file.
    (async function () { try { var st = await reqJson(EP.ksStatus); total = Number((st.d && st.d.sampleCount) || 0); } catch (e) { total = 0; } render(); })();
  }
  function reinforceMouse() {
    if (!window.mouseFeatures) return;
    var added = 0, total = null;
    function render() {
      openWiz('<div class="wizload" id="mwl"><span class="wizspin"></span>Saving session…</div><div class="t">Strengthen your mouse motion</div><div class="d">Move naturally AND click the target as it appears — clicks are part of your signature.</div><div class="samplecount">Sessions on file: <b>' + (total == null ? "…" : total) + '</b> · added now: <b>' + added + '</b></div><div class="pad" id="cpad"><span class="padlabel">move & click the dot</span></div><div class="bar"><i id="mbar"></i></div><div id="mdiag2" style="font-size:11px;color:#64748b;margin:6px 0 8px">movement 0% · clicks 0/' + MOUSE_ENROLL_CLICKS + '</div><div style="display:flex;gap:8px"><button class="b" id="ms" disabled style="flex:1">Save session</button><button class="b" id="mdone" style="flex:0 0 96px;background:#475569">Done</button></div><div class="e"></div>', closeWiz);
      var pad = wizEl.querySelector("#cpad"), label = pad.querySelector(".padlabel"), bar = wizEl.querySelector("#mbar"), btn = wizEl.querySelector("#ms"), done = wizEl.querySelector("#mdone"), e = wizEl.querySelector(".e"), load = wizEl.querySelector("#mwl"), diag = wizEl.querySelector("#mdiag2");
      var tracker = window.mouseFeatures.createMouseTracker(pad), iv = null;
      var clicks = 0; spawnClickTarget(pad, MOUSE_ENROLL_CLICKS, function (n) { clicks = n; });
      function tick() {
        var w = window.mouseFeatures.stepsToWindows(window.mouseFeatures.eventsToSteps(tracker.getEvents())); var n = w ? w.length : 0;
        var pct = Math.min(100, Math.round((n / MOUSE_ENROLL_TARGET) * 100)), enoughMove = n >= MOUSE_ENROLL_TARGET, enoughClicks = clicks >= MOUSE_ENROLL_CLICKS;
        bar.style.width = pct + "%";
        label.textContent = !enoughMove ? "keep moving…" : !enoughClicks ? "now hit the dot a few more times" : "ready ✓";
        diag.textContent = "movement " + pct + "% · clicks " + Math.min(clicks, MOUSE_ENROLL_CLICKS) + "/" + MOUSE_ENROLL_CLICKS;
        btn.disabled = !(enoughMove && enoughClicks);
      }
      iv = setInterval(tick, 400);
      done.addEventListener("click", function () { clearInterval(iv); closeWiz(); });
      btn.addEventListener("click", async function () {
        e.style.display = "none"; clearInterval(iv); load.classList.add("on");
        var w = window.mouseFeatures.stepsToWindows(window.mouseFeatures.eventsToSteps(tracker.getEvents()));
        var r = await reqJson(EP.mouseEnroll, "POST", { windows: w });
        load.classList.remove("on");
        if (!r.ok) { e.textContent = "(" + r.status + ") " + ((r.d && r.d.error) || "need more movement"); e.style.display = "block"; iv = setInterval(tick, 400); return; }
        added += 1; if (total != null) total += 1; render();
      });
    }
    (async function () { try { var st = await reqJson(EP.mouseStatus); total = Number((st.d && st.d.sessions) || 0); } catch (e) { total = 0; } render(); })();
  }

  // ================= GUARD LOOPS =================
  var ksTracker = null, ksOn = false, lastCheckedWindowCount = 0, checkInFlight = false, ksMissedWindow = false;
  var cleanRun = 0, lastContributeKeys = -1e9, activeField = null, contributing = false, learnVisible = false;
  // Which field types are monitored is deployment config (MONITOR_EXCLUDE_TYPES).
  // Password fields ARE monitored (their timing is captured, keyCode masked to 0 by
  // the tracker) but their VALUE is never sent — we substitute equal-length 'x' so
  // the server's coverage check works without ever seeing the secret.
  function fieldExcluded(n) { return EXCLUDE_TYPES.indexOf((n.type || "text").toLowerCase()) >= 0; }
  function currentTypedText() {
    var t = "", ns = document.querySelectorAll("input, textarea");
    for (var i = 0; i < ns.length; i++) {
      var n = ns[i]; if (fieldExcluded(n) || typeof n.value !== "string") continue;
      t += (n.type === "password" ? new Array(n.value.length + 1).join("x") : n.value) + " ";
    }
    return t.trim();
  }
  function ksKeyCount(ev) { return window.continuumKeystrokes.analyze(ev).keyCount || 0; }
  function currentKeys() { return ksTracker ? ksKeyCount(ksTracker.getEvents()) : 0; }
  function ksWindowCount(k) { var s = Math.max(k - 1, 0); return s >= WINDOW_SIZE ? Math.floor((s - WINDOW_SIZE) / WINDOW_STRIDE) + 1 : 0; }

  // Trigger policy mirrors the opinion.html reference: on any text input, fire a
  // check the moment a NEW sliding window forms (no debounce), gated on a minimum
  // amount of text. If a check is already in flight, remember the window and catch
  // up the instant it returns — so a window is never skipped, never double-fired.
  function onKsInput(e) {
    // Remember which field is being typed in — the adaptive prompt floats above it.
    if (e && e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") && e.target.type !== "password" && e.target.type !== "hidden") activeField = e.target;
    if (locked || !ksOn || !ksTracker) return;
    var text = currentTypedText();
    if (text.length < KS_MIN_CHARS) { setKb("mut", "type " + text.length + "/" + KS_MIN_CHARS + " chars to start"); return; }
    // Live feedback while the user keeps writing between verdicts (feels engaged
    // instead of frozen on the last "verified ✓").
    if (!checkInFlight) setKb("mut", "analyzing…");
    if (ksWindowCount(ksKeyCount(ksTracker.getEvents())) <= lastCheckedWindowCount) return; // no new window yet
    if (checkInFlight) { ksMissedWindow = true; return; }
    runKsCheck();
  }
  async function runKsCheck() {
    if (locked || !ksOn || !ksTracker) return;
    var events = ksTracker.getEvents(), text = currentTypedText();
    if (text.length < KS_MIN_CHARS) return;
    checkInFlight = true; ksMissedWindow = false; pulse(); setKb("mut", "checking…");
    try {
      var timings = window.continuumKeystrokes.analyze(events);
      var r = await reqJson(EP.ksCheck, "POST", { textContent: text, keystrokeEvents: events.slice(-700), keystrokeTimings: timings, sourcePath: location.pathname });
      var d = r.d; if (d && d.riskToken) latestRiskToken = d.riskToken;
      lastCheckedWindowCount = ksWindowCount(ksKeyCount(events));
      var ev = d.typingEvaluation || {};
      var wc = ev.windowCount || 0, pct = d.modelConfidence != null ? Math.round(d.modelConfidence * 100) : null;
      if (r.status === 423) { setKb("bad", "<b>locked</b> — verify"); maybeChallenge(d, "keystroke", onProbation); return; }
      // During post-step-up probation, ANY suspicious verdict re-challenges — even a
      // warmup one — so passing step-up grants no grace window to a persisting impostor.
      if (maybeChallenge(d, "keystroke", onProbation)) { setKb("bad", "<b>rhythm mismatch</b>"); cleanRun = 0; hideLearn(); return; }
      if (d.checked === false) { setKb("mut", "gathering…"); return; }
      // No trained model for THIS identity yet → not "warming", it needs enrollment.
      // (Otherwise the row sat forever at "warming 0/7 · 0%".)
      if (ev.modelAvailable === false) { setKb("mut", "not enrolled — add samples"); cleanRun = 0; return; }
      if (d.warmup) { setKb("warn", "warming " + wc + "/" + (RECENT_WINDOW_COUNT + 1) + " windows" + (pct != null ? " · <b>" + pct + "%</b>" : "")); cleanRun = 0; }
      else if (d.isSuspicious) { setKb("bad", "suspicious <b>" + pct + "%</b>"); cleanRun = 0; }
      else { setKb("ok", "verified <b>" + pct + "%</b>"); onProbation = false; cleanRun = (d.modelConfidence == null || d.modelConfidence >= ADAPT_CONFIDENCE_MIN) ? cleanRun + 1 : 0; }
      evalAdaptive(); // a clean run may now qualify to contribute a training sample
    } catch (e) { setKb("mut", "offline"); }
    finally { checkInFlight = false; if (ksMissedWindow) onKsInput(); } // catch up on a window that formed mid-check
  }

  // ---- adaptive learning (SDK port of the demo's "Contribute" panel) ----
  // Eligible after a clean run of high-confidence checks + a keystroke cooldown;
  // the prompt floats directly above the field the user is typing in.
  function evalAdaptive() {
    if (!ksOn || locked || contributing) { hideLearn(); return; }
    var cooldownOk = currentKeys() - lastContributeKeys >= RECENT_WINDOW_COUNT * WINDOW_STRIDE;
    if (cleanRun >= ADAPT_CLEAN_RUN && cooldownOk && activeField && currentTypedText().length >= KS_MIN_CHARS) showLearn();
    else hideLearn();
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
      var go = learnEl.querySelector(".go"); if (go) { go.disabled = false; go.textContent = "Contribute sample"; }
      learnEl.style.display = "block"; learnVisible = true;
    }
    positionLearn();
  }
  function hideLearn() { if (learnEl && learnVisible) { learnEl.style.display = "none"; learnVisible = false; } }
  function dismissLearn() { hideLearn(); lastContributeKeys = currentKeys(); cleanRun = 0; } // start the cooldown
  async function contributeSample() {
    if (contributing || !ksTracker) return;
    contributing = true;
    var go = learnEl.querySelector(".go"), msg = learnEl.querySelector(".lm"), bar = learnEl.querySelector(".lp > i");
    if (go) { go.disabled = true; go.textContent = "Adding…"; }
    try {
      var r = await reqJson(EP.ksContribute, "POST", { textContent: currentTypedText(), keystrokeEvents: ksTracker.getEvents().slice(-1400) });
      if (r.ok && r.d && r.d.ok !== false) {
        var done = r.d.adaptiveSamplesSinceRetrain || 0, need = r.d.adaptiveRetrainEvery || ADAPT_RETRAIN_EVERY;
        if (bar) bar.style.width = Math.min(100, (done / Math.max(need, 1)) * 100) + "%";
        if (msg) msg.textContent = done >= need ? "Added — your model is retraining now." : "Added! " + done + "/" + need + " to the next update.";
        setKb("ok", "learning ✓");
        lastContributeKeys = currentKeys(); cleanRun = 0;
        setTimeout(hideLearn, 2600);
      } else if (msg) { msg.textContent = (r.d && r.d.error) || "Couldn't add this sample."; }
    } catch (e) { if (msg) msg.textContent = "Offline — try again."; }
    finally { contributing = false; if (go) { go.disabled = false; go.textContent = "Contribute sample"; } }
  }

  // Enable/disable keystroke monitoring at runtime (panel toggle + persisted),
  // mirroring the mouse toggle. When on, a single delegated input listener covers
  // EVERY text field on the page; when off, the listener is removed entirely.
  function updateKsToggle() { if (ksToggleEl) { ksToggleEl.className = "tgl" + (ksOn ? " on" : ""); ksToggleEl.textContent = ksOn ? "on" : "off"; } }
  function setKeystroke(on) {
    ksOn = !!on;
    try { localStorage.setItem(LS_KEYSTROKE, ksOn ? "1" : "0"); } catch (e) {}
    if (ksOn) startKeystroke(); else stopKeystroke();
    updateKsToggle();
  }
  function startKeystroke() {
    if (!window.continuumKeystrokes) return;
    if (!ksTracker) ksTracker = window.continuumKeystrokes.createTracker(document.documentElement);
    if (!ksInputHandler) { ksInputHandler = onKsInput; document.addEventListener("input", ksInputHandler, true); }
    setKb("mut", "type " + KS_MIN_CHARS + " chars to start");
  }
  function stopKeystroke() {
    if (ksInputHandler) { document.removeEventListener("input", ksInputHandler, true); ksInputHandler = null; }
    checkInFlight = false; ksMissedWindow = false; lastCheckedWindowCount = 0;
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
  function updateToggle() { if (toggleEl) { toggleEl.className = "tgl" + (mouseOn ? " on" : ""); toggleEl.textContent = mouseOn ? "on" : "off"; } }
  function setMouse(on) { mouseOn = !!on; try { localStorage.setItem(LS_MOUSE, mouseOn ? "1" : "0"); } catch (e) {} if (mouseOn) { startMouse(); setMouseRow("mut", "warming up…"); } else { stopMouse(); setMouseRow("mut", "off"); } updateToggle(); }
  function startMouse() { stopMouse(); if (mouseTracker) mouseTracker.reset(); lastMouseEvents = 0; mouseTimer = setInterval(mouseTick, MOUSE_CHECK_MS); }
  function stopMouse() { if (mouseTimer) clearInterval(mouseTimer); mouseTimer = null; }
  async function mouseTick() {
    if (locked || !mouseTracker) return;
    var count = mouseTracker.eventCount(); if (count <= lastMouseEvents) return; lastMouseEvents = count;
    var windows; try { windows = window.mouseFeatures.stepsToWindows(window.mouseFeatures.eventsToSteps(mouseTracker.getEvents())); } catch (e) { return; }
    if (!windows || windows.length < MOUSE_MIN_WINDOWS) { setMouseRow("mut", "warming " + (windows ? windows.length : 0) + "/6"); return; }
    pulse();
    try {
      var r = await reqJson(EP.mouseCheck, "POST", { windows: windows.slice(-18) });
      var d = r.d; if (d && d.riskToken) latestRiskToken = d.riskToken;
      if (d && d.enrolled === false) { setMouseRow("mut", "not enrolled"); stopMouse(); mouseOn = false; updateToggle(); return; }
      if (maybeChallenge(d, "mouse", onProbation)) { setMouseRow("bad", "<b>mouse mismatch</b>"); return; }
      if (d.checked === false) { setMouseRow("mut", "move to check"); return; }
      var pct = d.meanScore != null ? Math.round(d.meanScore * 100) : null;
      if (d.isSuspicious) setMouseRow("warn", "suspicious " + (d.suspiciousStreak || 1) + "/" + (d.strikesToLock || 3));
      else { onProbation = false; setMouseRow("ok", "watching <b>" + (pct != null ? pct + "%" : "") + "</b>"); }
    } catch (e) { setMouseRow("mut", "offline"); }
  }

  async function loadConfig() {
    try { var r = await reqJson(EP.config); if (!r.ok) return; var c = r.d;
      if (c.windowSize) WINDOW_SIZE = c.windowSize; if (c.windowStride) WINDOW_STRIDE = c.windowStride;
      if (c.recentWindowCount) RECENT_WINDOW_COUNT = c.recentWindowCount; if (c.checkMinTextChars) KS_MIN_CHARS = c.checkMinTextChars;
      if (c.adaptiveConfidenceMin != null) ADAPT_CONFIDENCE_MIN = c.adaptiveConfidenceMin;
      if (c.adaptiveRetrainEvery != null) ADAPT_RETRAIN_EVERY = c.adaptiveRetrainEvery;
      if (!cfg.onboarding && c.onboardingMode) ONBOARD_MODE = c.onboardingMode; // docker-level strategy
      if (Array.isArray(c.excludeFieldTypes)) EXCLUDE_TYPES = c.excludeFieldTypes.map(function (x) { return String(x).toLowerCase(); });
    } catch (e) {}
  }

  function startGuard() {
    if (cfg.keystroke !== "off" && window.continuumKeystrokes) {
      if (ONBOARD_MODE === "lazy" && obState && !obState.keystroke) {
        // Lazy: unenrolled modality starts OFF; the toggle runs enrollment on demand.
        setKeystroke(false); setKb("mut", "off — enable to enroll");
      } else {
        // Default ON; respect the user's persisted toggle choice across reloads.
        var ksPref = null; try { ksPref = localStorage.getItem(LS_KEYSTROKE); } catch (e) {}
        setKeystroke(ksPref === null ? true : ksPref === "1");
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
    if (ksTracker) ksTracker.reset(); if (mouseTracker) mouseTracker.reset();
    checkInFlight = false; locked = false; ready = false;
  }

  // ---------- bootstrap (gateway mode) ----------
  async function bootstrapGateway() {
    var body = { siteKey: cfg.siteKey };
    if (identityToken) body.identityToken = identityToken; // backend-vouched, account-bound
    else { var ext = cfg.externalId; if (!ext) { try { ext = localStorage.getItem(LS_EXT); } catch (e) {} } body.externalId = ext || ""; }
    var r = await reqJson("/v1/sdk/session", "POST", body);
    if (!r.ok) throw new Error(r.d.error || "session failed");
    sessionToken = r.d.token; userId = r.d.userId;
    if (!cfg.onboarding && r.d.onboardingMode) ONBOARD_MODE = r.d.onboardingMode; // set before the onboarding decision
    if (!identityToken) { try { localStorage.setItem(LS_EXT, r.d.externalId); } catch (e) {} } // persist only the anon id
    return r.d.onboarding;
  }

  function needOnboarding(ob) {
    if (!ob.passkey) return true;
    if (ONBOARD_MODE === "lazy") return false; // modalities enroll on toggle
    return (cfg.keystroke !== "off" && !ob.keystroke) || (cfg.mouse !== "off" && !ob.mouse);
  }

  async function gatewayFlow() {
    try {
      var ob = await bootstrapGateway();
      await loadConfig(); // now authed
      obState = ob;
      if (needOnboarding(ob)) await runOnboarding(ob);
    } catch (e) { console.warn("[continuum] bootstrap failed:", e.message); setKb("bad", "offline"); return; }
    startGuard();
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
      requireStepUp: function (modality, onSuccess) { if (locked) return; locked = true; stepUpOnSuccess = onSuccess || null; showModal(modality || "keystroke"); },
      // Contribute the current clean typing as an adaptive training sample — the
      // same thing the floating "Contribute" prompt does, callable from a consumer's
      // own Save action so "save" and "keep learning my rhythm" are one gesture.
      contribute: function () { return reqJson(EP.ksContribute, "POST", { textContent: currentTypedText(), keystrokeEvents: ksTracker ? ksTracker.getEvents().slice(-1400) : [] }); },
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
      if (needOnboarding(ob)) await runOnboarding(ob);
    } catch (e) { console.warn("[continuum] onboarding:", e.message); }
    startGuard();
  }

  function boot() { ensureDeps().then(function () { if (document.body) init(); else document.addEventListener("DOMContentLoaded", init); }).catch(function (e) { console.warn("[continuum-guard]", e.message); }); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
