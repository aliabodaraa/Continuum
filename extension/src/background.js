// background.js — MV3 service worker. TensorFlow.js can't run HERE (a service worker has
// no DOM), so inference is delegated to an OFFSCREEN document (src/offscreen.html) that
// hosts TF.js. This worker keeps the rolling packet + verdict + config and serves the
// popup; it loads only the PURE decision logic from scoring.js (no tf) to apply the
// Lu et al. packet vote. Windows arrive from every tab; the typed text never leaves the page.
var api = globalThis.browser || globalThis.chrome;
var RECENT = 20;                                       // keystroke packet size (mirrors ca-service RECENT_WINDOW_COUNT)
// Short recent group the mouse diagnostic status reports (the popup's "analyzing n/need" and the
// recent-window mean). Display only: mouse enforcement is the sustained vote below.
var MOUSE_DIAG_RECENT = 6;
var WINDOW_THRESHOLD = 0.5, PACKET_VOTE_FRACTION = 0.5;

// Mouse enforcement uses a SUSTAINED vote, not the keystroke packet: mouse windows
// arrive every ~0.3 s of movement, so a short packet re-evaluated that often turns rare genuine
// low windows into a steady trickle of false locks. A window is "low" when its score falls below
// the user's OWN threshold (a percentile of their enrolment scores, stored with the model), and
// the page locks when the MEAN of the last n window scores falls below that threshold (rule
// "mean"; a k-of-n "vote" rule is also supported). The rule, n and the percentile were chosen by
// replaying the live loop on held-out users (Experiment I, artifacts/repr_arch_study: 0.22 false
// prompts per minute of movement, 87.3% of impostor runs caught) and travel in the model's
// metadata; the values below are only defaults for before the first score.
// ---- action-based mouse (Antal & Egyed-Zsigmond, IET Biometrics 2019) ----
// The published method scores mouse ACTIONS, not fixed windows, and decides on
// the MEAN probability over a set of k actions. The paper finds 10-20 actions
// are needed; 20 is its reporting point and the size at which we measured
// median EER 11.48% / AUC 0.947 over 20 held-out SapiMouse subjects.
// These must match services/ca-service/lib/mouseActions.js or the extension and
// the SDK reach different verdicts from identical motion.
var MOUSE_ACTION_SET_SIZE = 20;
var MOUSE_ACTION_THRESHOLD = 0.5;
var mouseActionScores = [];      // rolling per-action probabilities

// Mean of the last k action scores — the paper's P(A) = (1/k) * sum(p_i).
function mouseActionVerdict(scores) {
  if (scores.length < MOUSE_ACTION_SET_SIZE) {
    return { warmup: true, suspicious: false, setScore: null };
  }
  var recent = scores.slice(-MOUSE_ACTION_SET_SIZE);
  var sum = 0;
  for (var i = 0; i < recent.length; i++) sum += recent[i];
  var setScore = sum / recent.length;
  return { warmup: false, suspicious: setScore < MOUSE_ACTION_THRESHOLD, setScore: setScore };
}

var MOUSE_SUSTAIN_WINDOW = 60;   // n: length of the mouse enforcement buffer (model metadata wins)
var MOUSE_SUSTAIN_LOW = 30;      // k: for a "vote" rule only (model metadata wins); the popup
                                // slider can move it -> state.mouseSustainPct
var MOUSE_SUSTAIN_PCT_DEFAULT = Math.round((MOUSE_SUSTAIN_LOW / MOUSE_SUSTAIN_WINDOW) * 100);
// The slider's stored value. A new key: values saved under the old one were set against the
// retired 7-feature model and its fixed 0.5 boundary, and mean something else now.
var MOUSE_PCT_KEY = "cg_mouse_vote_pct";

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
function rpOriginOf() { try { return new URL(RP_BASE).origin; } catch (e) { return ""; } }

var config = { exclusions: [] };
// Verbose per-window diagnostics. These printed unconditionally — one line per scored
// keystroke window and one per MOUSE window, and mouse windows arrive several times a
// second while the pointer moves — which flooded the worker console and every page console
// so heavily that real errors were unfindable. Opt-in via the options page; warnings and
// errors are never gated.
var debugLog = false;
function dlog() { if (!debugLog) return; try { console.log.apply(console, arguments); } catch (e) {} }
// accountId starts undefined (distinct from the resolved "signed out" value, null) so the
// FIRST resolution always differs and fires onAccountChanged exactly once, even if it
// resolves to signed-out. Falsy either way, so every gate below defaults safely to
// "inactive" until a real resolution comes back.
var state = { totalWindows: 0, lastWindowAt: 0, modelReady: false, modelError: null, verdict: null, steps: 0, needSteps: 50, enrolled: false, modelPersonal: false, locked: false, lockReason: null, hasPasskey: false, profileNum: 0, mouseReady: false, mouseVerdict: null, totalMouseWindows: 0, mouseTracking: true, mouseSustainPct: MOUSE_SUSTAIN_PCT_DEFAULT, mouseThreshold: null, mouseVoteN: MOUSE_SUSTAIN_WINDOW, mouseVoteK: MOUSE_SUSTAIN_LOW, mouseRule: "mean", mouseStale: false, mouseProfile: null, mousePctUserSet: false, accountId: undefined, accountEmail: null, accountChecked: false, keySamples: 0, mouseSamples: 0, rpError: null };
var scores = [];       // rolling last N keystroke window scores
var mouseScores = [];  // rolling mouse window scores (up to MOUSE_SUSTAIN_WINDOW)

