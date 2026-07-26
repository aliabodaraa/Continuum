// offscreen.js — runs in the offscreen document (has a DOM, so TF.js works). Loads the
// model once and scores individual windows on request from the background worker.
var api = globalThis.browser || globalThis.chrome;
var ready = false, loadError = null, personal = false, mouseReady = false;

// Load order: (1) the model the WIZARD trained on-device (IndexedDB — THIS Chrome/Google
// account's own rhythm, see background.js's account binding), (2) the base model. Nothing
// user-specific is ever bundled in the package — a packaged model would leak into every
// account that loads the extension. accountId is undefined on the very first call (before
// background has resolved which account is signed in) — that always falls through to the
// base model; background follows up with a real cg:reload-model once it knows the account.
var curAccountId = null;
async function loadBestModel(accountId) {
  ready = false;
  curAccountId = accountId || null;
  ContinuumScoring.unload();   // never keep scoring on a PREVIOUS account's weights mid-swap
  try {
    // The scaler MUST load first — every model was trained on standardized features.
    await ContinuumScoring.loadScaler(api.runtime.getURL("model/scaler.json"));
    if (curAccountId) {
      try {
        await ContinuumScoring.loadTrained(api.runtime.getURL("model/base-extractor/model.json"), curAccountId);
        personal = true;
      } catch (et) {
        await ContinuumScoring.load(api.runtime.getURL("model/ws50-gru/model.json"));
        personal = false;
      }
    } else {
      await ContinuumScoring.load(api.runtime.getURL("model/ws50-gru/model.json"));
      personal = false;
    }
    ready = true;
    loadError = null;
    // Mouse head is optional — only exists after the wizard's mouse stage for THIS account.
    if (curAccountId) {
      try {
        await ContinuumScoring.loadMouseTrained(
          api.runtime.getURL("model/mouse-extractor/model.json"),
          api.runtime.getURL("model/mouse-scaler.json"), curAccountId);
        mouseReady = true;
      } catch (em) { mouseReady = false; }
    } else {
      mouseReady = false;
    }
    api.runtime.sendMessage({ type: "cg:model-ready", personal: personal, mouse: mouseReady });
    console.log("[continuum-guard/offscreen] model ready (" + (personal ? "PERSONAL" : "base") + ", mouse=" + mouseReady + "), account=" + (curAccountId || "none") + ", backend:", (typeof tf !== "undefined") && tf.getBackend && tf.getBackend());
  } catch (e) {
    loadError = (e && e.message) || String(e);
    api.runtime.sendMessage({ type: "cg:model-error", error: loadError });
    console.error("[continuum-guard/offscreen] model load failed:", loadError);
  }
}
loadBestModel(null);   // base model until background resolves the signed-in account

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
  if (msg.type === "cg:reload-model") { loadBestModel(msg.accountId).then(function () { reply({ ok: true }); }); return true; }
  if (msg.type === "cg:migrate-model") {
    // One-time move of a pre-account-binding trained head from the old unsuffixed
    // IndexedDB slot to this account's own slot — only tf (loaded here, not in the
    // service worker) can read/write the indexeddb:// scheme. Best-effort per slot:
    // a user might have trained only keystroke, only mouse, or neither.
    (async function () {
      try { await tf.ready(); } catch (e) {}
      try {
        var oldHead = await tf.loadLayersModel("indexeddb://cg-personal-head");
        await oldHead.save("indexeddb://cg-personal-head-" + msg.accountId);
        try { await tf.io.removeModel("indexeddb://cg-personal-head"); } catch (e2) {}
      } catch (e) {}
      try {
        var oldMouseHead = await tf.loadLayersModel("indexeddb://cg-personal-mouse-head");
        await oldMouseHead.save("indexeddb://cg-personal-mouse-head-" + msg.accountId);
        try { await tf.io.removeModel("indexeddb://cg-personal-mouse-head"); } catch (e2) {}
      } catch (e) {}
      reply({ ok: true });
    })();
    return true;
  }
});
