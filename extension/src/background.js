// background.js — the MV3 service worker of Continuum Guard.
//
// The extension is a CLIENT of the Continuum server, exactly like a site that embeds the SDK. Content
// scripts capture key timings and mouse windows on every page; this worker sends them to the gateway
// (/v1/sdk/keystroke/check, /v1/sdk/mouse/check) under the signed-in user's session, and the server
// scores them with its models. When the server asks for a step-up, every tab locks until the user
// verifies with their passkey on the gateway's page. Nothing is scored in the browser any more: the
// on-device version (TensorFlow.js, Google-account binding) is git tag extension-on-device-v1.
//
// Who the user is, one of three:
//   personal     — a Continuum account (email + passkey) on the built-in personal tenant;
//   organisation — an account at an organisation that uses Continuum ("Sign in with <organisation>");
//   study        — the research study (recovery plan T4.3): a pseudonym on the study tenant, set by the
//                  experimenter on the options page. While it is on it wins over any sign-in.
// Personal and organisation users sign in through the gateway (/v1/link/*: the OAuth 2.0 code flow with
// PKCE, the gateway's server.js "EXTENSION SIGN-IN") and the extension keeps only a refresh token.
var api = globalThis.browser || globalThis.chrome;
// The typing decision's packet: the signed-in organisation's choice (6, 10 or 20; /v1/sdk/keystroke/config
// recentWindowCount), kept in storage like the excluded field types. The first verdict needs one window
// more than this (the server treats a count up to the packet as warm-up), shown as "analyzing n/21".
var RECENT = 20;
var DEFAULT_GATEWAY = "http://localhost:8080";

var config = { exclusions: [] };
// Verbose per-check diagnostics, opt-in on the options page; warnings and errors are never gated.
var debugLog = false;
function dlog() { if (!debugLog) return; try { console.log.apply(console, arguments); } catch (e) {} }

// The signed-in account (storage.local "cg_account"):
//   { gateway, siteKey, kind: "personal"|"organisation", tenantName, label, userId, refreshToken, onboarding, linkedAt }
var account = null;
// The research study (storage.local "cg_study", options page): { on, gateway, siteKey, participant, condition, client, showVerdict }.
// `condition` is "genuine" or "impostor:<pseudonym of the person typing>"; `client` "extension-study" or "lab".
var study = { on: false, gateway: "", siteKey: "", participant: "", condition: "genuine", client: "extension-study", showVerdict: false };
// Show the live verdict in the popup and on the badge. Participants of the study never see it unless the
// experimenter ticks the study's own "show verdicts while testing".
var showVerdictPref = true;
// The pause (popup button or Alt+Shift+P): while on, no page captures anything on either channel and no
// check is sent. Persisted, and never lifted automatically.
var paused = false;
// The gateway not answering (Continuum stopped on this PC, the network down). Nothing is checked then, so nothing may
// look as if it were: the pages stop collecting (as for the pause), the icon shows the logo off with "!", the popup
// says the page is not protected, and the last verdicts are dropped (no stale "it's you"). Set by any request to the
// gateway that fails or gets 502/503/504, cleared by the next answer; a probe every 30 s (chrome.alarms: this worker
// sleeps) notices the return without waiting for movement. Kept in storage.local, so a restarted worker does not
// resume collecting while the gateway is still away. Before 2026-11-03 the bars kept filling with the server down.
var offline = null;   // { since, message }
var PROBE_ALARM = "cg-gateway-probe";

// MV3: this worker is stopped after ~30 s idle and restarted from scratch, so everything that gates
// behaviour is persisted (the lock in cg_progress, the settings, the account) and read back at start.
var state = { locked: false, lockReason: null, lockPasted: false, verdict: null, mouseVerdict: null, error: null, notEnrolled: null, lastCheckAt: 0,
  disabled: {},      // channel -> when the server last said the organisation turned it off
  unavailable: {} }; // channel -> when its model last could not score (ca-service 503 model_unavailable): no verdict for it
