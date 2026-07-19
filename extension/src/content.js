// content.js — injected on EVERY page. Captures keystroke TIMING, builds feature
// windows on-device (via features.js), and forwards only the finished windows (timing
// numbers) to the background worker. The typed CHARACTERS never leave this page:
//   • password fields → key masked to 0 (rhythm kept, secret never seen)
//   • hidden fields   → ignored
//   • excluded sites  → nothing captured at all
(function () {
  var api = globalThis.browser || globalThis.chrome;
  var enabled = true, excluded = false;
  var origin = location.origin;
  var events = [];              // raw key-timing — stays in THIS page, never sent
  var lastWindowCount = 0;
  var t0 = performance.now();

  var dead = false;
  // Guarded send: after the extension is reloaded/updated, this old content script's
  // context is invalidated and any runtime call throws. Catch it, stop capturing, and
  // let a page refresh inject a fresh script.
  function safeSend(msg, cb) {
    if (dead) return;
    try {
      api.runtime.sendMessage(msg, function (res) {
        void api.runtime.lastError; // orphaned tab / no receiver — ignore
        if (cb) cb(res);
      });
    } catch (e) {
      dead = true;
    }
  }

  safeSend({ type: "cg:hello", origin: origin }, function (res) {
    if (res) { enabled = res.enabled !== false; excluded = !!res.excluded; }
  });
  api.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "cg:config") {
      enabled = msg.enabled !== false;
      excluded = (msg.exclusions || []).indexOf(origin) >= 0;
    }
  });

  function fieldOf(t) { return t && (t.name || t.id || t.tagName) ? (t.name || t.id || t.tagName) : "page"; }
  function isPassword(t) { return t && t.tagName === "INPUT" && t.type === "password"; }
  function isHidden(t) { return t && t.tagName === "INPUT" && t.type === "hidden"; }

  function rec(type, e) {
    if (dead || !enabled || excluded) return;
    var tgt = e.target;
    if (isHidden(tgt)) return;
    var kc = isPassword(tgt) ? 0 : (e.keyCode || 0);   // mask the KEY on password fields
    events.push({ keyCode: kc, type: type, t: performance.now() - t0, field: fieldOf(tgt) });
    if (events.length > 2000) events = events.slice(-1400);
    emit();
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

  document.addEventListener("keydown", function (e) { rec("keydown", e); }, true);
  document.addEventListener("keyup", function (e) { rec("keyup", e); }, true);
})();
