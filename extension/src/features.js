// features.js — digraph feature extraction, ported verbatim (in behaviour) from the
// server's ca-service/lib/keystrokeSecurity.js. Produces windows of
//   [id1, id2, dwell1, dwell2, dd, ud]
// exactly like the server, so the SAME per-user model can score them on-device.
// Runs entirely in the page's content-script world; nothing here talks to the network.
(function () {
  var WINDOW_SIZE = 50, STRIDE = 10;
  var MIN_DD = 0.015;      // drop event-batching artifacts, not fast typing
  var MIN_DWELL = 0.01;
  // Gaps beyond this are treated as a real composition pause (hard segment break), not
  // rhythm. 1.0s fragmented copy-typing badly: reading a displayed passage naturally means
  // glancing up to read the next phrase before typing it, and those brief glances were
  // getting counted as "pauses" every ~5-6 words (confirmed: 28 segments from one
  // continuous typing session). 2.5s tolerates that glance-and-type rhythm while still
  // treating a genuine multi-second stop (actually pausing to think) as a real break.
  var PAUSE_DD = 2.5;

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  // events: [{ keyCode, type: "keydown"|"keyup", t (ms), field }]
  // A composition pause (dd > PAUSE_DD) is a HARD BREAK, not just a dropped digraph: the
  // steps right before and right after a real pause (stopped to think, then resumed) are
  // a different behavioral moment than sustained typing, so they must never end up in the
  // same 50-step window. Returned as segments (arrays of runs), not one flat array, so
  // stepsToWindows can never slide a window across a pause boundary.
  function eventSteps(events) {
    var lastDown = {}, keyUps = new Map(), downs = [];
    for (var i = 0; i < events.length; i++) {
      var e = events[i], id = e.field + ":" + e.keyCode;
      if (e.type === "keydown") { lastDown[id] = e; downs.push(e); }
      else if (e.type === "keyup") { var d = lastDown[id]; if (d) { keyUps.set(d, e); delete lastDown[id]; } }
    }
    var segments = [], current = [];
    for (var j = 0; j + 1 < downs.length; j++) {
      var a = downs[j], b = downs[j + 1];
      if (a.field !== b.field) continue;                 // digraph must be within one field
      var au = keyUps.get(a), bu = keyUps.get(b);
      if (!au || !bu) continue;
      var dwell1 = (au.t - a.t) / 1000, dwell2 = (bu.t - b.t) / 1000;
      var dd = (b.t - a.t) / 1000, ud = (b.t - au.t) / 1000;
      if (dwell1 < 0 || dwell2 < 0 || dd < 0) continue;
      if (dd < MIN_DD || dwell1 < MIN_DWELL || dwell2 < MIN_DWELL) continue;  // artifact — skip, no break
      if (dd > PAUSE_DD) {                                                    // composition pause — hard break
        if (current.length) { segments.push(current); current = []; }
        continue;
      }
      current.push([clamp01(a.keyCode / 254), clamp01(b.keyCode / 254), dwell1, dwell2, dd, ud]);
    }
    if (current.length) segments.push(current);
    return segments;
  }

  function stepsToWindows(segments) {
    var w = [];
    for (var k = 0; k < segments.length; k++) {
      var steps = segments[k];
      if (steps.length < WINDOW_SIZE) continue;
      for (var s = 0; s + WINDOW_SIZE <= steps.length; s += STRIDE) w.push(steps.slice(s, s + WINDOW_SIZE));
    }
    return w;
  }

  globalThis.ContinuumFeatures = { WINDOW_SIZE: WINDOW_SIZE, eventSteps: eventSteps, stepsToWindows: stepsToWindows };
})();
