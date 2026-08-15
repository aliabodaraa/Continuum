// diag-keystroke.js — in-browser diagnostic for the KEYSTROKE channel, mirroring
// diag-mouse.js. Loads the SAME pieces the live scorer uses (bundled graph extractor +
// this account's trained head from IndexedDB + keystroke scaler) and scores four sets:
//   (A) bundled impostor windows (other subjects)        -> should score LOW to be useful
//   (B) stored enrollment windows (in-sample)            -> optimistic genuine baseline
//   (C) live COPY-TYPING a passage (enrollment-style)    -> the task the head was trained on
//   (D) live FREE COMPOSITION (runtime-style)            -> what the guard actually scores
//
// C vs D is the point of this tool. Enrollment trains on copy-typed A1 passages while the
// guard scores free composition — different motor tasks (reading ahead at a steady rhythm
// vs. think-pauses, backspaces and bursts). If D scores materially below C, the keystroke
// channel has the same enroll-task/use-task mismatch that was found and fixed for mouse,
// and the fix is the same: enrol on the distribution that will actually be scored.
// Read-only: trains nothing, saves nothing.
var api = globalThis.browser || globalThis.chrome;
function q(id) { return document.getElementById(id); }

var accountId = null, extractor = null, head = null, scaler = null;
var enrollWins = [], impostorWins = [], copyWins = [], freeWins = [];

// Keystroke scaling CLIPS before standardizing (scoring.js KS_CLIP_MIN/MAX, mirroring
// services/model-api/preprocessing.py). Training clipped first, so scoring must too —
// skipping it makes a genuine window look extreme and drags its score down.
var KS_CLIP_MIN = [0.0, 0.0, 0.0, 0.0, 0.0, -1.0];
var KS_CLIP_MAX = [1.0, 1.0, 2.0, 2.0, 5.0, 5.0];
function scaleKs(win) {
  return win.map(function (row) {
    return row.map(function (v, c) {
      var x = Math.max(KS_CLIP_MIN[c], Math.min(KS_CLIP_MAX[c], v));
      return (x - scaler.mean[c]) / (scaler.std[c] || 1);
    });
  });
}
async function scoreOne(win) {
  var x = tf.tensor3d([scaleKs(win)]);
  var f = await extractor.executeAsync(x);
  var y = head.predict(f);
  var out = y.dataSync();
  x.dispose(); f.dispose(); y.dispose();
  return out[1];
}
async function scoreMany(wins) {
  var scores = [];
  for (var i = 0; i < wins.length; i++) {
    scores.push(await scoreOne(wins[i]));
    if (i % 10 === 0) await tf.nextFrame();
  }
  return scores;
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
function histLine(scores) {
  var bins = new Array(10).fill(0);
  scores.forEach(function (v) { var b = Math.min(9, Math.floor(v * 10)); bins[b]++; });
  var max = Math.max.apply(null, bins) || 1;
  var out = "";
  for (var b = 0; b < 10; b++) {
    var lo = (b / 10).toFixed(1), h = Math.round(8 * bins[b] / max);
    out += "<span class='" + (b < 5 ? "bar-bad" : "bar-ok") + "'>" + lo + "  "
      + String(bins[b]).padStart(4) + "  " + "█".repeat(h) + "</span>\n";
  }
  return out;
}

// ---- bootstrap ----
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
  try {
    scaler = await (await fetch(api.runtime.getURL("model/scaler.json"))).json();
    extractor = await tf.loadGraphModel(api.runtime.getURL("model/base-extractor/model.json"));
    head = await tf.loadLayersModel("indexeddb://cg-personal-head-" + accountId);
    q("headState").textContent = "loaded ✓";
  } catch (e) {
    q("headState").textContent = "NOT trained for this account — train typing first (" + ((e && e.message) || e) + ")";
    return;
  }
  api.storage.local.get(["cg_enroll_" + accountId], function (d) {
    enrollWins = (d && d["cg_enroll_" + accountId]) || [];
    q("enrollCount").textContent = enrollWins.length + " windows";
  });
  try {
    impostorWins = (await (await fetch(api.runtime.getURL("data/impostors.json"))).json()).windows || [];
    q("impCount").textContent = impostorWins.length + " windows";
  } catch (e) { q("impCount").textContent = "failed to load"; }
  maybeEnableRun();
}

// ---- live capture: two boxes, same feature pipeline as the guard ----
var F = globalThis.ContinuumFeatures;
// A1-style passage to copy — deliberately the same register the enrollment wizard uses,
// so box C reproduces the ENROLMENT task rather than merely "typing something".
var PASSAGE = "I get up early every day. I make a cup of tea and open the window. The birds "
  + "sing in the tree near my house. I like to sit and drink my tea in the morning. After "
  + "that I walk to work. I say hello to my friends on the way. We talk about the day and "
  + "the weather. At night I read a book and go to sleep.";

function makeCapture(boxId, countId, onWins) {
  var events = [], t0 = performance.now();
  var el = q(boxId);
  function rec(type, e) {
    events.push({ keyCode: e.keyCode || 0, type: type, t: performance.now() - t0, field: boxId });
    if (events.length % 10 === 0) {
      var wins = F.stepsToWindows(F.eventSteps(events));
      q(countId).textContent = wins.length + " windows (" + events.length + " events)";
      onWins(wins);
      maybeEnableRun();
    }
  }
  el.addEventListener("keydown", function (e) { rec("keydown", e); });
  el.addEventListener("keyup", function (e) { rec("keyup", e); });
}
q("passage").textContent = PASSAGE;
makeCapture("copyBox", "copyCount", function (w) { copyWins = w; });
makeCapture("freeBox", "freeCount", function (w) { freeWins = w; });

