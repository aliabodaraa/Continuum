// Experiment G (artifacts/repr_arch_study/PREREGISTRATION_G.md): the extension's on-device mouse
// personalisation, run as shipped -- extension/src/mouse-model.js on the extension's own TF.js
// build (CPU backend) and base model -- on Experiment F's windows.
//
//   node extension/scripts/eval_ondevice_g.js negatives           # embed + write data/mouse-impostors.json, parity vs Keras
//   node extension/scripts/eval_ondevice_g.js embed <k> <n>       # embeddings of shard k of n of the test windows
//   node extension/scripts/eval_ondevice_g.js heads               # train heads (3 seeds), write parts/G_device.json
//   node extension/scripts/eval_ondevice_g.js fidelity            # shipped end-to-end path == fast path, 2 targets
//
// Run in node:20 with the repository mounted at /w (see bench_fcn_cpu.js).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EXT, loadTf, installFetch, seedMathRandom } = require("./tf-node-shim");

const tf = loadTf();
installFetch();
const MM = require(path.join(EXT, "src", "mouse-model.js"));

const ROOT = path.resolve(EXT, "..");
const STUDY = path.join(ROOT, "artifacts", "repr_arch_study");
const EVAL = path.join(ROOT, "artifacts", "final_eval");
const INPUTS = path.join(EVAL, "g_inputs.json");
const IMPOSTORS = path.join(EXT, "data", "mouse-impostors.json");
const SEEDS = [101, 102, 103];
const BUDGET = 330;

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const inputs = () => JSON.parse(fs.readFileSync(INPUTS));
const round5 = (v) => Math.round(v * 1e5) / 1e5;

async function extractor() {
  await tf.setBackend("cpu"); await tf.ready();
  const base = await tf.loadLayersModel("ext:/model/mouse-fcn/model.json");
  const scaler = await (await fetch("ext:/model/mouse-scaler.json")).json();
  return { base, scaler, ex: MM.extractorOf(base) };
}

async function cmdNegatives() {
  const d = inputs();
  const { ex, scaler } = await extractor();
  const emb = await MM.embed(ex, d.negatives, scaler);
  let maxDiff = 0;
  emb.forEach((row, i) => row.forEach((v, j) => { maxDiff = Math.max(maxDiff, Math.abs(v - d.negativesKerasEmbedding[i][j])); }));
  const doc = {
    featureVersion: MM.FEATURE_VERSION,
    source: "SapiMouse base users only (held-out users excluded): the 660 windows model-api draws for a 330-window enrolment (Mouse_A5_W50_base.h5, seed 13 then 21)",
    baseModel: "model/mouse-fcn (sha256 of weights " + sha(path.join(EXT, "model", "mouse-fcn", "group1-shard1of1.bin")).slice(0, 16) + ")",
    embeddingLayer: "embedding",
    count: emb.length,
    embeddings: emb.map((r) => r.map(round5)),
  };
  fs.writeFileSync(IMPOSTORS, JSON.stringify(doc));
  const parity = { windows: emb.length, maxAbsDiffTfjsVsKeras: maxDiff };
  fs.writeFileSync(path.join(EVAL, "g_parity.json"), JSON.stringify(parity, null, 1));
  console.log("TF.js vs Keras embedding parity:", parity, "->", IMPOSTORS);
}

