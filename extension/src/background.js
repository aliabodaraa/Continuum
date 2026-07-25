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
// Configurable via the options page (src/options.html) so a real deployment doesn't
// need to edit source/repackage — defaults to localhost for local dev/demo use.
var RP_BASE_DEFAULT = "http://localhost:4000";
var RP_BASE = RP_BASE_DEFAULT;

var config = { exclusions: [] };
var state = { totalWindows: 0, lastWindowAt: 0, modelReady: false, modelError: null, verdict: null, steps: 0, needSteps: 50, enrolled: false, modelPersonal: false, locked: false, hasPasskey: false, profileNum: 0, mouseReady: false, mouseVerdict: null, totalMouseWindows: 0 };
var scores = [];       // rolling last N keystroke window scores
var mouseScores = [];  // rolling last N mouse window scores

// Snapshot live progress to storage so it survives a service-worker restart. Throttled so
// rapid keystrokes don't hammer storage (at most one write per ~1.2s); pass immediate=true
// for state that must not be lost even briefly (lock/unlock).
var _persistTimer = null;
function progressSnapshot() {
  return {
    steps: state.steps, needSteps: state.needSteps, totalWindows: state.totalWindows, verdict: state.verdict,
    scores: scores, mouseScores: mouseScores, mouseVerdict: state.mouseVerdict,
    totalMouseWindows: state.totalMouseWindows, locked: state.locked, at: Date.now(),
  };
}
function persistProgress(immediate) {
  if (immediate) {
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    try { api.storage.local.set({ cg_progress: progressSnapshot() }); } catch (e) {}
    return;
  }
  if (_persistTimer) return;
  _persistTimer = setTimeout(function () {
    _persistTimer = null;
    try { api.storage.local.set({ cg_progress: progressSnapshot() }); } catch (e) {}
  }, 1200);
}

// Monitoring is NOT a manual toggle anymore: it stays off until the user has trained a
// personal model (the wizard), then turns on by itself. A base-model verdict on a
// stranger's rhythm isn't meaningful, so there is nothing useful to "turn on" before that.
// monitoringEnabled() gates the KEYSTROKE (enforcing) channel; anyTrained() gates whether
// the extension does ANYTHING at all — content scripts only capture when at least one
// modality is trained, so a profile with neither is genuinely disabled.
function monitoringEnabled() { return !!state.modelPersonal; }
function anyTrained() { return !!state.modelPersonal || !!state.mouseReady; }

// Stable NUMERIC id for the passkey-service, derived from this profile's id (FNV-1a).
function numericUid(pid) {
  var h = 2166136261;
  for (var i = 0; i < pid.length; i++) { h ^= pid.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) + 1;   // +1: never 0 (service treats 0 as missing)
}

api.storage.local.get(["cg_exclusions", "cg_enrolled_at", "cg_passkey", "cg_profile_id", "cg_rp_base", "cg_model_personal", "cg_mouse_ready", "cg_progress"], function (d) {
  d = d || {};
  config.exclusions = d.cg_exclusions || [];
  state.enrolled = !!d.cg_enrolled_at;
  state.hasPasskey = !!d.cg_passkey;
  RP_BASE = (d.cg_rp_base || RP_BASE_DEFAULT).replace(/\/+$/, "");
  // Restore the LIVE session progress too — the rolling packet, step counter, verdict and
  // lock state — so a service-worker restart (e.g. opening/closing the popup, or an idle
  // gap while typing) doesn't wipe the in-progress packet and reset the counter to 0.
  var p = d.cg_progress;
  if (p && (Date.now() - (p.at || 0) < 10 * 60 * 1000)) {   // ignore stale (>10 min) snapshots
    state.steps = p.steps || 0;
    state.needSteps = p.needSteps || 50;
    state.totalWindows = p.totalWindows || 0;
    state.verdict = p.verdict || null;
    state.mouseVerdict = p.mouseVerdict || null;
    state.totalMouseWindows = p.totalMouseWindows || 0;
    state.locked = !!p.locked;   // a lock must survive a restart, or it'd silently drop
    scores = Array.isArray(p.scores) ? p.scores : [];
    mouseScores = Array.isArray(p.mouseScores) ? p.mouseScores : [];
  }
  // MV3 service workers are terminated after ~30s idle and re-run from scratch on the next
  // event — every in-memory var above resets, INCLUDING this one, while the offscreen
  // document (which actually holds the trained model) survives independently and nobody
  // re-pings it automatically. Since monitoringEnabled() gates both scoring AND the step
  // counter, a restart mid-session (very likely during a passkey flow — waiting on Windows
  // Hello easily exceeds 30s) silently killed everything until the popup happened to be
  // reopened. Restore the last-known value immediately so there's no gap; still corrected
  // for real by the offscreen ping below / on the next cg:model-ready.
  state.modelPersonal = !!d.cg_model_personal;
  state.mouseReady = !!d.cg_mouse_ready;
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
          { target: { tabId: t.id }, files: ["src/features.js", "src/features-mouse.js", "src/content.js"] },
          function () { void api.runtime.lastError; }   // chrome:// & store tabs refuse — fine
        );
      } catch (e) {}
    });
  });
}
if (api.runtime.onInstalled) api.runtime.onInstalled.addListener(injectAll);
if (api.runtime.onStartup) api.runtime.onStartup.addListener(injectAll);

