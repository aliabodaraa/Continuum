/**
 * Browser port of preprocess_mouse.py — MUST stay byte-compatible so the
 * windows scored live match the windows the model was trained on.
 *
 * Raw event: { t (ms, from evt.timeStamp), x, y, state }
 *   state ∈ "Move" | "Pressed" | "Released" | "Drag"
 * Feature vector F=7: [dx, dy, v, a, dtheta, dt, is_click]
 */
(function () {
  const SCREEN_SCALE = 1920.0;
  // Gaps above this emit NO motion vector. 2.0s was too permissive: a 1-2s reading pause
  // still produced a row with dt clipped to 1.0 and velocity near zero, a pattern absent from
  // both the enrollment pad and the SapiMouse base (unbroken 1-3 min tasks). Kept in sync
  // with extension/src/features-mouse.js — the two must agree or the SDK and the extension
  // extract different features from identical motion.
  const IDLE_SPLIT_SECONDS = 0.5;
  const DT_CLIP_SECONDS = 1.0;
  const WINDOW_SIZE = 50;
  const WINDOW_STRIDE = 10;
  // Minimum movement for a window to be worth scoring (same value as the extension).
  const MIN_WINDOW_PATH = 0.08;

  const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function eventsToSteps(events) {
    const steps = [];
    let prev = null; // {t, x, y}
    let prevV = 0;
    let prevDir = null;
    for (const e of events) {
      if (prev === null) {
        prev = { t: e.t, x: e.x, y: e.y };
        prevDir = null;
        prevV = 0;
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
        prevDir = null;
        prevV = 0;
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
      const v = dist / Math.max(dtMs, 1.0);
      const a = Math.abs(v - prevV);
      const direction = dist > 0 ? Math.atan2(dyPx, dxPx) : (prevDir || 0);
      let dtheta = 0;
      if (prevDir !== null && dist > 0) {
        const d = direction - prevDir;
        dtheta = ((d + Math.PI) % (2 * Math.PI)) - Math.PI;
      }
      const isClick =
        e.state === "Pressed" || e.state === "Released" || e.state === "Drag" ? 1 : 0;

      steps.push([
        clip(dxPx / SCREEN_SCALE, -1, 1),
        clip(dyPx / SCREEN_SCALE, -1, 1),
        Math.log1p(v),
        Math.log1p(a),
        dtheta / Math.PI,
        Math.min(dt, DT_CLIP_SECONDS),
        isClick,
      ]);
      prev = { t: e.t, x: e.x, y: e.y };
      prevV = v;
      if (dist > 0) prevDir = direction;
    }
    return steps;
  }

  // Total normalised distance travelled across a window — how much the pointer actually moved.
  function windowPathLength(win) {
    let s = 0;
    for (let i = 0; i < win.length; i++) s += Math.hypot(win[i][0], win[i][1]);
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
    };
  }

  window.mouseFeatures = {
    eventsToSteps,
    stepsToWindows,
    createMouseTracker,
    WINDOW_SIZE,
    WINDOW_STRIDE,
  };
})();
