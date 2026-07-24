// features-mouse.js — mouse feature builder for the extension. Byte-compatible port of
// sdk/js/mouse-features.js (itself a port of preprocess_mouse.py): the windows built here
// MUST match the windows the mouse base model was trained on.
//
// Raw event: { t (ms), x, y, state }  with state ∈ "Move" | "Pressed" | "Released" | "Drag"
// Feature vector F=7: [dx, dy, v, a, dtheta, dt, is_click]
(function () {
  var SCREEN_SCALE = 1920.0;
  var IDLE_SPLIT_SECONDS = 2.0;
  var DT_CLIP_SECONDS = 1.0;
  var WINDOW_SIZE = 50;
  var WINDOW_STRIDE = 10;
  // Minimum cursor path a window must cover to be scored/trained. The mouse base model is a
  // cursor-TRAJECTORY biometric (SapiMouse) — it only makes sense on windows of real movement.
  // Natural browsing is scroll-dominated with the cursor near-static, producing near-zero-path
  // windows that are out-of-distribution and make the verdict noisy. Grounded in real SapiMouse
  // active windows (path p5=0.10, median 0.41): 0.08 keeps ~98% of genuine movement while
  // dropping idle/scroll-reading windows (still cursor ≈ 0.02, ±3px drift ≈ 0.06).
  var MIN_WINDOW_PATH = 0.08;

  function clip(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // dx, dy are steps[i][0], steps[i][1] (screen-fraction displacement); path = summed magnitude.
  function windowPathLength(win) {
    var s = 0;
    for (var i = 0; i < win.length; i++) s += Math.hypot(win[i][0], win[i][1]);
    return s;
  }

  function eventsToSteps(events) {
    var steps = [];
    var prev = null, prevV = 0, prevDir = null;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (prev === null) { prev = { t: e.t, x: e.x, y: e.y }; prevDir = null; prevV = 0; continue; }
      var dtMs = e.t - prev.t;
      var dt = dtMs / 1000.0;
      if (dt <= 0) { prev = { t: e.t, x: e.x, y: e.y }; continue; }
      if (dt > IDLE_SPLIT_SECONDS) { prev = { t: e.t, x: e.x, y: e.y }; prevDir = null; prevV = 0; continue; }
      var dxPx = e.x - prev.x;
      var dyPx = e.y - prev.y;
      var dist = Math.hypot(dxPx, dyPx);
      var v = dist / Math.max(dtMs, 1.0);
      var a = Math.abs(v - prevV);
      var direction = dist > 0 ? Math.atan2(dyPx, dxPx) : (prevDir || 0);
      var dtheta = 0;
      if (prevDir !== null && dist > 0) {
        var d = direction - prevDir;
        dtheta = ((d + Math.PI) % (2 * Math.PI)) - Math.PI;
      }
      var isClick = (e.state === "Pressed" || e.state === "Released" || e.state === "Drag") ? 1 : 0;
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
    var windows = [];
    for (var s = 0; s + WINDOW_SIZE <= steps.length; s += WINDOW_STRIDE) {
      var win = steps.slice(s, s + WINDOW_SIZE);
      if (windowPathLength(win) >= MIN_WINDOW_PATH) windows.push(win);   // skip near-static (idle/scroll) windows
    }
    return windows;
  }

  globalThis.ContinuumMouseFeatures = {
    eventsToSteps: eventsToSteps,
    stepsToWindows: stepsToWindows,
    WINDOW_SIZE: WINDOW_SIZE,
    WINDOW_STRIDE: WINDOW_STRIDE,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.ContinuumMouseFeatures;