// Pick up an RP_BASE change from the options page without needing a full reload.
if (api.storage.onChanged) {
  api.storage.onChanged.addListener(function (changes, area) {
    if (area === "local" && changes.cg_rp_base) {
      RP_BASE = (changes.cg_rp_base.newValue || RP_BASE_DEFAULT).replace(/\/+$/, "");
    }
  });
}

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

function scoreViaOffscreen(win, msgType) {
  return new Promise(function (resolve) {
    try {
      api.runtime.sendMessage({ target: "offscreen", type: msgType || "cg:score", win: win }, function (res) {
        if (api.runtime.lastError || !res || res.error != null) resolve(null);
        else resolve(res.score);
      });
    } catch (e) { resolve(null); }
  });
}

function statusObj() {
  return {
    enabled: monitoringEnabled(), totalWindows: state.totalWindows, lastWindowAt: state.lastWindowAt,
    exclusions: config.exclusions, modelReady: state.modelReady, modelError: state.modelError, verdict: state.verdict,
    steps: state.steps, needSteps: state.needSteps, enrolled: state.enrolled, modelPersonal: state.modelPersonal,
    locked: state.locked, hasPasskey: state.hasPasskey,
    mouseReady: state.mouseReady, mouseVerdict: state.mouseVerdict, totalMouseWindows: state.totalMouseWindows,
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
  if (!monitoringEnabled()) return;
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
      console.log("[continuum-guard/diag] window score=" + s.toFixed(3) + " packet=" + JSON.stringify(scores.map(function (x) { return Number(x.toFixed(3)); })) + " mean=" + v.mean.toFixed(3));
      // Verdict only on a FULL packet (6 windows ≈ 100 keystrokes) — early provisional
      // verdicts were tried and reverted: they surface "!" on thin evidence without
      // making the decision meaningfully faster.
      state.verdict = {
        status: scores.length < RECENT ? "analyzing" : (v.suspicious ? "suspicious" : "genuine"),
        mean: Math.round(v.mean * 100),
        packet: scores.length,
        need: RECENT,
      };
      if (state.verdict.status === "suspicious" && !state.locked) engageLock();
      updateBadge();
      persistProgress();   // survive a SW restart mid-packet
    }
  } catch (e) { console.error("[continuum-guard] scoring error:", e && e.message); }
  finally { scoringBusy = false; }
}

