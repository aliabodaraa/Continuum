// mouse-model.js — the mouse verifier the extension ships, in one place. The enrolment page
// trains with it, the offscreen document scores with it and the diagnostic page measures it, so
// all three scale windows, score them and set the per-user threshold in exactly one way.
//
// Model: SapiMouse's FCN (Antal, Fejer & Buza, IEEE SACI 2021) trained on 100 SapiMouse base
// users (model/mouse-fcn), used as a FROZEN feature extractor up to its 128-d "embedding"
// (global average pooling), with a per-user Dense(2, softmax) head trained here, on the device.
// The server fine-tunes everything after the first conv block instead; that is not possible here,
// because TF.js's CPU backend takes 0.93 s per window per epoch for the FCN's backward pass, about
// 3 hours for the server's recipe (artifacts/repr_arch_study/ondevice_cost.json). Training only
// the head costs one forward pass over the enrolment (~32 s for 330 windows) plus ~2 s. What that
// costs in accuracy was measured before this shipped: Experiment G,
// artifacts/repr_arch_study/PREREGISTRATION_G.md, which ran THIS file under Node.
//
// Input windows are the extension's own features-mouse.js output: 50 steps x [|dx|, |dy|] px.
var ContinuumMouseModel = (function () {
  var FEATURE_VERSION = "a5-absdxdy-v1";     // must match features-mouse.js
  var SLOT_PREFIX = "indexeddb://cg-personal-mouse-fcn-";
  var EMBEDDING_LAYER = "embedding";
  var EMBED_BATCH = 32;
  // Head recipe (fixed in PREREGISTRATION_G.md before any result existed): the previous
  // on-device trainer's settings, which Experiment C evaluated as "M2".
  var EPOCHS = 25, BATCH = 32, LR = 0.002;
  // Operating point (Experiment I; the project owner's comfort-first choice): the per-user
  // threshold is the THRESHOLD_Q-th percentile of the user's own enrolment scores, and the page
  // locks when the MEAN of the last VOTE_N window scores falls below it (~17 s of movement).
  // Replaying the live loop on 19 held-out users: 0.22 false prompts per minute of movement,
  // 87.3% of impostor runs caught, typically after 17 s. Experiment G's point (10th percentile,
  // 14 of 20) caught 100% within 6.5 s but prompted genuine users 1.95 times per minute.
  var THRESHOLD_Q = 2, VOTE_N = 60, VOTE_K = null, VOTE_RULE = "mean";
  var PCT_GRID = [1, 2, 5, 10, 15, 20, 30, 40, 50];

  function tfOrThrow() {
    if (typeof tf === "undefined") throw new Error("tf runtime not loaded");
    return tf;
  }
  async function cpu() {
    try { await tf.setBackend("cpu"); } catch (e) {}   // the bundle ships only the CPU backend
    await tf.ready();
  }

  // z-score with the base model's training scaler (model/mouse-scaler.json), no clipping.
  function scaleWindow(win, scaler) {
    var out = new Array(win.length);
    for (var r = 0; r < win.length; r++) {
      out[r] = [(win[r][0] - scaler.mean[0]) / (scaler.std[0] || 1),
                (win[r][1] - scaler.mean[1]) / (scaler.std[1] || 1)];
    }
    return out;
  }

  // numpy.percentile's default (linear interpolation between closest ranks).
  function percentile(values, q) {
    var a = values.slice().sort(function (x, y) { return x - y; });
    if (!a.length) return NaN;
    var p = (a.length - 1) * q / 100, lo = Math.floor(p), hi = Math.ceil(p);
    return a[lo] + (a[hi] - a[lo]) * (p - lo);
  }

  function extractorOf(base) {
    return tf.model({ inputs: base.inputs, outputs: base.getLayer(EMBEDDING_LAYER).output });
  }

  // Frozen-FCN embeddings, [n][128], in batches so the page stays responsive.
  async function embed(extractor, wins, scaler, onProgress) {
    var out = [];
    for (var b = 0; b < wins.length; b += EMBED_BATCH) {
      var part = wins.slice(b, b + EMBED_BATCH).map(function (w) { return scaleWindow(w, scaler); });
      var x = tf.tensor3d(part);
      var y = extractor.predict(x);
      var rows = await y.array();
      x.dispose(); y.dispose();
      for (var i = 0; i < rows.length; i++) out.push(rows[i]);
      if (onProgress) onProgress(Math.min(b + EMBED_BATCH, wins.length), wins.length);
      await tf.nextFrame();
    }
    return out;
  }

  // Genuine embeddings repeated in order until they match the negatives' count; never truncated.
  function balance(gen, target) {
    var n = Math.max(target, gen.length), out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = gen[i % gen.length];
    return out;
  }

  // The per-user head: Dense(2, softmax) on the embedding, genuine = class 1.
  async function trainHead(genEmb, negEmb, onEpoch) {
    var gen = balance(genEmb, negEmb.length);
    var xs = tf.tensor2d(gen.concat(negEmb));
    var labels = [];
    for (var i = 0; i < gen.length; i++) labels.push([0, 1]);
    for (var j = 0; j < negEmb.length; j++) labels.push([1, 0]);
    var ys = tf.tensor2d(labels);
    var head = tf.sequential({ layers: [tf.layers.dense({ inputShape: [genEmb[0].length], units: 2, activation: "softmax", name: "verify_head_fit" })] });
    head.compile({ optimizer: tf.train.adam(LR), loss: "categoricalCrossentropy", metrics: ["accuracy"] });
    try {
      await head.fit(xs, ys, {
        epochs: EPOCHS, batchSize: BATCH, shuffle: true,
        callbacks: { onEpochEnd: function (epoch, logs) {
          if (onEpoch) onEpoch(epoch + 1, EPOCHS, (logs && (logs.acc != null ? logs.acc : logs.accuracy)) || 0);
          return tf.nextFrame();
        } },
      });
    } finally { xs.dispose(); ys.dispose(); }
    return head;
  }

  function headScores(head, embs) {
    var x = tf.tensor2d(embs), y = head.predict(x);
    var p = y.arraySync();
    x.dispose(); y.dispose();
    return p.map(function (r) { return r[1]; });
  }

  // One model for scoring: base up to the embedding + the trained head, saved with the per-user
  // threshold in its metadata so the weights and their threshold can never drift apart.
  function assemble(base, head) {
    var dense = tf.layers.dense({ units: 2, activation: "softmax", name: "verify_head" });
    var model = tf.model({ inputs: base.inputs, outputs: dense.apply(base.getLayer(EMBEDDING_LAYER).output) });
    dense.setWeights(head.getWeights());
    return model;
  }

  // genuine: this account's stored windows (50 x [|dx|, |dy|]); opts:
  //   baseUrl, scalerUrl, impostorsUrl — packaged assets
  //   saveTo — model URL or tf.io handler (default: this account's IndexedDB slot via accountId)
  //   onProgress({phase: "embed"|"train", done, total, acc})
  async function train(genuine, opts) {
    tfOrThrow(); await cpu();
    var t0 = Date.now();
    var scaler = await (await fetch(opts.scalerUrl)).json();
    var imp = await (await fetch(opts.impostorsUrl)).json();
    if (imp.featureVersion !== FEATURE_VERSION) throw new Error("impostor set is for " + imp.featureVersion + ", not " + FEATURE_VERSION);
    var base = await tf.loadLayersModel(opts.baseUrl);
    var extractor = extractorOf(base);
    var onProgress = opts.onProgress || function () {};
    var genEmb = await embed(extractor, genuine, scaler, function (d, n) { onProgress({ phase: "embed", done: d, total: n }); });
    var head = await trainHead(genEmb, imp.embeddings, function (e, n, acc) { onProgress({ phase: "train", done: e, total: n, acc: acc }); });
    var enrolScores = headScores(head, genEmb);
    var threshold = percentile(enrolScores, THRESHOLD_Q);
    // The whole percentile table travels with the model, so a later change of operating point can
    // re-derive the threshold without retraining (load() does exactly that).
    var enrolPercentiles = {};
    PCT_GRID.forEach(function (q) { enrolPercentiles[q] = percentile(enrolScores, q); });
    var model = assemble(base, head);
    var meta = {
      featureVersion: FEATURE_VERSION, threshold: threshold, thresholdQ: THRESHOLD_Q,
      voteN: VOTE_N, voteK: VOTE_K, voteRule: VOTE_RULE, enrolPercentiles: enrolPercentiles,
      windows: genuine.length, negatives: imp.embeddings.length,
      trainedAt: Date.now(), recipe: "frozen-fcn-embedding + dense head (Experiment G)",
    };
    model.setUserDefinedMetadata(meta);
    await model.save(opts.saveTo || (SLOT_PREFIX + opts.accountId));
    head.dispose();
    return { threshold: threshold, windows: genuine.length, seconds: (Date.now() - t0) / 1000, enrolScoreMedian: percentile(enrolScores, 50) };
  }

  // ---- scoring (offscreen document, diagnostic page) ----
  var live = null;   // { model, scaler, meta }
  async function load(accountId, scalerUrl, from) {
    tfOrThrow(); await cpu();
    var model = await tf.loadLayersModel(from || (SLOT_PREFIX + accountId));   // throws if never trained
    var meta = model.getUserDefinedMetadata() || {};
    if (meta.featureVersion !== FEATURE_VERSION || !(meta.threshold > 0)) {
      model.dispose();
      throw new Error("mouse profile predates " + FEATURE_VERSION + "; retrain");
    }
    // Apply the CURRENT operating point. A profile that carries its percentile table is re-derived
    // in place; one trained under another point without the table has to be rebuilt (the saved
    // windows are kept, so that is one click on the enrolment page).
    if (meta.thresholdQ !== THRESHOLD_Q || meta.voteN !== VOTE_N || meta.voteRule !== VOTE_RULE) {
      var t = meta.enrolPercentiles && meta.enrolPercentiles[THRESHOLD_Q];
      if (!(t > 0)) { model.dispose(); throw new Error("mouse profile was built for an earlier operating point; rebuild"); }
      meta = Object.assign({}, meta, { threshold: t, thresholdQ: THRESHOLD_Q, voteN: VOTE_N, voteK: VOTE_K, voteRule: VOTE_RULE });
    }
    live = { model: model, scaler: await (await fetch(scalerUrl)).json(), meta: meta };
    return meta;
  }
  function unload() { if (live) { try { live.model.dispose(); } catch (e) {} } live = null; }
  function isReady() { return !!live; }
  function meta() { return live ? live.meta : null; }

  // Genuine-class probability for each window.
  async function scoreWindows(wins) {
    var x = tf.tensor3d(wins.map(function (w) { return scaleWindow(w, live.scaler); }));
    var y = live.model.predict(x);
    var p = await y.array();
    x.dispose(); y.dispose();
    return p.map(function (r) { return r[1]; });
  }
  async function scoreWindow(win) { return (await scoreWindows([win]))[0]; }

  async function clearTrained(accountId) {
    try { await tf.io.removeModel(SLOT_PREFIX + accountId); return true; } catch (e) { return false; }
  }

  return {
    FEATURE_VERSION: FEATURE_VERSION, THRESHOLD_Q: THRESHOLD_Q, VOTE_N: VOTE_N, VOTE_K: VOTE_K, VOTE_RULE: VOTE_RULE,
    scaleWindow: scaleWindow, percentile: percentile, extractorOf: extractorOf, embed: embed,
    trainHead: trainHead, headScores: headScores, assemble: assemble, train: train,
    load: load, unload: unload, isReady: isReady, meta: meta, scoreWindow: scoreWindow,
    scoreWindows: scoreWindows, clearTrained: clearTrained,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ContinuumMouseModel;
