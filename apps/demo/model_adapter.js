// Optional global TFJS adapter. The auth flow uses the Python per-user CNN/LSTM API.
const path = require("path");

let tf = null;
let model = null;

async function tryLoadTfjsModel(modelDir) {
  try {
    tf = require("@tensorflow/tfjs-node");
    const modelPath = `file://${path.resolve(modelDir)}`;
    model = await tf.loadLayersModel(`${modelPath}/model.json`);
    console.log("Loaded TFJS model from", modelDir);
    return true;
  } catch (err) {
    console.warn("Could not load TFJS model:", err.message);
    return false;
  }
}

async function predictFromModel(inputArray) {
  if (!model) throw new Error("Model not loaded");
  const tfinput = tf.tensor(inputArray);
  const pred = model.predict(tfinput);
  const data = await pred.array();
  tfinput.dispose();
  if (typeof pred.dispose === "function") pred.dispose();
  return data;
}

module.exports = {
  init: async (opts = {}) => {
    if (process.env.USE_TFJS_MODEL !== "true") {
      console.log("Using Python per-user CNN/LSTM rhythm models; global TFJS model disabled.");
      return;
    }

    const modelDir = opts.modelDir || "../artifacts/tfjs_model";
    const ok = await tryLoadTfjsModel(path.resolve(__dirname, modelDir));
    if (!ok) {
      console.log("TFJS model not available. Python per-user CNN/LSTM rhythm models remain active.");
    }
  },
  predict: async (inputArray) => {
    if (model) return await predictFromModel(inputArray);
    throw new Error("No global TFJS model loaded");
  },
};
