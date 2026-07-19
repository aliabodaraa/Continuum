// offscreen.js — runs in the offscreen document (has a DOM, so TF.js works). Loads the
// model once and scores individual windows on request from the background worker.
var api = globalThis.browser || globalThis.chrome;
var ready = false, loadError = null, personal = false, mouseReady = false;

// Load order: (1) the model the WIZARD trained on-device (IndexedDB — this profile's own
// rhythm), (2) the base model. Nothing user-specific is ever bundled in the package —
// a packaged model would leak into every profile that loads the extension.
async function loadBestModel() {
  ready = false;
  try {
    // The scaler MUST load first — every model was trained on standardized features.
    await ContinuumScoring.loadScaler(api.runtime.getURL("model/scaler.json"));
    try {
      await ContinuumScoring.loadTrained(api.runtime.getURL("model/base-extractor/model.json"));
      personal = true;
    } catch (et) {
      await ContinuumScoring.load(api.runtime.getURL("model/ws50-gru/model.json"));
      personal = false;
    }
    ready = true;
    loadError = null;
    // Mouse head is optional — only exists after the wizard's mouse stage.
    try {
      await ContinuumScoring.loadMouseTrained(
        api.runtime.getURL("model/mouse-extractor/model.json"),
        api.runtime.getURL("model/mouse-scaler.json"));
      mouseReady = true;
    } catch (em) { mouseReady = false; }
    api.runtime.sendMessage({ type: "cg:model-ready", personal: personal, mouse: mouseReady });
    console.log("[continuum-guard/offscreen] model ready (" + (personal ? "PERSONAL" : "base") + ", mouse=" + mouseReady + "), backend:", (typeof tf !== "undefined") && tf.getBackend && tf.getBackend());
  } catch (e) {
    loadError = (e && e.message) || String(e);
    api.runtime.sendMessage({ type: "cg:model-error", error: loadError });
    console.error("[continuum-guard/offscreen] model load failed:", loadError);
  }
}
loadBestModel();

api.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg || msg.target !== "offscreen") return;      // only handle messages addressed to us
  if (msg.type === "cg:score") {
    if (!ready) { reply({ error: loadError || "not_ready" }); return true; }
    ContinuumScoring.scoreWindow(msg.win)
      .then(function (s) { reply({ score: s }); })
      .catch(function (e) { reply({ error: (e && e.message) || "score_failed" }); });
    return true; // async reply
  }
  if (msg.type === "cg:score-mouse") {
    if (!mouseReady) { reply({ error: "mouse_not_trained" }); return true; }
    ContinuumScoring.scoreMouseWindow(msg.win)
      .then(function (s) { reply({ score: s }); })
      .catch(function (e) { reply({ error: (e && e.message) || "score_failed" }); });
    return true;
  }
  if (msg.type === "cg:ping") { reply({ ready: ready, error: loadError, personal: personal, mouse: mouseReady }); return true; }
  if (msg.type === "cg:reload-model") { loadBestModel(); reply({ ok: true }); return true; }
});
