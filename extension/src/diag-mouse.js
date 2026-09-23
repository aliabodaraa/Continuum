// diag-mouse.js — in-browser diagnostic: does this account's mouse model separate the user from
// impostors? Loads the model the guard scores with (IndexedDB, via the same scaling as
// mouse-model.js) and scores three sets:
//   (A) the bundled impostor set (SapiMouse base users, as frozen-FCN embeddings) -> should be LOW
//   (B) the stored enrolment windows (in-sample)                                  -> optimistic
//   (C) live-captured movement on this page (out-of-sample)                       -> the real test
// "Accepted" means at or above the user's own threshold, the boundary the live rule uses.
// Read-only: trains and saves nothing.
var api = globalThis.browser || globalThis.chrome;
function q(id) { return document.getElementById(id); }

var accountId = null, model = null, scaler = null, meta = null;
var enrollWins = [], impostorEmb = [], liveWins = [];

async function scoreWindows(wins, onProg) {
  var out = [];
  for (var b = 0; b < wins.length; b += 32) {
    var x = tf.tensor3d(wins.slice(b, b + 32).map(function (w) { return ContinuumMouseModel.scaleWindow(w, scaler); }));
    var y = model.predict(x);
    (await y.array()).forEach(function (r) { out.push(r[1]); });
    x.dispose(); y.dispose();
    if (onProg) onProg(Math.min(b + 32, wins.length), wins.length);
    await tf.nextFrame();
  }
  return out;
}
// The impostor set ships as embeddings of the frozen FCN, so only the head is applied to it.
function scoreEmbeddings(embs) {
  var x = tf.tensor2d(embs), y = model.getLayer("verify_head").apply(x);
  var out = y.arraySync().map(function (r) { return r[1]; });
  x.dispose(); y.dispose();
  return out;
}

// P(at least k of n windows low) for a per-window low rate p, IF windows were independent
// (used for a "vote" rule only). Consecutive windows overlap (stride 10 of 50 steps), so this is
// optimistic; the measured rates for the shipped rule are in artifacts/repr_arch_study/analysis_I.json.
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
  var acc = 0; for (var j = 0; j < s.length; j++) if (s[j] >= meta.threshold) acc++;
  return { n: s.length, mean: sum / s.length, median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1], acceptedPct: 100 * acc / s.length };
}
// 10-bin [0..1] histogram; bins below the user's threshold are drawn in the "low" colour.
function histLine(scores) {
  var bins = new Array(10).fill(0);
  scores.forEach(function (v) { bins[Math.min(9, Math.floor(v * 10))]++; });
  var max = Math.max.apply(null, bins) || 1, out = "";
  for (var b = 0; b < 10; b++) {
    var cls = (b + 1) / 10 <= meta.threshold ? "bar-bad" : "bar-ok";
    out += "<span class='" + cls + "'>" + (b / 10).toFixed(1) + "  " + String(bins[b]).padStart(4) + "  " + "█".repeat(Math.round(8 * bins[b] / max)) + "</span>\n";
  }
  return out;
}

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
    scaler = await (await fetch(api.runtime.getURL("model/mouse-scaler.json"))).json();
    model = await tf.loadLayersModel("indexeddb://cg-personal-mouse-fcn-" + accountId);
    meta = model.getUserDefinedMetadata() || {};
    if (meta.featureVersion !== ContinuumMouseModel.FEATURE_VERSION || !(meta.threshold > 0)) throw new Error("profile predates the current model");
    // Judge with the operating point the guard applies now (mouse-model.js load() does the same).
    var MM = ContinuumMouseModel;
    if (meta.thresholdQ !== MM.THRESHOLD_Q || meta.voteN !== MM.VOTE_N || meta.voteRule !== MM.VOTE_RULE) {
      var t = meta.enrolPercentiles && meta.enrolPercentiles[MM.THRESHOLD_Q];
      if (!(t > 0)) throw new Error("profile was built for an earlier operating point; rebuild it on the training page");
      meta = Object.assign({}, meta, { threshold: t, thresholdQ: MM.THRESHOLD_Q, voteN: MM.VOTE_N, voteK: MM.VOTE_K, voteRule: MM.VOTE_RULE });
    }
    q("headState").textContent = "loaded ✓ (threshold " + meta.threshold.toFixed(3) + " = " + meta.thresholdQ + "th percentile of " + meta.windows + " enrolment windows; "
      + (meta.voteRule === "mean" ? "locks when the average of the last " + meta.voteN + " windows is below it" : "lock at " + meta.voteK + " of " + meta.voteN) + ")";
  } catch (e) {
    model = null;
    q("headState").textContent = "NOT trained for this account — train mouse first (" + ((e && e.message) || e) + ")";
    return;
  }
  api.storage.local.get(["cg_enroll_mouse_" + accountId], function (d) {
    enrollWins = ContinuumMouseFeatures.fromRetired7((d && d["cg_enroll_mouse_" + accountId]) || []);
    q("enrollCount").textContent = enrollWins.length + " windows";
  });
  try {
    impostorEmb = (await (await fetch(api.runtime.getURL("data/mouse-impostors.json"))).json()).embeddings || [];
    q("impCount").textContent = impostorEmb.length + " windows";
  } catch (e) { q("impCount").textContent = "failed to load"; }
  maybeEnableRun();
}

