// content.js — injected on EVERY page. Captures keystroke TIMING, builds feature windows
// on-device (via features.js), and forwards only the finished windows (timing numbers) to
// the background worker. The typed CHARACTERS never leave this page:
//   • password fields → key masked to 0 (rhythm kept, secret never seen)
//   • hidden fields   → ignored
//   • excluded sites  → nothing captured at all
// Fully guarded: when the extension is reloaded/updated this old script's context is
// invalidated; we detect that and tear ourselves down instead of throwing.
(function () {
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

  safeSend({ type: "cg:hello", origin: origin }, function (res) {
    if (res) { enabled = res.enabled !== false; excluded = !!res.excluded; }
  });
  if (alive()) {
    api.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === "cg:config") { enabled = msg.enabled !== false; excluded = (msg.exclusions || []).indexOf(origin) >= 0; }
    });
  }

  function fieldOf(t) { return t && (t.name || t.id || t.tagName) ? (t.name || t.id || t.tagName) : "page"; }
  function isPassword(t) { return t && t.tagName === "INPUT" && t.type === "password"; }
  function isHidden(t) { return t && t.tagName === "INPUT" && t.type === "hidden"; }

  function rec(type, e) {
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

  function emit() {
    var F = globalThis.ContinuumFeatures;
    if (!F) return;
    var steps = F.eventSteps(events);
    var windows = F.stepsToWindows(steps);
    if (windows.length > lastWindowCount) {
      lastWindowCount = windows.length;
      // Only the newest window of TIMING features — never the characters.
      safeSend({ type: "cg:windows", origin: origin, latest: windows[windows.length - 1] });
    }
  }

  function on(type) { var fn = function (e) { rec(type, e); }; document.addEventListener(type, fn, true); handlers.push([type, fn]); }
  on("keydown");
  on("keyup");
})();
