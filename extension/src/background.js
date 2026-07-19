// background.js — MV3 service worker. TensorFlow.js can't run HERE (a service worker has
// no DOM), so inference is delegated to an OFFSCREEN document (src/offscreen.html) that
// hosts TF.js. This worker keeps the rolling packet + verdict + config and serves the
// popup; it loads only the PURE decision logic from scoring.js (no tf) to apply the
// Lu et al. packet vote. Windows arrive from every tab; the typed text never leaves the page.
var api = globalThis.browser || globalThis.chrome;
var RECENT = 6;                                        // packet size (mirrors ca-service)
var WINDOW_THRESHOLD = 0.5, PACKET_VOTE_FRACTION = 0.5;

// Pure Lu et al. packet vote, INLINED — the service worker needs no importScripts (MV3 SW
// importScripts of a packaged file was failing and cascading into "No SW"). The offscreen
// document still uses scoring.js for the actual TF.js inference.
function decide(scores) {
  var low = 0, sum = 0;
  for (var i = 0; i < scores.length; i++) { if (scores[i] < WINDOW_THRESHOLD) low += 1; sum += scores[i]; }
  var frac = scores.length ? low / scores.length : 0;
  return { suspicious: frac >= PACKET_VOTE_FRACTION, mean: scores.length ? sum / scores.length : 0, lowFraction: frac };
}

// The FIXED Continuum relying party: passkeys live on this origin (site passkeys are
// origin-bound, so the extension keeps its own RP — served by the passkey-service).
var RP_BASE = "http://localhost:4000";

var config = { enabled: true, exclusions: [] };
var state = { totalWindows: 0, lastWindowAt: 0, modelReady: false, modelError: null, verdict: null, steps: 0, needSteps: 50, enrolled: false, modelPersonal: false, locked: false, hasPasskey: false, profileNum: 0 };
var scores = [];  // rolling last N window scores

// Stable NUMERIC id for the passkey-service, derived from this profile's id (FNV-1a).
function numericUid(pid) {
  var h = 2166136261;
  for (var i = 0; i < pid.length; i++) { h ^= pid.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) + 1;   // +1: never 0 (service treats 0 as missing)
}

api.storage.local.get(["cg_enabled", "cg_exclusions", "cg_enrolled_at", "cg_passkey", "cg_profile_id"], function (d) {
  d = d || {};
  config.enabled = d.cg_enabled !== false;
  config.exclusions = d.cg_exclusions || [];
  state.enrolled = !!d.cg_enrolled_at;
  state.hasPasskey = !!d.cg_passkey;
  var pid = d.cg_profile_id;
  if (!pid) {   // same format the enrollment wizard uses; whoever runs first creates it
    pid = "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    api.storage.local.set({ cg_profile_id: pid });
  }
  state.profileNum = numericUid(pid);
});

// Inject the capture scripts into tabs that were ALREADY open when the extension was
// (re)loaded — otherwise monitoring only starts after the user manually refreshes each tab.
function injectAll() {
  if (!api.scripting || !api.tabs) return;
  api.tabs.query({ url: ["http://*/*", "https://*/*"] }, function (tabs) {
    (tabs || []).forEach(function (t) {
      try {
        api.scripting.executeScript(
          { target: { tabId: t.id }, files: ["src/features.js", "src/content.js"] },
          function () { void api.runtime.lastError; }   // chrome:// & store tabs refuse — fine
        );
      } catch (e) {}
    });
  });
}
if (api.runtime.onInstalled) api.runtime.onInstalled.addListener(injectAll);
if (api.runtime.onStartup) api.runtime.onStartup.addListener(injectAll);

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
    steps: state.steps, needSteps: state.needSteps, enrolled: state.enrolled, modelPersonal: state.modelPersonal,
    locked: state.locked, hasPasskey: state.hasPasskey,
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
      var v = decide(scores);
      state.verdict = {
        status: scores.length < RECENT ? "analyzing" : (v.suspicious ? "suspicious" : "genuine"),
        mean: Math.round(v.mean * 100),
        packet: scores.length,
        need: RECENT,
      };
      // ENFORCEMENT: a full suspicious packet locks every monitored page until the
      // user proves presence with the Continuum passkey (fixed RP).
      if (state.verdict.status === "suspicious" && !state.locked) engageLock();
      updateBadge();
    }
  } catch (e) { console.error("[continuum-guard] scoring error:", e && e.message); }
  finally { scoringBusy = false; }
}

