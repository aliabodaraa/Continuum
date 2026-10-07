// features-mouse.js — mouse feature builder for the extension. Byte-compatible port of
// sdk/js/mouse-features.js (itself a port of preprocess_mouse.py): the windows built here
// MUST match the windows the mouse base model was trained on.
//
// Raw event: { t (ms), x, y, state }  with state ∈ "Move" | "Pressed" | "Released" | "Drag"
// Feature vector F=2: [|dx|, |dy|] in PIXELS per step -- SapiMouse's best raw representation
// (Antal, Fejer & Buza, IEEE SACI 2021, Table I), adopted by the pre-registered study in
// artifacts/repr_arch_study (Experiment A). The step filter below is unchanged; window selection
// still uses the screen-normalised path, which depends only on |dx| and |dy|, so the windows kept
// are bit-identical to the ones the model was trained and evaluated on.
(function () {
  var SCREEN_SCALE = 1920.0;
  // Gaps above this emit NO motion vector — the pointer was parked, not moving. 2.0s was too
  // permissive: every 1-2s reading pause still produced a row, with dt clipped to 1.0 and
  // velocity near zero. Enrollment (continuous clicking) contains almost no such rows, and
  // neither does the SapiMouse base (unbroken 1-3 min tasks), so live browsing — move, read,
  // move — fed the head a pattern it had never seen. Measured live during real browsing:
  // windows scored 0.25-0.51 (mean ~0.30) against 0.61 for continuous movement in the
  // diagnostic, which is what drives the sustained vote to a false lock.
  // 0.5s removes every such row while costing ~1% of windows (simulated browsing: 184 -> 182),
  // because the stream is NOT broken here — prev is reset and the run continues, so windows
  // simply splice across the pause instead of recording it.
  var IDLE_SPLIT_SECONDS = 0.5;
  var WINDOW_SIZE = 50;
  var WINDOW_STRIDE = 10;
  // Minimum cursor path a window must cover to be scored/trained. The mouse base model is a
  // cursor-TRAJECTORY biometric (SapiMouse) — it only makes sense on windows of real movement.
  // Natural browsing is scroll-dominated with the cursor near-static, producing near-zero-path
  // windows that are out-of-distribution and make the verdict noisy. Grounded in real SapiMouse
  // active windows (path p5=0.10, median 0.41): 0.08 keeps ~98% of genuine movement while
  // dropping idle/scroll-reading windows (still cursor ≈ 0.02, ±3px drift ≈ 0.06).
  var MIN_WINDOW_PATH = 0.08;

  // steps[i] = [|dx|, |dy|] in pixels; path = summed step length in screen widths (1920 px).
  function windowPathLength(win) {
    var s = 0;
    // Same value as before the representation change: hypot(clip(dx/1920), clip(dy/1920))
    // depends only on |dx| and |dy|.
    for (var i = 0; i < win.length; i++) {
      s += Math.hypot(Math.min(win[i][0] / SCREEN_SCALE, 1), Math.min(win[i][1] / SCREEN_SCALE, 1));
    }
    return s;
  }

  function eventsToSteps(events) {
    var steps = [];
    var prev = null;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (prev === null) { prev = { t: e.t, x: e.x, y: e.y }; continue; }
      var dtMs = e.t - prev.t;
      var dt = dtMs / 1000.0;
      if (dt <= 0) { prev = { t: e.t, x: e.x, y: e.y }; continue; }
      if (dt > IDLE_SPLIT_SECONDS) { prev = { t: e.t, x: e.x, y: e.y }; continue; }
      var dxPx = e.x - prev.x;
      var dyPx = e.y - prev.y;
      var dist = Math.hypot(dxPx, dyPx);
      // A mousemove that did not actually move the pointer carries no motion. Chrome emits
      // these in bulk while the page SCROLLS — the cursor is stationary but the element under
      // it changes — and each one used to become an all-zero feature row [0,0,0,0,0,dt,0].
      // Real browsing is full of scrolling, while the enrollment page and the diagnostic page
      // never scroll, so live windows filled with a pattern the model had never been trained
      // on: measured at 52% of all rows inside a window during simulated browsing, versus 0%
      // on either training surface. That is what pinned live scores near 0.28 with almost no
      // variance while the same model scored 0.61 in the diagnostic. Clicks are kept even at
      // zero displacement, since their timing is real. prev is deliberately NOT advanced, so
      // the next genuine movement measures dx/dy/dt from the last real position — a long
      // stationary spell then falls to the IDLE_SPLIT rule above, as it should.
      if (dist === 0 && e.state !== "Pressed" && e.state !== "Released") continue;
      // Pixels, unclipped: the model reads the magnitude of each step. Clicks at zero
      // displacement stay in the stream as [0, 0], exactly as in training.
      steps.push([Math.abs(dxPx), Math.abs(dyPx)]);
      prev = { t: e.t, x: e.x, y: e.y };
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

  // Windows saved by the retired 7-feature extractor stored dx and dy as pixels / 1920 (clipped
  // to +-1), so |dx| and |dy| in pixels come back exactly as |col| * 1920 -- the same conversion
  // ca-service's migration uses, verified against the training pipeline. Current windows pass
  // through unchanged.
  function fromRetired7(windows) {
    if (!Array.isArray(windows) || !windows.length || !windows[0][0] || windows[0][0].length !== 7) return windows;
    return windows.map(function (w) {
      return w.map(function (r) { return [Math.abs(r[0]) * SCREEN_SCALE, Math.abs(r[1]) * SCREEN_SCALE]; });
    });
  }

  globalThis.ContinuumMouseFeatures = {
    eventsToSteps: eventsToSteps,
    stepsToWindows: stepsToWindows,
    fromRetired7: fromRetired7,
    WINDOW_SIZE: WINDOW_SIZE,
    WINDOW_STRIDE: WINDOW_STRIDE,
    FEATURES: 2,
    FEATURE_VERSION: "a5-absdxdy-v1",
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.ContinuumMouseFeatures;