async function cmdEmbed(k, n) {
  const d = inputs();
  const { ex, scaler } = await extractor();
  const jobs = [];
  d.targets.forEach((t) => { jobs.push(["enrol", t.participant, t.enrol]); jobs.push(["genuine", t.participant, t.genuine]); });
  Object.entries(d.impostorRuns).forEach(([u, w]) => jobs.push(["impostor", u, w]));
  const out = {};
  for (let i = k; i < jobs.length; i += n) {
    const [kind, u, w] = jobs[i];
    const t0 = Date.now();
    out[kind + ":" + u] = await MM.embed(ex, w, scaler);
    console.log(`shard ${k}/${n}: ${kind} ${u} (${w.length} windows) ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  fs.writeFileSync(path.join(EVAL, `g_emb_${k}of${n}.json`), JSON.stringify(out));
}

function loadEmbeddings() {
  const all = {};
  fs.readdirSync(EVAL).filter((f) => /^g_emb_\d+of\d+\.json$/.test(f))
    .forEach((f) => Object.assign(all, JSON.parse(fs.readFileSync(path.join(EVAL, f)))));
  return all;
}

async function cmdHeads() {
  await tf.setBackend("cpu"); await tf.ready();
  const d = inputs();
  const E = loadEmbeddings();
  const neg = JSON.parse(fs.readFileSync(IMPOSTORS)).embeddings;
  const prereg = sha(path.join(STUDY, "PREREGISTRATION_G.md"));
  const docs = [];
  for (let s = 0; s < SEEDS.length; s++) {
    const rows = [];
    for (let i = 0; i < d.targets.length; i++) {
      const u = d.targets[i].participant;
      seedMathRandom(SEEDS[s] * 1000 + i);
      const t0 = Date.now();
      const head = await MM.trainHead(E["enrol:" + u], neg);
      const P = (emb) => MM.headScores(head, emb);
      const runs = {};
      Object.keys(d.impostorRuns).forEach((o) => { if (o !== u) runs[o] = P(E["impostor:" + o]); });
      rows.push({ participant: u, M: { [BUDGET]: { _enrolScores: P(E["enrol:" + u]), _genuineScores: P(E["genuine:" + u]), _impostorRuns: runs } } });
      head.dispose();
      console.log(`seed ${SEEDS[s]} ${u}: head trained in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    docs.push({ seedIndex: s, seed: SEEDS[s], perUser: rows });
  }
  const out = {
    preregistrationGSha256: prereg, exp: "G", pipeline: "device", budget: BUDGET,
    code: { "extension/src/mouse-model.js": sha(path.join(EXT, "src", "mouse-model.js")),
            "extension/vendor/tf-lite.js": sha(path.join(EXT, "vendor", "tf-lite.js")),
            "extension/model/mouse-fcn/group1-shard1of1.bin": sha(path.join(EXT, "model", "mouse-fcn", "group1-shard1of1.bin")),
            "extension/data/mouse-impostors.json": sha(IMPOSTORS) },
    seeds: docs,
  };
  const dest = path.join(STUDY, "parts", "G_device.json");
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log("wrote", dest);
}

// The shipped end-to-end path (train() -> save -> load() -> scoreWindows()) must give the same
// scores and threshold as the fast path the heads command uses (precomputed embeddings -> head).
async function cmdFidelity() {
  const d = inputs();
  const { ex, scaler } = await extractor();
  const neg = JSON.parse(fs.readFileSync(IMPOSTORS)).embeddings;
  const report = [];
  for (const t of d.targets.slice(0, 2)) {
    seedMathRandom(7);
    let saved = null;
    const r = await MM.train(t.enrol, {
      baseUrl: "ext:/model/mouse-fcn/model.json", scalerUrl: "ext:/model/mouse-scaler.json",
      impostorsUrl: "ext:/data/mouse-impostors.json",
      saveTo: tf.io.withSaveHandler(async (a) => { saved = a; return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: "JSON" } }; }),
    });
    const meta = await MM.load(null, "ext:/model/mouse-scaler.json", tf.io.fromMemory(saved));
    const probe = t.genuine.slice(0, 60).concat(d.impostorRuns[Object.keys(d.impostorRuns).find((o) => o !== t.participant)].slice(0, 60));
    const endToEnd = await MM.scoreWindows(probe);
    // Fast path with the SAME trained head: the saved model's head weights on precomputed embeddings.
    const w = tf.io.decodeWeights(saved.weightData, saved.weightSpecs);
    const head = tf.sequential({ layers: [tf.layers.dense({ inputShape: [128], units: 2, activation: "softmax" })] });
    head.setWeights([w["verify_head/kernel"], w["verify_head/bias"]]);
    const fast = MM.headScores(head, await MM.embed(ex, probe, scaler));
    const thrFast = MM.percentile(MM.headScores(head, await MM.embed(ex, t.enrol, scaler)), MM.THRESHOLD_Q);
    const maxDiff = Math.max(...fast.map((v, i) => Math.abs(v - endToEnd[i])));
    report.push({ participant: t.participant, trainSeconds: r.seconds, scoredWindows: probe.length,
                  maxAbsScoreDiff: maxDiff, thresholdSaved: meta.threshold, thresholdFastPath: thrFast,
                  thresholdAbsDiff: Math.abs(meta.threshold - thrFast), negativesUsed: meta.negatives });
    MM.unload();
    console.log(report[report.length - 1]);
  }
  fs.writeFileSync(path.join(EVAL, "g_fidelity.json"), JSON.stringify(report, null, 1));
}

const [cmd, a, b] = process.argv.slice(2);
({ negatives: cmdNegatives, embed: () => cmdEmbed(+a, +b), heads: cmdHeads, fidelity: cmdFidelity }[cmd] || (() => { throw new Error("unknown command " + cmd); }))()
  .catch((e) => { console.error(e); process.exit(1); });
