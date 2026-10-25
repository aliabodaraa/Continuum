/**
 * Browser port of preprocess_mouse.py — MUST stay byte-compatible so the
 * windows scored live match the windows the model was trained on.
 *
 * Raw event: { t (ms, from evt.timeStamp), x, y, state }
 *   state ∈ "Move" | "Pressed" | "Released" | "Drag"
 * Feature vector F=2: [|dx|, |dy|] in PIXELS per step -- SapiMouse's best raw representation
 * (Antal, Fejer & Buza, IEEE SACI 2021, Table I), adopted by the pre-registered study in
 * artifacts/repr_arch_study (Experiment A). The step filter below is unchanged; window selection
 * still uses the screen-normalised path, which depends only on |dx| and |dy|, so the windows kept
 * are bit-identical to the ones the model was trained and evaluated on.
 */
(function () {
  const SCREEN_SCALE = 1920.0;
  // Gaps above this emit NO motion vector. 2.0s was too permissive: a 1-2s reading pause
  // still produced a row with dt clipped to 1.0 and velocity near zero, a pattern absent from
  // both the enrollment pad and the SapiMouse base (unbroken 1-3 min tasks). Kept in sync
  // with extension/src/features-mouse.js — the two must agree or the SDK and the extension
  // extract different features from identical motion.
  const IDLE_SPLIT_SECONDS = 0.5;
  const WINDOW_SIZE = 50;
  const WINDOW_STRIDE = 10;
  // Minimum movement for a window to be worth scoring (same value as the extension).
  const MIN_WINDOW_PATH = 0.08;

  function eventsToSteps(events) {
    const steps = [];
    let prev = null; // {t, x, y}
    for (const e of events) {
      if (prev === null) {
        prev = { t: e.t, x: e.x, y: e.y };
        continue;
      }
      const dtMs = e.t - prev.t;
      const dt = dtMs / 1000.0;
      if (dt <= 0) {
        prev = { t: e.t, x: e.x, y: e.y };
        continue;
      }
      if (dt > IDLE_SPLIT_SECONDS) {
        prev = { t: e.t, x: e.x, y: e.y };
        continue;
      }
      const dxPx = e.x - prev.x;
      const dyPx = e.y - prev.y;
      const dist = Math.hypot(dxPx, dyPx);
      // A mousemove that did not move the pointer carries no motion. Browsers emit these in
      // bulk while the page SCROLLS — the cursor is stationary but the element beneath it
      // changes — and each one otherwise becomes an all-zero feature row [0,0,0,0,0,dt,0].
      // Enrollment happens in a small pad that never scrolls, so a profile contains none of
      // them, while the live guard runs on real scrolling pages and fills windows with them.
      // Measured in the extension (same defect, same feature code): 52% of every live window
      // was this filler, which pinned scores near 0.28 with almost no variance and caused
      // constant false locks. Clicks are kept even at zero displacement — their timing is
      // real. prev is deliberately NOT advanced, so the next genuine movement measures
      // dx/dy/dt from the last real position and a long stationary spell still falls to the
      // IDLE_SPLIT rule above.
      if (dist === 0 && e.state !== "Pressed" && e.state !== "Released") continue;
      // Pixels, unclipped: the model reads the magnitude of each step. Clicks at zero
      // displacement stay in the stream as [0, 0], exactly as in training.
      steps.push([Math.abs(dxPx), Math.abs(dyPx)]);
      prev = { t: e.t, x: e.x, y: e.y };
    }
    return steps;
  }

  // Total normalised distance travelled across a window — how much the pointer actually moved.
  function windowPathLength(win) {
    let s = 0;
    // Same value as before the representation change: hypot(clip(dx/1920), clip(dy/1920))
    // depends only on |dx| and |dy|.
    for (let i = 0; i < win.length; i++) {
      s += Math.hypot(Math.min(win[i][0] / SCREEN_SCALE, 1), Math.min(win[i][1] / SCREEN_SCALE, 1));
    }
    return s;
  }

  function stepsToWindows(steps) {
    if (steps.length < WINDOW_SIZE) return [];
    const windows = [];
    for (let s = 0; s + WINDOW_SIZE <= steps.length; s += WINDOW_STRIDE) {
      const win = steps.slice(s, s + WINDOW_SIZE);
      // Skip near-static windows. A window in which the pointer barely moved carries no
      // identity — everyone's "almost still" looks alike — so scoring it only feeds noise
      // into the verdict and drags it toward a false lock. The extension has filtered these
      // since the mouse channel began enforcing; the SDK never did, which is one reason the
      // same model behaves worse here. Kept identical to extension/src/features-mouse.js.
      if (windowPathLength(win) >= MIN_WINDOW_PATH) windows.push(win);
    }
    return windows;
  }

  // A lightweight capture helper: attach to an element, collect raw events.
  function createMouseTracker(el) {
    let events = [];
    let down = false;
    function push(x, y, state) {
      events.push({ t: performance.now(), x, y, state });
    }
    function onMove(e) {
      const r = el.getBoundingClientRect();
      push(e.clientX - r.left, e.clientY - r.top, down ? "Drag" : "Move");
    }
    function onDown(e) {
      down = true;
      const r = el.getBoundingClientRect();
      push(e.clientX - r.left, e.clientY - r.top, "Pressed");
    }
    function onUp(e) {
      down = false;
      const r = el.getBoundingClientRect();
      push(e.clientX - r.left, e.clientY - r.top, "Released");
    }
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    return {
      getEvents: () => events.slice(),
      reset: () => {
        events = [];
        down = false;
      },
      eventCount: () => events.length,
      windowCount: () => stepsToWindows(eventsToSteps(events)).length,
      // Stop listening. A recorder that is done must detach, or it keeps collecting the page's movement
      // (guard.js mouseSampleFlow).
      stop: () => {
        el.removeEventListener("mousemove", onMove);
        el.removeEventListener("mousedown", onDown);
        window.removeEventListener("mouseup", onUp);
      },
    };
  }

  window.mouseFeatures = {
    eventsToSteps,
    stepsToWindows,
    createMouseTracker,
    WINDOW_SIZE,
    WINDOW_STRIDE,
    FEATURES: 2,
    FEATURE_VERSION: "a5-absdxdy-v1",
  };
})();