// Mouse windows: same packet vote, separate stream. Only runs once the wizard's mouse
// stage has trained a personal head (the mouse base alone can't say genuine/impostor).
var mouseBusy = false, pendingMouseWin = null;
async function onMouseWindow(win) {
  // Gated on its OWN readiness, independent of the keystroke model — the two modalities
  // now enroll (and thus monitor) independently, so a profile that trained only mouse
  // still shows a live mouse verdict. (Mouse remains info-only; keystroke drives enforcement.)
  if (!state.mouseReady) return;
  state.totalMouseWindows += 1;
  pendingMouseWin = win;
  if (mouseBusy) return;
  mouseBusy = true;
  try {
    while (pendingMouseWin) {
      var w = pendingMouseWin; pendingMouseWin = null;
      var s = await scoreViaOffscreen(w, "cg:score-mouse");
      if (s == null) continue;
      mouseScores.push(s);
      if (mouseScores.length > RECENT) mouseScores.shift();
      var v = decide(mouseScores);
      state.mouseVerdict = {
        status: mouseScores.length < RECENT ? "analyzing" : (v.suspicious ? "suspicious" : "genuine"),
        mean: Math.round(v.mean * 100),
        packet: mouseScores.length,
        need: RECENT,
      };
      // NOT enforcement (yet): the mouse model is trained on the wizard's chase-the-dot
      // game — directed movement toward a target, frequent clicks — which doesn't resemble
      // natural browsing (scrolling, reading pauses, moving across a wide page). Mouse
      // events also fire far more often than keystrokes, so its packet fills first; letting
      // it lock caused false lockouts seconds into a session, before typing even started.
      // Verdict stays visible in the popup as a secondary signal; only keystrokes enforce
      // until the mouse enrollment task is redesigned to capture natural movement.
      updateBadge();
      persistProgress();
    }
  } catch (e) { console.error("[continuum-guard] mouse scoring error:", e && e.message); }
  finally { mouseBusy = false; }
}

// Toolbar-icon assets: full-colour when active, greyed when the site is excluded.
var ICON_ON = { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
var ICON_OFF = { 16: "icons/icon-off16.png", 32: "icons/icon-off32.png", 48: "icons/icon-off48.png", 128: "icons/icon-off128.png" };

// The badge value for the CURRENT verdict. The KEYSTROKE channel (the enforcing one) owns
// the badge whenever it's trained — any %/!/🔒 shown is keystroke, so there's no ambiguity.
// Mouse (info-only) only appears on the badge when it is the SOLE trained modality, and then
// in a distinct CYAN so it's never mistaken for the green/red keystroke signal.
function badgeForState() {
  if (!anyTrained()) return { text: "⚙️", color: "#475569" };          // nothing trained → needs setup
  if (state.locked) return { text: "🔒", color: "#dc2626" };
  if (state.verdict && state.verdict.status === "suspicious") return { text: "!", color: "#dc2626" };
  if (state.verdict && state.verdict.status === "genuine") return { text: state.verdict.mean + "%", color: "#16a34a" };
  if (monitoringEnabled()) return { text: state.steps > 0 ? String(Math.min(state.steps, 99)) : "", color: "#4f46e5" };
  if (state.mouseReady && state.mouseVerdict && state.mouseVerdict.status !== "analyzing") {
    return { text: state.mouseVerdict.mean + "%", color: "#0891b2" };    // cyan = mouse (info) channel
  }
  return { text: "", color: "#4f46e5" };
}

// Apply badge + icon for ONE tab, keyed to whether that tab's site is excluded.
function applyBadgeToTab(tabId, url) {
  if (!api.action || tabId == null) return;
  var origin = "";
  try { if (url) origin = new URL(url).origin; } catch (e) {}
  var excluded = origin && config.exclusions.indexOf(origin) >= 0;
  try {
    if (excluded) {
      api.action.setBadgeText({ tabId: tabId, text: "off" });
      api.action.setBadgeBackgroundColor({ tabId: tabId, color: "#64748b" });
      api.action.setTitle({ tabId: tabId, title: "Continuum Guard — off on this site" });
      if (api.action.setIcon) api.action.setIcon({ tabId: tabId, path: ICON_OFF }, function () { void api.runtime.lastError; });
    } else {
      var b = badgeForState();
      api.action.setBadgeText({ tabId: tabId, text: b.text });
      api.action.setBadgeBackgroundColor({ tabId: tabId, color: b.color });
      api.action.setTitle({ tabId: tabId, title: "Continuum Guard" });
      if (api.action.setIcon) api.action.setIcon({ tabId: tabId, path: ICON_ON }, function () { void api.runtime.lastError; });
    }
  } catch (e) {}
}

// Verdict changed → refresh the tab the user is actually looking at.
function updateBadge() {
  if (!api.tabs) return;
  api.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs && tabs[0]) applyBadgeToTab(tabs[0].id, tabs[0].url);
  });
}