// The buffer epoch (2026-11-25): a new value at every lock, every unlock and every change of user, kept in storage.local
// so a restarted worker keeps it. A page's buffers belong to the epoch they were collected in, and a check from another
// epoch is refused and the page told to start again. Before this, a page that did not hear the unlock (kept in the
// back/forward cache, frozen, or hidden) kept the movement that had locked the account and sent it again after the
// passkey: the owner was asked twice in a row on 22 and 24 Nov (58 and 59 of 60 windows the same).
var bufferEpoch = null;
function newBufferEpoch() {
  bufferEpoch = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try { api.storage.local.set({ cg_buffer_epoch: bufferEpoch }); } catch (e) {}
}
// The message that wakes this worker can arrive before its saved state is read, so every message waits for that read.
// Answered before it, a page heard "not locked, nobody signed in", and an unlock could be undone by the read.
var restoreDone = false, restoreResolve = null;
var restored = new Promise(function (resolve) { restoreResolve = resolve; });
function markRestored() { if (!restoreDone) { restoreDone = true; restoreResolve(); } }
setTimeout(markRestored, 3000);   // a read that never answers must not hold every message for ever
var session = null;     // { token, userId, key } from /v1/sdk/session; re-minted on a 401 or a change of user
// The account's sign-in itself refused by the gateway (its refresh token expired or revoked, its organisation revoked): no
// session, so no passkey page either. The settings and the lock overlay then offer "Sign in again" (2026-11-25).
var signInDead = false;
var probation = false;  // after a step-up: re-challenge on any scored suspicious verdict (as the SDK); kept in cg_progress
var openPrompt = null;      // the open step-up: { channel, decisionId, sessionId, tabId } (study logging)
// Learning from real use, stage 1: after a verified step-up the gateway may offer to record a real-use mouse sample
// (ca-service lib/mouseUse.js). The verify page asks; on a yes every tab records fresh movement (content.js) and the
// first to reach a sample's windows sends it here. Both states live in storage.session, because this worker is
// stopped when idle and restarted from scratch (the MV3 rule); lastUseSample is for the popup.
var useOffer = null;        // { until, tabId }: offered, the user not asked yet
var useRec = null;          // { epoch, until }: recording
var lastUseSample = null;   // { at, ok, error }
function persistUse() { try { api.storage.session.set({ cg_use: { offer: useOffer, rec: useRec } }); } catch (e) {} }
function stopUseRecording() {
  var was = !!(useOffer || useRec);
  useOffer = null; useRec = null;
  persistUse();
  if (was) broadcastAll({ type: "cg:use-sample-stop" });
}
function startUseRecording(until) {
  useRec = { epoch: "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), until: until };
  persistUse();
  broadcastAll({ type: "cg:use-sample-start", epoch: useRec.epoch, until: useRec.until });
}
function sendUseSample(windows) {
  gw("/v1/sdk/mouse/use-sample", { windows: windows })
    .then(function (r) { lastUseSample = { at: Date.now(), ok: r.status === 200, error: r.status === 200 ? null : ((r.d && (r.d.note || r.d.error)) || "HTTP " + r.status) }; })
    .catch(function (e) { lastUseSample = { at: Date.now(), ok: false, error: (e && e.message) || "gateway unreachable" }; })
    .then(function () { try { api.storage.local.set({ cg_last_use_sample: lastUseSample }); } catch (e) {} });
}

function studyOn() { return !!(study && study.on && study.gateway && study.siteKey && study.participant); }
// The active connection, or null when nobody is signed in.
function conn() {
  if (studyOn()) return { kind: "study", gateway: study.gateway, siteKey: study.siteKey };
  if (account && account.gateway && account.siteKey && account.refreshToken) return { kind: account.kind, gateway: account.gateway, siteKey: account.siteKey };
  return null;
}
function connKey() {
  var c = conn();
  return c ? [c.kind, c.gateway, c.siteKey, c.kind === "study" ? study.participant : (account.userId || "")].join("|") : "";
}
function showVerdict() { return studyOn() ? !!study.showVerdict : showVerdictPref; }
function studyInfo() { return studyOn() ? { participant: study.participant, condition: study.condition, client: study.client } : null; }
// What the content scripts need: capture on or off, and whether it is the study (no password-field events).
// offline: the gateway does not answer, nothing is collected. off: the channels the organisation turned off, not
// collected either.
function captureInfo() {
  var c = conn();
  return c ? { kind: c.kind, paused: paused, offline: !!offline, off: { keystroke: !!state.disabled.keystroke, mouse: !!state.disabled.mouse } } : null;
}
function disabledKey() { return Object.keys(state.disabled).sort().join(","); }
// Kept in storage (2026-11-25): it lived only in state.disabled, so every restart of this worker (~30 s idle) forgot it and
// the pages collected a channel the organisation had turned off until its next check was refused.
function persistDisabled() { try { api.storage.local.set({ cg_disabled: state.disabled }); } catch (e) {} }
// The signed-in organisation's settings (its console, or the operator's default): which channels are on,
// the "fields never watched" and the typing packet. The field types and the packet are kept in storage
// because the worker loses its variables when idle. The server enforces all of them anyway.
var excludeTypes = ["hidden"];
// The panel's language and colours as the organisation set them (its console: panelLanguage auto | en | ar,
// panelTheme auto | light | dark), for the popup and the lock overlay; "auto" is the browser's language and the
// device's mode. Kept in storage like the rest, and sent to the pages with the capture config.
var look = { lang: "auto", theme: "auto" };
var orgConfigAt = 0;
function refreshOrgConfig() {
  if (!conn()) return;
  orgConfigAt = Date.now();
  gw("/v1/sdk/keystroke/config", null, "GET").then(function (r) {
    if (!r || r.status !== 200) return;
    // A channel switched back on is used again at once (it used to wait up to 10 minutes for a retry).
    var before = disabledKey();
    ["keystroke", "mouse"].forEach(function (ch) {
      if (r.d[ch] === "off") { if (!state.disabled[ch]) state.disabled[ch] = Date.now(); }
      else if (r.d[ch] === "on") delete state.disabled[ch];
    });
    if (disabledKey() !== before) { broadcastConfig(); persistDisabled(); }   // the pages stop or resume collecting that channel
    refreshAllBadges();
    if (Array.isArray(r.d.excludeFieldTypes)) {
      excludeTypes = r.d.excludeFieldTypes.map(function (x) { return String(x).toLowerCase(); });
      api.storage.local.set({ cg_exclude_types: excludeTypes });
    }
    if (Number(r.d.recentWindowCount) > 0) {
      RECENT = Number(r.d.recentWindowCount);
      api.storage.local.set({ cg_ks_packet: RECENT });
      refreshAllBadges();
    }
    var nl = { lang: ["auto", "en", "ar"].indexOf(r.d.panelLanguage) >= 0 ? r.d.panelLanguage : "auto", theme: ["auto", "light", "dark"].indexOf(r.d.panelTheme) >= 0 ? r.d.panelTheme : "auto" };
    if (nl.lang !== look.lang || nl.theme !== look.theme) { look = nl; api.storage.local.set({ cg_look: look }); broadcastConfig(); }
  }).catch(function () {});
}
// At most once per `minMs`: while the popup is open (it polls the status every second) and while a
// channel is off, so a change in the console shows within seconds.
function maybeRefreshOrgConfig(minMs) { if (Date.now() - orgConfigAt >= minMs) refreshOrgConfig(); }
function gatewayOrigin() { var c = conn(); try { return c ? new URL(c.gateway).origin : ""; } catch (e) { return ""; } }

function loadStudy(v) {
  v = v || {};
  study = {
    on: v.on === true, gateway: String(v.gateway || "").replace(/\/+$/, ""), siteKey: String(v.siteKey || ""),
    participant: String(v.participant || ""), condition: String(v.condition || "genuine"),
    client: v.client === "lab" ? "lab" : "extension-study", showVerdict: v.showVerdict === true,
  };
}
function loadAccount(v) {
  account = v && v.gateway && v.siteKey && v.refreshToken ? v : null;
}
// Any change of user: drop what belonged to the previous one.
function resetUser() {
  session = null; probation = false; openPrompt = null; signInDead = false;
  stopUseRecording();
  state.verdict = null; state.mouseVerdict = null; state.error = null; state.notEnrolled = null; state.unavailable = {};
  // Another gateway, or none: whether the old one answered says nothing about it.
  offline = null;
  try { api.storage.local.remove("cg_offline"); } catch (e) {}
  if (api.alarms) api.alarms.clear(PROBE_ALARM);
  look = { lang: "auto", theme: "auto" };
  try { api.storage.local.remove("cg_look"); } catch (e) {}
}

// ---- talking to the gateway ----
// Every request to the gateway goes through here, so a failure or a recovery is noticed whatever the call.
async function gfetch(url, opts) {
  var r;
  try { r = await fetch(url, opts); }
  catch (e) { setOffline((e && e.message) || "unreachable"); throw e; }
  if ((r.status === 502 || r.status === 503 || r.status === 504) && !(await modelOnly(r))) setOffline("HTTP " + r.status);   // the edge answers, nothing behind it
  else setOnline();
  return r;
}
// A 503 whose body says model_unavailable is the gateway answering: that one channel's model cannot score (ca-service
// issues no verdict), the gateway and the other channel are fine. It used to count as "gateway away" (2026-11-08), so a
// typing-model outage stopped the mouse channel too and the pages dropped their buffers every 30 s on the probe's return.
async function modelOnly(r) {
  if (r.status !== 503) return false;
  try { var d = await r.clone().json(); return !!d && d.error === "model_unavailable"; } catch (e) { return false; }
}
function setOffline(message) {
  var first = !offline;
  offline = { since: (offline && offline.since) || Date.now(), message: String(message || "unreachable") };
  state.error = "Can't reach Continuum at " + ((conn() || {}).gateway || "the gateway") + " (" + offline.message + "): nothing is checked";
  if (!first) return;
  state.verdict = null; state.mouseVerdict = null;   // no stale "it's you" while nothing is checked
  try { api.storage.local.set({ cg_offline: offline }); } catch (e) {}
  if (api.alarms) api.alarms.create(PROBE_ALARM, { periodInMinutes: 0.5 });
  broadcastConfig();   // captureInfo() now says offline: the pages stop collecting and drop their buffers
  refreshAllBadges();
  persistProgress(true);
}
function setOnline() {
  if (!offline) return;
  offline = null;
  state.error = null;
  try { api.storage.local.remove("cg_offline"); } catch (e) {}
  if (api.alarms) api.alarms.clear(PROBE_ALARM);
  broadcastConfig();   // collecting resumes, from empty buffers
  refreshAllBadges();
}
// The gateway's /health needs no sign-in. Any answer below 500 means it is back.
function probeGateway() {
  var c = conn();
  if (!c || !offline) { if (api.alarms) api.alarms.clear(PROBE_ALARM); return Promise.resolve(); }
  return gfetch(c.gateway + "/health", { cache: "no-store" }).catch(function () {});
}
if (api.alarms && api.alarms.onAlarm) api.alarms.onAlarm.addListener(function (a) { if (a && a.name === PROBE_ALARM) probeGateway(); });

async function sessionToken(force) {
  var c = conn();
  if (!c) throw new Error("not signed in");
  var key = connKey();
  if (session && session.key === key && !force) return session.token;
  var body = c.kind === "study" ? { siteKey: c.siteKey, externalId: "study:" + study.participant } : { siteKey: c.siteKey, refreshToken: account.refreshToken };
  var r = await gfetch(c.gateway + "/v1/sdk/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok || !d.token) {
    // The refresh token was revoked or has expired, or the organisation was: sign in again.
    var dead = c.kind !== "study" && /refresh_token|tenant_revoked|invalid_site_key/.test(d.error || "");
    if (dead) { state.error = "Your sign-in has expired. Sign in again in the settings."; signInDead = true; }
    var err = new Error(d.error || ("session HTTP " + r.status));
    err.signInDead = dead;   // gatewayDown: the gateway answered, so not "Can't reach Continuum"
    throw err;
  }
  signInDead = false;
  session = { token: d.token, userId: d.userId, key: key };
  if (d.onboarding) setOnboarding(d.onboarding);
  return d.token;
}
async function gw(path, body, method) {
  var c = conn();
  if (!c) throw new Error("not signed in");
  for (var attempt = 0; attempt < 2; attempt++) {
    var token = await sessionToken(attempt > 0);
    var r = await gfetch(c.gateway + path, { method: method || "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: method === "GET" ? undefined : JSON.stringify(body || {}) });
    if (r.status === 401 && attempt === 0) continue;   // session expired: mint a new one once
    return { status: r.status, d: await r.json().catch(function () { return {}; }) };
  }
}
// What the user has enrolled on the server: { passkey, keystroke, mouse }.
function setOnboarding(ob) {
  if (!ob) return;
  if (account && !studyOn()) {
    var same = account.onboarding && account.onboarding.passkey === !!ob.passkey && account.onboarding.keystroke === !!ob.keystroke && account.onboarding.mouse === !!ob.mouse
      && account.onboarding.keystrokeTraining === !!ob.keystrokeTraining;
    // keystrokeTraining: typing enrolment is done and its model is being built on the server's queue.
    account.onboarding = { passkey: !!ob.passkey, keystroke: !!ob.keystroke, keystrokeTraining: !!ob.keystrokeTraining, mouse: !!ob.mouse };
    if (!same) api.storage.local.set({ cg_account: account });
  }
  if (ob.keystroke && ob.mouse) state.notEnrolled = null;
}
var onboardingAt = 0;
// While the typing model is being built (about a minute) the popup re-reads the onboarding state, so it
// says "ready" without a reload.
function maybeRefreshOnboarding(minMs) { if (Date.now() - onboardingAt >= minMs) refreshOnboarding(); }
function refreshOnboarding() {
  if (!conn()) return;
  onboardingAt = Date.now();
  refreshOrgConfig();
  gw("/v1/sdk/onboarding", null, "GET").then(function (r) { if (r && r.status === 200) setOnboarding(r.d); refreshAllBadges(); }).catch(function () {});
}

// ---- study logging (ca-service lib/studyLog.js): only the study sends a study context ----
function studyContext(sessionId, clientTs, extra) {
  return Object.assign({ participant: study.participant, sessionId: sessionId, condition: study.condition, client: study.client, clientTs: clientTs }, extra || {});
}
function promptEvent(event) {
  var p = openPrompt;
  if (!p || !studyOn()) return;
  gw("/v1/sdk/study/prompt", { study: studyContext(p.sessionId, Date.now()), channel: p.channel, decisionId: p.decisionId, event: event })
    .catch(function (e) { console.warn("[continuum-guard] prompt event not logged:", e && e.message); });
}

// ---- verdicts ----
// A verdict from the server. Challenge as the SDK does (sdk/guard.js maybeChallenge): when the server
// requires it, or during probation on a suspicious verdict backed by scored windows.
function onVerdict(channel, r, sessionId) {
  var d = (r && r.d) || {};
  state.lastCheckAt = Date.now();
  // The organisation turned this channel off (its console or the operator page): stop sending it, and the pages stop
  // collecting it.
  if (r && r.status === 409 && /_disabled$/.test(String(d.error || ""))) {
    var wasOff = !!state.disabled[channel];
    state.disabled[channel] = Date.now();
    if (!wasOff) { broadcastConfig(); persistDisabled(); }
    refreshAllBadges();
    return;
  }
  if (d.checked && state.disabled[channel]) { delete state.disabled[channel]; broadcastConfig(); persistDisabled(); }
  // That channel's model cannot score: no verdict, so its last one is dropped (no stale "it's you"); the other channel
  // goes on, and the next check of this one tries again.
  if (r && r.status === 503 && d.error === "model_unavailable") {
    state.unavailable[channel] = Date.now();
    if (channel === "keystroke") state.verdict = null; else state.mouseVerdict = null;
    refreshAllBadges();
    persistProgress();
    return;
  }
  if (r && r.status < 500) delete state.unavailable[channel];   // its model answered
  if (r && r.status === 423 && !state.locked) { challenge(channel, null, sessionId); return; }   // locked server-side
  if (d.enrolled === false || (d.typingEvaluation && d.typingEvaluation.modelAvailable === false)) {
    state.notEnrolled = channel; state.error = null; refreshAllBadges(); return;
  }
  if (state.notEnrolled === channel) state.notEnrolled = null;   // its model is there now
  if (!d.checked) return;
  state.error = null;
  if (channel === "keystroke") {
    // The organisation's packet, as the server just applied it: the counter follows a change at once.
    if (Number(d.packetWindows) > 0 && Number(d.packetWindows) !== RECENT) {
      RECENT = Number(d.packetWindows);
      api.storage.local.set({ cg_ks_packet: RECENT });
    }
    state.verdict = { status: d.warmup ? "analyzing" : (d.isSuspicious ? "suspicious" : "genuine"),
      mean: Math.round((d.modelConfidence || 0) * 100), packet: Number(d.scoredWindowCount || 0), need: RECENT + 1 };
  } else {
    state.mouseVerdict = { status: d.warmup ? "analyzing" : (d.isSuspicious ? "suspicious" : "genuine"),
      low: d.lowWindows, buffer: d.windowCount, bufferMax: d.bufferMax, lockAt: d.lockAt,
      mean: Math.round((d.meanScore || 0) * 100) };
  }
  dlog("[continuum-guard] " + channel + " verdict", JSON.stringify(channel === "keystroke" ? state.verdict : state.mouseVerdict));
  var scored = channel === "keystroke" ? Number(d.scoredWindowCount) > 0 : Number(d.windowCount) > 0;
  var trigger = !!d.requiresPasskeyChallenge || (probation && !!d.isSuspicious && scored);
  // a paste lock (more pastes into one field than the organisation allows) says so on the page
  var pasted = !!(d.typingEvaluation && d.typingEvaluation.modelType === "paste-policy");
  if (trigger && !state.locked) { challenge(channel, d.studyDecisionId || null, sessionId, pasted); return; }
  if (!d.warmup && !d.isSuspicious && probation) { probation = false; persistProgress(true); }   // a clean verdict ends probation
  updateBadge();
  persistProgress();
}
function challenge(channel, decisionId, sessionId, pasted) {
  openPrompt = { channel: channel, decisionId: decisionId, sessionId: sessionId, tabId: null };
  engageLock(channel, pasted);
  promptEvent("shown");
}

// ---- the gateway's pages: step-up, enrolment, sign-in ----
// The study keeps its own page (/study.html, identity "study:<pseudonym>"); a signed-in user's page gets
// the session in the URL fragment (/connect.html), which never reaches a server and is removed at once.
async function pageUrl(mode, reason) {
  var c = conn();
  if (!c) return null;
  if (c.kind === "study") {
    return c.gateway + "/study.html?mode=" + mode + "&p=" + encodeURIComponent(study.participant)
      + "&k=" + encodeURIComponent(study.siteKey) + (reason ? "&reason=" + reason : "");
  }
  var token = await sessionToken();
  return c.gateway + "/connect.html?mode=" + mode + (reason ? "&reason=" + reason : "") + "#s=" + encodeURIComponent(token);
}
function openPage(url, asPopup, onTab) {
  if (asPopup && api.windows && api.windows.create) {
    try { api.windows.create({ url: url, type: "popup", width: 520, height: 700 }, function (w) { if (onTab) onTab(w && w.tabs && w.tabs[0]); }); return; } catch (e) {}
  }
  api.tabs.create({ url: url }, function (t) { if (onTab) onTab(t); });
}
function openVerify() {
  pageUrl("verify", state.lockReason === "mouse" ? "mouse" : "keystroke").then(function (url) {
    if (!url) return;
    openPage(url, true, function (tab) { if (openPrompt && tab) openPrompt.tabId = tab.id; });
  }).catch(function (e) { gatewayDown(e); });
}
function openEnrol() {
  pageUrl("enrol").then(function (url) { if (url) openPage(url, false); }).catch(function (e) { gatewayDown(e); });
}
// The step-up is the only way to clear a lock, so an unreachable gateway must be said out loud, in the
// overlay too; otherwise the click seems to do nothing and the user looks locked out for good.
function gatewayDown(e) {
  // The gateway answered, but the sign-in itself is no longer valid: said as such, with "Sign in again" in the overlay
  // (2026-11-25). It said "Can't reach Continuum", and signing out is refused while locked, so a locked user had no way out.
  if (e && e.signInDead) { broadcastAll({ type: "cg:sign-in-needed" }); refreshAllBadges(); return; }
  state.error = "Can't reach Continuum at " + ((conn() || {}).gateway || "the gateway") + " (" + ((e && e.message) || "unreachable") + ")";
  broadcastAll({ type: "cg:gateway-unreachable", message: state.error });
  refreshAllBadges();
}
// A page of the active gateway. Its messages (the step-up's result, the sign-in's code) are trusted only
// from there: Chrome sets sender.url, a page cannot fake it.
function fromGatewayPage(sender, page) {
  var c = conn(), g = c ? c.gateway : "";
  if (page === "/connect.html" && pendingGateway) g = pendingGateway;
  return !!g && !!sender && !!sender.url && sender.url.indexOf(g + page) === 0;
}
function closeSenderTab(sender) {
  if (sender && sender.tab && sender.tab.id != null) { try { api.tabs.remove(sender.tab.id, function () { void api.runtime.lastError; }); } catch (e) {} }
}
// Closing the step-up page while still locked = the prompt was dismissed (study logging).
if (api.tabs && api.tabs.onRemoved) {
  api.tabs.onRemoved.addListener(function (tabId) {
    if (openPrompt && openPrompt.tabId === tabId && state.locked) { promptEvent("dismissed"); openPrompt.tabId = null; }
  });
}

// ---- signing in (personal account or organisation) ----
// OAuth 2.0 code flow with PKCE: a random verifier stays in this worker (storage.session: in memory,
// survives the worker's restarts, gone when the browser closes); the page gets only its S256 challenge.
var pendingGateway = "";   // gateway of the sign-in in progress, so its /connect.html is trusted before the account exists
function b64url(bytes) {
  var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function tabById(id) {
  return new Promise(function (resolve) { try { api.tabs.get(id, function (t) { void api.runtime.lastError; resolve(t || null); }); } catch (e) { resolve(null); } });
}
async function startSignIn(gateway, siteKey) {
  gateway = String(gateway || DEFAULT_GATEWAY).trim().replace(/\/+$/, "");
  siteKey = String(siteKey || "").trim();
  // A sign-in already open (2026-11-25): a second click made a new verifier, so neither window could finish (the first
  // one's code no longer matched it, the second found nothing pending). The same sign-in is brought to the front; another
  // one (other server or organisation) replaces it and its window is closed.
  var old = (await api.storage.session.get("cg_link_pending")).cg_link_pending;
  if (old && old.tabId == null && Date.now() - old.at < 5000) return;   // its window is being opened
  var oldTab = old && old.tabId != null && Date.now() - old.at < 15 * 60000 ? await tabById(old.tabId) : null;
  if (oldTab && old.gateway === gateway && old.siteKey === siteKey) {
    try { api.windows.update(oldTab.windowId, { focused: true }, function () { void api.runtime.lastError; }); } catch (e) {}
    return;
  }
  if (oldTab) { try { api.tabs.remove(oldTab.id, function () { void api.runtime.lastError; }); } catch (e) {} }
  var verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  var challengeS256 = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  var pending = { gateway: gateway, siteKey: siteKey, verifier: verifier, at: Date.now() };
  await api.storage.session.set({ cg_link_pending: pending });
  pendingGateway = gateway;
  openPage(gateway + "/connect.html?mode=link&k=" + encodeURIComponent(siteKey) + "&cc=" + challengeS256, true, function (t) {
    if (t && t.id != null) { pending.tabId = t.id; try { api.storage.session.set({ cg_link_pending: pending }); } catch (e) {} }
  });
}
async function finishSignIn(msg, sender) {
  var p = (await api.storage.session.get("cg_link_pending")).cg_link_pending;
  if (!p || Date.now() - p.at > 15 * 60000) throw new Error("no sign-in in progress");
  var r = await fetch(p.gateway + "/v1/link/token", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ linkId: String(msg.link || ""), code: String(msg.code || ""), codeVerifier: p.verifier }) });
  var d = await r.json().catch(function () { return {}; });
  await api.storage.session.remove("cg_link_pending");
  pendingGateway = "";
  if (!r.ok || !d.refreshToken) throw new Error(d.error || ("sign-in HTTP " + r.status));
  // Locked: only the locked account may sign in again ("Sign in again" after its sign-in expired, 2026-11-25). Anyone else
  // would replace it here and could then lift the lock with their own passkey.
  if (state.locked && account && !studyOn() && (p.gateway !== account.gateway || d.siteKey !== account.siteKey || String(d.userId) !== String(account.userId))) {
    revoke({ gateway: p.gateway, refreshToken: d.refreshToken });
    throw new Error("this browser is locked for " + (account.label || "user " + account.userId) + ": sign in with that account");
  }
  var who = connKey();
  if (account && account.refreshToken) revoke(account);   // signing in as someone else replaces the old sign-in
  resetUser();
  account = { gateway: p.gateway, siteKey: d.siteKey, kind: d.kind, tenantName: d.tenantName, label: d.label, userId: d.userId,
    refreshToken: d.refreshToken, onboarding: d.onboarding || null, linkedAt: new Date().toISOString() };
  await api.storage.local.set({ cg_account: account });
  if (!studyOn()) session = { token: d.token, userId: d.userId, key: connKey() };
  // Another user: what the pages collected belonged to the one before (storage.onChanged does not see this change, the
  // account is replaced here first). Reachable from "Sign in again" since 2026-11-25.
  if (connKey() !== who) { newBufferEpoch(); broadcastAll({ type: "cg:reset", bufferEpoch: bufferEpoch }); }
  closeSenderTab(sender);
  broadcastConfig();
  refreshAllBadges();
  var ob = d.onboarding || {};
  if (!studyOn()) {
    if (state.locked) openVerify();   // signed in again to lift the lock: the passkey next, never the enrolment
    else if (!(ob.passkey && ob.keystroke && ob.mouse)) openEnrol();   // nothing to score before enrolment
  }
}
function revoke(acc) {
  try {
    fetch(acc.gateway + "/v1/link/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: acc.refreshToken }) })
      .catch(function () {});
  } catch (e) {}
}

// ---- restore at worker start ----
api.storage.local.get(["cg_exclusions", "cg_progress", "cg_debug", "cg_study", "cg_account", "cg_paused", "cg_show_verdict", "cg_study_paused", "cg_exclude_types", "cg_ks_packet", "cg_offline", "cg_look", "cg_buffer_epoch", "cg_disabled"], function (d) {
  try {
  d = d || {};
  // An epoch issued before this read (a change of user that woke the worker) stays: the read is older than it.
  if (!bufferEpoch) { if (typeof d.cg_buffer_epoch === "string" && d.cg_buffer_epoch) bufferEpoch = d.cg_buffer_epoch; else newBufferEpoch(); }
  if (Array.isArray(d.cg_exclude_types)) excludeTypes = d.cg_exclude_types;
  if (Number(d.cg_ks_packet) > 0) RECENT = Number(d.cg_ks_packet);
  if (d.cg_look && d.cg_look.lang) look = { lang: d.cg_look.lang, theme: d.cg_look.theme || "auto" };
  if (d.cg_disabled) ["keystroke", "mouse"].forEach(function (ch) { if (d.cg_disabled[ch] && !state.disabled[ch]) state.disabled[ch] = Number(d.cg_disabled[ch]) || Date.now(); });
  loadStudy(d.cg_study);
  loadAccount(d.cg_account);
  paused = d.cg_paused === true;
  // The pause was the study's alone (cg_study_paused) before it became everyone's: a participant paused
  // at the update must stay paused, never resume recording by surprise.
  if (d.cg_study_paused !== undefined) {
    if (d.cg_paused === undefined && d.cg_study_paused === true) { paused = true; api.storage.local.set({ cg_paused: true }); }
    api.storage.local.remove("cg_study_paused");
  }
  showVerdictPref = d.cg_show_verdict !== false;
  config.exclusions = d.cg_exclusions || [];
  debugLog = d.cg_debug === true;
  // Restore the lock (and the last verdicts) so a worker restart never silently drops a lock.
  var p = d.cg_progress;
  if (p && p.user === connKey()) {
    state.locked = !!p.locked;
    state.lockReason = p.lockReason || null;
    state.lockPasted = !!p.lockPasted;
    if (p.probation === true) probation = true;   // set by a step-up, ended only by a clean verdict
    if (Date.now() - (p.at || 0) < 10 * 60 * 1000) { state.verdict = p.verdict || null; state.mouseVerdict = p.mouseVerdict || null; }
  }
  // The gateway was away when this worker stopped: stay offline (nothing collected) and ask it now.
  if (d.cg_offline && conn() && !offline) {
    offline = d.cg_offline;
    state.verdict = null; state.mouseVerdict = null;
    state.error = "Can't reach Continuum at " + conn().gateway + " (" + (offline.message || "unreachable") + "): nothing is checked";
    if (api.alarms) api.alarms.create(PROBE_ALARM, { periodInMinutes: 0.5 });
  }
  broadcastConfig();
  refreshAllBadges();
  if (offline) probeGateway();
  // A page sends nothing of a channel that is off, so nothing else would notice it switched back on.
  else if (disabledKey()) refreshOrgConfig();
  } finally { markRestored(); }
});
if (api.storage.session && api.storage.session.get) {
  api.storage.session.get("cg_link_pending", function (d) { var p = d && d.cg_link_pending; if (p) pendingGateway = p.gateway; });
}
// A real-use sample offered or being recorded before this worker was restarted. The handlers that need it wait for this,
// because the message that woke the worker can arrive before the read completes.
var useRestored = new Promise(function (resolve) {
  if (!api.storage.session || !api.storage.session.get) { resolve(); return; }
  api.storage.session.get("cg_use", function (d) {
    var u = (d && d.cg_use) || {}, now = Date.now();
    if (!useOffer && u.offer && u.offer.until > now) useOffer = u.offer;
    if (!useRec && u.rec && u.rec.until > now) useRec = u.rec;
    resolve();
  });
});
api.storage.local.get("cg_last_use_sample", function (d) { if (d && d.cg_last_use_sample) lastUseSample = d.cg_last_use_sample; });

// Snapshot the lock and the verdicts so they survive a worker restart. Throttled (at most one write per
// ~1.2 s); immediate for the lock itself.
var _persistTimer = null;
// probation too (2026-11-08): it lived only in a variable, so after a step-up the worker's first idle stop (~30 s) ended
// it, and a suspicious verdict after that no longer re-challenged at once.
function progressSnapshot() {
  return { user: connKey(), verdict: state.verdict, mouseVerdict: state.mouseVerdict, locked: state.locked, lockReason: state.lockReason, lockPasted: state.lockPasted,
    probation: probation, at: Date.now() };
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

// Inject the capture scripts into tabs that were ALREADY open when the extension was (re)loaded;
// otherwise capture only starts after each tab is refreshed by hand.
function injectAll() {
  if (!api.scripting || !api.tabs) return;
  api.tabs.query({ url: ["http://*/*", "https://*/*"] }, function (tabs) {
    (tabs || []).forEach(function (t) {
      try {
        // lang-ar.js before content.js, as in the manifest: without it the lock overlay was English in these tabs (2026-11-25)
        api.scripting.executeScript({ target: { tabId: t.id }, files: ["src/features.js", "src/features-mouse.js", "src/lang-ar.js", "src/content.js"] },
          function () { void api.runtime.lastError; });   // chrome:// & store tabs refuse — fine
      } catch (e) {}
    });
  });
}
if (api.runtime.onInstalled) {
  api.runtime.onInstalled.addListener(function (details) {
    injectAll();
    // First install: the settings page is where one signs in; nothing is captured before that.
    if (details && details.reason === "install" && api.runtime.openOptionsPage) api.runtime.openOptionsPage();
  });
}
if (api.runtime.onStartup) api.runtime.onStartup.addListener(injectAll);

// The pause shortcut (manifest "commands"): quicker than opening the popup before typing something private.
function setPaused(v) { try { api.storage.local.set({ cg_paused: !!v }); } catch (e) {} }
if (api.commands && api.commands.onCommand) {
  // After the saved state is read, as the messages are: pressed while this worker slept, the shortcut found nobody
  // signed in and did nothing, so recording went on although the user had asked for the pause.
  api.commands.onCommand.addListener(function (cmd) {
    if (cmd !== "toggle-pause") return;
    restored.then(function () { if (conn()) setPaused(!paused); });
  });
}

// Settings changed on the options page or the popup: follow them without a reload.
if (api.storage.onChanged) {
  api.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    var who = connKey();
    if (changes.cg_study) loadStudy(changes.cg_study.newValue);
    if (changes.cg_account) loadAccount(changes.cg_account.newValue);
    if (changes.cg_paused) paused = changes.cg_paused.newValue === true;
    if (changes.cg_show_verdict) showVerdictPref = changes.cg_show_verdict.newValue !== false;
    if (changes.cg_debug) debugLog = changes.cg_debug.newValue === true;
    if (connKey() !== who) {
      // Another user (or nobody): the old lock and verdicts belonged to the previous one.
      resetUser();
      newBufferEpoch();
      if (state.locked) { state.locked = false; state.lockReason = null; state.lockPasted = false; broadcastAll({ type: "cg:unlock", bufferEpoch: bufferEpoch }); }
      broadcastAll({ type: "cg:reset", bufferEpoch: bufferEpoch });
      persistProgress(true);
    }
    if (changes.cg_study || changes.cg_account || changes.cg_paused || changes.cg_debug) broadcastConfig();
    refreshAllBadges();
  });
}

function statusObj(tabId) {
  var c = conn();
  return {
    connected: !!c, kind: c ? c.kind : null, gateway: c ? c.gateway : null,
    account: account ? { kind: account.kind, tenantName: account.tenantName, label: account.label, gateway: account.gateway, siteKey: account.siteKey, onboarding: account.onboarding } : null,
    study: studyInfo(), paused: paused, showVerdict: showVerdict(),
    offline: offline ? { since: offline.since, message: offline.message } : null,
    locked: state.locked, lockReason: state.lockReason, verdict: state.verdict, mouseVerdict: state.mouseVerdict,
    error: state.error, notEnrolled: state.notEnrolled, lastCheckAt: state.lastCheckAt, exclusions: config.exclusions,
    disabled: { keystroke: !!state.disabled.keystroke, mouse: !!state.disabled.mouse },
    unavailable: { keystroke: !!state.unavailable.keystroke, mouse: !!state.unavailable.mouse },
    look: look,
    signInExpired: !!(signInDead && account && !studyOn()),   // the settings offer "Sign in again"
    bars: tabId != null ? { keystroke: barState("keystroke", tabId).text, mouse: barState("mouse", tabId).text } : null,
    useSample: { recording: !!(useRec && useRec.until > Date.now()), last: lastUseSample },
  };
}

// ---- toolbar badge ----
var ICON_ON = { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
var ICON_OFF = { 16: "icons/icon-off16.png", 32: "icons/icon-off32.png", 48: "icons/icon-off48.png", 128: "icons/icon-off128.png" };
// ---- the two bars: typing (left) and mouse (right) ----
// Chrome gives an extension one badge, so with the live verdict shown the ICON itself becomes two bars. Each
// fills as the page collects evidence (typing: the packet + 1 windows, 21 by default, at least 250 keystrokes; mouse: 60 windows,
// about 17 s of movement), then turns green when the server says it's the user, red when suspicious.
// Progress is per tab (content.js "cg:progress"); verdicts are the user's (the last server reply).
var MOUSE_NEED = 60;
var COL_TRACK = "rgba(100,116,139,0.38)", COL_FILL = "#6366f1", COL_OK = "#16a34a", COL_BAD = "#dc2626";
var tabProgress = {};   // tabId -> { ks, mouse }
var iconDrawn = {};     // tabId -> key of the last image set, so an unchanged picture is not redrawn
if (api.tabs && api.tabs.onRemoved) api.tabs.onRemoved.addListener(function (tabId) { delete tabProgress[tabId]; delete iconDrawn[tabId]; });
// One bar's state: { frac 0..1, color, text } from the verdict if there is one, else the tab's progress.
function barState(channel, tabId) {
  var p = tabProgress[tabId] || { ks: 0, mouse: 0 };
  // Turned off by the organisation: nothing collected or checked, an empty bar.
  if (state.disabled[channel]) return { frac: 0, color: COL_TRACK, text: "off (organisation setting)" };
  if (channel === "keystroke") {
    var v = state.verdict;
    if (v && v.status === "genuine") return { frac: 1, color: COL_OK, text: "it's you (" + v.mean + "%)" };
    if (v && v.status === "suspicious") return { frac: 1, color: COL_BAD, text: "suspicious" };
    // The server's own count once it has answered (it windows the same way, but only it decides).
    var need = RECENT + 1;
    var n = v && v.status === "analyzing" ? Math.max(v.packet || 0, Math.min(p.ks, need - 1)) : Math.min(p.ks, need);
    return { frac: n / need, color: COL_FILL, text: Math.min(n, need) + "/" + need + " windows" };
  }
  var mv = state.mouseVerdict;
  if (mv && mv.status === "genuine") return { frac: 1, color: COL_OK, text: "it's you" };
  if (mv && mv.status === "suspicious") return { frac: 1, color: COL_BAD, text: "suspicious" };
  var m = Math.min(p.mouse, MOUSE_NEED);
  return { frac: m / MOUSE_NEED, color: COL_FILL, text: m + "/" + MOUSE_NEED + " windows" };
}
function barsImage(size, ks, ms) {
  var c = new OffscreenCanvas(size, size), g = c.getContext("2d");
  var pad = Math.max(1, Math.round(size * 0.06)), gap = Math.max(2, Math.round(size * 0.12));
  var w = Math.floor((size - 2 * pad - gap) / 2), h = size - 2 * pad, r = Math.max(1, Math.round(w * 0.3));
  [[ks, pad], [ms, size - pad - w]].forEach(function (b) {
    var bar = b[0], x = b[1];
    g.fillStyle = COL_TRACK; g.beginPath(); g.roundRect(x, pad, w, h, r); g.fill();
    // a sliver as soon as anything is collected, so "recording" is visible from the first window
    var fh = bar.frac > 0 ? Math.max(Math.round(h * 0.15), Math.round(h * bar.frac)) : 0;
    if (fh > 0) { g.fillStyle = bar.color; g.beginPath(); g.roundRect(x, pad + h - fh, w, fh, r); g.fill(); }
  });
  return g.getImageData(0, 0, size, size);
}
function drawBars(tabId) {
  var ks = barState("keystroke", tabId), ms = barState("mouse", tabId);
  var title = "Continuum Guard — typing: " + ks.text + " · mouse: " + ms.text;
  var key = [Math.round(ks.frac * 16), ks.color, Math.round(ms.frac * 16), ms.color].join("|");
  if (iconDrawn[tabId] !== key) {
    iconDrawn[tabId] = key;
    try { actionSafe(api.action.setIcon, { tabId: tabId, imageData: { 16: barsImage(16, ks, ms), 32: barsImage(32, ks, ms) } }); }
    catch (e) { iconDrawn[tabId] = null; actionSafe(api.action.setIcon, { tabId: tabId, path: ICON_ON }); }
  }
  actionSafe(api.action.setBadgeText, { tabId: tabId, text: "" });
  actionSafe(api.action.setTitle, { tabId: tabId, title: title });
}
function setLogo(tabId, path) { iconDrawn[tabId] = null; actionSafe(api.action.setIcon, { tabId: tabId, path: path }); }

// RECORDING ("•"): signed in and capturing, but no verdict yet (the mouse needs about 17 s of movement, typing
// about a paragraph). An empty badge here looked exactly like a broken extension. applyBadgeToTab blanks it on
// pages where no content script can run, so the dot also says "this page is being watched".
var RECORDING = { text: "•", color: "#4f46e5" };
function badgeForState() {
  if (!conn()) return { text: "", color: "#64748b" };
  if (state.locked) return { text: "🔒", color: "#dc2626" };
  if (paused) return { text: "II", color: "#64748b" };
  if (offline) return { text: "!", color: "#b45309" };
  if (!showVerdict()) return studyOn() ? { text: "REC", color: "#dc2626" } : RECORDING;
  var v = state.verdict, mv = state.mouseVerdict;
  if ((v && v.status === "suspicious") || (mv && mv.status === "suspicious")) return { text: "!", color: "#dc2626" };
  if (v && v.status === "genuine") return { text: v.mean + "%", color: "#16a34a" };
  if (mv && mv.status === "genuine") return { text: "✓", color: "#0891b2" };
  return RECORDING;
}
// Called WITHOUT a callback, the action.* APIs return a promise that rejects with "No tab with id" when a
// tab closed between being listed and being painted, an uncatchable "Uncaught (in promise)". A callback
// turns that into runtime.lastError, absorbed here.
function actionSafe(fn, arg) {
  if (typeof fn !== "function") return;
  try { fn.call(api.action, arg, function () { void api.runtime.lastError; }); } catch (e) {}
}
function applyBadgeToTab(tabId, url) {
  if (!api.action || tabId == null) return;
  var origin = "";
  try { if (url) origin = new URL(url).origin; } catch (e) {}
  var excluded = origin && config.exclusions.indexOf(origin) >= 0;
  if (!conn()) {
    actionSafe(api.action.setBadgeText, { tabId: tabId, text: "" });
    actionSafe(api.action.setTitle, { tabId: tabId, title: "Continuum Guard — sign in to start" });
    setLogo(tabId, ICON_OFF);
  } else if (excluded) {
    actionSafe(api.action.setBadgeText, { tabId: tabId, text: "off" });
    actionSafe(api.action.setBadgeBackgroundColor, { tabId: tabId, color: "#64748b" });
    actionSafe(api.action.setTitle, { tabId: tabId, title: "Continuum Guard — off on this site" });
    setLogo(tabId, ICON_OFF);
  } else {
    // No content script runs on Chrome's own pages, the extension's pages, the Web Store or the gateway's
    // pages (content.js onGatewayPage), so nothing is recorded there: no dot, no bars.
    var capturable = /^https?:/i.test(url || "") && origin !== gatewayOrigin()
      && !/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url || "");
    // The two bars whenever the live verdict is shown on a page that records; the lock, the pause and an unreachable
    // gateway keep the logo with their badge.
    if (capturable && showVerdict() && !state.locked && !paused && !offline) { drawBars(tabId); return; }
    var b = badgeForState(), title = "Continuum Guard";
    if (b === RECORDING) {
      if (capturable) title = "Continuum Guard — recording; the verdict comes after about 17 s of mouse movement or a paragraph of typing";
      else { b = { text: "", color: b.color }; title = "Continuum Guard — this page can't be recorded"; }
    }
    var away = !!offline && !state.locked && !paused;
    if (away) title = "Continuum Guard — can't reach Continuum: nothing is checked, this page is not protected";
    actionSafe(api.action.setBadgeText, { tabId: tabId, text: b.text });
    actionSafe(api.action.setBadgeBackgroundColor, { tabId: tabId, color: b.color });
    actionSafe(api.action.setTitle, { tabId: tabId, title: title });
    setLogo(tabId, away ? ICON_OFF : ICON_ON);
  }
}
function updateBadge() {
  if (!api.tabs) return;
  api.tabs.query({ active: true, currentWindow: true }, function (tabs) { if (tabs && tabs[0]) applyBadgeToTab(tabs[0].id, tabs[0].url); });
}
// Global changes (lock, sign-in) repaint EVERY tab: the unlock happens while the passkey window has focus.
function refreshAllBadges() {
  if (!api.tabs) return;
  api.tabs.query({}, function (tabs) { (tabs || []).forEach(function (t) { applyBadgeToTab(t.id, t.url); }); });
}
if (api.tabs && api.tabs.onActivated) {
  api.tabs.onActivated.addListener(function (info) {
    api.tabs.get(info.tabId, function (t) { if (!api.runtime.lastError && t) applyBadgeToTab(t.id, t.url); });
  });
}
if (api.tabs && api.tabs.onUpdated) {
  api.tabs.onUpdated.addListener(function (tabId, ch, t) { if (ch.url || ch.status === "complete") applyBadgeToTab(tabId, t && t.url); });
}

// ---- lock ----
function broadcastAll(msg) {
  if (!api.tabs) return;
  api.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (t) { try { api.tabs.sendMessage(t.id, msg, function () { void api.runtime.lastError; }); } catch (e) {} });
  });
}
function engageLock(reason, pasted) {
  stopUseRecording();   // no movement around a lock is ever a real-use sample
  state.locked = true;
  state.lockReason = reason || "keystroke";
  state.lockPasted = !!pasted;
  newBufferEpoch();   // nothing collected before this lock is checked after it, however the lock comes to an end
  broadcastAll({ type: "cg:lock", pasted: state.lockPasted, bufferEpoch: bufferEpoch });
  refreshAllBadges();
  persistProgress(true);
}
function releaseLock() {
  state.locked = false;
  state.lockReason = null;
  state.lockPasted = false;
  state.error = null;
  state.verdict = null;
  state.mouseVerdict = null;
  newBufferEpoch();
  broadcastAll({ type: "cg:unlock", bufferEpoch: bufferEpoch });
  broadcastAll({ type: "cg:reset", bufferEpoch: bufferEpoch });   // content scripts drop their buffers: fresh evidence after a step-up
  refreshAllBadges();
  persistProgress(true);
}
function broadcastConfig() {
  if (!api.tabs) return;
  api.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (t) {
      try {
        api.tabs.sendMessage(t.id, { type: "cg:config", capture: captureInfo(), exclusions: config.exclusions, gatewayOrigin: gatewayOrigin(), debug: debugLog, excludeTypes: excludeTypes, look: look, bufferEpoch: bufferEpoch },
          function () { void api.runtime.lastError; });
      } catch (e) {}
    });
  });
}

