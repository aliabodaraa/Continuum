// content.js — injected on EVERY page. Captures key TIMING and mouse movement and hands them to the
// service worker, which sends them to the Continuum server (as sdk/guard.js does) under the signed-in
// user's session. What leaves the page:
//   • keys: the key-event tail (key codes and timings) and the typed length. The text itself is not
//     sent, but the order of key codes is, and text could be rebuilt from it;
//   • mouse: numbered windows of movement features (positions and timing only);
//   • password fields and the field types the organisation never watches (hidden by default) → no
//     event at all; excluded sites and the pause → nothing captured. Rich-text editors
//     (contenteditable) are fields like any other.
// Fully guarded: when the extension is reloaded/updated this old script's context is invalidated; it
// detects that and tears itself down instead of throwing.
(function () {
  // Double-injection guard: the worker programmatically injects into already-open tabs, which can race
  // the manifest's own injection after a reload.
  if (window.__cgGuardActive) return;
  window.__cgGuardActive = true;
  var api = globalThis.browser || globalThis.chrome;
  var excluded = false;
  // Field types the signed-in organisation never watches ("fields never watched"), from the service worker.
  var excludeTypes = ["hidden"];
  // Per-check diagnostics are opt-in (options page -> "Verbose diagnostics"); warnings are not gated.
  var debug = false;
  function dlog() { if (!debug) return; try { console.log.apply(console, arguments); } catch (e) {} }
  var origin = location.origin;
  // The gateway's origin hosts the step-up and sign-in pages. The lock overlay must never cover it (a
  // locked session could not run the step-up that clears the lock), and nothing typed there is checked.
  var gatewayOrigin = "";
  var t0 = performance.now();
  // Event time, not handler time: event.timeStamp is when the browser created the event, on the same
  // clock as performance.now(). A busy page that runs these handlers late would otherwise compress the
  // typing rhythm the model scores. The SDK's tracker does the same, so enrolment and live checks agree.
  function evtTime(e) {
    var now = performance.now();
    var ts = e && typeof e.timeStamp === "number" ? e.timeStamp : 0;
    return ts > 0 && ts <= now + 1 ? ts : now;
  }
  var dead = false;
  var handlers = [], winHandlers = [];   // document-level and window-level listeners

  // Capture follows the worker: null = nobody signed in (nothing captured), else { kind, paused }.
  // One page visit is one session (the study logs it as such).
  var capture = null;
  var sessionId = (function () {
    try { var b = new Uint8Array(8); crypto.getRandomValues(b); return "s" + Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join(""); }
    catch (e) { return "s" + Date.now().toString(16) + Math.random().toString(16).slice(2, 10); }
  })();
  var MOUSE_N = 60, MOUSE_MS = 1600, KS_TAIL = 1400;   // as sdk/guard.js
  var events = [];            // key-event buffer
  var lastWindowCount = 0, ksInFlight = false, ksMissed = false, ksPasteMissed = false;
  var mouseEvents = [], mouseDown = false, lastMouseWindows = 0;
  var mouseWindows = [], mouseSeq = 0, lastMouseKey = null, mouseInFlight = false, mouseTimer = null;
  // Learning from real use, stage 1: a real-use mouse sample being recorded after a verified passkey and the user's
  // yes (background.js). Its own events, from the start message on, never the check buffer above.
  var useRec = null;   // { epoch, until, events }
  var USE_SAMPLE_WINDOWS = 55;
  // capture.offline: the worker cannot reach the gateway, so nothing would be checked: nothing is collected either.
  function capturing() { return !!capture && !capture.paused && !capture.offline && !excluded && !dead && !onGatewayPage(); }
  // A channel the organisation turned off is not collected (capture.off from the worker).
  function channelOn(ch) { return !(capture && capture.off && capture.off[ch]); }
  function offKey() { return capture && capture.off ? (capture.off.keystroke ? "k" : "") + (capture.off.mouse ? "m" : "") : ""; }
  function onGatewayPage() { return !!gatewayOrigin && origin === gatewayOrigin; }
  // Buffers are dropped when capture stops or resumes (the pause, a sign-out) and after a step-up, so no
  // check ever carries anything from around a pause or from before the lock.
  function clearCapture() {
    events = []; lastWindowCount = 0; ksMissed = false; ksPasteMissed = false;
    mouseEvents = []; lastMouseWindows = 0; mouseWindows = []; lastMouseKey = null;
    progress.ks = 0; progress.mouse = 0; reportProgress();
  }
  // How far this page is toward a first verdict: typing windows (the organisation's packet + 1, 21 by
  // default) and mouse windows (60 decide).
  // The worker draws them as the two bars of the toolbar icon. Coalesced: at most one message per 300 ms.
  var progress = { ks: 0, mouse: 0 }, progressSent = "", progressTimer = null;
  function reportProgress() {
    if (progressTimer) return;
    progressTimer = setTimeout(function () {
      progressTimer = null;
      var key = progress.ks + "/" + progress.mouse;
      if (key === progressSent || dead) return;
      progressSent = key;
      safeSend({ type: "cg:progress", ks: progress.ks, mouse: progress.mouse });
    }, 300);
  }
  function setCapture(v) {
    var was = capturing(), wasOff = offKey();
    capture = v && v.kind ? v : null;
    if (capturing() !== was || offKey() !== wasOff) clearCapture();
    if (capture && !mouseTimer) mouseTimer = setInterval(mouseTick, MOUSE_MS);
    if (!capture && mouseTimer) { clearInterval(mouseTimer); mouseTimer = null; }
  }

  // Printable keydowns in the tail stand in for the text length the server gates on (80 chars).
  function isPrintable(kc) { return kc === 32 || (kc >= 48 && kc <= 57) || (kc >= 65 && kc <= 90) || (kc >= 96 && kc <= 111) || (kc >= 186 && kc <= 192) || (kc >= 219 && kc <= 222); }
  // A new keystroke window formed -> one server check (as the SDK), never two in flight.
  function keyCheckMaybe(windowCount) {
    if (!capturing() || windowCount <= lastWindowCount) return;
    if (ksInFlight) { ksMissed = true; return; }
    lastWindowCount = windowCount;
    sendKeyCheck();
  }
  // A paste is judged at once: the server counts the pastes in each field against the organisation's allowance.
  // Waiting for a new typing window (before 2026-10-25) never judged a paste that no typing followed.
  function keyCheckNow() {
    if (!capturing()) return;
    if (ksInFlight) { ksPasteMissed = true; return; }
    sendKeyCheck();
  }
  function sendKeyCheck() {
    ksInFlight = true; ksMissed = false;
    var tail = events.slice(-KS_TAIL);
    var typed = 0;
    for (var i = 0; i < tail.length; i++) if (tail[i].type === "keydown" && isPrintable(tail[i].keyCode)) typed += 1;
    safeSend({ type: "cg:check", channel: "keystroke", sessionId: sessionId, clientTs: performance.now() - t0,
      body: { textLength: typed, keystrokeEvents: tail.map(function (e) {
        return { keyCode: e.keyCode, eventType: e.type, timestampRelative: e.t, fieldName: e.field, fieldType: e.ftype || "unknown", pastedLength: e.pastedLength || 0 };
      }) } }, function (res) {
      ksInFlight = false;
      dlog("[continuum-guard] keystroke check", res);
      if (ksPasteMissed) { ksPasteMissed = false; keyCheckNow(); return; }
      if (ksMissed) { ksMissed = false; var F = globalThis.ContinuumFeatures; if (F) keyCheckMaybe(F.stepsToWindows(F.eventSteps(events)).length); }
    });
  }
  // The last 60 mouse windows, every 1.6 s while the pointer moves (as the SDK).
  function mouseTick() {
    if (!capturing() || lockEl || mouseInFlight || mouseWindows.length < MOUSE_N) return;
    var last = mouseWindows[mouseWindows.length - 1].k;
    if (last === lastMouseKey) return;   // no new movement since the last check
    lastMouseKey = last;
    mouseInFlight = true;
    safeSend({ type: "cg:check", channel: "mouse", sessionId: sessionId, clientTs: performance.now() - t0,
      body: { windows: mouseWindows.map(function (x) { return x.w; }) }, windowKeys: mouseWindows.map(function (x) { return x.k; }) },
      function (res) { mouseInFlight = false; dlog("[continuum-guard] mouse check", res); });
  }

  // The extension context is invalid after a reload/update — accessing chrome.runtime.id then throws.
  // Check it before every chrome call so no uncaught error is ever raised.
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
    for (var w = 0; w < winHandlers.length; w++) {
      try { window.removeEventListener(winHandlers[w][0], winHandlers[w][1], true); } catch (e) {}
    }
    winHandlers = [];
    try { api.runtime.onMessage.removeListener(onMsg); } catch (e) {}
    if (mouseTimer) { try { clearInterval(mouseTimer); } catch (e) {} mouseTimer = null; }
    // Don't leave a stuck lock overlay behind, and clear the injection guard so a fresh content script
    // can take over.
    try { hideLock(); } catch (e) {}
    try { window.__cgGuardActive = false; } catch (e) {}
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

  // ---- the lock overlay: shown while the server's verdict asks for a step-up ----
  var lockEl = null;
  function blockWhileLocked(e) { if (lockEl) { e.stopImmediatePropagation(); e.preventDefault(); } }
  // Registered on WINDOW, so teardown() unbinds them separately; left attached, an orphaned content
  // script would keep input interceptors on the page for as long as the tab lives.
  function onWin(type, fn) { window.addEventListener(type, fn, true); winHandlers.push([type, fn]); }
  onWin("keydown", blockWhileLocked);
  onWin("keyup", blockWhileLocked);
  onWin("beforeinput", blockWhileLocked);
  // pasted: the lock came from more pastes into one field than the organisation allows, not from the rhythm.
  function showLock(pasted) {
    if (lockEl || dead) return;
    if (onGatewayPage() || isAuthOrigin(origin)) {
      // never lock the step-up's own pages, nor a sign-in page a passkey ceremony hands off to
      dlog("[continuum-guard] lock suppressed on the gateway / a sign-in origin: " + origin);
      return;
    }
    lockEl = document.createElement("div");
    lockEl.setAttribute("style",
      "position:fixed;inset:0;z-index:2147483647;background:rgba(2,6,23,.88);backdrop-filter:blur(6px);" +
      "display:flex;align-items:center;justify-content:center;font:15px/1.5 system-ui,sans-serif;color:#e2e8f0;");
    var box = document.createElement("div");
    box.setAttribute("style", "max-width:420px;background:#0f172a;border:1px solid #334155;border-radius:16px;padding:28px 30px;text-align:center;");
    box.innerHTML =
      '<div style="font-size:34px;margin-bottom:10px">🔒</div>' +
      '<div style="font-weight:800;font-size:18px;margin-bottom:8px">Continuum Guard locked this page</div>' +
      '<div style="color:#94a3b8;margin-bottom:18px">' + (pasted ? 'Text was pasted into a field more times than allowed.'
        : 'The recent typing or mouse rhythm does not match your profile.') + ' Verify it&#39;s you to continue.</div>' +
      '<button id="__cgVerifyBtn" style="background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:12px 22px;font:700 15px system-ui;cursor:pointer">Verify with passkey</button>' +
      '<div id="__cgErr" style="display:none;margin-top:16px;padding:12px 14px;border-radius:10px;background:#3f1d1d;border:1px solid #7f1d1d;color:#fecaca;font-size:13px;text-align:left"></div>';
    lockEl.appendChild(box);
    (document.body || document.documentElement).appendChild(lockEl);
    box.querySelector("#__cgVerifyBtn").addEventListener("click", function () {
      var err = lockEl && lockEl.querySelector("#__cgErr");
      if (err) { err.style.display = "none"; }
      var btn = this;
      btn.textContent = "Opening…";
      setTimeout(function () { try { btn.textContent = "Verify with passkey"; } catch (e) {} }, 3000);
      safeSend({ type: "cg:open-verify" });
    });
  }
  // The worker could not reach the gateway, so no step-up window opened. Say so in the overlay: without
  // this the click seemed to do nothing, which looks like the extension itself had broken.
  function showGatewayError(message) {
    if (!lockEl) return;
    var err = lockEl.querySelector("#__cgErr");
    if (!err) return;
    err.textContent = message + ". Check that the Continuum server is running, or its address in the extension's settings, then press the button again.";
    err.style.display = "block";
  }
  function hideLock() { if (lockEl) { try { lockEl.remove(); } catch (e) {} lockEl = null; } }

  // The gateway's pages post their outcome into their own window; this relays it to the worker, which
  // trusts it only when sender.url is the gateway's page (Chrome sets it; a page cannot fake it).
  window.addEventListener("message", function (ev) {
    var d = ev && ev.data;
    if (!d || ev.source !== window) return;
    if (d.type === "continuum-ext-passkey" && d.action === "verify") {
      safeSend(d.ok ? { type: "cg:verified", useOffer: d.useOffer && Number(d.useOffer.expiresInMs) > 0 ? { expiresInMs: Number(d.useOffer.expiresInMs) } : null }
        : { type: "cg:verify-failed" });
    }
    else if (d.type === "continuum-ext-use-consent") safeSend({ type: "cg:use-consent", consent: d.consent === true });
    else if (d.type === "continuum-ext-link") safeSend({ type: "cg:link-code", link: String(d.link || ""), code: String(d.code || "") });
    else if (d.type === "continuum-ext-enrolled") safeSend({ type: "cg:enrolled" });
  });

  // Self-heal: a background tab can miss the cg:unlock broadcast when the passkey is verified elsewhere.
  // When it becomes visible again, re-check the worker's lock and drop a stale overlay (or show one).
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || dead) return;
    safeSend({ type: "cg:hello", origin: origin }, function (res) {
      if (!res) return;
      if (res.gatewayOrigin) gatewayOrigin = res.gatewayOrigin;
      if (!res.locked && lockEl) hideLock();
      else if (res.locked && !lockEl) showLock(res.lockPasted);
    });
  });

  // Identity-provider sign-in origins a passkey ceremony may hand off to ("Sign in again to use passkeys
  // saved in your Google Account"). Never locked, or the unlock itself would deadlock. Kept narrow.
  function isAuthOrigin(o) {
    return o === "https://accounts.google.com" || o === "https://accounts.youtube.com" || o === "https://myaccount.google.com";
  }

  function onMsg(msg) {
    if (dead || !msg) return;
    if (msg.type === "cg:config") {
      excluded = (msg.exclusions || []).indexOf(origin) >= 0;
      if (Array.isArray(msg.excludeTypes)) excludeTypes = msg.excludeTypes;
      if (typeof msg.gatewayOrigin === "string") gatewayOrigin = msg.gatewayOrigin;
      if (typeof msg.debug !== "undefined") debug = !!msg.debug;
      setCapture(msg.capture);
    }
    if (msg.type === "cg:lock") { useRec = null; showLock(msg.pasted); }
    if (msg.type === "cg:unlock") hideLock();
    if (msg.type === "cg:use-sample-start" && msg.epoch) useRec = { epoch: msg.epoch, until: Number(msg.until) || 0, events: [] };
    if (msg.type === "cg:use-sample-stop") useRec = null;
    if (msg.type === "cg:gateway-unreachable") showGatewayError(msg.message || "Can't reach the Continuum server");
    if (msg.type === "cg:reset") clearCapture();   // fresh evidence after a verified step-up
  }

  safeSend({ type: "cg:hello", origin: origin }, function (res) {
    if (res) {
      excluded = !!res.excluded;
      if (Array.isArray(res.excludeTypes)) excludeTypes = res.excludeTypes;
      debug = !!res.debug;
      if (res.gatewayOrigin) gatewayOrigin = res.gatewayOrigin;   // before showLock, so the gateway is never locked
      setCapture(res.capture);
      if (res.locked) showLock(res.lockPasted);   // navigated / reopened while locked
      dlog("[continuum-guard] handshake: capture=" + (capturing() ? "ON" : "OFF") + (capture ? "" : " (not signed in)") + (excluded ? " (site excluded)" : ""));
    } else {
      try { console.warn("[continuum-guard] handshake got NO reply — the service worker did not answer; reload the extension"); } catch (e) {}
    }
  });
  if (alive()) { try { api.runtime.onMessage.addListener(onMsg); } catch (e) { teardown(); } }

  function fieldOf(t) { return t && (t.name || t.id || t.tagName) ? (t.name || t.id || t.tagName) : "page"; }
  function isPassword(t) { return t && t.tagName === "INPUT" && t.type === "password"; }
  function isHidden(t) { return t && t.tagName === "INPUT" && t.type === "hidden"; }
  // A field's type, as the organisation's "fields never watched" names it.
  function typeOf(t) { return !t ? "unknown" : (t.tagName === "INPUT" || t.tagName === "TEXTAREA") ? (t.type || t.tagName).toLowerCase() : t.isContentEditable ? "contenteditable" : String(t.tagName || "unknown").toLowerCase(); }
  function excludedField(t) { return excludeTypes.indexOf(typeOf(t)) >= 0; }

  function rec(type, e) {
    if (dead) return;
    if (!alive()) { teardown(); return; }
    if (!capturing() || !channelOn("keystroke")) return;
    try {
      var tgt = e.target;
      if (isHidden(tgt) || isPassword(tgt) || excludedField(tgt)) return;   // no event at all from a password or excluded field
      events.push({ keyCode: e.keyCode || 0, type: type, t: evtTime(e) - t0, field: fieldOf(tgt), ftype: typeOf(tgt) });
      if (events.length > 2000) {
        // Trimming shrinks the window count, so lastWindowCount must drop with it or no new window
        // would ever be detected again (the verdict would freeze).
        events = events.slice(-1400);
        var F0 = globalThis.ContinuumFeatures;
        lastWindowCount = F0 ? F0.stepsToWindows(F0.eventSteps(events)).length : 0;
      }
      var F = globalThis.ContinuumFeatures;
      if (!F) { if (!rec.warned) { rec.warned = true; console.warn("[continuum-guard] ContinuumFeatures NOT loaded — features.js didn't run"); } return; }
      var nWin = F.stepsToWindows(F.eventSteps(events)).length;
      if (nWin !== progress.ks) { progress.ks = nWin; reportProgress(); }
      keyCheckMaybe(nWin);
    } catch (err) { teardown(); }
  }
  function on(type) { var fn = function (e) { rec(type, e); }; document.addEventListener(type, fn, true); handlers.push([type, fn]); }
  on("keydown");
  on("keyup");
  // A paste, with its LENGTH only: the server refuses pasted text as typing rhythm.
  var onPaste = function (e) {
    if (!capturing() || !channelOn("keystroke") || isHidden(e.target) || isPassword(e.target) || excludedField(e.target)) return;
    var n = 0; try { n = ((e.clipboardData && e.clipboardData.getData("text")) || "").length; } catch (x) {}
    events.push({ keyCode: 0, type: "paste", t: evtTime(e) - t0, field: fieldOf(e.target), ftype: typeOf(e.target), pastedLength: n });
    keyCheckNow();
  };
  document.addEventListener("paste", onPaste, true); handlers.push(["paste", onPaste]);

  // ---- mouse (positions + timing only) ----
  function recMouse(x, y, st, e) {
    if (lockEl || !capturing() || !channelOn("mouse")) return;
    mouseEvents.push({ t: evtTime(e), x: x, y: y, state: st });
    if (useRec) {
      if (Date.now() > useRec.until) useRec = null;
      else {
        useRec.events.push({ t: evtTime(e), x: x, y: y, state: st });
        if (useRec.events.length % 10 === 0) buildUseSample();
      }
    }
    if (mouseEvents.length > 3000) {
      // Same re-basing as the key buffer: without it no new window would be detected again.
      mouseEvents = mouseEvents.slice(-2000);
      var M0 = globalThis.ContinuumMouseFeatures;
      lastMouseWindows = M0 ? M0.stepsToWindows(M0.eventsToSteps(mouseEvents)).length : 0;
    }
    // Mouse events are dense (60–120/s) — rebuild windows every 10th event, not on each.
    if (mouseEvents.length % 10 === 0) buildMouseWindows();
  }
  function buildMouseWindows() {
    var M = globalThis.ContinuumMouseFeatures;
    if (!M || !alive()) return;
    var windows = M.stepsToWindows(M.eventsToSteps(mouseEvents));
    if (windows.length > lastMouseWindows) {
      var fresh = windows.slice(lastMouseWindows);
      for (var i = 0; i < fresh.length; i++) mouseWindows.push({ k: String(mouseSeq++), w: fresh[i] });
      if (mouseWindows.length > MOUSE_N) mouseWindows = mouseWindows.slice(-MOUSE_N);
      if (mouseWindows.length !== progress.mouse) { progress.mouse = mouseWindows.length; reportProgress(); }
    }
    lastMouseWindows = windows.length;
  }
  // The first page to reach a sample's windows sends them; the worker keeps the first and stops the others.
  function buildUseSample() {
    var M = globalThis.ContinuumMouseFeatures;
    if (!M || !useRec || !alive()) return;
    var windows = M.stepsToWindows(M.eventsToSteps(useRec.events));
    if (windows.length < USE_SAMPLE_WINDOWS) return;
    var done = useRec;
    useRec = null;
    safeSend({ type: "cg:use-sample", epoch: done.epoch, windows: windows.slice(0, USE_SAMPLE_WINDOWS) });
  }
  function onM(type, fn) { document.addEventListener(type, fn, true); handlers.push([type, fn]); }
  onM("mousemove", function (e) { recMouse(e.clientX, e.clientY, mouseDown ? "Drag" : "Move", e); });
  onM("mousedown", function (e) { mouseDown = true; recMouse(e.clientX, e.clientY, "Pressed", e); });
  onM("mouseup", function (e) { mouseDown = false; recMouse(e.clientX, e.clientY, "Released", e); });
})();
