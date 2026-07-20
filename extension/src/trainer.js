// trainer.js — ON-DEVICE personalization. Trains a personal classifier on the wizard's
// enrolled windows (genuine, label 1) against a bundled set of impostor windows from the
// public dataset (label 0). Everything runs in the browser: the user's windows never
// leave the device.
//
// Design note: tfjs-layers cannot LOAD a Keras GRU with reset_after=true (TF 2.x default),
// so we cannot fine-tune the full model as a layers model. Instead the frozen Conv1D+GRU
// stack ships as a GRAPH model cut at the flatten layer (model/base-extractor — graph GRUs
// already run fine via executeAsync, same as the scorer), and only a tiny Dense softmax
// HEAD is trained in tfjs-layers on the extracted features. Head → indexeddb, which the
// offscreen scorer prefers over any bundled model (extractor.executeAsync → head.predict).
var ContinuumTrainer = (function () {
  var EPOCHS = 25, BATCH = 32, LR = 0.002;
  var JITTER = 0.006;   // augmentation noise on continuous feature columns

  // Oversample + jitter the genuine windows so the two classes are balanced.
  // jitterCols: which feature columns take noise (keystroke: timings only, ids pristine;
  // mouse: kinematics only, the is_click flag pristine).
  function augment(genuine, targetCount, jitterCols) {
    var out = [];
    for (var i = 0; out.length < targetCount; i++) {
      var w = genuine[i % genuine.length], copy = [];
      for (var r = 0; r < w.length; r++) {
        var row = w[r].slice();
        if (i >= genuine.length) {                 // first pass stays pristine
          for (var j = 0; j < jitterCols.length; j++) {
            var c = jitterCols[j];
            row[c] = row[c] + (Math.random() * 2 - 1) * JITTER;
          }
        }
        copy.push(row);
      }
      out.push(copy);
    }
    return out;
  }

  // genuine: array of [50xF] windows from the wizard; opts:
  //   impostorsUrl / extractorUrl / scalerUrl — packaged assets for this modality
  //   saveTo     — IndexedDB slot for the trained head (default: the keystroke slot)
  //   jitterCols — feature columns the augmentation may jitter (default: keystroke timings)
  //   onProgress({epoch, epochs, acc, loss}) — fires per epoch for the UI
  async function train(genuine, opts) {
    if (typeof tf === "undefined") throw new Error("tf runtime not loaded");
    try { await tf.setBackend("cpu"); } catch (e) {}
    await tf.ready();
    var onProgress = opts.onProgress;
    var saveTo = opts.saveTo || "indexeddb://cg-personal-head";
    var jitterCols = opts.jitterCols || [2, 3, 4, 5];

    var impostors = (await (await fetch(opts.impostorsUrl)).json()).windows;
    var scaler = await (await fetch(opts.scalerUrl)).json();
    var extractor = await tf.loadGraphModel(opts.extractorUrl);

    // Augment in RAW feature space, then standardize exactly like the base model's
    // training pipeline (model-api preprocessing.py FeatureScaler) — CLIP before
    // z-score, same as scoring.js, or the extractor sees out-of-distribution inputs.
    var KS_CLIP_MIN = [0.0, 0.0, 0.0, 0.0, 0.0, -1.0];
    var KS_CLIP_MAX = [1.0, 1.0, 2.0, 2.0, 5.0, 5.0];
    function scale(w) {
      var clip = w[0] && w[0].length === KS_CLIP_MIN.length;   // 6 dims = keystroke; mouse (7) skips clip
      return w.map(function (row) {
        return row.map(function (v, c) {
          if (clip) v = Math.max(KS_CLIP_MIN[c], Math.min(KS_CLIP_MAX[c], v));
          return (v - scaler.mean[c]) / (scaler.std[c] || 1);
        });
      });
    }
    var gen = augment(genuine, impostors.length, jitterCols);
    var X = gen.concat(impostors).map(scale);
    var Y = [];
    for (var i = 0; i < X.length; i++) Y.push(i < gen.length ? [0, 1] : [1, 0]);

    // One pass through the frozen stack (batched; executeAsync because of the GRU loop).
    var featParts = [];
    for (var b = 0; b < X.length; b += BATCH) {
      var xb = tf.tensor3d(X.slice(b, b + BATCH));
      featParts.push(await extractor.executeAsync(xb));
      xb.dispose();
      if (onProgress) onProgress({ epoch: 0, epochs: EPOCHS, acc: 0, phase: "features", done: Math.min(b + BATCH, X.length), total: X.length });
      await tf.nextFrame();
    }
    var feats = tf.concat(featParts); featParts.forEach(function (t) { t.dispose(); });
    var featDim = feats.shape[feats.shape.length - 1];

    var head = tf.sequential({ layers: [tf.layers.dense({ inputShape: [featDim], units: 2, activation: "softmax" })] });
    head.compile({ optimizer: tf.train.adam(LR), loss: "categoricalCrossentropy", metrics: ["accuracy"] });

    var ys = tf.tensor2d(Y);
    var acc = 0;
    try {
      await head.fit(feats, ys, {
        epochs: EPOCHS, batchSize: BATCH, shuffle: true,
        callbacks: {
          onEpochEnd: function (epoch, logs) {
            acc = (logs && (logs.acc != null ? logs.acc : logs.accuracy)) || 0;
            if (onProgress) onProgress({ epoch: epoch + 1, epochs: EPOCHS, acc: acc, loss: logs && logs.loss });
            return tf.nextFrame();               // keep the wizard page responsive
          },
        },
      });
    } finally { feats.dispose(); ys.dispose(); }

    await head.save(saveTo);
    return { accuracy: acc, genuineWindows: genuine.length, impostorWindows: impostors.length };
  }

  async function clearTrained() {
    var ok = false;
    try { await tf.io.removeModel("indexeddb://cg-personal-head"); ok = true; } catch (e) {}
    try { await tf.io.removeModel("indexeddb://cg-personal-mouse-head"); ok = true; } catch (e) {}
    return ok;
  }

  return { train: train, clearTrained: clearTrained };
})();
if (typeof module !== "undefined" && module.exports) module.exports = ContinuumTrainer;