// Live status on the toolbar icon badge, so capture/verdict is visible without the popup.
function updateBadge() {
  if (!api.action || !api.action.setBadgeText) return;
  var txt = "", color = "#4f46e5";
  if (!config.enabled) { txt = "off"; color = "#475569"; }
  else if (state.locked) { txt = "🔒"; color = "#dc2626"; }
  else if (state.verdict && state.verdict.status === "suspicious") { txt = "!"; color = "#dc2626"; }
  else if (state.verdict && state.verdict.status === "genuine") { txt = state.verdict.mean + "%"; color = "#16a34a"; }  // live genuine confidence
  else if (state.steps > 0) { txt = String(Math.min(state.steps, 99)); }  // steps toward first window
  try { api.action.setBadgeText({ text: txt }); api.action.setBadgeBackgroundColor({ color: color }); } catch (e) {}
}

// ---- lock / passkey step-up (fixed Continuum RP) ----
function broadcastAll(msg) {
  if (!api.tabs) return;
  api.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (t) {
      try { api.tabs.sendMessage(t.id, msg, function () { void api.runtime.lastError; }); } catch (e) {}
    });
  });
}
function engageLock() {
  state.locked = true;
  broadcastAll({ type: "cg:lock", hasPasskey: state.hasPasskey });
  updateBadge();
}
function releaseLock() {
  state.locked = false;
  scores = [];              // fresh packet after a verified step-up (probation-style reset)
  state.verdict = null;
  broadcastAll({ type: "cg:unlock" });
  updateBadge();
}

function broadcastConfig() {
  if (!api.tabs) return;
  api.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (t) {
      // Callback reads lastError so tabs without a content script (chrome:// pages, the
      // web store) don't produce an unhandled "receiving end does not exist" rejection.
      try {
        api.tabs.sendMessage(t.id, { type: "cg:config", enabled: config.enabled, exclusions: config.exclusions }, function () { void api.runtime.lastError; });
      } catch (e) {}
    });
  });
}

api.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg) return;
  switch (msg.type) {
    case "cg:enrolled":
      state.enrolled = true;
      // The wizard just trained a personal model into IndexedDB — hot-swap it in.
      ensureOffscreen().then(function () {
        try { api.runtime.sendMessage({ target: "offscreen", type: "cg:reload-model" }, function () { void api.runtime.lastError; }); } catch (e) {}
      });
      scores = [];            // old packet was scored by the previous model
      state.verdict = null;
      return;
    case "cg:model-ready": state.modelReady = true; state.modelError = null; state.modelPersonal = !!msg.personal; return;
    case "cg:model-error": state.modelReady = false; state.modelError = msg.error || "load_failed"; return;
    case "cg:hello":
      reply({ enabled: config.enabled, excluded: config.exclusions.indexOf(msg.origin) >= 0, locked: state.locked, hasPasskey: state.hasPasskey });
      return true;
    case "cg:open-verify":
      api.tabs.create({ url: RP_BASE + "/ext/verify.html#uid=" + state.profileNum });
      return;
    case "cg:open-register":
      api.tabs.create({ url: RP_BASE + "/ext/register.html#uid=" + state.profileNum });
      return;
    case "cg:verified":
      // Relayed by the content script on the RP page — trust ONLY that origin.
      if (sender && sender.url && sender.url.indexOf(RP_BASE) === 0) releaseLock();
      return;
    case "cg:passkey-registered":
      if (sender && sender.url && sender.url.indexOf(RP_BASE) === 0) {
        state.hasPasskey = true;
        api.storage.local.set({ cg_passkey: 1 });
        if (state.locked) broadcastAll({ type: "cg:lock", hasPasskey: true });  // refresh overlay button
      }
      return;
    case "cg:activity":
      if (config.enabled) { state.steps = msg.steps || 0; state.needSteps = msg.need || 50; state.lastWindowAt = Date.now(); updateBadge(); }
      return;
    case "cg:windows":
      if (msg.latest) onWindow(msg.latest);
      return;
    case "cg:status":
      if (!state.modelReady) {
        // Make sure the offscreen doc exists, then ask it directly whether the model loaded.
        ensureOffscreen().then(function () {
          pingOffscreen(function (r) {
            if (r && r.ready) { state.modelReady = true; state.modelError = null; state.modelPersonal = !!r.personal; }
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
      updateBadge();
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