// GLOBAL state changed (lock/unlock, training on/off) → refresh EVERY tab, not just the
// active one. Unlock happens while the passkey popup is focused, so the tab that showed 🔒
// isn't the active tab — without this its lock icon would linger until its next event.
function refreshAllBadges() {
  if (!api.tabs) return;
  api.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (t) { applyBadgeToTab(t.id, t.url); });
  });
}

// Keep each tab's badge/icon correct as the user switches/navigates.
if (api.tabs && api.tabs.onActivated) {
  api.tabs.onActivated.addListener(function (info) {
    api.tabs.get(info.tabId, function (t) { if (!api.runtime.lastError && t) applyBadgeToTab(t.id, t.url); });
  });
}
if (api.tabs && api.tabs.onUpdated) {
  api.tabs.onUpdated.addListener(function (tabId, ch, t) {
    if (ch.url || ch.status === "complete") applyBadgeToTab(tabId, t && t.url);
  });
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
  refreshAllBadges();   // every monitored tab shows 🔒
  persistProgress(true);
}
function releaseLock() {
  state.locked = false;
  scores = [];              // fresh packets after a verified step-up (probation-style reset)
  mouseScores = [];
  state.verdict = null;
  state.mouseVerdict = null;
  state.steps = 0;          // and a fresh step counter — otherwise the badge sticks at 99
  broadcastAll({ type: "cg:unlock" });
  broadcastAll({ type: "cg:reset" });   // content scripts drop their event buffers too
  refreshAllBadges();   // clear 🔒 on every tab now, not just when the next event fires
  persistProgress(true);
}

// After a successful ceremony, close the RP window — Chrome hands focus straight back
// to the window/tab the user was on. Short delay so the ✓ message is visible.
function closeRpTab(sender) {
  if (!(sender && sender.tab && sender.tab.id != null && api.tabs)) return;
  var tabId = sender.tab.id;
  setTimeout(function () {
    try { api.tabs.remove(tabId, function () { void api.runtime.lastError; }); } catch (e) {}
  }, 1200);
}

// Open the RP ceremony as a small dialog-style popup window (falls back to a tab).
function openRpPage(path) {
  var url = RP_BASE + path + "#uid=" + state.profileNum;
  if (api.windows && api.windows.create) {
    try { api.windows.create({ url: url, type: "popup", width: 480, height: 620 }); return; } catch (e) {}
  }
  api.tabs.create({ url: url });
}

function broadcastConfig() {
  if (!api.tabs) return;
  api.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (t) {
      // Callback reads lastError so tabs without a content script (chrome:// pages, the
      // web store) don't produce an unhandled "receiving end does not exist" rejection.
      try {
        // enabled = anyTrained(): content scripts capture (keys AND mouse) whenever at least
        // one modality is trained; the worker then routes each window to the right channel.
        api.tabs.sendMessage(t.id, { type: "cg:config", enabled: anyTrained(), exclusions: config.exclusions }, function () { void api.runtime.lastError; });
      } catch (e) {}
    });
  });
}

// Flip monitoring on the instant training completes — broadcasts to every open tab so
// capture starts without a page refresh (mirrors the earlier auto-inject fix).
function setModelPersonal(v) {
  v = !!v;
  if (v === state.modelPersonal) return;
  state.modelPersonal = v;
  api.storage.local.set({ cg_model_personal: v });   // survives the next service-worker restart
  broadcastConfig();
  refreshAllBadges();
}