// ================= USER STUDY MODE (recovery plan T4.3) =================
// Set by the experimenter on the options page. In study mode the extension is a CLIENT of the
// deployed server system, like the SDK: the content script sends the raw key-event tail and its
// mouse windows, ca-service scores them with the server models (mouse S1, keystroke on the Aalto
// negatives) and logs every score (services/ca-service/lib/studyLog.js). On-device scoring is off,
// so there is one system under test. Enrolment and the passkey step-up run on the gateway's
// /study.html (passkeys are bound to that origin) under the same identity, externalId
// "study:<pseudonym>". `condition` is "genuine" or "impostor:<pseudonym of the person typing>".
var study = { on: false, gateway: "", siteKey: "", participant: "", condition: "genuine", client: "extension-study" };
// E4: the participant's pause. While it is on, no page captures anything on either channel and no
// check is sent. Set from the popup or the keyboard shortcut; persisted, and never lifted automatically.
var studyPaused = false;
var studySession = null;       // { token, userId } from the gateway's /v1/sdk/session
var studyProbation = false;    // after a step-up: re-challenge on any scored suspicious verdict (as the SDK)
var studyPrompt = null;        // the open step-up: { channel, decisionId, sessionId, tabId }
var studyError = null;
function studyOn() { return !!(study && study.on && study.gateway && study.siteKey && study.participant); }
function studyInfo() { return studyOn() ? { participant: study.participant, condition: study.condition, client: study.client, paused: studyPaused } : null; }
function loadStudy(v) {
  v = v || {};
  study = {
    on: v.on === true, gateway: String(v.gateway || "").replace(/\/+$/, ""), siteKey: String(v.siteKey || ""),
    participant: String(v.participant || ""), condition: String(v.condition || "genuine"),
    client: v.client === "lab" ? "lab" : "extension-study",
  };
  studySession = null; studyProbation = false; studyError = null;
}
async function studySessionToken(force) {
  if (studySession && !force) return studySession.token;
  var r = await fetch(study.gateway + "/v1/sdk/session", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteKey: study.siteKey, externalId: "study:" + study.participant }) });
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok || !d.token) throw new Error(d.error || ("session HTTP " + r.status));
  studySession = { token: d.token, userId: d.userId };
  return d.token;
}
async function studyPost(path, body) {
  for (var attempt = 0; attempt < 2; attempt++) {
    var token = await studySessionToken(attempt > 0);
    var r = await fetch(study.gateway + path, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(body) });
    if (r.status === 401 && attempt === 0) continue;   // session expired: mint a new one once
    return { status: r.status, d: await r.json().catch(function () { return {}; }) };
  }
}
function studyContext(sessionId, clientTs, extra) {
  return Object.assign({ participant: study.participant, sessionId: sessionId, condition: study.condition, client: study.client, clientTs: clientTs }, extra || {});
}
function studyPromptEvent(event) {
  var p = studyPrompt;
  if (!p) return;
  studyPost("/v1/sdk/study/prompt", { study: studyContext(p.sessionId, Date.now()), channel: p.channel, decisionId: p.decisionId, event: event })
    .catch(function (e) { console.warn("[continuum-guard/study] prompt event not logged:", e && e.message); });
}
// A verdict from the server. Challenge as the SDK does (sdk/guard.js maybeChallenge): when the
// server requires it, or during probation on a suspicious verdict backed by scored windows.
function studyVerdict(channel, r, sessionId) {
  var d = (r && r.d) || {};
  if (r && r.status === 423 && !state.locked) { studyChallenge(channel, null, sessionId); return; }   // locked server-side
  if (d.enrolled === false || (d.typingEvaluation && d.typingEvaluation.modelAvailable === false)) { studyError = "not enrolled (" + channel + ")"; return; }
  if (!d.checked) return;
  studyError = null;
  if (channel === "keystroke") {
    state.verdict = { status: d.warmup ? "analyzing" : (d.isSuspicious ? "suspicious" : "genuine"),
      mean: Math.round((d.modelConfidence || 0) * 100), packet: Number(d.scoredWindowCount || 0), need: RECENT };
  } else {
    state.mouseVerdict = { status: d.warmup ? "analyzing" : (d.isSuspicious ? "suspicious" : "genuine"),
      low: d.lowWindows, buffer: d.windowCount, bufferMax: d.bufferMax, lockAt: d.lockAt, riskPct: d.riskPct, rule: "vote",
      mean: Math.round((d.meanScore || 0) * 100), packet: d.windowCount, need: d.bufferMax };
  }
  var scored = channel === "keystroke" ? Number(d.scoredWindowCount) > 0 : Number(d.windowCount) > 0;
  var trigger = !!d.requiresPasskeyChallenge || (studyProbation && !!d.isSuspicious && scored);
  if (trigger && !state.locked) { studyChallenge(channel, d.studyDecisionId || null, sessionId); return; }
  if (!d.warmup && !d.isSuspicious) studyProbation = false;   // a clean verdict ends probation
  updateBadge();
  persistProgress();
}
function studyChallenge(channel, decisionId, sessionId) {
  studyPrompt = { channel: channel, decisionId: decisionId, sessionId: sessionId, tabId: null };
  engageLock(channel);
  studyPromptEvent("shown");
}
function studyOpenPage(mode, reason) {
  var url = study.gateway + "/study.html?mode=" + mode + "&p=" + encodeURIComponent(study.participant)
    + "&k=" + encodeURIComponent(study.siteKey) + (reason ? "&reason=" + reason : "");
  function track(tab) { if (mode === "verify" && studyPrompt && tab) studyPrompt.tabId = tab.id; }
  if (mode === "verify" && api.windows && api.windows.create) {
    try { api.windows.create({ url: url, type: "popup", width: 520, height: 680 }, function (w) { track(w && w.tabs && w.tabs[0]); }); return; } catch (e) {}
  }
  api.tabs.create({ url: url }, track);
}
function setStudyPaused(v) { try { api.storage.local.set({ cg_study_paused: !!v }); } catch (e) {} }
// The pause shortcut (manifest "commands"): quicker than opening the popup before typing something private.
if (api.commands && api.commands.onCommand) {
  api.commands.onCommand.addListener(function (cmd) { if (cmd === "toggle-study-pause" && studyOn()) setStudyPaused(!studyPaused); });
}
function fromStudyPage(sender) { return studyOn() && sender && sender.url && sender.url.indexOf(study.gateway + "/study.html") === 0; }
// Closing the step-up page while still locked = the prompt was dismissed.
if (api.tabs && api.tabs.onRemoved) {
  api.tabs.onRemoved.addListener(function (tabId) {
    if (studyPrompt && studyPrompt.tabId === tabId && state.locked) { studyPromptEvent("dismissed"); studyPrompt.tabId = null; }
  });
}

