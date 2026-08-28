// diag-mouse.js — in-browser diagnostic: does the trained mouse head actually discriminate
// the genuine user from an impostor? Loads the SAME pieces the live scorer uses (the graph
// extractor + trained head from IndexedDB + mouse scaler), then scores three window sets:
//   (A) bundled impostor windows (SapiMouse other-subjects)  -> should score LOW to be useful
//   (B) stored enrollment windows (in-sample)                -> optimistic genuine baseline
//   (C) live-captured browsing windows (out-of-sample)       -> the REAL genuine-in-use test
// and reports the separation. Read-only: trains/saves nothing.
var api = globalThis.browser || globalThis.chrome;
function q(id) { return document.getElementById(id); }

var accountId = null, extractor = null, head = null, scaler = null;
var enrollWins = [], impostorWins = [], liveWins = [];

// ---- faithful copy of ContinuumScoring.scoreMouseWindow (scoring.js): z-score with the
// mouse scaler (7-dim, no clip), extractor.executeAsync -> head.predict -> softmax[1]. ----
function scaleMouse(win) {
  return win.map(function (row) {
    return row.map(function (v, c) { return (v - scaler.mean[c]) / (scaler.std[c] || 1); });
  });
}
async function scoreOne(win) {
  var x = tf.tensor3d([scaleMouse(win)]);
  var f = await extractor.executeAsync(x);
  var y = head.predict(f);
  var out = y.dataSync();
  x.dispose(); f.dispose(); y.dispose();
  return out[1];
}
async function scoreMany(wins, onProg) {
  var scores = [];
  for (var i = 0; i < wins.length; i++) {
    scores.push(await scoreOne(wins[i]));
    if (onProg && i % 10 === 0) { onProg(i, wins.length); await tf.nextFrame(); }
  }
  return scores;
}

