// scoring.js — ON-DEVICE inference + decision. Runs in the background worker after
// tf.min.js is loaded. Turns feature windows into a verdict using the SAME Lu et al.
// (2020) packet vote as the server (ca-service/lib/keystrokeSecurity.js), so behaviour
// matches. Nothing here touches the network — the model is a packaged extension asset.
var ContinuumScoring = (function () {
  var WINDOW_THRESHOLD = 0.5;      // a window is "low" if genuine prob < 0.5 (Lu et al. boundary)
  var PACKET_VOTE_FRACTION = 0.5;  // suspicious when >= this fraction of the packet is low
  var RECENT_WINDOW_COUNT = 6;     // packet size
  var model = null, kind = null;   // kind: "graph" (bundled asset) | "hybrid" (trained on-device)
  var extractor = null, head = null;  // hybrid pieces: graph feature-extractor + trained dense head
  var scaler = null;               // {mean:[6], std:[6]} — the models were trained on
                                   // STANDARDIZED features (model-api scale_windows); raw
                                   // windows must get the same (x-mean)/std or scores are garbage.

  async function loadScaler(url) {
    scaler = await (await fetch(url)).json();
    return true;
  }

  function scaleWindow(win) {
    if (!scaler) return win;
    var out = [];
    for (var r = 0; r < win.length; r++) {
      var row = [];
      for (var c = 0; c < win[r].length; c++) row.push((win[r][c] - scaler.mean[c]) / (scaler.std[c] || 1));
      out.push(row);
    }
    return out;
  }

  // url = chrome.runtime.getURL("model/<name>/model.json")
  async function load(url) {
    if (typeof tf === "undefined") throw new Error("tf runtime not loaded");
    try { await tf.setBackend("cpu"); } catch (e) {}  // no WebGL in a service worker
    await tf.ready();
    model = await tf.loadGraphModel(url);
    kind = "graph";
    return true;
  }

  // The wizard-trained personal classifier: a dense head saved by trainer.js to IndexedDB
  // (same chrome-extension:// origin as the offscreen doc, so both see it) that runs on
  // top of the packaged graph feature-extractor (Conv1D+GRU cut at flatten).
  async function loadTrained(extractorUrl) {
    if (typeof tf === "undefined") throw new Error("tf runtime not loaded");
    try { await tf.setBackend("cpu"); } catch (e) {}
    await tf.ready();
    head = await tf.loadLayersModel("indexeddb://cg-personal-head");  // throws if never trained
    extractor = await tf.loadGraphModel(extractorUrl);
    model = null;
    kind = "hybrid";
    return true;
  }

  function isReady() { return kind === "hybrid" ? !!(extractor && head) : !!model; }

  // ---- mouse modality (only meaningful once a personal head is trained: the mouse
  // base is a 120-user ID net, so there is no generic genuine/impostor fallback) ----
  var mouseExtractor = null, mouseHead = null, mouseScaler = null;
  async function loadMouseTrained(extractorUrl, scalerUrl) {
    if (typeof tf === "undefined") throw new Error("tf runtime not loaded");
    try { await tf.setBackend("cpu"); } catch (e) {}
    await tf.ready();
    mouseHead = await tf.loadLayersModel("indexeddb://cg-personal-mouse-head");  // throws if never trained
    mouseScaler = await (await fetch(scalerUrl)).json();
    mouseExtractor = await tf.loadGraphModel(extractorUrl);
    return true;
  }
  function isMouseReady() { return !!(mouseExtractor && mouseHead); }
  async function scoreMouseWindow(win) {
    var scaled = win.map(function (row) {
      return row.map(function (v, c) { return (v - mouseScaler.mean[c]) / (mouseScaler.std[c] || 1); });
    });
    var x = tf.tensor3d([scaled]);               // [1, 50, 7]
    var f = await mouseExtractor.executeAsync(x);
    var y = mouseHead.predict(f);
    var out = y.dataSync();
    x.dispose(); f.dispose(); y.dispose();
    return out[1];                               // class 1 = genuine
  }

  // win = 50 x 6 array → genuine-class probability (softmax[1]).
  // Graph models run via executeAsync() (the GRU compiles to a dynamic while-loop op;
  // predict() throws). Hybrid: extractor (graph) → features → trained head (layers).
  async function scoreWindow(win) {
    var x = tf.tensor3d([scaleWindow(win)]);   // [1, 50, 6], standardized like training
    var y, out;
    if (kind === "hybrid") {
      var f = await extractor.executeAsync(x);   // [1, 1568]
      y = head.predict(f);
      f.dispose();
    } else {
      y = await model.executeAsync(x);    // [1, 2] softmax
    }
    out = y.dataSync();
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

  return { load: load, loadTrained: loadTrained, loadScaler: loadScaler, scaleWindow: scaleWindow, isReady: isReady, scoreWindow: scoreWindow, loadMouseTrained: loadMouseTrained, isMouseReady: isMouseReady, scoreMouseWindow: scoreMouseWindow, verdict: verdict, decide: decide, RECENT_WINDOW_COUNT: RECENT_WINDOW_COUNT };
})();

// Allow importing the pure decision logic under Node for tests.
if (typeof module !== "undefined" && module.exports) module.exports = ContinuumScoring;
