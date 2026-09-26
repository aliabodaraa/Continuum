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
  var enabled = true, excluded = false, mouseTracking = true;   // mouseTracking = user toggle (popup)
  // Per-window/per-keystroke diagnostics used to print unconditionally on EVERY page, which
  // buried real page errors under a wall of [continuum-guard] output in every site's DevTools.
  // They are now opt-in (options page -> "Verbose diagnostics"), delivered with the handshake
  // and every cg:config broadcast. Genuine warnings and errors are never gated.
  var debug = false;
  function dlog() { if (!debug) return; try { console.log.apply(console, arguments); } catch (e) {} }
  var origin = location.origin;
  // The fixed relying-party origin that hosts the passkey step-up pages. The lock overlay
  // must NEVER cover this origin (nor, transitively, a sign-in page the ceremony redirects
  // to) — otherwise a locked session can't run the very ceremony that clears the lock,
  // deadlocking the user. Learned from the worker via cg:hello / cg:config below.
  var rpOrigin = "";
  var events = [];              // raw key-timing — stays in THIS page, never sent
  var lastWindowCount = 0;
  var t0 = performance.now();
  var dead = false;
  var handlers = [], winHandlers = [];   // document-level and window-level listeners

  // ---- user-study mode (background.js "USER STUDY MODE", recovery plan T4.3) ----
  // Set by the worker from the options page. The deployed SERVER system then scores this page:
  // the raw key-event tail (key codes and timings; password keys stay masked to 0) and the mouse
  // windows go to the gateway through the worker, as the SDK sends them. The text itself is not
  // sent: checks carry its length. One page visit is one study session.
  var study = null;                       // { participant, condition } or null
  var sessionId = (function () {
    try { var b = new Uint8Array(8); crypto.getRandomValues(b); return "s" + Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join(""); }
    catch (e) { return "s" + Date.now().toString(16) + Math.random().toString(16).slice(2, 10); }
  })();
  var STUDY_MOUSE_N = 60, STUDY_MOUSE_MS = 1600, STUDY_KS_TAIL = 1400;   // as sdk/guard.js
  var lastStudyWindowCount = 0, ksInFlight = false, ksMissed = false;
  var studyMouse = [], mouseSeq = 0, lastStudyMouseKey = null, mouseInFlight = false, studyTimer = null;
  function setStudy(v) {
    study = v && v.participant ? v : null;
    if (study && !studyTimer) studyTimer = setInterval(studyMouseTick, STUDY_MOUSE_MS);
    if (!study && studyTimer) { clearInterval(studyTimer); studyTimer = null; }
  }
  // Printable keydowns in the tail stand in for the text length the server gates on (80 chars).
  function isPrintable(kc) { return kc === 32 || (kc >= 48 && kc <= 57) || (kc >= 65 && kc <= 90) || (kc >= 96 && kc <= 111) || (kc >= 186 && kc <= 192) || (kc >= 219 && kc <= 222); }
  // The study page (enrolment and step-up) is not participant data: no checks from it.
  function onStudyPage() { return !!rpOrigin && origin === rpOrigin; }
  function studyKsMaybe(windowCount) {
    if (!study || onStudyPage() || windowCount <= lastStudyWindowCount) return;
    if (ksInFlight) { ksMissed = true; return; }
    lastStudyWindowCount = windowCount;
    ksInFlight = true; ksMissed = false;
    var tail = events.slice(-STUDY_KS_TAIL);
    var typed = 0;
    for (var i = 0; i < tail.length; i++) if (tail[i].type === "keydown" && isPrintable(tail[i].keyCode)) typed += 1;
    safeSend({ type: "cg:study-check", channel: "keystroke", sessionId: sessionId, clientTs: performance.now() - t0,
      body: { textLength: typed, keystrokeEvents: tail.map(function (e) {
        return { keyCode: e.keyCode, eventType: e.type, timestampRelative: e.t, fieldName: e.field, fieldType: e.ftype || "unknown", pastedLength: e.pastedLength || 0 };
      }) } }, function () {
      ksInFlight = false;
      if (ksMissed) { ksMissed = false; var F = globalThis.ContinuumFeatures; if (F) studyKsMaybe(F.stepsToWindows(F.eventSteps(events)).length); }
    });
  }
  function studyMouseTick() {
    if (!study || dead || lockEl || mouseInFlight || onStudyPage() || studyMouse.length < STUDY_MOUSE_N) return;
    var last = studyMouse[studyMouse.length - 1].k;
    if (last === lastStudyMouseKey) return;   // no new movement since the last check
    lastStudyMouseKey = last;
    mouseInFlight = true;
    safeSend({ type: "cg:study-check", channel: "mouse", sessionId: sessionId, clientTs: performance.now() - t0,
      body: { windows: studyMouse.map(function (x) { return x.w; }) }, windowKeys: studyMouse.map(function (x) { return x.k; }) },
      function () { mouseInFlight = false; });
  }

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
    for (var w = 0; w < winHandlers.length; w++) {
      try { window.removeEventListener(winHandlers[w][0], winHandlers[w][1], true); } catch (e) {}
    }
    winHandlers = [];
    try { api.runtime.onMessage.removeListener(onMsg); } catch (e) {}
    if (studyTimer) { try { clearInterval(studyTimer); } catch (e) {} studyTimer = null; }
    // Don't leave a stuck lock overlay behind (e.g. after an extension reload invalidates
    // this script), and clear the injection guard so a fresh content script can take over.
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

  // ---- enforcement overlay: shown when the worker declares the session suspicious ----
  var lockEl = null;
  function blockWhileLocked(e) { if (lockEl) { e.stopImmediatePropagation(); e.preventDefault(); } }
  // Registered on WINDOW, so teardown() — which only walks the document-level handlers — has
  // to unbind them separately. Left attached, an orphaned content script from a previous
  // extension version keeps input interceptors on the page for as long as the tab lives.
  function onWin(type, fn) { window.addEventListener(type, fn, true); winHandlers.push([type, fn]); }
  onWin("keydown", blockWhileLocked);
  onWin("keyup", blockWhileLocked);
  onWin("beforeinput", blockWhileLocked);
  function showLock(hasPasskey) {
    if (lockEl || dead) return;
    if ((rpOrigin && origin === rpOrigin) || isAuthOrigin(origin)) {
      // never lock the step-up ceremony's own pages, nor a sign-in page it hands off to —
      // otherwise a locked session can't run the ceremony that clears the lock.
      dlog("[continuum-guard] lock suppressed on step-up/sign-in origin: " + origin);
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
      '<div style="color:#94a3b8;margin-bottom:18px">The recent typing rhythm does not match the enrolled profile. Verify it&#39;s you to continue.</div>' +
      '<button id="__cgVerifyBtn" style="background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:12px 22px;font:700 15px system-ui;cursor:pointer">' +
      (hasPasskey ? "Verify with passkey" : "Set up your passkey") + "</button>" +
      '<div id="__cgErr" style="display:none;margin-top:16px;padding:12px 14px;border-radius:10px;background:#3f1d1d;border:1px solid #7f1d1d;color:#fecaca;font-size:13px;text-align:left"></div>';
    lockEl.appendChild(box);
    (document.body || document.documentElement).appendChild(lockEl);
    box.querySelector("#__cgVerifyBtn").addEventListener("click", function () {
      var err = lockEl && lockEl.querySelector("#__cgErr");
      if (err) { err.style.display = "none"; }
      this.textContent = "Opening…";
      var btn = this;
      setTimeout(function () { try { btn.textContent = hasPasskey ? "Verify with passkey" : "Set up your passkey"; } catch (e) {} }, 3000);
      safeSend({ type: hasPasskey ? "cg:open-verify" : "cg:open-register" });
    });
  }

  // The worker could not reach the passkey service, so no ceremony window was opened. Say so
  // inside the overlay: without this the click appeared to do nothing at all (or flashed a
  // "site can't be reached" tab), which is indistinguishable from the extension being broken.
  function showRpError(rpBase, reason) {
    if (!lockEl) return;
    var err = lockEl.querySelector("#__cgErr");
    if (!err) return;
    err.textContent = "Can't reach the verification service at " + rpBase + " (" + reason + "). "
      + "Start the passkey service, or set the correct address in the extension's Options, then press the button again.";
    err.style.display = "block";
  }
  function hideLock() { if (lockEl) { try { lockEl.remove(); } catch (e) {} lockEl = null; } }

  // RP page (fixed Continuum passkey origin) posts its outcome into its own window; the
  // content script running there relays it to the worker, which checks sender.url === RP.
  window.addEventListener("message", function (ev) {
    var d = ev && ev.data;
    if (!d || d.type !== "continuum-ext-passkey") return;
    if (!d.ok) { if (d.action === "verify") safeSend({ type: "cg:verify-failed" }); return; }
    safeSend({ type: d.action === "register" ? "cg:passkey-registered" : "cg:verified" });
  });

  // Self-heal: a background tab (esp. in another window) can miss the cg:unlock broadcast
  // when the passkey is resolved elsewhere. When it becomes visible again, re-check the
  // worker's lock state and drop a now-stale overlay (or show one if it locked meanwhile).
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || dead) return;
    safeSend({ type: "cg:hello", origin: origin }, function (res) {
      if (!res) return;
      if (res.rpOrigin) rpOrigin = res.rpOrigin;
      if (!res.locked && lockEl) hideLock();
      else if (res.locked && !lockEl) showLock(!!res.hasPasskey);
    });
  });

  // Identity-provider sign-in origins a passkey ceremony may hand off to. Excluded from the
  // lock so a synced-passkey redirect ("Sign in again to use passkeys saved in your Google
  // Account") isn't itself blocked, which would deadlock the unlock. Kept narrow: the IdP
  // sign-in host only, not arbitrary Google properties.
  function isAuthOrigin(o) {
    // Google's sign-in / account origins a synced-passkey ceremony can redirect to.
    return o === "https://accounts.google.com" || o === "https://accounts.youtube.com"
      || o === "https://myaccount.google.com";
  }

  function onMsg(msg) {
    if (dead) return;
    if (msg && msg.type === "cg:config") { if (typeof msg.study !== "undefined") setStudy(msg.study); enabled = msg.enabled !== false; excluded = (msg.exclusions || []).indexOf(origin) >= 0; if (typeof msg.mouseTracking !== "undefined") mouseTracking = msg.mouseTracking !== false; if (msg.rpOrigin) rpOrigin = msg.rpOrigin; if (typeof msg.debug !== "undefined") debug = !!msg.debug; }
    if (msg && msg.type === "cg:lock") showLock(!!msg.hasPasskey);
    if (msg && msg.type === "cg:unlock") hideLock();
    if (msg && msg.type === "cg:rp-unreachable") showRpError(msg.rpBase || "the configured address", msg.reason || "unreachable");
    if (msg && msg.type === "cg:reset") {
      // Fresh packet after a verified step-up: drop buffered timings so counting
      // restarts from zero instead of replaying pre-lock windows.
      events = [];
      lastWindowCount = 0;
      mouseEvents = [];
      lastMouseWindows = 0;
      lastStudyWindowCount = 0; ksMissed = false; studyMouse = []; lastStudyMouseKey = null;
      safeSend({ type: "cg:activity", steps: 0, need: (globalThis.ContinuumFeatures || {}).WINDOW_SIZE || 50 });
    }
  }

  safeSend({ type: "cg:hello", origin: origin }, function (res) {
    if (res) {
      enabled = res.enabled !== false;
      excluded = !!res.excluded;
      if (typeof res.mouseTracking !== "undefined") mouseTracking = res.mouseTracking !== false;
      debug = !!res.debug;
      if (res.rpOrigin) rpOrigin = res.rpOrigin;    // set before showLock so the RP guard applies
      setStudy(res.study);
      if (res.locked) showLock(!!res.hasPasskey);   // navigated / reopened while locked
      // The ACTIVE log below prints before this reply lands, so it can only show the
      // optimistic defaults. This is the authoritative line: if capture is off, it says why.
      if (debug) try {
        console.log("[continuum-guard] handshake: capture=" + (enabled && !excluded ? "ON" : "OFF")
          + " (enabled=" + enabled + ", excluded=" + excluded + ", mouseTracking=" + mouseTracking + ")"
          + (enabled ? "" : " — no modality trained for this account, or account not resolved yet"));
      } catch (e) {}
    } else {
      try { console.warn("[continuum-guard] handshake got NO reply — the service worker did not answer; reload the extension"); } catch (e) {}
    }
  });
  if (alive()) { try { api.runtime.onMessage.addListener(onMsg); } catch (e) { teardown(); } }

  function fieldOf(t) { return t && (t.name || t.id || t.tagName) ? (t.name || t.id || t.tagName) : "page"; }
  function isPassword(t) { return t && t.tagName === "INPUT" && t.type === "password"; }
  function isHidden(t) { return t && t.tagName === "INPUT" && t.type === "hidden"; }

  function rec(type, e) {
    if (!rec.fired) { rec.fired = true; dlog("[continuum-guard] FIRST key event (" + type + ") — listener works; field=" + (e.target && (e.target.name || e.target.id || e.target.tagName))); }
    if (dead) return;
    if (!alive()) { teardown(); return; }
    if (!enabled || excluded) return;
    try {
      var tgt = e.target;
      if (isHidden(tgt)) return;
      var kc = isPassword(tgt) ? 0 : (e.keyCode || 0);   // mask the KEY on password fields
      events.push({ keyCode: kc, type: type, t: performance.now() - t0, field: fieldOf(tgt), ftype: (tgt && (tgt.type || tgt.tagName)) || "unknown" });
      if (events.length > 2000) {
        // Same re-basing as the mouse buffer: trimming shrinks the window count, so
        // lastWindowCount must drop with it or new windows stop being emitted (verdict freeze).
        events = events.slice(-1400);
        var F0 = globalThis.ContinuumFeatures;
        lastWindowCount = F0 ? F0.stepsToWindows(F0.eventSteps(events)).length : 0;
        lastStudyWindowCount = lastWindowCount;
      }
      emit();
    } catch (err) { teardown(); }
  }

  var warnedNoF = false;
  function emit() {
    var F = globalThis.ContinuumFeatures;
    if (!F) { if (!warnedNoF) { warnedNoF = true; console.warn("[continuum-guard] ContinuumFeatures NOT loaded — features.js didn't run; capture can't build windows"); } return; }
    var segments = F.eventSteps(events);           // array of pause-separated step runs
    var windows = F.stepsToWindows(segments);
    studyKsMaybe(windows.length);   // study mode: a new window formed -> server check (as the SDK)
    // Progress toward the NEXT window only cares about the CURRENT run — a pause starts
    // a fresh one, so the counter resets after a real pause instead of counting through it.
    var curSteps = segments.length ? segments[segments.length - 1].length : 0;
    if (debug && events.length % 20 === 0) dlog("[continuum-guard] keys=" + events.length + " steps=" + curSteps + "/" + F.WINDOW_SIZE + " windows=" + windows.length);
    // Live progress so the popup shows capture is working before a full window forms.
    safeSend({ type: "cg:activity", steps: curSteps, need: F.WINDOW_SIZE });
    if (windows.length > lastWindowCount) {
      lastWindowCount = windows.length;
      var latest = windows[windows.length - 1];
      // DIAGNOSTIC: per-feature min/mean/max for this LIVE window, so it can be compared
      // directly against the enrollment wizard's logged stats (same format, this page's
      // own DevTools console, F12) to spot any real discrepancy between enrolled data and
      // what's actually being scored.
      if (debug) try {
        var mn = [Infinity, Infinity, Infinity, Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity, -Infinity, -Infinity, -Infinity], sm = [0, 0, 0, 0, 0, 0];
        latest.forEach(function (row) { for (var c = 0; c < 6; c++) { if (row[c] < mn[c]) mn[c] = row[c]; if (row[c] > mx[c]) mx[c] = row[c]; sm[c] += row[c]; } });
        console.log("[continuum-guard/diag] live-window min:", mn.map(function (v) { return Number(v.toFixed(3)); }), "mean:", sm.map(function (v) { return Number((v / latest.length).toFixed(3)); }), "max:", mx.map(function (v) { return Number(v.toFixed(3)); }));
      } catch (e) {}
      // Only the newest window of TIMING features — never the characters.
      safeSend({ type: "cg:windows", origin: origin, latest: latest });
    }
  }

  function on(type) { var fn = function (e) { rec(type, e); }; document.addEventListener(type, fn, true); handlers.push([type, fn]); }
  on("keydown");
  on("keyup");
  // Study mode only: a paste event with its LENGTH (the server refuses pasted text as rhythm).
  var onPaste = function (e) {
    if (!study || dead || !enabled || excluded || isHidden(e.target)) return;
    var n = 0; try { n = ((e.clipboardData && e.clipboardData.getData("text")) || "").length; } catch (x) {}
    events.push({ keyCode: 0, type: "paste", t: performance.now() - t0, field: fieldOf(e.target), ftype: (e.target && (e.target.type || e.target.tagName)) || "unknown", pastedLength: n });
  };
  document.addEventListener("paste", onPaste, true); handlers.push(["paste", onPaste]);

  // ---- mouse capture (positions + timing only — same privacy story as keys) ----
  var mouseEvents = [], mouseDown = false, lastMouseWindows = 0;
  function recMouse(x, y, st) {
    if (dead || !enabled || excluded || lockEl || !mouseTracking) return;
    mouseEvents.push({ t: performance.now(), x: x, y: y, state: st });
    if (mouseEvents.length > 3000) {
      // Trimming the event buffer shrinks the window count computed from it. lastMouseWindows
      // is compared against that count to detect a NEW window, so it must be re-based to the
      // trimmed buffer's count — otherwise it stays stuck high, windows.length never exceeds
      // it again, and no further windows are ever emitted (the mouse verdict freezes).
      mouseEvents = mouseEvents.slice(-2000);
      var M0 = globalThis.ContinuumMouseFeatures;
      lastMouseWindows = M0 ? M0.stepsToWindows(M0.eventsToSteps(mouseEvents)).length : 0;
    }
    // Mouse events are dense (60–120/s) — rebuild windows every 10th event, not on each.
    if (mouseEvents.length % 10 === 0) emitMouse();
  }
  function emitMouse() {
    var M = globalThis.ContinuumMouseFeatures;
    if (!M || !alive()) return;
    var steps = M.eventsToSteps(mouseEvents);
    var windows = M.stepsToWindows(steps);
    if (debug && mouseEvents.length % 40 === 0) dlog("[continuum-guard] mouse events=" + mouseEvents.length + " steps=" + steps.length + " windows=" + windows.length + " (needs " + M.WINDOW_SIZE + " steps + path>=0.08 to qualify a window)");
    if (windows.length > lastMouseWindows) {
      if (study) {
        var fresh = windows.slice(lastMouseWindows);
        for (var fi = 0; fi < fresh.length; fi++) studyMouse.push({ k: String(mouseSeq++), w: fresh[fi] });
        if (studyMouse.length > STUDY_MOUSE_N) studyMouse = studyMouse.slice(-STUDY_MOUSE_N);
      }
      lastMouseWindows = windows.length;
      var latest = windows[windows.length - 1];
      if (debug) try {
        var path = 0; for (var i = 0; i < latest.length; i++) path += Math.hypot(latest[i][0], latest[i][1]);
        console.log("[continuum-guard/diag] new mouse window #" + windows.length + " path=" + path.toFixed(3) + " (min 0.08 to qualify — this one did)");
      } catch (e) {}
      safeSend({ type: "cg:windows-mouse", origin: origin, latest: latest });
    }
  }
  function onM(type, fn) { document.addEventListener(type, fn, true); handlers.push([type, fn]); }
  onM("mousemove", function (e) { recMouse(e.clientX, e.clientY, mouseDown ? "Drag" : "Move"); });
  onM("mousedown", function (e) { mouseDown = true; recMouse(e.clientX, e.clientY, "Pressed"); });
  onM("mouseup", function (e) { mouseDown = false; recMouse(e.clientX, e.clientY, "Released"); });
  dlog("[continuum-guard] content script ACTIVE on " + origin + " — features.js: " + (globalThis.ContinuumFeatures ? "loaded" : "MISSING") + ", enabled=" + enabled + ", excluded=" + excluded);
})();
