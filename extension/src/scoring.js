// scoring.js — ON-DEVICE inference + decision. Runs in the background worker after
// tf.min.js is loaded. Turns feature windows into a verdict using the SAME Lu et al.
// (2020) packet vote as the server (ca-service/lib/keystrokeSecurity.js), so behaviour
// matches. Nothing here touches the network — the model is a packaged extension asset.
var ContinuumScoring = (function () {
  var WINDOW_THRESHOLD = 0.5;      // a window is "low" if genuine prob < 0.5 (Lu et al. boundary)
  var PACKET_VOTE_FRACTION = 0.5;  // suspicious when >= this fraction of the packet is low
  var RECENT_WINDOW_COUNT = 6;     // packet size
  var model = null;

  // url = chrome.runtime.getURL("model/<name>/model.json")
  async function load(url) {
    if (typeof tf === "undefined") throw new Error("tf runtime not loaded");
    try { await tf.setBackend("cpu"); } catch (e) {}  // no WebGL in a service worker
    await tf.ready();
    model = await tf.loadGraphModel(url);
    return true;
  }

  function isReady() { return !!model; }

  // win = 50 x 6 array → genuine-class probability (softmax[1]).
  // ASYNC: the GRU compiles to a graph model with a dynamic while-loop op, so it must
  // run via executeAsync() (predict() throws on dynamic ops).
  async function scoreWindow(win) {
    var x = tf.tensor3d([win]);           // [1, 50, 6]
    var y = await model.executeAsync(x);  // [1, 2] softmax
    var out = y.dataSync();
    x.dispose(); y.dispose();
    return out[1];                        // class 1 = genuine
  }

  // recentWindows = last N windows → verdict (mirrors the server's packet vote)
  async function verdict(recentWindows) {
    var scores = [];
    for (var i = 0; i < recentWindows.length; i++) scores.push(await scoreWindow(recentWindows[i]));
    return decide(scores);
  }

  // Pure decision (kept separate so it can be unit-tested without tf).
  function decide(scores) {
    var low = 0, sum = 0;
    for (var i = 0; i < scores.length; i++) { if (scores[i] < WINDOW_THRESHOLD) low += 1; sum += scores[i]; }
    var frac = scores.length ? low / scores.length : 0;
    return {
      suspicious: frac >= PACKET_VOTE_FRACTION,
      mean: scores.length ? sum / scores.length : 0,
      lowFraction: frac,
      scores: scores,
    };
  }

  return { load: load, isReady: isReady, scoreWindow: scoreWindow, verdict: verdict, decide: decide, RECENT_WINDOW_COUNT: RECENT_WINDOW_COUNT };
})();

// Allow importing the pure decision logic under Node for tests.
if (typeof module !== "undefined" && module.exports) module.exports = ContinuumScoring;