api.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg) return;
  if (restoreDone) return onMessage(msg, sender, reply);
  // Held until the saved state is read, so the channel must stay open for the answer. A message that gets none is
  // answered empty here: left open, its channel would wait (and keep this worker awake) until the reply was collected.
  restored.then(function () { if (onMessage(msg, sender, reply) !== true) { try { reply(); } catch (e) {} } });
  return true;
});
function onMessage(msg, sender, reply) {
  switch (msg.type) {
    case "cg:hello":
      reply({ capture: captureInfo(), excluded: config.exclusions.indexOf(msg.origin) >= 0, locked: state.locked, lockPasted: state.lockPasted, gatewayOrigin: gatewayOrigin(), debug: debugLog, excludeTypes: excludeTypes, look: look, bufferEpoch: bufferEpoch });
      return true;
    case "cg:check": {
      // From a content script: { channel, sessionId, clientTs, bufferEpoch, body, windowKeys }.
      var c = conn();
      if (!msg.body) { reply({ ok: false }); return true; }
      // Nobody signed in, the pause, or a lock: a page that still sends a check did not hear of it (it was not
      // listening when the others were told). It is told to ask for the state again (content.js recheck), so it stops
      // collecting, or shows the lock, in place of staying as it was until it is next hidden and shown.
      if (!c || paused || state.locked) { reply({ ok: false, paused: paused, resync: true }); return true; }
      // Collected before the last unlock, or for another user: refused, and the page starts again.
      if (bufferEpoch && msg.bufferEpoch !== bufferEpoch) { reply({ ok: false, stale: true, bufferEpoch: bufferEpoch }); return true; }
      var ch = msg.channel === "mouse" ? "mouse" : "keystroke";
      // Turned off by the organisation: nothing is sent; its settings are read again every 30 s while the
      // user is active, so switching the channel back on takes effect without waiting.
      if (state.disabled[ch]) { maybeRefreshOrgConfig(30000); reply({ ok: false, disabled: true }); return true; }
      var path = ch === "mouse" ? "/v1/sdk/mouse/check" : "/v1/sdk/keystroke/check";
      var body = msg.body;
      if (c.kind === "study") body = Object.assign({}, msg.body, { study: studyContext(msg.sessionId, msg.clientTs, ch === "mouse" ? { windowKeys: msg.windowKeys || [] } : null) });
      gw(path, body)
        .then(function (r) { onVerdict(ch, r, msg.sessionId); reply({ ok: true, status: r.status }); })
        .catch(function (e) { if (!offline && !(e && e.signInDead)) state.error = (e && e.message) || "gateway unreachable"; refreshAllBadges(); reply({ ok: false, error: state.error }); });
      return true;
    }
    case "cg:open-verify":
      // The button of a lock that was already lifted (its page did not hear the unlock): there is nothing to verify.
      // The page is told and drops its overlay, in place of a passkey request nobody needs.
      if (!state.locked) { reply({ locked: false, bufferEpoch: bufferEpoch }); return true; }
      openVerify();
      reply({ locked: true });
      return true;
    case "cg:verified":
      // The step-up passed on the gateway's page; the gateway already cleared the server lock.
      if (fromGatewayPage(sender, "/study.html") || fromGatewayPage(sender, "/connect.html")) {
        promptEvent("passed");
        openPrompt = null;
        probation = true;
        releaseLock();
        // A real-use sample offered: the page asks first, and closes on the answer (cg:use-consent).
        if (msg.useOffer && Number(msg.useOffer.expiresInMs) > 0 && fromGatewayPage(sender, "/connect.html")) {
          useOffer = { until: Date.now() + Number(msg.useOffer.expiresInMs) - 5000, tabId: sender.tab && sender.tab.id };
          persistUse();
        } else closeSenderTab(sender);
      }
      return;
    case "cg:use-consent":
      // The user's answer on the verify page. A yes starts fresh recording in every tab, if nothing changed meanwhile.
      if (!fromGatewayPage(sender, "/connect.html")) return;
      useRestored.then(function () {
        var offer = useOffer;
        useOffer = null;
        persistUse();
        closeSenderTab(sender);
        if (msg.consent === true && offer && offer.until > Date.now() && conn() && !paused && !state.locked && !state.disabled.mouse) startUseRecording(offer.until);
      });
      return;
    case "cg:use-sample":
      // From a content script: the first page to reach a sample's windows. Kept once, the others are told to stop.
      if (!sender || !sender.tab || !Array.isArray(msg.windows)) return;
      useRestored.then(function () {
        if (!useRec || msg.epoch !== useRec.epoch || !(useRec.until > Date.now()) || state.locked) return;
        stopUseRecording();
        sendUseSample(msg.windows);
      });
      return;
    case "cg:verify-failed":
      if (fromGatewayPage(sender, "/study.html") || fromGatewayPage(sender, "/connect.html")) promptEvent("failed");
      return;
    case "cg:enrolled":
      if (fromGatewayPage(sender, "/connect.html") || fromGatewayPage(sender, "/study.html")) { state.notEnrolled = null; refreshOnboarding(); }
      return;
    case "cg:link-code":
      if (!fromGatewayPage(sender, "/connect.html")) return;
      finishSignIn(msg, sender).catch(function (e) {
        var why = (e && e.message) || String(e);
        // The gateway refused this copy of the extension (its id is not allowed): said plainly, with the id (2026-11-25).
        if (why === "origin_not_allowed") why = "this Continuum server does not accept this copy of the extension (id " + api.runtime.id + "). Ask whoever runs it, or your organisation, to allow that id";
        state.error = "Sign-in failed: " + why;
        console.warn("[continuum-guard] " + state.error);
        // Its window would wait, then say to sign in again: closed, so the settings page or the lock overlay behind it says
        // what went wrong.
        closeSenderTab(sender);
        if (state.locked) broadcastAll({ type: "cg:sign-in-needed", message: state.error });
        refreshAllBadges();
      });
      return;
    // ---- from the options page and the popup ----
    case "cg:sign-in":
      startSignIn(msg.gateway, msg.siteKey).then(function () { reply({ ok: true }); }).catch(function (e) { reply({ ok: false, error: (e && e.message) || String(e) }); });
      return true;
    case "cg:sign-in-again":
      // The account's own server and organisation, from the lock overlay or the settings once its sign-in expired. Who
      // signs in is checked when it finishes: while locked, only the locked account (finishSignIn).
      if (!account || studyOn()) { reply({ ok: false, error: "not signed in" }); return true; }
      startSignIn(account.gateway, account.siteKey).then(function () { reply({ ok: true }); }).catch(function (e) { reply({ ok: false, error: (e && e.message) || String(e) }); });
      return true;
    case "cg:sign-out":
      // Locked: verify first. Signing out would otherwise be a way round the lock.
      if (state.locked) { reply({ ok: false, error: "locked" }); return true; }
      if (account) revoke(account);
      api.storage.local.remove("cg_account", function () { reply({ ok: true }); });
      return true;
    case "cg:open-enrol":
      // Never while locked (2026-11-25): the enrolment page asked for the passkey too, and the lock then asked again.
      if (state.locked) { reply({ ok: false, error: "locked" }); return true; }
      openEnrol();
      reply({ ok: true });
      return true;
    case "cg:status":
      maybeRefreshOrgConfig(5000);
      if (account && account.onboarding && account.onboarding.keystrokeTraining && !account.onboarding.keystroke) maybeRefreshOnboarding(8000);
      reply(statusObj(msg.tabId));
      return true;
    case "cg:progress":
      // From a content script: how far this page is toward a first verdict (the icon's two bars).
      if (sender && sender.tab && sender.tab.id != null) {
        tabProgress[sender.tab.id] = { ks: Number(msg.ks) || 0, mouse: Number(msg.mouse) || 0 };
        applyBadgeToTab(sender.tab.id, sender.tab.url);
      }
      return;
    case "cg:toggleExclude": {
      var i = config.exclusions.indexOf(msg.origin);
      if (i >= 0) config.exclusions.splice(i, 1);
      else if (msg.origin) config.exclusions.push(msg.origin);
      api.storage.local.set({ cg_exclusions: config.exclusions });
      broadcastConfig();
      refreshAllBadges();
      reply({ exclusions: config.exclusions });
      return true;
    }
  }
}
