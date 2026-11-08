/**
 * Browser port of services/model-api/preprocess_mouse_actions.py.
 *
 * Implements the published mouse-action segmentation and 39-feature set of
 *   M. Antal and E. Egyed-Zsigmond, "Intrusion detection using mouse dynamics",
 *   IET Biometrics 8(5):285-294, 2019.
 *
 * This replaces the fixed 50-step / stride-10 window used by mouse-features.js.
 * Those two numbers came from the KEYSTROKE method of Lu et al. and have no
 * published basis for pointer motion; the mouse literature segments by ACTION.
 *
 * MUST stay numerically identical to the Python module. The window pipeline
 * drifted apart at exactly this seam — the browser filtered events the training
 * data kept, so the deployed model scored a distribution it had never been
 * trained on. tools/action_parity_check.js compares both implementations on the
 * same raw events and fails the build if any feature differs by more than 1e-6.
 *
 * Raw event: { t (ms), x, y, state }  with state in
 *   "Move" | "Pressed" | "Released" | "Drag"
 */
(function () {
  // ---- published parameters (Antal & Egyed-Zsigmond 2019) ------------------
  const ACTION_GAP_SECONDS = 10.0;   // "10 seconds as the time threshold"
  const MIN_EVENTS_PER_ACTION = 4;   // "actions with fewer than 4 events discarded"
  const SHARP_ANGLE_THRESHOLD = Math.PI / 2;

  const ACTION_MM = 1, ACTION_PC = 3, ACTION_DD = 4;

  const FEATURE_NAMES = [];
  ["vx", "vy", "v", "a", "jerk", "omega", "curv"].forEach((s) => {
    ["mean", "std", "min", "max"].forEach((k) => FEATURE_NAMES.push(`${s}_${k}`));
  });
  [
    "action_type", "elapsed_time", "traj_length", "end_to_end_dist",
    "direction_bin", "straightness", "n_points", "sum_of_angles",
    "largest_deviation", "n_sharp_angles", "accel_time_beginning",
  ].forEach((n) => FEATURE_NAMES.push(n));

  /** Segment raw events into [{type, events}] — the paper's two-step rule. */
  function segmentActions(events) {
    const actions = [];
    let current = [];

    for (const e of events) {
      // Step 2 — a gap beyond the threshold ends the movement in progress.
      if (current.length && (e.t - current[current.length - 1].t) / 1000.0 > ACTION_GAP_SECONDS) {
        actions.push({ type: ACTION_MM, events: current });
        current = [];
      }
      current.push(e);

      if (e.state === "Released") {
        // Step 1 — cut at every release. The WHOLE segment is the action: a
        // point-and-click is the travel to the target plus the click, not the
        // press/release pair alone (which is 2 events and would be dropped by
        // the 4-event minimum, deleting every click from the data).
        const prev = current.length >= 2 ? current[current.length - 2].state : null;
        if (prev === "Pressed") {
          actions.push({ type: ACTION_PC, events: current });
        } else if (current.some((q) => q.state === "Drag")) {
          actions.push({ type: ACTION_DD, events: current });
        } else {
          actions.push({ type: ACTION_PC, events: current });
        }
        current = [];
      }
    }
    if (current.length) actions.push({ type: ACTION_MM, events: current });

    return actions.filter((a) => a.events.length >= MIN_EVENTS_PER_ACTION);
  }

  /** mean, std, min, max — matching numpy's population std (ddof=0). */
  function stats(arr) {
    const a = arr.filter((v) => Number.isFinite(v));
    if (!a.length) return [0, 0, 0, 0];
    let sum = 0;
    for (const v of a) sum += v;
    const mean = sum / a.length;
    let ss = 0;
    for (const v of a) ss += (v - mean) * (v - mean);
    return [mean, Math.sqrt(ss / a.length), Math.min.apply(null, a), Math.max.apply(null, a)];
  }

  /** The 39 published features for one action. */
  function actionFeatures(actionType, events) {
    const n = events.length;
    const t = events.map((e) => e.t / 1000.0);          // ms -> s, as in Python
    const x = events.map((e) => e.x);
    const y = events.map((e) => e.y);

    const dt = [], dx = [], dy = [], dist = [];
    for (let i = 1; i < n; i++) {
      let d = t[i] - t[i - 1];
      if (d <= 0) d = 1e-3;                              // duplicate-timestamp guard
      dt.push(d);
      dx.push(x[i] - x[i - 1]);
      dy.push(y[i] - y[i - 1]);
      dist.push(Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]));
    }

    const vx = dx.map((d, i) => d / dt[i]);
    const vy = dy.map((d, i) => d / dt[i]);
    const v = dist.map((d, i) => d / dt[i]);

    const a = [];
    for (let i = 1; i < v.length; i++) a.push((v[i] - v[i - 1]) / dt[i]);
    const jerk = [];
    for (let i = 1; i < a.length; i++) jerk.push((a[i] - a[i - 1]) / dt[i + 1]);

    const theta = dx.map((d, i) => Math.atan2(dy[i], d));
    const dtheta = [];
    for (let i = 1; i < theta.length; i++) {
      let w = theta[i] - theta[i - 1];
      w = ((w + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      dtheta.push(w);
    }
    const omega = dtheta.map((w, i) => w / dt[i + 1]);
    const curv = dtheta.map((w, i) => (dist[i + 1] > 0 ? w / dist[i + 1] : 0));

    const feats = [];
    [vx, vy, v, a, jerk, omega, curv].forEach((s) => {
      stats(s).forEach((q) => feats.push(q));
    });

    let trajLength = 0;
    for (const d of dist) trajLength += d;
    const endToEnd = Math.hypot(x[n - 1] - x[0], y[n - 1] - y[0]);
    const elapsed = t[n - 1] - t[0];
    const direction = Math.atan2(y[n - 1] - y[0], x[n - 1] - x[0]);
    const directionBin = Math.floor((((direction + Math.PI) / (2 * Math.PI)) * 8) % 8);
    const straightness = trajLength > 0 ? endToEnd / trajLength : 0;
    let sumAngles = 0;
    for (const w of dtheta) sumAngles += Math.abs(w);
    let nSharp = 0;
    for (const w of dtheta) if (Math.abs(w) > SHARP_ANGLE_THRESHOLD) nSharp++;

    let largestDev = 0;
    if (endToEnd > 0) {
      const ux = (x[n - 1] - x[0]) / endToEnd, uy = (y[n - 1] - y[0]) / endToEnd;
      for (let i = 0; i < n; i++) {
        const px = x[i] - x[0], py = y[i] - y[0];
        largestDev = Math.max(largestDev, Math.abs(px * uy - py * ux));
      }
    }

    let accelTime = 0;
    if (v.length) {
      let bi = 0;
      for (let i = 1; i < v.length; i++) if (v[i] > v[bi]) bi = i;
      accelTime = t[bi + 1] - t[0];
    }

    feats.push(actionType, elapsed, trajLength, endToEnd, directionBin,
               straightness, n, sumAngles, largestDev, nSharp, accelTime);
    return feats.map((f) => (Number.isFinite(f) ? f : 0));
  }

  /** Raw events -> [{type, features[39]}] */
  function eventsToActions(events) {
    return segmentActions(events).map((a) => ({
      type: a.type,
      features: actionFeatures(a.type, a.events),
    }));
  }

  /** Capture helper: attach to an element and collect raw events. */
  // Viewport coordinates and the event's own timestamp, as mouse-features.js (2026-11-08): relative to a scrolling
  // element's box, a scroll became a fake movement.
  function createActionTracker(el) {
    let events = [];
    let down = false;
    function push(x, y, state, e) {
      events.push({ t: e && typeof e.timeStamp === "number" && e.timeStamp > 0 ? e.timeStamp : performance.now(), x, y, state });
    }
    function onMove(e) {
      push(e.clientX, e.clientY, down ? "Drag" : "Move", e);
    }
    function onDown(e) {
      down = true;
      push(e.clientX, e.clientY, "Pressed", e);
    }
    function onUp(e) {
      down = false;
      push(e.clientX, e.clientY, "Released", e);
    }
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    return {
      getEvents: () => events.slice(),
      reset: () => { events = []; down = false; },
      eventCount: () => events.length,
      actionCount: () => eventsToActions(events).length,
      getActions: () => eventsToActions(events),
    };
  }

  const api = {
    segmentActions, actionFeatures, eventsToActions, createActionTracker,
    FEATURE_NAMES, ACTION_GAP_SECONDS, MIN_EVENTS_PER_ACTION,
    ACTION_MM, ACTION_PC, ACTION_DD,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.mouseActions = api;
})();