// The live enforcement rule this tool is measuring against — must match background.js
// (MOUSE_SUSTAIN_LOW of MOUSE_SUSTAIN_WINDOW recent windows below WINDOW_THRESHOLD).
var SUSTAIN_WINDOW = 20, SUSTAIN_LOW = 15;
// P(at least k of n windows low) for a per-window low rate p — turns the measured rates
// into the number that actually matters: how often the rule fires.
function atLeast(n, k, p) {
  var s = 0;
  for (var i = k; i <= n; i++) {
    var c = 1;
    for (var j = 0; j < i; j++) c = c * (n - j) / (j + 1);
    s += c * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return s;
}

function stats(scores) {
  if (!scores.length) return null;
  var s = scores.slice().sort(function (a, b) { return a - b; });
  var sum = 0; for (var i = 0; i < s.length; i++) sum += s[i];
  var acc = 0; for (var j = 0; j < s.length; j++) if (s[j] >= 0.5) acc++;
  return {
    n: s.length, mean: sum / s.length, median: s[Math.floor(s.length / 2)],
    min: s[0], max: s[s.length - 1], acceptedPct: 100 * acc / s.length,
  };
}
// 10-bin [0..1] histogram as a monospace bar row.
function histLine(scores) {
  var bins = new Array(10).fill(0);
  scores.forEach(function (v) { var b = Math.min(9, Math.floor(v * 10)); bins[b]++; });
  var max = Math.max.apply(null, bins) || 1;
  var out = "";
  for (var b = 0; b < 10; b++) {
    var lo = (b / 10).toFixed(1), h = Math.round(8 * bins[b] / max);
    var cls = b < 5 ? "bar-bad" : "bar-ok";
    out += "<span class='" + cls + "'>" + lo + "  " + String(bins[b]).padStart(4) + "  " + "█".repeat(h) + "</span>\n";
  }
  return out;
}

// ---- bootstrap: account, models, data ----
(function init() {
  api.runtime.sendMessage({ type: "cg:get-account" }, function (res) {
    void api.runtime.lastError;   // worker may be asleep; res is then undefined
    accountId = res && res.id;
    q("acct").textContent = (res && res.email) || accountId || "not signed in";
    if (!accountId) { q("headState").textContent = "no account — sign in & train first"; return; }
    loadAll();
  });
})();

async function loadAll() {
  try { await tf.setBackend("cpu"); } catch (e) {}
  await tf.ready();
  // scaler + extractor (bundled assets), head (this account's trained model in IndexedDB)
  try {
    scaler = await (await fetch(api.runtime.getURL("model/mouse-scaler.json"))).json();
    extractor = await tf.loadGraphModel(api.runtime.getURL("model/mouse-extractor/model.json"));
    head = await tf.loadLayersModel("indexeddb://cg-personal-mouse-head-" + accountId);
    q("headState").textContent = "loaded ✓";
  } catch (e) {
    q("headState").textContent = "NOT trained for this account — train mouse first (" + ((e && e.message) || e) + ")";
    return;
  }
  // genuine enrollment windows (in-sample) + bundled impostors
  api.storage.local.get(["cg_enroll_mouse_" + accountId], function (d) {
    enrollWins = (d && d["cg_enroll_mouse_" + accountId]) || [];
    q("enrollCount").textContent = enrollWins.length + " windows";
  });
  try {
    impostorWins = (await (await fetch(api.runtime.getURL("data/mouse-impostors.json"))).json()).windows || [];
    q("impCount").textContent = impostorWins.length + " windows";
  } catch (e) { q("impCount").textContent = "failed to load"; }
  maybeEnableRun();
}

// ---- live browsing capture ----
var M = globalThis.ContinuumMouseFeatures;
var mEvents = [], down = false;
var area = q("capArea");
function pushEv(x, y, st) {
  mEvents.push({ t: performance.now(), x: x, y: y, state: st });
  if (mEvents.length % 10 === 0) {
    liveWins = M.stepsToWindows(M.eventsToSteps(mEvents));
    q("liveCount").textContent = liveWins.length;
    maybeEnableRun();
  }
}
// Capture WINDOW-WIDE, not just inside the box. content.js scores motion across the whole
// viewport, so sampling the genuine user through a small box measures a different (cramped,
// low-variety) distribution and reports them as worse than they are — the very mismatch this
// tool exists to detect. The box below is only a visual target to move around.
document.addEventListener("mousemove", function (e) { pushEv(e.clientX, e.clientY, down ? "Drag" : "Move"); });
document.addEventListener("mousedown", function (e) { down = true; pushEv(e.clientX, e.clientY, "Pressed"); });
document.addEventListener("mouseup", function (e) { down = false; pushEv(e.clientX, e.clientY, "Released"); });

function maybeEnableRun() { q("run").disabled = !(head && impostorWins.length); }

// ---- run the comparison ----
q("run").addEventListener("click", async function () {
  q("run").disabled = true;
  var res = q("results");
  res.innerHTML = "<p class='muted'>scoring…</p>";

  var impScores = await scoreMany(impostorWins);
  var enrScores = enrollWins.length ? await scoreMany(enrollWins) : [];
  var liveScores = liveWins.length ? await scoreMany(liveWins) : [];

  var impS = stats(impScores), enrS = stats(enrScores), liveS = stats(liveScores);

  function block(title, note, st, scores) {
    if (!st) return "<div class='card'><h2>" + title + "</h2><p class='muted'>" + note + " — no windows.</p></div>";
    return "<div class='card'><h2>" + title + "</h2><p class='muted'>" + note + "</p>" +
      "<div class='row'><span>windows</span><span class='val'>" + st.n + "</span></div>" +
      "<div class='row'><span>mean score</span><span class='val'>" + st.mean.toFixed(3) + "</span></div>" +
      "<div class='row'><span>median</span><span class='val'>" + st.median.toFixed(3) + "</span></div>" +
      "<div class='row'><span>min / max</span><span class='val'>" + st.min.toFixed(3) + " / " + st.max.toFixed(3) + "</span></div>" +
      "<div class='row'><span>accepted as genuine (≥0.5)</span><span class='val'>" + st.acceptedPct.toFixed(1) + "%</span></div>" +
      "<div class='hist'>" + histLine(scores) + "</div></div>";
  }

  var html = "";
  html += block("(C) Live browsing — genuine, out-of-sample (the real test)", "Your natural movement just now. Should score HIGH if the model recognizes you while browsing.", liveS, liveScores);
  html += block("(A) Impostor windows — SapiMouse others", "Should score LOW if the model can reject an impostor.", impS, impScores);
  html += block("(B) Enrollment windows — genuine, in-sample (optimistic)", "Training data — expected high; only tells us the head isn't degenerate.", enrS, enrScores);

  // ---- verdict ----
  var v = "", cls = "v-warn";
  if (impS) {
    var impAcc = impS.acceptedPct;
    var liveMean = liveS ? liveS.mean : null;
    if (impAcc > 60) {
      cls = "v-bad";
      v = "❌ Non-discriminative: the model accepts " + impAcc.toFixed(0) + "% of IMPOSTOR windows as genuine. " +
        "It cannot tell an impostor apart in this setting → mouse enforcement is NOT defensible. " +
        "Fix required: re-enroll on natural browsing movement (not the directed task), then re-measure.";
    } else if (liveS && liveMean !== null && liveMean < 0.5) {
      cls = "v-bad";
      v = "❌ Genuine-in-use failure: impostors are rejected (" + impAcc.toFixed(0) + "% accepted), but YOUR live browsing " +
        "only scores " + liveMean.toFixed(2) + " mean — you'd be falsely flagged while browsing. This is the enroll-task vs " +
        "use-task mismatch. Fix: re-enroll on natural browsing movement.";
    } else if (liveS) {
      // Report what the measured rates actually imply for the live rule, rather than a
      // generic "looks promising". The mouse channel enforces on a SUSTAINED vote —
      // MOUSE_SUSTAIN_LOW of MOUSE_SUSTAIN_WINDOW recent windows below 0.5 — so the useful
      // question is how often that trips for the genuine user versus an impostor.
      cls = "v-ok";
      var pGen = 1 - liveS.acceptedPct / 100, pImp = 1 - impAcc / 100;
      var fl = atLeast(SUSTAIN_WINDOW, SUSTAIN_LOW, pGen) * 100;
      var det = atLeast(SUSTAIN_WINDOW, SUSTAIN_LOW, pImp) * 100;
      v = "✅ Working: impostors accepted " + impAcc.toFixed(0) + "%, your live browsing accepted "
        + liveS.acceptedPct.toFixed(0) + "% (mean " + liveMean.toFixed(2) + ", separation "
        + (liveMean - impS.mean).toFixed(2) + "). Under the live rule (" + SUSTAIN_LOW + " of "
        + SUSTAIN_WINDOW + " recent windows low) that is a genuine false-lock chance of "
        + (fl < 0.01 ? fl.toExponential(1) : fl.toFixed(3)) + "% per evaluation, while an impostor is caught "
        + det.toFixed(1) + "% of the time within about " + SUSTAIN_WINDOW + " windows."
        + (enrS ? "  In-sample " + enrS.mean.toFixed(2) + " vs live " + liveMean.toFixed(2) + " (gap "
          + (enrS.mean - liveMean).toFixed(2) + ") — "
          + (enrS.mean - liveMean > 0.20 ? "large, add more enrollment windows." : "small, the head generalises.") : "");
    } else {
      v = "⚠ Impostors accepted " + impAcc.toFixed(0) + "%, but no live-browsing sample captured — move the mouse around the screen and re-run for the real genuine test.";
    }
  } else { v = "⚠ No impostor scores — cannot conclude."; }
  res.innerHTML = "<div class='verdict " + cls + "'>" + v + "</div>" + html;
  q("run").disabled = false;
});
