// offscreen.js — runs in the offscreen document (has a DOM, so TF.js works). Loads the
// model once and scores individual windows on request from the background worker.
var api = globalThis.browser || globalThis.chrome;
var ready = false, loadError = null;

(async function () {
  try {
    await ContinuumScoring.load(api.runtime.getURL("model/ws50-gru/model.json"));
    ready = true;
    api.runtime.sendMessage({ type: "cg:model-ready" });
    console.log("[continuum-guard/offscreen] model ready, backend:", (typeof tf !== "undefined") && tf.getBackend && tf.getBackend());
  } catch (e) {
    loadError = (e && e.message) || String(e);
    api.runtime.sendMessage({ type: "cg:model-error", error: loadError });
    console.error("[continuum-guard/offscreen] model load failed:", loadError);
  }
})();

api.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg || msg.target !== "offscreen") return;      // only handle messages addressed to us
  if (msg.type === "cg:score") {
    if (!ready) { reply({ error: loadError || "not_ready" }); return true; }
    ContinuumScoring.scoreWindow(msg.win)
      .then(function (s) { reply({ score: s }); })
      .catch(function (e) { reply({ error: (e && e.message) || "score_failed" }); });
    return true; // async reply
  }
  if (msg.type === "cg:ping") { reply({ ready: ready, error: loadError }); return true; }
});
