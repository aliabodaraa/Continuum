/*
 * mouse-ca.js — live mouse continuous-authentication guard.
 *
 * Drop-in on any authenticated app page (needs mouse-features.js + the
 * SimpleWebAuthn browser lib also loaded). It:
 *   1. adds a "Mouse guard" toggle to the page nav (persisted in localStorage),
 *   2. tracks mouse movement/clicks across the whole document,
 *   3. every CHECK_MS posts the recent windows to /api/mouse/check,
 *   4. on a suspicious verdict, opens a passkey step-up modal (reusing the
 *      exact WebAuthn flow + the shared continuousAuthLocked session flag).
 *
 * It is self-contained: it injects its own modal, so it works on pages that
 * don't already have the keystroke passkey UI (dashboard, profile).
 */
(function () {
  "use strict";

  // Guard against double-initialization (script included twice → two loops,
  // two modals firing on the same verdict).
  if (window.__mouseCaLoaded) return;
  window.__mouseCaLoaded = true;

  const CHECK_MS = 1600; // one decision every ~1.6s of activity
  // The server decides on its last VOTE_N windows (60 = ~17 s of movement; /api/mouse/status
  // reports it) and reports warm-up until it has them, so sending fewer would leave every check in
  // warm-up for good. Both are replaced by the server's value at init.
  let SEND_WINDOWS = 60; // rolling tail sent to the server
  let MIN_WINDOWS = 60; // below this is warm-up
  const LS_KEY = "mouseGuardEnabled";

  const MF = window.mouseFeatures;
  if (!MF || typeof MF.createMouseTracker !== "function") {
    console.warn("[mouse-ca] mouse-features.js not loaded — guard disabled");
    return;
  }

  let enabled = localStorage.getItem(LS_KEY) === "1";
  // Track on the root <html> element (document.documentElement) — it has
  // getBoundingClientRect (document does NOT) and mousemove/mousedown from
  // anywhere on the page bubble up to it, so we capture motion page-wide.
  let tracker = MF.createMouseTracker(document.documentElement);
  let lastStatus = ""; // "warming" | "ok" | ""
  let timer = null;
  let inFlight = false;
  let locked = false; // a passkey challenge is open
  let enrolled = null; // null=unknown, true/false once /status resolves
  let toggleEl = null;

  // ---------- passkey step-up modal (self-injected) ----------
  function ensureModal() {
    if (document.getElementById("mouseCaModal")) return;
    const wrap = document.createElement("div");
    wrap.id = "mouseCaModal";
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:9999;display:none;align-items:center;" +
      "justify-content:center;background:rgba(15,23,42,.55);backdrop-filter:blur(3px)";
    wrap.innerHTML =
      '<div style="background:#fff;border-radius:16px;padding:28px 32px;max-width:420px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.35);font-family:inherit">' +
      '<div style="font-size:19px;font-weight:800;color:#0f172a;margin-bottom:8px">Identity Verification Required</div>' +
      '<div style="font-size:14px;color:#475569;line-height:1.6;margin-bottom:6px">Your <b>mouse movement</b> no longer matches your trained profile.</div>' +
      '<div style="font-size:13px;color:#64748b;margin-bottom:18px">Verify with your passkey to continue. This session is paused until you do.</div>' +
      '<button id="mouseCaVerify" style="width:100%;background:#4f46e5;color:#fff;border:none;' +
      'border-radius:10px;padding:13px;font-size:15px;font-weight:700;cursor:pointer">Verify with Passkey</button>' +
      '<div id="mouseCaErr" style="display:none;font-size:12px;color:#dc2626;margin-top:10px"></div>' +
      "</div>";
    document.body.appendChild(wrap);
    document.getElementById("mouseCaVerify").addEventListener("click", stepUp);
  }

  // Another passkey step-up (e.g. the keystroke CA's #passkeyModal on the Write
  // page) already open? Don't stack a second popup — the shared session lock is
  // resolved by whichever one the user completes.
  function otherPasskeyOpen() {
    const ks = document.getElementById("passkeyModal");
    return ks && getComputedStyle(ks).display !== "none";
  }

  function showModal() {
    if (otherPasskeyOpen()) return; // defer to the already-visible challenge
    ensureModal();
    document.getElementById("mouseCaModal").style.display = "flex";
  }
  function hideModal() {
    const m = document.getElementById("mouseCaModal");
    if (m) m.style.display = "none";
  }

  function getWebAuthn() {
    const w = window.SimpleWebAuthnBrowser;
    if (!w || typeof w.startAuthentication !== "function") {
      throw new Error("Passkey library not loaded on this page");
    }
    return w;
  }

  async function stepUp() {
    const btn = document.getElementById("mouseCaVerify");
    const err = document.getElementById("mouseCaErr");
    err.style.display = "none";
    btn.disabled = true;
    btn.textContent = "Verifying…";
    try {
      const { userId } = await fetch("/api/auth/me").then((r) => r.json());
      const optRes = await fetch("/api/webauthn/auth/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const options = await optRes.json();
      if (!optRes.ok) throw new Error(options.error || "Could not start verification");
      const assertion = await getWebAuthn().startAuthentication(options);
      const verRes = await fetch("/api/webauthn/auth/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, challengeId: options.challengeId, assertion }),
      });
      const verData = await verRes.json();
      if (!verRes.ok) throw new Error(verData.error || "Passkey verification failed");
      // Verified — clear the tracker so the intruder's motion doesn't linger,
      // unlock, and resume monitoring from a clean slate.
      tracker.reset();
      locked = false;
      hideModal();
    } catch (e) {
      err.textContent = e.message || "Verification failed";
      err.style.display = "block";
    } finally {
      btn.disabled = false;
      btn.textContent = "Verify with Passkey";
    }
  }

  // ---------- the check loop ----------
  let lastEventCount = 0; // events captured at the previous check
  let idleTicks = 0;

  async function tick() {
    if (!enabled || inFlight || locked) return;

    // Only check when the mouse has ACTUALLY moved since last time. Firing on a
    // fixed timer while the pointer is still wastes requests, re-scores stale
    // windows, and needlessly ships motion data. If nothing new arrived, skip.
    const eventCount = tracker.eventCount ? tracker.eventCount() : tracker.getEvents().length;
    const newEvents = eventCount - lastEventCount;
    lastEventCount = eventCount;
    if (newEvents <= 0) {
      idleTicks += 1;
      // After a while idle, show "idle" so the toggle doesn't look stuck.
      if (idleTicks === 3) {
        lastStatus = "idle";
        updateToggle();
      }
      return;
    }
    idleTicks = 0;

    let windows;
    try {
      windows = MF.stepsToWindows(MF.eventsToSteps(tracker.getEvents()));
    } catch (e) {
      return;
    }
    if (!windows || windows.length < MIN_WINDOWS) {
      // Still gathering the first packet — show live progress.
      lastStatus = "warming:" + (windows ? windows.length : 0);
      updateToggle();
      return;
    }
    inFlight = true;
    try {
      const r = await fetch("/api/mouse/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windows: windows.slice(-SEND_WINDOWS) }),
      });
      const d = await r.json();
      if (d && d.enrolled === false) {
        // No mouse model — the guard can't run; turn it off cleanly.
        enrolled = false;
        setEnabled(false);
        return;
      }
      if (d && d.requiresPasskeyChallenge) {
        // Only a SUSTAINED suspicious streak (server-debounced) reaches here.
        if (otherPasskeyOpen()) {
          // The keystroke guard already owns a passkey challenge for the SAME
          // session lock. Let it resolve — but do NOT latch our own `locked`
          // here: our modal never opens (we defer), so our stepUp() would never
          // run to clear it, and tick() would bail on `locked` forever, freezing
          // the mouse guard even after the keystroke passkey unlocks the session.
          lastStatus = "deferred";
        } else {
          locked = true;
          showModal();
        }
      } else if (d && d.isSuspicious) {
        // Suspicious but below the strike threshold — building suspicion, no
        // lock yet. Surface it so the toggle shows momentum without a popup.
        lastStatus = "warn:" + (d.suspiciousStreak || 1) + "/" + (d.strikesToLock || 1);
      } else if (d && d.checked) {
        // A clean verdict means the session is no longer locked (server-side),
        // so drop any stale lock and resume normal monitoring.
        locked = false;
        lastStatus = "ok:" + Math.round((d.meanScore || 0) * 100);
      }
      updateToggle();
    } catch (e) {
      /* transient network/model error — skip this tick */
    } finally {
      inFlight = false;
    }
  }

  function start() {
    stop();
    tracker.reset();
    timer = setInterval(tick, CHECK_MS);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function setEnabled(on) {
    enabled = !!on;
    localStorage.setItem(LS_KEY, enabled ? "1" : "0");
    if (enabled) start();
    else {
      stop();
      locked = false;
      hideModal();
    }
    updateToggle();
  }

  // ---------- the header toggle ----------
  function updateToggle() {
    if (!toggleEl) return;
    const off = enrolled === false;
    toggleEl.disabled = off;
    toggleEl.title = off
      ? "Enroll your mouse first to use the guard"
      : "Toggle live mouse continuous-authentication";
    const on = enabled && !off;
    toggleEl.style.background = on ? "rgba(34,197,94,.18)" : "rgba(255,255,255,.06)";
    toggleEl.style.borderColor = on ? "rgba(34,197,94,.6)" : "rgba(255,255,255,.18)";
    toggleEl.style.color = on ? "#86efac" : "rgba(255,255,255,.85)";
    toggleEl.style.opacity = off ? "0.5" : "1";
    let tail = "";
    if (on) {
      if (lastStatus.startsWith("warming:")) {
        tail = ' · <span style="opacity:.85">warming ' + lastStatus.split(":")[1] + "/" + MIN_WINDOWS + "</span>";
      } else if (lastStatus.startsWith("ok:")) {
        tail = ' · <span style="opacity:.9">👁 ' + lastStatus.split(":")[1] + "%</span>";
      } else if (lastStatus.startsWith("warn:")) {
        tail = ' · <span style="color:#fcd34d">⚠ ' + lastStatus.split(":")[1] + "</span>";
      } else if (lastStatus === "idle") {
        tail = ' · <span style="opacity:.6">idle</span>';
      } else {
        tail = ' · <span style="opacity:.85">watching…</span>';
      }
    }
    toggleEl.innerHTML =
      '<span style="font-size:13px">🖱</span> Guard: <b>' +
      (off ? "N/A" : on ? "ON" : "OFF") +
      "</b>" +
      tail;
  }

  function injectToggle() {
    const nav =
      document.querySelector(".navbar-right") ||
      document.querySelector(".nav-right") ||
      document.querySelector("nav");
    if (!nav) return;
    toggleEl = document.createElement("button");
    toggleEl.id = "mouseGuardToggle";
    toggleEl.type = "button";
    toggleEl.style.cssText =
      "display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.18);" +
      "border-radius:8px;padding:7px 12px;font-size:13px;font-weight:600;cursor:pointer;" +
      "background:rgba(255,255,255,.06);color:rgba(255,255,255,.85);font-family:inherit";
    toggleEl.addEventListener("click", () => {
      if (enrolled === false) return;
      setEnabled(!enabled);
    });
    // place it as the first nav control
    nav.insertBefore(toggleEl, nav.firstChild);
    updateToggle();
  }

  // ---------- init ----------
  function init() {
    injectToggle();
    fetch("/api/mouse/status")
      .then((r) => (r.ok ? r.json() : { enrolled: false }))
      .then((d) => {
        enrolled = !!d.enrolled;
        if (d.voteN) { SEND_WINDOWS = d.voteN; MIN_WINDOWS = d.voteN; }
        updateToggle();
        if (enabled && enrolled) start();
        else if (enabled && !enrolled) setEnabled(false);
      })
      .catch(() => {
        enrolled = false;
        updateToggle();
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