function maybeEnableRun() { q("run").disabled = !(head && impostorWins.length); }

// ---- run ----
q("run").addEventListener("click", async function () {
  q("run").disabled = true;
  var res = q("results");
  res.innerHTML = "<p class='muted'>scoring…</p>";

  var impScores = await scoreMany(impostorWins);
  var enrScores = enrollWins.length ? await scoreMany(enrollWins) : [];
  var copyScores = copyWins.length ? await scoreMany(copyWins) : [];
  var freeScores = freeWins.length ? await scoreMany(freeWins) : [];

  var impS = stats(impScores), enrS = stats(enrScores),
      copyS = stats(copyScores), freeS = stats(freeScores);

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

  // ---- verdict: the C-vs-D comparison is what this tool exists to answer ----
  var v = "", cls = "v-warn";
  if (!impS) {
    v = "⚠ No impostor scores — cannot conclude.";
  } else if (impS.acceptedPct > 60) {
    cls = "v-bad";
    v = "❌ Non-discriminative: the head accepts " + impS.acceptedPct.toFixed(0) + "% of IMPOSTOR windows. "
      + "It cannot separate you from someone else, so keystroke enforcement is not defensible as configured.";
  } else if (copyS && freeS) {
    var gap = copyS.mean - freeS.mean;
    if (gap >= 0.10) {
      cls = "v-bad";
      v = "❌ ENROL/USE MISMATCH CONFIRMED: copy-typing scores " + copyS.mean.toFixed(2) + " but free composition only "
        + freeS.mean.toFixed(2) + " (gap " + gap.toFixed(2) + ", accepted " + copyS.acceptedPct.toFixed(0) + "% vs "
        + freeS.acceptedPct.toFixed(0) + "%). The head is tuned to the passage-copying task, not to how you actually type. "
        + "Fix: add a free-composition stage to keystroke enrollment, then re-measure — this is the same defect that was "
        + "found and fixed for the mouse channel.";
    } else if (gap <= -0.10) {
      v = "⚠ Free composition scores HIGHER than copy-typing (" + freeS.mean.toFixed(2) + " vs " + copyS.mean.toFixed(2)
        + "). Unexpected — worth repeating with more text before drawing a conclusion.";
    } else if (enrS && (enrS.mean - Math.max(copyS.mean, freeS.mean)) >= 0.20) {
      // No task gap, but in-sample scores far above BOTH live tasks: the head has memorised
      // its (too few) training windows rather than learned the user. Checked before the
      // acceptance test below, because this diagnoses the cause rather than the symptom.
      cls = "v-bad";
      v = "❌ OVERFITTING, not a task mismatch: enrolment windows score " + enrS.mean.toFixed(2)
        + " in-sample but your live typing only ~" + ((copyS.mean + freeS.mean) / 2).toFixed(2)
        + " (gap " + (enrS.mean - (copyS.mean + freeS.mean) / 2).toFixed(2) + "), from just " + enrS.n
        + " stored windows. Copy and free now match, so the enrolment TASK is fine — there is simply too "
        + "little data. Run the enrollment wizard again a few times: windows accumulate across sessions "
        + "(cap 60) and the gap should close. Do NOT clear your data between sessions.";
    } else if (freeS.acceptedPct < 85) {
      cls = "v-bad";
      v = "❌ Genuine-in-use failure: impostors are rejected (" + impS.acceptedPct.toFixed(0) + "% accepted) but only "
        + freeS.acceptedPct.toFixed(0) + "% of YOUR free-typing windows are accepted (mean " + freeS.mean.toFixed(2)
        + "). At that rate the 3-of-6 packet vote false-locks you often while you simply write. Not a task mismatch "
        + "(copy-typing scores similarly) — the personal head needs more enrolment data.";
    } else {
      cls = "v-ok";
      v = "✅ No mismatch: copy-typing " + copyS.mean.toFixed(2) + " vs free composition " + freeS.mean.toFixed(2)
        + " (gap " + gap.toFixed(2) + "), impostors accepted only " + impS.acceptedPct.toFixed(0) + "%. The head generalises "
        + "from the enrolment task to real typing — no enrollment redesign needed for keystroke.";
    }
  } else {
    v = "⚠ Impostors accepted " + impS.acceptedPct.toFixed(0) + "%, but both live boxes need text: type the passage in (C) "
      + "AND write freely in (D) until each shows ~10+ windows, then re-run. That comparison is the point of this tool.";
  }

  var html = "";
  html += block("(D) Free composition — genuine, runtime-style (the real test)",
    "What the guard actually scores in use. Should be HIGH if the head generalises.", freeS, freeScores);
  html += block("(C) Copy-typing — genuine, enrolment-style",
    "The task enrollment trains on. Compare against (D): a large gap means an enrol/use mismatch.", copyS, copyScores);
  html += block("(A) Impostor windows — other subjects",
    "Should score LOW if the head can reject an impostor.", impS, impScores);
  html += block("(B) Enrollment windows — genuine, in-sample (optimistic)",
    "Training data — expected high; only shows the head isn't degenerate.", enrS, enrScores);

  res.innerHTML = "<div class='verdict " + cls + "'>" + v + "</div>" + html;
  q("run").disabled = false;
});