// Snapshot live progress to storage so it survives a service-worker restart. Throttled so
// rapid keystrokes don't hammer storage (at most one write per ~1.2s); pass immediate=true
// for state that must not be lost even briefly (lock/unlock).
var _persistTimer = null;
function progressSnapshot() {
  return {
    steps: state.steps, needSteps: state.needSteps, totalWindows: state.totalWindows, verdict: state.verdict,
    scores: scores, mouseScores: mouseScores, mouseVerdict: state.mouseVerdict,
    totalMouseWindows: state.totalMouseWindows, locked: state.locked, lockReason: state.lockReason, at: Date.now(),
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
// Both gates ALSO require a signed-in Chrome/Google account — samples and trained models
// are keyed to that account (see refreshAccount below), so with nobody signed in there is
// no profile to monitor against at all.
// monitoringEnabled() gates the KEYSTROKE (enforcing) channel; anyTrained() gates whether
// the extension does ANYTHING at all — content scripts only capture when at least one
// modality is trained, so a profile with neither is genuinely disabled.
// In study mode the server's models do the scoring, so capture runs regardless of on-device models.
function monitoringEnabled() { return studyOn() || (!!state.accountId && !!state.modelPersonal); }
function anyTrained() { return studyOn() || (!!state.accountId && (!!state.modelPersonal || !!state.mouseReady)); }

// Stable NUMERIC id for the passkey-service, derived from this account's id (FNV-1a).
function numericUid(pid) {
  var h = 2166136261;
  for (var i = 0; i < pid.length; i++) { h ^= pid.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) + 1;   // +1: never 0 (service treats 0 as missing)
}

// ---- browser account binding ----
// Samples, trained heads, and the passkey link are keyed to WHICHEVER Google account THIS
// CHROME PROFILE is tied to (chrome.identity.getProfileUserInfo), not to any website login.
//
// TESTED LIMIT (verified against a real Sign-out click, both accountStatus modes): Chrome
// does NOT expose a live "currently signed in vs. just signed out" signal to extensions.
// getProfileUserInfo reports whichever account this profile is nominally associated with,
// and keeps reporting it through "Sign out" / "Sync is paused" — Chrome only clears it if
// the account is removed from the profile outright. So this gates on "has this Chrome
// PROFILE ever been signed into a Google account", not "is it live right now" — a same-
// profile sign-out click will NOT deactivate the guard, by platform limitation, not a bug.
// What DOES give real isolation: separate Chrome PROFILES (Settings -> "Other Chrome
// profiles"), since chrome.storage/IndexedDB are already fully siloed per profile — that's
// the actual mechanism for "a different person is using this browser now", not sign-out.
var _lastAccountCheck = 0;
function refreshAccount(cb) {
  if (!api.identity || !api.identity.getProfileUserInfo) { state.accountChecked = true; if (cb) cb(); return; }
  try {
    // "ANY": also catch a profile that's signed in with sync deliberately turned off — the
    // gate here is "ever associated with an account", not "currently syncing" (see above).
    api.identity.getProfileUserInfo({ accountStatus: "ANY" }, function (info) {
      void api.runtime.lastError;
      var id = info && info.id ? ("g_" + info.id) : null;
      var email = (info && info.email) || null;
      state.accountChecked = true;
      state.accountEmail = email;
      if (id !== state.accountId) { state.accountId = id; onAccountChanged(cb); }
      else if (cb) cb();
    });
  } catch (e) { state.accountChecked = true; if (cb) cb(); }
}
if (api.identity && api.identity.onSignInChanged) {
  api.identity.onSignInChanged.addListener(function () { refreshAccount(); });
}

// The account just changed (including first resolution at startup, or going to/from
// signed-out) — drop whatever live packet/verdict/lock belonged to the PREVIOUS account
// and load this account's own trained flags + model before anything scores again.
function onAccountChanged(cb) {
  scores = []; mouseScores = [];
  state.verdict = null; state.mouseVerdict = null;
  state.steps = 0; state.totalWindows = 0; state.totalMouseWindows = 0;
  if (state.locked) { state.locked = false; broadcastAll({ type: "cg:unlock" }); }
  var id = state.accountId;
  if (!id) {
    state.profileNum = 0;
    state.modelPersonal = false; state.mouseReady = false; state.hasPasskey = false; state.enrolled = false;
    state.keySamples = 0; state.mouseSamples = 0;
    finishAccountSwitch(cb);
    return;
  }
  migrateLegacyProfile(id, function () {
    resolveProfileNum(id, function (num) {
      state.profileNum = num;
      api.storage.local.get(["cg_model_personal_" + id, "cg_mouse_ready_" + id, "cg_passkey_" + id, "cg_enrolled_at_" + id, "cg_enroll_" + id, "cg_enroll_mouse_" + id], function (d) {
        d = d || {};
        state.modelPersonal = !!d["cg_model_personal_" + id];
        state.mouseReady = !!d["cg_mouse_ready_" + id];
        state.hasPasskey = !!d["cg_passkey_" + id];
        state.enrolled = !!d["cg_enrolled_at_" + id];
        state.keySamples = ((d["cg_enroll_" + id]) || []).length;
        state.mouseSamples = ((d["cg_enroll_mouse_" + id]) || []).length;
        finishAccountSwitch(cb);
      });
    });
  });
}

// The numeric uid sent to the passkey-service (its DB keys credentials by this NUMBER,
// not by account id) must stay FIXED for an account forever once established — recomputing
// it from a hash of the account id (as this used to do) silently orphans any already-
// registered passkey the moment the hashed input changes, because the service then looks
// up a uid with zero credentials and errors before ever invoking the native WebAuthn
// prompt. Persisted once per account; if a legacy (pre-account-binding) profile id exists,
// reuse the uid computed the OLD way so it still matches what's already in that DB.
function resolveProfileNum(id, cb) {
  api.storage.local.get(["cg_profile_num_" + id, "cg_profile_id"], function (d) {
    d = d || {};
    var existing = d["cg_profile_num_" + id];
    if (existing) { cb(existing); return; }
    var num = d.cg_profile_id ? numericUid(d.cg_profile_id) : numericUid(id);
    var rec = {}; rec["cg_profile_num_" + id] = num;
    api.storage.local.set(rec, function () { cb(num); });
  });
}

// ONE-TIME migration: before account binding existed, everything lived under an unkeyed
// (or random-per-install-id) namespace. Without this, anyone who trained before that
// change would silently see "needs training" on their real account — the samples are
// still there, just under the old names. Runs once (cg_legacy_migrated guards re-entry),
// copies chrome.storage.local values across, and asks the offscreen doc to move the
// IndexedDB model(s), which only tf (loaded there, not in this service worker) can do.
function migrateLegacyProfile(id, cb) {
  api.storage.local.get(["cg_profile_id", "cg_legacy_migrated"], function (d) {
    d = d || {};
    var oldId = d.cg_profile_id;
    if (!oldId || d.cg_legacy_migrated) { cb(); return; }
    var oldKeys = ["cg_model_personal", "cg_mouse_ready", "cg_passkey", "cg_enrolled_at",
      "cg_enroll_" + oldId, "cg_enroll_mouse_" + oldId, "cg_enroll_sessions_" + oldId, "cg_enroll_mouse_sessions_" + oldId];
    api.storage.local.get(oldKeys, function (old) {
      old = old || {};
      var hasLegacy = !!(old.cg_model_personal || old.cg_mouse_ready
        || (old["cg_enroll_" + oldId] || []).length || (old["cg_enroll_mouse_" + oldId] || []).length);
      if (!hasLegacy) { api.storage.local.set({ cg_legacy_migrated: true }); cb(); return; }
      var rec = { cg_legacy_migrated: true };
      if (old.cg_model_personal) rec["cg_model_personal_" + id] = true;
      if (old.cg_mouse_ready) rec["cg_mouse_ready_" + id] = true;
      if (old.cg_passkey) rec["cg_passkey_" + id] = true;
      if (old.cg_enrolled_at) rec["cg_enrolled_at_" + id] = old.cg_enrolled_at;
      if (old["cg_enroll_" + oldId]) rec["cg_enroll_" + id] = old["cg_enroll_" + oldId];
      if (old["cg_enroll_mouse_" + oldId]) rec["cg_enroll_mouse_" + id] = old["cg_enroll_mouse_" + oldId];
      if (old["cg_enroll_sessions_" + oldId]) rec["cg_enroll_sessions_" + id] = old["cg_enroll_sessions_" + oldId];
      if (old["cg_enroll_mouse_sessions_" + oldId]) rec["cg_enroll_mouse_sessions_" + id] = old["cg_enroll_mouse_sessions_" + oldId];
      console.log("[continuum-guard] migrating legacy profile " + oldId + " -> " + id);
      api.storage.local.set(rec, function () {
        ensureOffscreen().then(function () {
          try {
            api.runtime.sendMessage({ target: "offscreen", type: "cg:migrate-model", accountId: id }, function () { void api.runtime.lastError; cb(); });
          } catch (e) { cb(); }
        });
      });
    });
  });
}

// Re-read just the sample-count arrays for the CURRENT account — called after a training
// session so the popup's "Trained on" count updates immediately, without a full account
// re-resolution (which would also reset the live packet/verdict).
function refreshSampleCounts() {
  var id = state.accountId;
  if (!id) return;
  api.storage.local.get(["cg_enroll_" + id, "cg_enroll_mouse_" + id], function (d) {
    d = d || {};
    state.keySamples = ((d["cg_enroll_" + id]) || []).length;
    state.mouseSamples = ((d["cg_enroll_mouse_" + id]) || []).length;
  });
}
function finishAccountSwitch(cb) {
  state.modelReady = false; state.modelError = null;   // offscreen must (re)load THIS account's model
  broadcastConfig();
  refreshAllBadges();
  persistProgress(true);
  ensureOffscreen().then(function () {
    try { api.runtime.sendMessage({ target: "offscreen", type: "cg:reload-model", accountId: state.accountId }, function () { void api.runtime.lastError; }); } catch (e) {}
  });
  if (cb) cb();
}

api.storage.local.get(["cg_exclusions", "cg_rp_base", "cg_progress", "cg_mouse_tracking", MOUSE_PCT_KEY, "cg_debug", "cg_study", "cg_study_paused"], function (d) {
  d = d || {};
  loadStudy(d.cg_study);
  studyPaused = d.cg_study_paused === true;
  config.exclusions = d.cg_exclusions || [];
  debugLog = d.cg_debug === true;
  RP_BASE = (d.cg_rp_base || RP_BASE_DEFAULT).replace(/\/+$/, "");
  // User toggle for the mouse channel (default ON). Persisted so a SW restart keeps it.
  state.mouseTracking = d.cg_mouse_tracking !== false;
  // User-tuned mouse lock sensitivity (percent of the vote buffer that must be low).
  var pct = parseInt(d[MOUSE_PCT_KEY], 10);
  state.mousePctUserSet = pct >= 30 && pct <= 100;
  state.mouseSustainPct = state.mousePctUserSet ? pct : MOUSE_SUSTAIN_PCT_DEFAULT;
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
    state.lockReason = p.lockReason || null;
    scores = Array.isArray(p.scores) ? p.scores : [];
    mouseScores = Array.isArray(p.mouseScores) ? p.mouseScores : [];
  }
  // MV3 service workers are terminated after ~30s idle and re-run from scratch on the next
  // event — every in-memory var above resets. Resolve the signed-in account (and this
  // account's trained flags) right away; onAccountChanged fires unconditionally on this
  // first resolution and loads everything properly, so no separate restore path is needed
  // for modelPersonal/mouseReady/hasPasskey here.
  refreshAccount();
});

// Inject the capture scripts into tabs that were ALREADY open when the extension was
// (re)loaded — otherwise monitoring only starts after the user manually refreshes each tab.
function injectAll() {
  if (!api.scripting || !api.tabs) return;
  api.tabs.query({ url: ["http://*/*", "https://*/*"] }, function (tabs) {
    (tabs || []).forEach(function (t) {
      try {
        api.scripting.executeScript(
          { target: { tabId: t.id }, files: ["src/features.js", "src/features-mouse.js", "src/features-mouse-actions.js", "src/content.js"] },
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
    if (area === "local" && changes.cg_study_paused) {
      studyPaused = changes.cg_study_paused.newValue === true;
      broadcastConfig();   // every page stops (or resumes) capturing at once
      refreshAllBadges();
    }
    if (area === "local" && changes.cg_study) {
      loadStudy(changes.cg_study.newValue);
      broadcastConfig();   // capture follows study mode in every open tab
      refreshAllBadges();
    }
    if (area === "local" && changes.cg_debug) {
      debugLog = changes.cg_debug.newValue === true;
      broadcastConfig();   // content scripts follow the same flag
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
    // Guarantee the promise ALWAYS settles: a dropped/never-answered offscreen message would
    // otherwise hang the caller's `await`, leaving scoringBusy/mouseBusy stuck true forever
    // and silently freezing all further verdicts (esp. mouse, which fires constantly).
    var done = false;
    function finish(v) { if (!done) { done = true; resolve(v); } }
    var timer = setTimeout(function () { finish(null); }, 3000);
    try {
      api.runtime.sendMessage({ target: "offscreen", type: msgType || "cg:score", win: win }, function (res) {
        clearTimeout(timer);
        if (api.runtime.lastError || !res || res.error != null) finish(null);
        else finish(res.score);
      });
    } catch (e) { clearTimeout(timer); finish(null); }
  });
}

// Mouse variant of scoreViaOffscreen: resolves the whole reply ({score, threshold, voteN, voteK}),
// because a mouse score is only meaningful against the threshold of the model that produced it.
function scoreMouseViaOffscreen(win) {
  return new Promise(function (resolve) {
    var done = false;
    function finish(v) { if (!done) { done = true; resolve(v); } }
    var timer = setTimeout(function () { finish(null); }, 3000);
    try {
      api.runtime.sendMessage({ target: "offscreen", type: "cg:score-mouse", win: win }, function (res) {
        clearTimeout(timer);
        if (api.runtime.lastError || !res || res.error != null || !(res.threshold > 0)) finish(null);
        else finish(res);
      });
    } catch (e) { clearTimeout(timer); finish(null); }
  });
}

// The loaded mouse model's metadata (threshold, vote, profile size) and whether an old-model
// profile is waiting to be rebuilt. mouseStale is a positive finding (the retired model's head is
// on disk and the current model is not), so unlike a failed load it is safe to persist.
function applyMouseMeta(meta, stale) {
  if (meta && meta.threshold > 0) {
    state.mouseThreshold = meta.threshold;
    state.mouseVoteN = meta.voteN || MOUSE_SUSTAIN_WINDOW;
    state.mouseVoteK = meta.voteK || MOUSE_SUSTAIN_LOW;
    state.mouseRule = meta.voteRule || "vote";
    // Until the user moves the slider, the lock rule is the model's own measured k of n.
    if (!state.mousePctUserSet) state.mouseSustainPct = Math.round((100 * state.mouseVoteK) / state.mouseVoteN);
    state.mouseProfile = { windows: meta.windows || 0, thresholdQ: meta.thresholdQ, trainedAt: meta.trainedAt };
  }
  state.mouseStale = !!stale;
  if (stale) setMouseReady(false, true);
}

function statusObj() {
  return {
    enabled: monitoringEnabled(), totalWindows: state.totalWindows, lastWindowAt: state.lastWindowAt,
    exclusions: config.exclusions, modelReady: state.modelReady, modelError: state.modelError, verdict: state.verdict,
    steps: state.steps, needSteps: state.needSteps, enrolled: state.enrolled, modelPersonal: state.modelPersonal,
    locked: state.locked, hasPasskey: state.hasPasskey,
    mouseReady: state.mouseReady, mouseVerdict: state.mouseVerdict, totalMouseWindows: state.totalMouseWindows, mouseTracking: state.mouseTracking, mouseSustainPct: state.mouseSustainPct,
    mouseVoteN: state.mouseVoteN, mouseVoteK: state.mouseVoteK, mouseRule: state.mouseRule, mouseThreshold: state.mouseThreshold,
    mouseStale: state.mouseStale, mouseProfile: state.mouseProfile,
    accountId: state.accountId || null, accountEmail: state.accountEmail || null, accountChecked: state.accountChecked,
    keySamples: state.keySamples, mouseSamples: state.mouseSamples, lockReason: state.lockReason,
    rpError: state.rpError || null, rpBase: RP_BASE,
    study: studyInfo(), studyError: studyError, studyPaused: studyPaused,   // user-study mode (see USER STUDY MODE)
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
  if (studyOn()) return;   // study mode: the server scores (see USER STUDY MODE)
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
      dlog("[continuum-guard/diag] window score=" + s.toFixed(3) + " packet=" + JSON.stringify(scores.map(function (x) { return Number(x.toFixed(3)); })) + " mean=" + v.mean.toFixed(3));
      // Verdict only on a FULL packet (20 windows: >= 240 digraph steps, ~400 keys of real
      // typing), as on the server (10 of 20 at 0.50 since 2026-09-23) — early provisional
      // verdicts were tried and reverted: they surface "!" on thin evidence without
      // making the decision meaningfully faster.
      state.verdict = {
        status: scores.length < RECENT ? "analyzing" : (v.suspicious ? "suspicious" : "genuine"),
        mean: Math.round(v.mean * 100),
        packet: scores.length,
        need: RECENT,
      };
      if (state.verdict.status === "suspicious" && !state.locked) engageLock("keystroke");
      updateBadge();
      persistProgress();   // survive a SW restart mid-packet
    }
  } catch (e) { console.error("[continuum-guard] scoring error:", e && e.message); }
  finally { scoringBusy = false; }
}

// Mouse windows: separate stream, gated on its own readiness. A window is low when its score is
// below the user's own threshold; ENFORCEMENT is the sustained k-of-n vote over the last n
// windows (see the constants above). The display verdict uses the same per-user threshold.
var mouseBusy = false, pendingMouseWin = null;
async function onMouseWindow(win) {
  if (studyOn()) return;   // study mode: the server scores (see USER STUDY MODE)
  if (!state.mouseReady || !state.mouseTracking) return;   // user can disable the mouse channel
  state.totalMouseWindows += 1;
  pendingMouseWin = win;
  if (mouseBusy) return;
  mouseBusy = true;
  try {
    while (pendingMouseWin) {
      var w = pendingMouseWin; pendingMouseWin = null;
      var r = await scoreMouseViaOffscreen(w);
      if (r == null) { ensureOffscreen(); continue; }   // recreate a torn-down offscreen doc
      var s = r.score, thr = r.threshold;
      var N = r.voteN || MOUSE_SUSTAIN_WINDOW;
      state.mouseThreshold = thr;
      var rule = r.rule || "vote";
      state.mouseVoteN = N; state.mouseVoteK = r.voteK || MOUSE_SUSTAIN_LOW; state.mouseRule = rule;
      if (!state.mousePctUserSet && rule === "vote") state.mouseSustainPct = Math.round((100 * state.mouseVoteK) / N);
      mouseScores.push(s);
      while (mouseScores.length > N) mouseScores.shift();
      var recent = mouseScores.slice(-MOUSE_DIAG_RECENT);
      var recentLow = 0, recentSum = 0;
      for (var ri = 0; ri < recent.length; ri++) { if (recent[ri] < thr) recentLow += 1; recentSum += recent[ri]; }
      var low = 0, bufSum = 0;
      for (var i = 0; i < mouseScores.length; i++) { if (mouseScores[i] < thr) low += 1; bufSum += mouseScores[i]; }
      var bufMean = mouseScores.length ? bufSum / mouseScores.length : 1;
      // The popup slider sets the share of the buffer that must be low; its default is the
      // model's own k of n. Clamped to >= 1 so it can never be zero.
      var lockAt = Math.max(1, Math.round((state.mouseSustainPct / 100) * N));
      // Describe the window as well as its score: path = distance covered (screen widths) and the
      // mean step in pixels, the two properties that separate browsing from directed movement.
      var wPath = 0, wStep = 0;
      for (var wi = 0; wi < w.length; wi++) { var st = Math.hypot(w[wi][0], w[wi][1]); wStep += st; wPath += st / 1920; }
      dlog("[continuum-guard/diag] mouse score=" + s.toFixed(3) + " (threshold " + thr.toFixed(3) + ")"
        + " path=" + wPath.toFixed(3) + " step=" + (wStep / w.length).toFixed(1) + "px"
        + " recentLow=" + recentLow + "/" + recent.length + " sustainedLow=" + low + "/" + mouseScores.length
        + " bufferMean=" + bufMean.toFixed(3)
        + (rule === "mean" ? " (locks when the mean of " + N + " < threshold)" : " (lock at " + lockAt + "/" + N + " = " + state.mouseSustainPct + "%)"));
      // Report the SUSTAINED buffer, which is what decides a passkey request, and the mean score
      // over the group the decision is made on (lockAt windows) for the badge.
      var groupN = Math.min(lockAt, mouseScores.length);
      var groupSum = 0;
      for (var gi = mouseScores.length - groupN; gi < mouseScores.length; gi++) groupSum += mouseScores[gi];
      var groupMean = groupN ? groupSum / groupN : 0;
      state.mouseVerdict = {
        status: recent.length < MOUSE_DIAG_RECENT ? "analyzing" : (recentLow / recent.length >= PACKET_VOTE_FRACTION ? "suspicious" : "genuine"),
        low: low, buffer: mouseScores.length, bufferMax: N,
        lockAt: rule === "vote" ? lockAt : null, riskPct: Math.round((100 * low) / N), rule: rule,
        bufferMean: Math.round(bufMean * 100), threshold: Math.round(thr * 100),
        groupN: groupN, groupMean: Math.round(groupMean * 100),
        mean: Math.round((recent.length ? recentSum / recent.length : 0) * 100),
        packet: recent.length,
        need: MOUSE_DIAG_RECENT,
      };
      // ENFORCE on sustained suspicion over a full buffer: its mean below the user's threshold
      // ("mean" rule), or at least lockAt low windows ("vote" rule).
      var fire = mouseScores.length >= N && (rule === "mean" ? bufMean < thr : low >= lockAt);
      if (!state.locked && fire) {
        dlog("[continuum-guard] mouse sustained-suspicion lock (" + (rule === "mean" ? "mean " + bufMean.toFixed(3) + " < " + thr.toFixed(3) : low + "/" + mouseScores.length + " low") + ")");
        mouseScores = [];   // the next decision needs a fresh buffer, as in the evaluation's replay
        engageLock("mouse");
      }
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
  // Study mode: the recording indicator (E4). No scores are shown to participants.
  if (studyOn()) return studyPaused ? { text: "II", color: "#64748b" } : { text: "REC", color: "#dc2626" };
  if (state.verdict && state.verdict.status === "suspicious") return { text: "!", color: "#dc2626" };
  if (state.verdict && state.verdict.status === "genuine") return { text: state.verdict.mean + "%", color: "#16a34a" };
  if (monitoringEnabled()) return { text: state.steps > 0 ? String(Math.min(state.steps, 99)) : "", color: "#4f46e5" };
  if (state.mouseReady && state.mouseVerdict && state.mouseVerdict.status !== "analyzing") {
    // groupMean averages the decision group (lockAt windows), not the 6-window packet, so the
    // badge reflects the evidence the lock is actually weighed against instead of twitching
    // on each movement. Falls back to the packet mean for a verdict saved before this field.
    var mvB = state.mouseVerdict;
    var pctB = mvB.groupMean != null ? mvB.groupMean : mvB.mean;
    return { text: pctB + "%", color: "#0891b2" };    // cyan = mouse (info) channel
  }
  return { text: "", color: "#4f46e5" };
}

// Called WITHOUT a callback, the action.* APIs return a promise that REJECTS with
// "No tab with id: N" when the tab closed between being enumerated and having its badge
// painted — a routine race, since refreshAllBadges walks every tab and the user can close
// one at any moment. A surrounding try/catch cannot catch that: the rejection is async, so
// it surfaces as an "Uncaught (in promise)" error on the extensions page. Passing a callback
// switches these back to callback style, where the failure arrives as runtime.lastError and
// is absorbed here — the tab is gone, so there is nothing to paint and nothing to report.
function actionSafe(fn, arg) {
  if (typeof fn !== "function") return;
  try { fn.call(api.action, arg, function () { void api.runtime.lastError; }); } catch (e) {}
}

// Apply badge + icon for ONE tab, keyed to whether that tab's site is excluded OR nobody
// is signed into Chrome (a browser-wide "off", not per-site — takes priority).
function applyBadgeToTab(tabId, url) {
  if (!api.action || tabId == null) return;
  var origin = "";
  try { if (url) origin = new URL(url).origin; } catch (e) {}
  var noAccount = state.accountChecked && !state.accountId;
  var excluded = !noAccount && origin && config.exclusions.indexOf(origin) >= 0;
  if (noAccount) {
    actionSafe(api.action.setBadgeText, { tabId: tabId, text: "" });
    actionSafe(api.action.setBadgeBackgroundColor, { tabId: tabId, color: "#64748b" });
    actionSafe(api.action.setTitle, { tabId: tabId, title: "Continuum Guard — sign in to Chrome with a Google account to activate" });
    actionSafe(api.action.setIcon, { tabId: tabId, path: ICON_OFF });
  } else if (excluded) {
    actionSafe(api.action.setBadgeText, { tabId: tabId, text: "off" });
    actionSafe(api.action.setBadgeBackgroundColor, { tabId: tabId, color: "#64748b" });
    actionSafe(api.action.setTitle, { tabId: tabId, title: "Continuum Guard — off on this site" });
    actionSafe(api.action.setIcon, { tabId: tabId, path: ICON_OFF });
  } else {
    var b = badgeForState();
    actionSafe(api.action.setBadgeText, { tabId: tabId, text: b.text });
    actionSafe(api.action.setBadgeBackgroundColor, { tabId: tabId, color: b.color });
    actionSafe(api.action.setTitle, { tabId: tabId, title: "Continuum Guard" });
    actionSafe(api.action.setIcon, { tabId: tabId, path: ICON_ON });
  }
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
function engageLock(reason) {
  state.locked = true;
  state.lockReason = reason || "keystroke";   // which channel caught it (shown in the popup)
  broadcastAll({ type: "cg:lock", hasPasskey: studyOn() || state.hasPasskey });   // study: the passkey was set up at enrolment
  refreshAllBadges();   // every monitored tab shows 🔒
  persistProgress(true);
}
function releaseLock() {
  state.locked = false;
  state.rpError = null;
  state.lockReason = null;
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
// Close the ceremony window IMMEDIATELY. This used to wait 1200ms so the page's "✓" was
// visible, but a setTimeout in an MV3 service worker is not guaranteed to run: the worker
// can be terminated before the timer fires, and the pending callback dies with it. That is
// why the window only *sometimes* closed after Windows Hello succeeded. The unlock itself is
// the user-visible confirmation, so nothing is lost by closing at once.
function closeRpTab(sender) {
  if (!api.tabs) return;
  function remove(id) { try { api.tabs.remove(id, function () { void api.runtime.lastError; }); } catch (e) {} }
  if (sender && sender.tab && sender.tab.id != null) { remove(sender.tab.id); return; }
  // No sender tab (message not relayed from a tab context) — fall back to closing whatever
  // RP page is open, so the ceremony window never gets orphaned.
  try {
    api.tabs.query({}, function (tabs) {
      void api.runtime.lastError;
      (tabs || []).forEach(function (t) { if (t.url && t.url.indexOf(RP_BASE) === 0) remove(t.id); });
    });
  } catch (e) {}
}

// Is the passkey RP actually up? /health is deliberately un-keyed on the service, so this
// needs no credentials. Always settles: a hung connect resolves false on the timer.
function rpReachable(cb) {
  var done = false;
  function finish(ok, why) { if (!done) { done = true; cb(ok, why); } }
  var t = setTimeout(function () { finish(false, "timed out"); }, 2500);
  try {
    fetch(RP_BASE + "/health", { method: "GET", cache: "no-store" })
      .then(function (r) { clearTimeout(t); finish(!!r.ok, r.ok ? "" : "HTTP " + r.status); })
      .catch(function (e) { clearTimeout(t); finish(false, (e && e.message) || "connection refused"); });
  } catch (e) { clearTimeout(t); finish(false, "connection refused"); }
}

// Open the RP ceremony as a small dialog-style popup window (falls back to a tab).
//
// The RP is PROBED first. When the passkey service is not running — or RP_BASE points at
// the wrong host — the old behaviour opened a window that simply failed to connect: the
// user got Chrome's "site can't be reached", closed it, and stayed locked on every page
// with keyboard input blocked, no explanation, and no way forward. The lock then cleared
// only by accident, when the persisted progress snapshot aged past 10 minutes and a worker
// restart dropped it. Now the overlay is told, so the failure is legible and retryable
// instead of looking like the extension itself had broken.
function openRpPage(path) {
  var url = RP_BASE + path + "#uid=" + state.profileNum;
  rpReachable(function (ok, why) {
    if (!ok) {
      state.rpError = why || "unreachable";
      broadcastAll({ type: "cg:rp-unreachable", rpBase: RP_BASE, reason: state.rpError });
      refreshAllBadges();
      console.warn("[continuum-guard] passkey service unreachable at " + RP_BASE + " (" + state.rpError + ") — step-up cannot run");
      return;
    }
    state.rpError = null;
    if (api.windows && api.windows.create) {
      try { api.windows.create({ url: url, type: "popup", width: 480, height: 620 }); return; } catch (e) {}
    }
    api.tabs.create({ url: url });
  });
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
        api.tabs.sendMessage(t.id, { type: "cg:config", enabled: anyTrained(), mouseTracking: state.mouseTracking, exclusions: config.exclusions, rpOrigin: studyOn() ? study.gateway : rpOriginOf(), debug: debugLog, study: studyInfo() }, function () { void api.runtime.lastError; });
      } catch (e) {}
    });
  });
}

// Flip monitoring on the instant training completes — broadcasts to every open tab so
// capture starts without a page refresh (mirrors the earlier auto-inject fix). Persisted
// PER ACCOUNT — a flag set while account A is active must never leak into account B.
// persist: whether this value should be written to storage as a DURABLE fact.
//
// These flags record "this account has enrolled and trained a model" — something only the
// wizard establishes and only a reset revokes. They must never be derived from whether the
// offscreen document happened to load the model successfully just now. It used to be: on
// every extension reload the offscreen doc is recreated and runs loadBestModel BEFORE the
// background has resolved the account (chrome.identity is async), so it reported
// personal:false / mouse:false, and those transient falses were written straight to storage.
// The result looked exactly like losing your training data — capture switched off, the panel
// showed "not trained" — while the windows and the IndexedDB heads were still sitting there
// untouched. Only a successful load (v === true) is proof, so only that is persisted.
function setModelPersonal(v, persist) {
  v = !!v;
  if (v === state.modelPersonal) return;
  state.modelPersonal = v;
  if (persist !== false && state.accountId) { var rec = {}; rec["cg_model_personal_" + state.accountId] = v; api.storage.local.set(rec); }
  broadcastConfig();
  refreshAllBadges();
}

// See setModelPersonal: only a successful load is proof, so only that is persisted.
function setMouseReady(v, persist) {
  v = !!v;
  if (v === state.mouseReady) return;
  state.mouseReady = v;
  if (persist !== false && state.accountId) { var rec = {}; rec["cg_mouse_ready_" + state.accountId] = v; api.storage.local.set(rec); }
  broadcastConfig();   // enabling mouse (even without keystroke) must turn capture on in open tabs
  refreshAllBadges();
}

api.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg) return;
  switch (msg.type) {
    case "cg:get-account":
      if (!state.accountChecked) {
        refreshAccount(function () { reply({ id: state.accountId || null, email: state.accountEmail || null }); });
        return true;
      }
      reply({ id: state.accountId || null, email: state.accountEmail || null });
      return true;
    case "cg:enrolled":
      state.enrolled = true;
      refreshSampleCounts();   // the wizard just accumulated new windows — update the popup's count
      // The wizard just trained a personal model into IndexedDB — hot-swap it in.
      ensureOffscreen().then(function () {
        try { api.runtime.sendMessage({ target: "offscreen", type: "cg:reload-model", accountId: state.accountId }, function () { void api.runtime.lastError; }); } catch (e) {}
      });
      // BOTH rolling buffers must be dropped: every score in them was produced by the model
      // that was just replaced. Only the keystroke packet used to be cleared, so after mouse
      // retraining the 20-window mouse buffer still held the OLD model's low scores and could
      // trigger a lock immediately — before the newly trained head had scored a single window.
      scores = [];
      mouseScores = [];
      state.verdict = null;
      state.mouseVerdict = null;
      persistProgress(true);
      return;
    case "cg:profile-reset": {
      // The wizard just deleted the stored windows + trained heads (IndexedDB) — mirror
      // that here: drop back to untrained (monitoring off) until the user retrains.
      state.enrolled = false;
      state.keySamples = 0;
      state.mouseSamples = 0;
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
        try { api.runtime.sendMessage({ target: "offscreen", type: "cg:reload-model", accountId: state.accountId }, function () { void api.runtime.lastError; }); } catch (e) {}
      });
      updateBadge();
      persistProgress(true);
      return;
    }
    case "cg:model-ready":
      // A load RESULT, not an enrollment fact: persist only the positive case. A false here
      // means "could not load right now" — the account was not resolved yet, or the offscreen
      // document was just recreated — and must never overwrite the stored record that this
      // account has a trained model.
      state.modelReady = true; state.modelError = null;
      setModelPersonal(msg.personal, msg.personal === true);
      setMouseReady(msg.mouse, msg.mouse === true);
      applyMouseMeta(msg.mouseMeta, msg.mouseStale);
      return;
    case "cg:model-error": state.modelReady = false; state.modelError = msg.error || "load_failed"; return;
    case "cg:hello":
      // enabled = anyTrained(), matching broadcastConfig: this flag gates CAPTURE in the
      // content script, and capture must run whenever EITHER modality is trained. Using
      // monitoringEnabled() here (keystroke-only) meant a mouse-only profile captured
      // nothing on a fresh page load until some later broadcast happened to re-enable it.
      reply({ enabled: anyTrained(), mouseTracking: state.mouseTracking, excluded: config.exclusions.indexOf(msg.origin) >= 0, locked: state.locked, hasPasskey: studyOn() || state.hasPasskey, rpOrigin: studyOn() ? study.gateway : rpOriginOf(), debug: debugLog, study: studyInfo() });
      return true;
    case "cg:open-verify":
      if (studyOn()) { studyOpenPage("verify", state.lockReason === "mouse" ? "mouse" : "keystroke"); return; }
      openRpPage("/ext/verify.html");
      return;
    case "cg:open-register":
      openRpPage("/ext/register.html");
      return;
    case "cg:verified":
      if (fromStudyPage(sender)) {
        // Study step-up passed: the gateway already cleared the server lock. Probation follows.
        studyPromptEvent("passed");
        studyPrompt = null;
        studyProbation = true;
        releaseLock();
        closeRpTab(sender);
        return;
      }
      // Relayed by the content script on the RP page — trust ONLY that origin.
      if (sender && sender.url && sender.url.indexOf(RP_BASE) === 0) {
        releaseLock();
        closeRpTab(sender);   // return the user to where they were
      }
      return;
    case "cg:passkey-registered":
      if (sender && sender.url && sender.url.indexOf(RP_BASE) === 0) {
        state.hasPasskey = true;
        if (state.accountId) { var pkRec = {}; pkRec["cg_passkey_" + state.accountId] = 1; api.storage.local.set(pkRec); }
        if (state.locked) broadcastAll({ type: "cg:lock", hasPasskey: true });  // refresh overlay button
        closeRpTab(sender);
      }
      return;
    case "cg:activity":
      if (monitoringEnabled()) { state.steps = msg.steps || 0; state.needSteps = msg.need || 50; state.lastWindowAt = Date.now(); updateBadge(); persistProgress(); }
      return;
    case "cg:verify-failed":
      if (fromStudyPage(sender)) studyPromptEvent("failed");
      return;
    case "cg:study-open-enrol":
      if (studyOn()) studyOpenPage("enrol");
      return;
    case "cg:study-check": {
      // From a content script in study mode: { channel, sessionId, clientTs, body, windowKeys }.
      if (!studyOn() || studyPaused || state.locked || !msg.body) { reply({ ok: false, paused: studyPaused }); return true; }
      var ch = msg.channel === "mouse" ? "mouse" : "keystroke";
      var path = ch === "mouse" ? "/v1/sdk/mouse/check" : "/v1/sdk/keystroke/check";
      var extra = ch === "mouse" ? { windowKeys: msg.windowKeys || [] } : null;
      var body = Object.assign({}, msg.body, { study: studyContext(msg.sessionId, msg.clientTs, extra) });
      studyPost(path, body)
        .then(function (r) { studyVerdict(ch, r, msg.sessionId); reply({ ok: true, status: r.status }); })
        .catch(function (e) { studyError = (e && e.message) || "gateway unreachable"; reply({ ok: false, error: studyError }); });
      return true;
    }
    case "cg:windows":
      if (msg.latest) onWindow(msg.latest);
      return;
    case "cg:windows-mouse":
      if (msg.latest) onMouseWindow(msg.latest);
      return;
    case "cg:status":
      // Fallback safety net for chrome.identity.onSignInChanged, which isn't reliable on
      // every platform: the popup polls every 1s, so a cheap throttled re-check here still
      // catches an account switch within a few seconds even if the event never fires.
      if (Date.now() - _lastAccountCheck > 4000) { _lastAccountCheck = Date.now(); refreshAccount(); }
      if (!state.modelReady) {
        // Make sure the offscreen doc exists, then ask it directly whether the model loaded.
        ensureOffscreen().then(function () {
          pingOffscreen(function (r) {
            // Same rule as cg:model-ready — this is a load result, so persist only a success.
            // The popup polls this once a second, so persisting a false here would rewrite the
            // "trained" record every second the offscreen doc had not loaded the head yet.
            if (r && r.ready) {
              state.modelReady = true; state.modelError = null;
              setModelPersonal(r.personal, r.personal === true);
              setMouseReady(r.mouse, r.mouse === true);
              applyMouseMeta(r.mouseMeta, r.mouseStale);
            }
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
    case "cg:set-mouse-tracking": {
      state.mouseTracking = msg.on !== false;
      api.storage.local.set({ cg_mouse_tracking: state.mouseTracking });
      if (!state.mouseTracking) {
        mouseScores = [];                 // drop the rolling vote so it can't lock after being turned off
        state.mouseVerdict = null;
      }
      broadcastConfig();                  // tell content scripts to stop/resume capturing mouse
      updateBadge();
      reply({ mouseTracking: state.mouseTracking });
      return true;
    }
    case "cg:set-mouse-sustain": {
      var pct = parseInt(msg.pct, 10);
      if (!(pct >= 30 && pct <= 100)) { reply({ mouseSustainPct: state.mouseSustainPct }); return true; }
      state.mouseSustainPct = pct;
      state.mousePctUserSet = true;
      var pr = {}; pr[MOUSE_PCT_KEY] = pct; api.storage.local.set(pr);
      reply({ mouseSustainPct: state.mouseSustainPct });
      return true;
    }
  }
});
