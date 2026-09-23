// What the mouse FCN costs on the extension's TF.js CPU backend (Node 20 / V8, single thread).
// Timing depends only on shapes, so the inputs are random. Writes
// artifacts/repr_arch_study/ondevice_cost.json.
//
//   docker run --rm -v "<repo>/continuum:/w" -w /w node:20-bookworm-slim node extension/scripts/bench_fcn_cpu.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const { EXT, loadTf, installFetch, seedMathRandom } = require("./tf-node-shim");

const tf = loadTf();
installFetch();
seedMathRandom(1);
const MM = require(path.join(EXT, "src", "mouse-model.js"));

const rand = (n) => Array.from({ length: n }, () => Array.from({ length: 50 }, () => [Math.random() * 40, Math.random() * 20]));
const secs = (t) => (Date.now() - t) / 1000;

(async () => {
  await tf.setBackend("cpu"); await tf.ready();
  const base = await tf.loadLayersModel("ext:/model/mouse-fcn/model.json");
  const scaler = await (await fetch("ext:/model/mouse-scaler.json")).json();
  const extractor = MM.extractorOf(base);
  const out = { engine: `node ${process.version} (V8), tfjs ${tf.version_core || ""} backend ${tf.getBackend()}`, cpu: os.cpus()[0].model };

  // Per-window scoring, as the offscreen document does it (one window per call).
  const one = rand(1)[0];
  const x1 = tf.tensor3d([MM.scaleWindow(one, scaler)]);
  for (let i = 0; i < 5; i++) base.predict(x1).dispose();
  let t = Date.now();
  for (let i = 0; i < 50; i++) { const y = extractor.predict(x1); y.dataSync(); y.dispose(); }
  out.scoreOneWindowMs = (Date.now() - t) / 50;

  // Head-only personalisation (what the extension ships): embed 330 windows + train the head.
  t = Date.now();
  const genEmb = await MM.embed(extractor, rand(330), scaler);
  out.embed330Seconds = secs(t);
  const negEmb = await MM.embed(extractor, rand(660), scaler);
  t = Date.now();
  await MM.trainHead(genEmb, negEmb);
  out.headTrain25EpochsSeconds = secs(t);

  // Full fine-tuning as on the server (conv1 + bn1 frozen, Adam 3e-4, batch 32): one epoch over
  // 99 windows, extrapolated to the server's 15 epochs over its 792 training windows at 330.
  const emb = base.getLayer("embedding").output;
  const m = tf.model({ inputs: base.inputs, outputs: tf.layers.dense({ units: 2, activation: "softmax", name: "bench_head" }).apply(emb) });
  m.getLayer("conv1").trainable = false; m.getLayer("bn1").trainable = false;
  m.compile({ optimizer: tf.train.adam(3e-4), loss: "categoricalCrossentropy" });
  const X = tf.tensor3d(rand(99).map((w) => MM.scaleWindow(w, scaler)));
  const Y = tf.oneHot(tf.tensor1d(Array.from({ length: 99 }, (_, i) => (i < 33 ? 1 : 0)), "int32"), 2);
  t = Date.now();
  await m.fit(X, Y, { epochs: 1, batchSize: 32, shuffle: true, verbose: 0 });
  out.fullFineTuneEpoch99Seconds = secs(t);
  out.fullFineTunePerWindowEpochSeconds = out.fullFineTuneEpoch99Seconds / 99;
  out.fullFineTuneServerRecipeHoursEstimate = (out.fullFineTunePerWindowEpochSeconds * 792 * 15) / 3600;

  const dest = path.resolve(EXT, "..", "artifacts", "repr_arch_study", "ondevice_cost.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  console.log("wrote", dest);
})().catch((e) => { console.error(e); process.exit(1); });