// ---- live capture, window-wide (content.js scores motion across the whole viewport) ----
var M = globalThis.ContinuumMouseFeatures;
var mEvents = [], down = false;
function pushEv(x, y, st) {
  mEvents.push({ t: performance.now(), x: x, y: y, state: st });
  if (mEvents.length % 10 === 0) {
    liveWins = M.stepsToWindows(M.eventsToSteps(mEvents));
    q("liveCount").textContent = liveWins.length;
    maybeEnableRun();
  }
}
document.addEventListener("mousemove", function (e) { pushEv(e.clientX, e.clientY, down ? "Drag" : "Move"); });
document.addEventListener("mousedown", function (e) { down = true; pushEv(e.clientX, e.clientY, "Pressed"); });
document.addEventListener("mouseup", function (e) { down = false; pushEv(e.clientX, e.clientY, "Released"); });

function maybeEnableRun() { q("run").disabled = !(model && impostorEmb.length); }

q("run").addEventListener("click", async function () {
  q("run").disabled = true;
  var res = q("results");
  res.innerHTML = "<p class='muted'>scoring…</p>";
  var impScores = scoreEmbeddings(impostorEmb);
  var enrScores = enrollWins.length ? await scoreWindows(enrollWins) : [];
  var liveScores = liveWins.length ? await scoreWindows(liveWins) : [];
  var impS = stats(impScores), enrS = stats(enrScores), liveS = stats(liveScores);

  function block(title, note, st, scores) {
    if (!st) return "<div class='card'><h2>" + title + "</h2><p class='muted'>" + note + " — no windows.</p></div>";
    return "<div class='card'><h2>" + title + "</h2><p class='muted'>" + note + "</p>" +
      "<div class='row'><span>windows</span><span class='val'>" + st.n + "</span></div>" +
      "<div class='row'><span>mean score</span><span class='val'>" + st.mean.toFixed(3) + "</span></div>" +
      "<div class='row'><span>median</span><span class='val'>" + st.median.toFixed(3) + "</span></div>" +
      "<div class='row'><span>min / max</span><span class='val'>" + st.min.toFixed(3) + " / " + st.max.toFixed(3) + "</span></div>" +
      "<div class='row'><span>accepted (≥ your threshold " + meta.threshold.toFixed(3) + ")</span><span class='val'>" + st.acceptedPct.toFixed(1) + "%</span></div>" +
      "<div class='hist'>" + histLine(scores) + "</div></div>";
  }
  var html = block("(C) Live movement — genuine, out-of-sample (the real test)", "Your movement on this page just now. Should mostly be accepted.", liveS, liveScores)
    + block("(A) Impostors — SapiMouse base users", "Should mostly be rejected.", impS, impScores)
    + block("(B) Enrolment windows — genuine, in-sample (optimistic)", "Training data. By construction " + (100 - meta.thresholdQ) + "% sit at or above the threshold.", enrS, enrScores);

  var v = "", cls = "v-warn", K = meta.voteK, N = meta.voteN;
  if (!impS) { v = "⚠ No impostor scores — cannot conclude."; }
  else if (!liveS) { v = "⚠ Impostors accepted " + impS.acceptedPct.toFixed(0) + "%, but no live movement captured — move the mouse around the page and run again."; }
  else if (meta.voteRule === "mean") {
    // Apply the live rule itself: slide a buffer of N over the live scores and count the buffers
    // whose average falls below the threshold (each would have asked for the passkey).
    var fires = 0, buffers = 0;
    for (var e = N; e <= liveScores.length; e++) {
      var sm = 0; for (var f = e - N; f < e; f++) sm += liveScores[f];
      buffers += 1; if (sm / N < meta.threshold) fires += 1;
    }
    var lastMean = liveScores.length >= N ? liveScores.slice(-N).reduce(function (a, b) { return a + b; }, 0) / N : null;
    cls = !buffers ? "v-warn" : fires === 0 && impS.mean < meta.threshold ? "v-ok" : fires > buffers / 2 ? "v-bad" : "v-warn";
    v = (cls === "v-ok" ? "✅ " : cls === "v-bad" ? "❌ " : "⚠ ")
      + (buffers
        ? "Your last " + N + " live windows average " + lastMean.toFixed(3) + " against your threshold " + meta.threshold.toFixed(3)
          + "; of " + buffers + " consecutive " + N + "-window stretches of your movement here, " + fires + " would have asked for your passkey."
        : "Only " + liveScores.length + " live windows so far; the rule needs " + N + " (about 17 s of movement) — keep moving and run again.")
      + " Impostor windows average " + impS.mean.toFixed(3) + (impS.mean < meta.threshold ? " (below your threshold: they would be asked)." : " (NOT below your threshold).")
      + (buffers && fires > buffers / 2 ? " Your live movement looks unlike your enrolment: add a sample with more natural, varied movement." : "");
  }
  else {
    var pGen = 1 - liveS.acceptedPct / 100, pImp = 1 - impS.acceptedPct / 100;
    var fl = atLeast(N, K, pGen) * 100, det = atLeast(N, K, pImp) * 100;
    cls = liveS.acceptedPct >= 70 && impS.acceptedPct <= 40 ? "v-ok" : liveS.acceptedPct < 50 ? "v-bad" : "v-warn";
    v = (cls === "v-ok" ? "✅ " : cls === "v-bad" ? "❌ " : "⚠ ") + "Your live movement accepted " + liveS.acceptedPct.toFixed(0)
      + "%, impostors accepted " + impS.acceptedPct.toFixed(0) + "%. Under the live rule (" + K + " of " + N
      + " recent windows low), and if windows were independent, that is a false-lock chance of about "
      + (fl < 0.01 ? fl.toExponential(1) : fl.toFixed(2)) + "% per check for you and a " + det.toFixed(0)
      + "% chance of catching an impostor within " + N + " windows."
      + (liveS.acceptedPct < 50 ? " Your live movement looks unlike your enrolment: add a sample with more natural, varied movement." : "");
  }
  res.innerHTML = "<div class='verdict " + cls + "'>" + v + "</div>" + html;
  q("run").disabled = false;
});
