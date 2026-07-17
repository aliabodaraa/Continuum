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
  const IDLE_SPLIT_SECONDS = 2.0;
  const DT_CLIP_SECONDS = 1.0;
  const WINDOW_SIZE = 50;
  const WINDOW_STRIDE = 10;

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

  function stepsToWindows(steps) {
    if (steps.length < WINDOW_SIZE) return [];
    const windows = [];
    for (let s = 0; s + WINDOW_SIZE <= steps.length; s += WINDOW_STRIDE) {
      windows.push(steps.slice(s, s + WINDOW_SIZE));
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
