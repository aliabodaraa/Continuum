// Load the extension's own TF.js build (vendor/tf-lite.js, the browser bundle) under Node, so
// the extension's code can be measured in the same engine (V8) with the same kernels (CPU
// backend) it runs with in Chrome. The bundle picks its platform at load time: `process` is
// hidden and a minimal `window`/`document` provided so it selects the browser platform, and
// `fetch` serves files from the repository for the http(s)/extension URLs the code requests.
const fs = require("fs");
const path = require("path");

const EXT = path.resolve(__dirname, "..");

function loadTf() {
  const realProcess = globalThis.process;
  delete globalThis.process;
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.document = {};
  require(path.join(EXT, "vendor", "tf-lite.js"));
  globalThis.process = realProcess;
  return globalThis.tf;
}

// fetch("ext:/model/mouse-fcn/model.json") -> the file under extension/.
function installFetch() {
  globalThis.fetch = async (url) => {
    const rel = String(url).replace(/^ext:\/?/, "");
    const file = path.join(EXT, rel);
    const buf = fs.readFileSync(file);
    return new Response(buf, { status: 200, headers: { "Content-Type": file.endsWith(".json") ? "application/json" : "application/octet-stream" } });
  };
}

// Deterministic Math.random (mulberry32): TF.js draws weight-initialiser seeds and fit()'s
// shuffle order from it, so replacing it makes a training run repeatable.
function seedMathRandom(seed) {
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { EXT, loadTf, installFetch, seedMathRandom };
