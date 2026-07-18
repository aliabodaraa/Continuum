// background.js — MV3 service worker. Loads the TF.js runtime + the graph model, scores
// the feature windows arriving from every tab ON-DEVICE (Lu et al. packet vote), and
// serves the popup. Nothing leaves the browser: the model is a packaged asset, keystrokes
// stay in the content script, and only the verdict is kept here.
//
// NOTE: P2 scores against the BASE model (population-level). P1 will download the user's
// personalised model and swap it in via ContinuumScoring.load() — the loop is identical.
try {
  importScripts("../vendor/tf.min.js", "scoring.js");
} catch (e) {
  console.error("[continuum-guard] failed to load tf/scoring:", e && e.message);
}

var api = globalThis.browser || globalThis.chrome;

var config = { enabled: true, exclusions: [] };
var state = { totalWindows: 0, lastWindowAt: 0, modelReady: false, modelError: null, verdict: null };
var scores = [];  // rolling last N window SCORES (each window scored once)

api.storage.local.get(["cg_enabled", "cg_exclusions"], function (d) {
  d = d || {};
  config.enabled = d.cg_enabled !== false;
  config.exclusions = d.cg_exclusions || [];
});

// Load the on-device model (packaged asset — no network).
(async function () {
  try {
    if (typeof ContinuumScoring === "undefined") throw new Error("scoring module missing");
    await ContinuumScoring.load(api.runtime.getURL("model/ws50-gru/model.json"));
    state.modelReady = true;
    console.log("[continuum-guard] on-device model ready");
  } catch (e) {
    state.modelError = (e && e.message) || String(e);
    console.error("[continuum-guard] model load failed:", state.modelError);
  }
})();

function broadcastConfig() {
  if (!api.tabs) return;
  api.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (t) {
      try { api.tabs.sendMessage(t.id, { type: "cg:config", enabled: config.enabled, exclusions: config.exclusions }); } catch (e) {}
    });
  });
}

var scoringBusy = false;
var pendingWin = null;
async function onWindow(win) {
  if (!config.enabled) return;
  state.totalWindows += 1;
  state.lastWindowAt = Date.now();
  if (!state.modelReady) return;

  // Score each window ONCE (~80ms). Coalesce bursts: while a score is running, only the
  // newest pending window is kept, so we never build a backlog — we always score latest.
  pendingWin = win;
  if (scoringBusy) return;
  scoringBusy = true;
  var N = ContinuumScoring.RECENT_WINDOW_COUNT;
  try {
    while (pendingWin) {
      var w = pendingWin; pendingWin = null;
      var s = await ContinuumScoring.scoreWindow(w);
      scores.push(s);
      if (scores.length > N) scores.shift();
      var v = ContinuumScoring.decide(scores);
      state.verdict = {
        status: scores.length < N ? "analyzing" : (v.suspicious ? "suspicious" : "genuine"),
        mean: Math.round(v.mean * 100),
        packet: scores.length,
        need: N,
      };
    }
  } catch (e) {
    console.error("[continuum-guard] scoring error:", e && e.message);
  } finally {
    scoringBusy = false;
  }
}

api.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg) return;
  switch (msg.type) {
    case "cg:hello":
      reply({ enabled: config.enabled, excluded: config.exclusions.indexOf(msg.origin) >= 0 });
      return true;
    case "cg:windows":
      if (msg.latest) onWindow(msg.latest);
      return;
    case "cg:status":
      reply({
        enabled: config.enabled, totalWindows: state.totalWindows, lastWindowAt: state.lastWindowAt,
        exclusions: config.exclusions, modelReady: state.modelReady, modelError: state.modelError, verdict: state.verdict,
      });
      return true;
    case "cg:setEnabled":
      config.enabled = !!msg.value;
      api.storage.local.set({ cg_enabled: config.enabled });
      broadcastConfig();
      reply({ ok: true });
      return true;
    case "cg:toggleExclude": {
      var i = config.exclusions.indexOf(msg.origin);
      if (i >= 0) config.exclusions.splice(i, 1);
      else if (msg.origin) config.exclusions.push(msg.origin);
      api.storage.local.set({ cg_exclusions: config.exclusions });
      broadcastConfig();
      reply({ exclusions: config.exclusions });
      return true;
    }
  }
});
