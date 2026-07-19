// background.js — MV3 service worker. TensorFlow.js can't run HERE (a service worker has
// no DOM), so inference is delegated to an OFFSCREEN document (src/offscreen.html) that
// hosts TF.js. This worker keeps the rolling packet + verdict + config and serves the
// popup; it loads only the PURE decision logic from scoring.js (no tf) to apply the
// Lu et al. packet vote. Windows arrive from every tab; the typed text never leaves the page.
try { importScripts("scoring.js"); } catch (e) { console.error("[continuum-guard] failed to load scoring:", e && e.message); }

var api = globalThis.browser || globalThis.chrome;
var RECENT = (typeof ContinuumScoring !== "undefined") ? ContinuumScoring.RECENT_WINDOW_COUNT : 6;

var config = { enabled: true, exclusions: [] };
var state = { totalWindows: 0, lastWindowAt: 0, modelReady: false, modelError: null, verdict: null };
var scores = [];  // rolling last N window scores

api.storage.local.get(["cg_enabled", "cg_exclusions"], function (d) {
  d = d || {};
  config.enabled = d.cg_enabled !== false;
  config.exclusions = d.cg_exclusions || [];
});

// ---- offscreen document that hosts TF.js (Chromium; Firefox has no offscreen API) ----
async function ensureOffscreen() {
  if (!api.offscreen) { if (!state.modelError) state.modelError = "offscreen_api_unavailable"; return; }
  try {
    if (api.offscreen.hasDocument && (await api.offscreen.hasDocument())) return;
    await api.offscreen.createDocument({
      url: "src/offscreen.html",
      reasons: ["WORKERS"],
      justification: "Run the on-device keystroke model (TensorFlow.js requires a DOM).",
    });
  } catch (e) {
    var m = (e && e.message) || "";
    if (!/single offscreen|already/i.test(m)) { state.modelError = "offscreen_create: " + m; console.error("[continuum-guard]", state.modelError); }
  }
}
ensureOffscreen();

function scoreViaOffscreen(win) {
  return new Promise(function (resolve) {
    try {
      api.runtime.sendMessage({ target: "offscreen", type: "cg:score", win: win }, function (res) {
        if (api.runtime.lastError || !res || res.error != null) resolve(null);
        else resolve(res.score);
      });
    } catch (e) { resolve(null); }
  });
}

function statusObj() {
  return {
    enabled: config.enabled, totalWindows: state.totalWindows, lastWindowAt: state.lastWindowAt,
    exclusions: config.exclusions, modelReady: state.modelReady, modelError: state.modelError, verdict: state.verdict,
  };
}

// Ask the offscreen doc whether the model is ready (survives worker restarts, where the
// in-memory modelReady flag is lost but the offscreen doc is still alive).
function pingOffscreen(cb) {
  try {
    api.runtime.sendMessage({ target: "offscreen", type: "cg:ping" }, function (r) {
      cb(api.runtime.lastError ? null : r);
    });
  } catch (e) { cb(null); }
}

// ---- capture → score (offscreen) → verdict ----
var scoringBusy = false, pendingWin = null;
async function onWindow(win) {
  if (!config.enabled) return;
  state.totalWindows += 1;
  state.lastWindowAt = Date.now();
  if (!state.modelReady) { await ensureOffscreen(); return; }

  pendingWin = win;                 // coalesce bursts — always score the newest
  if (scoringBusy) return;
  scoringBusy = true;
  try {
    while (pendingWin) {
      var w = pendingWin; pendingWin = null;
      var s = await scoreViaOffscreen(w);
      if (s == null) continue;
      scores.push(s);
      if (scores.length > RECENT) scores.shift();
      var v = ContinuumScoring.decide(scores);
      state.verdict = {
        status: scores.length < RECENT ? "analyzing" : (v.suspicious ? "suspicious" : "genuine"),
        mean: Math.round(v.mean * 100),
        packet: scores.length,
        need: RECENT,
      };
    }
  } catch (e) { console.error("[continuum-guard] scoring error:", e && e.message); }
  finally { scoringBusy = false; }
}

function broadcastConfig() {
  if (!api.tabs) return;
  api.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (t) {
      try { api.tabs.sendMessage(t.id, { type: "cg:config", enabled: config.enabled, exclusions: config.exclusions }); } catch (e) {}
    });
  });
}

api.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg) return;
  switch (msg.type) {
    case "cg:model-ready": state.modelReady = true; state.modelError = null; return;
    case "cg:model-error": state.modelReady = false; state.modelError = msg.error || "load_failed"; return;
    case "cg:hello":
      reply({ enabled: config.enabled, excluded: config.exclusions.indexOf(msg.origin) >= 0 });
      return true;
    case "cg:windows":
      if (msg.latest) onWindow(msg.latest);
      return;
    case "cg:status":
      if (!state.modelReady) {
        // Make sure the offscreen doc exists, then ask it directly whether the model loaded.
        ensureOffscreen().then(function () {
          pingOffscreen(function (r) {
            if (r && r.ready) { state.modelReady = true; state.modelError = null; }
            else if (r && r.error) { state.modelError = r.error; }
            reply(statusObj());
          });
        });
        return true; // async reply
      }
      reply(statusObj());
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
