// content.js — injected on EVERY page. Captures keystroke TIMING, builds feature windows
// on-device (via features.js), and forwards only the finished windows (timing numbers) to
// the background worker. The typed CHARACTERS never leave this page:
//   • password fields → key masked to 0 (rhythm kept, secret never seen)
//   • hidden fields   → ignored
//   • excluded sites  → nothing captured at all
// Fully guarded: when the extension is reloaded/updated this old script's context is
// invalidated; we detect that and tear ourselves down instead of throwing.
(function () {
  // Double-injection guard: the worker programmatically injects into already-open tabs,
  // which can race the manifest's own injection after a reload.
  if (window.__cgGuardActive) return;
  window.__cgGuardActive = true;
  var api = globalThis.browser || globalThis.chrome;
  var enabled = true, excluded = false;
  var origin = location.origin;
  var events = [];              // raw key-timing — stays in THIS page, never sent
  var lastWindowCount = 0;
  var t0 = performance.now();
  var dead = false;
  var handlers = [];

  // The extension context is invalid after a reload/update — accessing chrome.runtime.id
  // then throws. Check it before every chrome call so we never raise an uncaught error.
  function alive() {
    if (dead) return false;
    try { return !!(api && api.runtime && api.runtime.id); } catch (e) { return false; }
  }
  function teardown() {
    dead = true;
    for (var i = 0; i < handlers.length; i++) {
      try { document.removeEventListener(handlers[i][0], handlers[i][1], true); } catch (e) {}
    }
    handlers = [];
    try { api.runtime.onMessage.removeListener(onMsg); } catch (e) {}
  }
  function safeSend(msg, cb) {
    if (!alive()) { teardown(); return; }
    try {
      api.runtime.sendMessage(msg, function (res) {
        try { void api.runtime.lastError; } catch (e) {}   // orphaned tab — ignore
        if (cb) cb(res);
      });
    } catch (e) { teardown(); }
  }

  // ---- enforcement overlay: shown when the worker declares the session suspicious ----
  var lockEl = null;
  function blockWhileLocked(e) { if (lockEl) { e.stopImmediatePropagation(); e.preventDefault(); } }
  window.addEventListener("keydown", blockWhileLocked, true);
  window.addEventListener("keyup", blockWhileLocked, true);
  window.addEventListener("beforeinput", blockWhileLocked, true);
  function showLock(hasPasskey) {
    if (lockEl || dead) return;
    lockEl = document.createElement("div");
    lockEl.setAttribute("style",
      "position:fixed;inset:0;z-index:2147483647;background:rgba(2,6,23,.88);backdrop-filter:blur(6px);" +
      "display:flex;align-items:center;justify-content:center;font:15px/1.5 system-ui,sans-serif;color:#e2e8f0;");
    var box = document.createElement("div");
    box.setAttribute("style", "max-width:420px;background:#0f172a;border:1px solid #334155;border-radius:16px;padding:28px 30px;text-align:center;");
    box.innerHTML =
      '<div style="font-size:34px;margin-bottom:10px">🔒</div>' +
      '<div style="font-weight:800;font-size:18px;margin-bottom:8px">Continuum Guard locked this page</div>' +
      '<div style="color:#94a3b8;margin-bottom:18px">The recent typing rhythm does not match the enrolled profile. Verify it&#39;s you to continue.</div>' +
      '<button id="__cgVerifyBtn" style="background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:12px 22px;font:700 15px system-ui;cursor:pointer">' +
      (hasPasskey ? "Verify with passkey" : "Set up your passkey") + "</button>";
    lockEl.appendChild(box);
    (document.body || document.documentElement).appendChild(lockEl);
    box.querySelector("#__cgVerifyBtn").addEventListener("click", function () {
      safeSend({ type: hasPasskey ? "cg:open-verify" : "cg:open-register" });
    });
  }
  function hideLock() { if (lockEl) { try { lockEl.remove(); } catch (e) {} lockEl = null; } }

  // RP pages (the fixed Continuum passkey origin) postMessage their outcome into their own
  // window; this relay forwards it to the worker, which checks sender.url === RP origin.
  window.addEventListener("message", function (ev) {
    var d = ev && ev.data;
    if (!d || d.type !== "continuum-ext-passkey" || !d.ok) return;
    safeSend({ type: d.action === "register" ? "cg:passkey-registered" : "cg:verified" });
  });

  function onMsg(msg) {
    if (dead) return;
    if (msg && msg.type === "cg:config") { enabled = msg.enabled !== false; excluded = (msg.exclusions || []).indexOf(origin) >= 0; }
    if (msg && msg.type === "cg:lock") showLock(!!msg.hasPasskey);
    if (msg && msg.type === "cg:unlock") hideLock();
    if (msg && msg.type === "cg:reset") {
      // Fresh packet after a verified step-up: drop buffered timings so counting
      // restarts from zero instead of replaying pre-lock windows.
      events = [];
      lastWindowCount = 0;
      mouseEvents = [];
      lastMouseWindows = 0;
      safeSend({ type: "cg:activity", steps: 0, need: (globalThis.ContinuumFeatures || {}).WINDOW_SIZE || 50 });
    }
  }

  safeSend({ type: "cg:hello", origin: origin }, function (res) {
    if (res) {
      enabled = res.enabled !== false;
      excluded = !!res.excluded;
      if (res.locked) showLock(!!res.hasPasskey);   // navigated / reopened while locked
    }
  });
  if (alive()) { try { api.runtime.onMessage.addListener(onMsg); } catch (e) { teardown(); } }

  function fieldOf(t) { return t && (t.name || t.id || t.tagName) ? (t.name || t.id || t.tagName) : "page"; }
  function isPassword(t) { return t && t.tagName === "INPUT" && t.type === "password"; }
  function isHidden(t) { return t && t.tagName === "INPUT" && t.type === "hidden"; }

  function rec(type, e) {
    if (!rec.fired) { rec.fired = true; try { console.log("[continuum-guard] FIRST key event (" + type + ") — listener works; field=" + (e.target && (e.target.name || e.target.id || e.target.tagName))); } catch (x) {} }
    if (dead) return;
    if (!alive()) { teardown(); return; }
    if (!enabled || excluded) return;
    try {
      var tgt = e.target;
      if (isHidden(tgt)) return;
      var kc = isPassword(tgt) ? 0 : (e.keyCode || 0);   // mask the KEY on password fields
      events.push({ keyCode: kc, type: type, t: performance.now() - t0, field: fieldOf(tgt) });
      if (events.length > 2000) events = events.slice(-1400);
      emit();
    } catch (err) { teardown(); }
  }

  var warnedNoF = false;
  function emit() {
    var F = globalThis.ContinuumFeatures;
    if (!F) { if (!warnedNoF) { warnedNoF = true; console.warn("[continuum-guard] ContinuumFeatures NOT loaded — features.js didn't run; capture can't build windows"); } return; }
    var steps = F.eventSteps(events);
    var windows = F.stepsToWindows(steps);
    if (events.length % 20 === 0) { try { console.log("[continuum-guard] keys=" + events.length + " steps=" + steps.length + "/" + F.WINDOW_SIZE + " windows=" + windows.length); } catch (e) {} }
    // Live progress so the popup shows capture is working before a full window forms.
    safeSend({ type: "cg:activity", steps: steps.length, need: F.WINDOW_SIZE });
    if (windows.length > lastWindowCount) {
      lastWindowCount = windows.length;
      // Only the newest window of TIMING features — never the characters.
      safeSend({ type: "cg:windows", origin: origin, latest: windows[windows.length - 1] });
    }
  }

  function on(type) { var fn = function (e) { rec(type, e); }; document.addEventListener(type, fn, true); handlers.push([type, fn]); }
  on("keydown");
  on("keyup");

  // ---- mouse capture (positions + timing only — same privacy story as keys) ----
  var mouseEvents = [], mouseDown = false, lastMouseWindows = 0;
  function recMouse(x, y, st) {
    if (dead || !enabled || excluded || lockEl) return;
    mouseEvents.push({ t: performance.now(), x: x, y: y, state: st });
    if (mouseEvents.length > 3000) mouseEvents = mouseEvents.slice(-2000);
    // Mouse events are dense (60–120/s) — rebuild windows every 10th event, not on each.
    if (mouseEvents.length % 10 === 0) emitMouse();
  }
  function emitMouse() {
    var M = globalThis.ContinuumMouseFeatures;
    if (!M || !alive()) return;
    var windows = M.stepsToWindows(M.eventsToSteps(mouseEvents));
    if (windows.length > lastMouseWindows) {
      lastMouseWindows = windows.length;
      safeSend({ type: "cg:windows-mouse", origin: origin, latest: windows[windows.length - 1] });
    }
  }
  function onM(type, fn) { document.addEventListener(type, fn, true); handlers.push([type, fn]); }
  onM("mousemove", function (e) { recMouse(e.clientX, e.clientY, mouseDown ? "Drag" : "Move"); });
  onM("mousedown", function (e) { mouseDown = true; recMouse(e.clientX, e.clientY, "Pressed"); });
  onM("mouseup", function (e) { mouseDown = false; recMouse(e.clientX, e.clientY, "Released"); });
  try { console.log("[continuum-guard] content script ACTIVE on " + origin + " — features.js: " + (globalThis.ContinuumFeatures ? "loaded" : "MISSING") + ", enabled=" + enabled + ", excluded=" + excluded); } catch (e) {}
})();
