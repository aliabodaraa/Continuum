// features.js — digraph feature extraction, ported verbatim (in behaviour) from the
// server's ca-service/lib/keystrokeSecurity.js. Produces windows of
//   [id1, id2, dwell1, dwell2, dd, ud]
// exactly like the server, so the SAME per-user model can score them on-device.
// Runs entirely in the page's content-script world; nothing here talks to the network.
(function () {
  var WINDOW_SIZE = 50, STRIDE = 10;
  var MIN_DD = 0.015;      // drop event-batching artifacts, not fast typing
  var MIN_DWELL = 0.01;
  // Gaps beyond this are composition pauses (thinking between phrases), not typing rhythm,
  // so the digraph is DROPPED and the surrounding fluent typing is spliced together. This
  // matches ca-service (keystrokeSecurity.js PAUSE_DD_SECONDS), which reached the same rule
  // after observing the same failure: "windows containing several 0.8-1.9s gaps scored
  // 0.19-0.21 for the genuine user -> false locks".
  //
  // The extension previously used 2.5s AND made the pause a hard segment BREAK. Both parts
  // were wrong for real use. Copy-typing a displayed passage has almost no gaps over 1s, so
  // an enrolled profile contains no such rows at all; free composition is full of them, and
  // at 2.5s every one of those 1-2.5s gaps was kept as a feature row INSIDE a live window.
  // The head therefore scored windows containing a pattern it had never been trained on —
  // measured as 0.84 on copy-typing versus 0.60 on the same person composing. Lowering the
  // threshold alone is not enough either: as a hard break, 1.0s shatters composition into
  // sub-window fragments and yields almost no windows. Dropping without breaking fixes both
  // (simulated on 900 keystrokes of composition: 50 windows with 95 pause rows -> 75 windows
  // with none), and leaves copy-typing byte-identical because it has no such gaps to drop.
  var PAUSE_DD = 1.0;

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  // events: [{ keyCode, type: "keydown"|"keyup", t (ms), field }]
  // A composition pause (dd > PAUSE_DD) DROPS that digraph and keeps going, so the fluent
  // typing either side of the pause is spliced into one continuous run. Only the silence is
  // removed; every sub-second digraph — where the rhythm signature actually lives — is kept,
  // so impostor detection is unaffected. Still returned as segments (arrays of runs) because
  // a field change genuinely does break the sequence.
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
      if (dd > PAUSE_DD) continue;              // composition pause — drop the digraph, don't break
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