function setMouseReady(v) {
  v = !!v;
  if (v === state.mouseReady) return;
  state.mouseReady = v;
  api.storage.local.set({ cg_mouse_ready: v });
  broadcastConfig();   // enabling mouse (even without keystroke) must turn capture on in open tabs
  refreshAllBadges();
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
      persistProgress(true);
      return;
    case "cg:profile-reset": {
      // The wizard just deleted the stored windows + trained heads (IndexedDB) — mirror
      // that here: drop back to untrained (monitoring off) until the user retrains.
      state.enrolled = false;
      setMouseReady(false);
      state.mouseVerdict = null;
      scores = [];
      mouseScores = [];
      state.verdict = null;
      var wasLocked = state.locked;
      state.locked = false;
      setModelPersonal(false);                          // broadcasts cg:config (enabled:false)
      if (wasLocked) broadcastAll({ type: "cg:unlock" });
      broadcastAll({ type: "cg:reset" });                // tabs drop buffered timings too
      ensureOffscreen().then(function () {
        try { api.runtime.sendMessage({ target: "offscreen", type: "cg:reload-model" }, function () { void api.runtime.lastError; }); } catch (e) {}
      });
      updateBadge();
      persistProgress(true);
      return;
    }
    case "cg:model-ready": state.modelReady = true; state.modelError = null; setModelPersonal(msg.personal); setMouseReady(msg.mouse); return;
    case "cg:model-error": state.modelReady = false; state.modelError = msg.error || "load_failed"; return;
    case "cg:hello":
      reply({ enabled: monitoringEnabled(), excluded: config.exclusions.indexOf(msg.origin) >= 0, locked: state.locked, hasPasskey: state.hasPasskey });
      return true;
    case "cg:open-verify":
      openRpPage("/ext/verify.html");
      return;
    case "cg:open-register":
      openRpPage("/ext/register.html");
      return;
    case "cg:verified":
      // Relayed by the content script on the RP page — trust ONLY that origin.
      if (sender && sender.url && sender.url.indexOf(RP_BASE) === 0) {
        releaseLock();
        closeRpTab(sender);   // return the user to where they were
      }
      return;
    case "cg:passkey-registered":
      if (sender && sender.url && sender.url.indexOf(RP_BASE) === 0) {
        state.hasPasskey = true;
        api.storage.local.set({ cg_passkey: 1 });
        if (state.locked) broadcastAll({ type: "cg:lock", hasPasskey: true });  // refresh overlay button
        closeRpTab(sender);
      }
      return;
    case "cg:activity":
      if (monitoringEnabled()) { state.steps = msg.steps || 0; state.needSteps = msg.need || 50; state.lastWindowAt = Date.now(); updateBadge(); persistProgress(); }
      return;
    case "cg:windows":
      if (msg.latest) onWindow(msg.latest);
      return;
    case "cg:windows-mouse":
      if (msg.latest) onMouseWindow(msg.latest);
      return;
    case "cg:status":
      if (!state.modelReady) {
        // Make sure the offscreen doc exists, then ask it directly whether the model loaded.
        ensureOffscreen().then(function () {
          pingOffscreen(function (r) {
            if (r && r.ready) { state.modelReady = true; state.modelError = null; setModelPersonal(r.personal); setMouseReady(r.mouse); }
            else if (r && r.error) { state.modelError = r.error; }
            reply(statusObj());
          });
        });
        return true; // async reply
      }
      reply(statusObj());
      return true;
    case "cg:toggleExclude": {
      var i = config.exclusions.indexOf(msg.origin);
      if (i >= 0) config.exclusions.splice(i, 1);
      else if (msg.origin) config.exclusions.push(msg.origin);
      api.storage.local.set({ cg_exclusions: config.exclusions });
      broadcastConfig();
      // Immediately grey/restore the toolbar icon on every tab of this site.
      if (api.tabs && msg.origin) {
        api.tabs.query({}, function (tabs) {
          (tabs || []).forEach(function (t) {
            try { if (t.url && new URL(t.url).origin === msg.origin) applyBadgeToTab(t.id, t.url); } catch (e) {}
          });
        });
      }
      reply({ exclusions: config.exclusions });
      return true;
    }
  }
});
