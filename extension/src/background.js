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

// MV3: this worker is stopped after ~30 s idle and restarted from scratch, so everything that gates
// behaviour is persisted (the lock in cg_progress, the settings, the account) and read back at start.
var state = { locked: false, lockReason: null, verdict: null, mouseVerdict: null, error: null, notEnrolled: null, lastCheckAt: 0,
  disabled: {} };   // channel -> when the server last said the organisation turned it off
var session = null;     // { token, userId, key } from /v1/sdk/session; re-minted on a 401 or a change of user
var probation = false;  // after a step-up: re-challenge on any scored suspicious verdict (as the SDK)
var openPrompt = null;      // the open step-up: { channel, decisionId, sessionId, tabId } (study logging)

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
function captureInfo() { var c = conn(); return c ? { kind: c.kind, paused: paused } : null; }
// The signed-in organisation's settings (its console, or the operator's default): which channels are on,
// the "fields never watched" and the typing packet. The field types and the packet are kept in storage
// because the worker loses its variables when idle. The server enforces all of them anyway.
var excludeTypes = ["hidden"];
var orgConfigAt = 0;
function refreshOrgConfig() {
  if (!conn()) return;
  orgConfigAt = Date.now();
  gw("/v1/sdk/keystroke/config", null, "GET").then(function (r) {
    if (!r || r.status !== 200) return;
    // A channel switched back on is used again at once (it used to wait up to 10 minutes for a retry).
    ["keystroke", "mouse"].forEach(function (ch) {
      if (r.d[ch] === "off") { if (!state.disabled[ch]) state.disabled[ch] = Date.now(); }
      else if (r.d[ch] === "on") delete state.disabled[ch];
    });
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
  session = null; probation = false; openPrompt = null;
  state.verdict = null; state.mouseVerdict = null; state.error = null; state.notEnrolled = null;
}

// ---- talking to the gateway ----
async function sessionToken(force) {
  var c = conn();
  if (!c) throw new Error("not signed in");
  var key = connKey();
  if (session && session.key === key && !force) return session.token;
  var body = c.kind === "study" ? { siteKey: c.siteKey, externalId: "study:" + study.participant } : { siteKey: c.siteKey, refreshToken: account.refreshToken };
  var r = await fetch(c.gateway + "/v1/sdk/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok || !d.token) {
    // The refresh token was revoked or has expired, or the organisation was: sign in again.
    if (c.kind !== "study" && /refresh_token|tenant_revoked|invalid_site_key/.test(d.error || "")) state.error = "Your sign-in has expired. Sign in again in the settings.";
    throw new Error(d.error || ("session HTTP " + r.status));
  }
  session = { token: d.token, userId: d.userId, key: key };
  if (d.onboarding) setOnboarding(d.onboarding);
  return d.token;
}
async function gw(path, body, method) {
  var c = conn();
  if (!c) throw new Error("not signed in");
  for (var attempt = 0; attempt < 2; attempt++) {
    var token = await sessionToken(attempt > 0);
    var r = await fetch(c.gateway + path, { method: method || "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
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
  // The organisation turned this channel off (its console or the operator page): stop sending it.
  if (r && r.status === 409 && /_disabled$/.test(String(d.error || ""))) { state.disabled[channel] = Date.now(); refreshAllBadges(); return; }
  if (d.checked) delete state.disabled[channel];
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
  if (trigger && !state.locked) { challenge(channel, d.studyDecisionId || null, sessionId); return; }
  if (!d.warmup && !d.isSuspicious) probation = false;   // a clean verdict ends probation
  updateBadge();
  persistProgress();
}
function challenge(channel, decisionId, sessionId) {
  openPrompt = { channel: channel, decisionId: decisionId, sessionId: sessionId, tabId: null };
  engageLock(channel);
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
async function startSignIn(gateway, siteKey) {
  gateway = String(gateway || DEFAULT_GATEWAY).trim().replace(/\/+$/, "");
  siteKey = String(siteKey || "").trim();
  var verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  var challengeS256 = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await api.storage.session.set({ cg_link_pending: { gateway: gateway, siteKey: siteKey, verifier: verifier, at: Date.now() } });
  pendingGateway = gateway;
  openPage(gateway + "/connect.html?mode=link&k=" + encodeURIComponent(siteKey) + "&cc=" + challengeS256, true);
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
  if (account && account.refreshToken) revoke(account);   // signing in as someone else replaces the old sign-in
  resetUser();
  account = { gateway: p.gateway, siteKey: d.siteKey, kind: d.kind, tenantName: d.tenantName, label: d.label, userId: d.userId,
    refreshToken: d.refreshToken, onboarding: d.onboarding || null, linkedAt: new Date().toISOString() };
  await api.storage.local.set({ cg_account: account });
  if (!studyOn()) session = { token: d.token, userId: d.userId, key: connKey() };
  closeSenderTab(sender);
  broadcastConfig();
  refreshAllBadges();
  var ob = d.onboarding || {};
  if (!studyOn() && !(ob.passkey && ob.keystroke && ob.mouse)) openEnrol();   // nothing to score before enrolment
}
function revoke(acc) {
  try {
    fetch(acc.gateway + "/v1/link/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: acc.refreshToken }) })
      .catch(function () {});
  } catch (e) {}
}

// ---- restore at worker start ----
api.storage.local.get(["cg_exclusions", "cg_progress", "cg_debug", "cg_study", "cg_account", "cg_paused", "cg_show_verdict", "cg_study_paused", "cg_exclude_types", "cg_ks_packet"], function (d) {
  d = d || {};
  if (Array.isArray(d.cg_exclude_types)) excludeTypes = d.cg_exclude_types;
  if (Number(d.cg_ks_packet) > 0) RECENT = Number(d.cg_ks_packet);
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
    if (Date.now() - (p.at || 0) < 10 * 60 * 1000) { state.verdict = p.verdict || null; state.mouseVerdict = p.mouseVerdict || null; }
  }
  broadcastConfig();
  refreshAllBadges();
});
if (api.storage.session && api.storage.session.get) {
  api.storage.session.get("cg_link_pending", function (d) { var p = d && d.cg_link_pending; if (p) pendingGateway = p.gateway; });
}

// Snapshot the lock and the verdicts so they survive a worker restart. Throttled (at most one write per
// ~1.2 s); immediate for the lock itself.
var _persistTimer = null;
function progressSnapshot() {
  return { user: connKey(), verdict: state.verdict, mouseVerdict: state.mouseVerdict, locked: state.locked, lockReason: state.lockReason, at: Date.now() };
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
        api.scripting.executeScript({ target: { tabId: t.id }, files: ["src/features.js", "src/features-mouse.js", "src/content.js"] },
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
  api.commands.onCommand.addListener(function (cmd) { if (cmd === "toggle-pause" && conn()) setPaused(!paused); });
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
      if (state.locked) { state.locked = false; state.lockReason = null; broadcastAll({ type: "cg:unlock" }); }
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
    locked: state.locked, lockReason: state.lockReason, verdict: state.verdict, mouseVerdict: state.mouseVerdict,
    error: state.error, notEnrolled: state.notEnrolled, lastCheckAt: state.lastCheckAt, exclusions: config.exclusions,
    disabled: { keystroke: !!state.disabled.keystroke, mouse: !!state.disabled.mouse },
    bars: tabId != null ? { keystroke: barState("keystroke", tabId).text, mouse: barState("mouse", tabId).text } : null,
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
    // The two bars whenever the live verdict is shown on a page that records; the lock and the pause keep
    // the logo with their badge.
    if (capturable && showVerdict() && !state.locked && !paused) { drawBars(tabId); return; }
    var b = badgeForState(), title = "Continuum Guard";
    if (b === RECORDING) {
      if (capturable) title = "Continuum Guard — recording; the verdict comes after about 17 s of mouse movement or a paragraph of typing";
      else { b = { text: "", color: b.color }; title = "Continuum Guard — this page can't be recorded"; }
    }
    actionSafe(api.action.setBadgeText, { tabId: tabId, text: b.text });
    actionSafe(api.action.setBadgeBackgroundColor, { tabId: tabId, color: b.color });
    actionSafe(api.action.setTitle, { tabId: tabId, title: title });
    setLogo(tabId, ICON_ON);
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
function engageLock(reason) {
  state.locked = true;
  state.lockReason = reason || "keystroke";
  broadcastAll({ type: "cg:lock" });
  refreshAllBadges();
  persistProgress(true);
}
function releaseLock() {
  state.locked = false;
  state.lockReason = null;
  state.error = null;
  state.verdict = null;
  state.mouseVerdict = null;
  broadcastAll({ type: "cg:unlock" });
  broadcastAll({ type: "cg:reset" });   // content scripts drop their buffers: fresh evidence after a step-up
  refreshAllBadges();
  persistProgress(true);
}
function broadcastConfig() {
  if (!api.tabs) return;
  api.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (t) {
      try {
        api.tabs.sendMessage(t.id, { type: "cg:config", capture: captureInfo(), exclusions: config.exclusions, gatewayOrigin: gatewayOrigin(), debug: debugLog, excludeTypes: excludeTypes },
          function () { void api.runtime.lastError; });
      } catch (e) {}
    });
  });
}

api.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg) return;
  switch (msg.type) {
    case "cg:hello":
      reply({ capture: captureInfo(), excluded: config.exclusions.indexOf(msg.origin) >= 0, locked: state.locked, gatewayOrigin: gatewayOrigin(), debug: debugLog, excludeTypes: excludeTypes });
      return true;
    case "cg:check": {
      // From a content script: { channel, sessionId, clientTs, body, windowKeys }.
      var c = conn();
      if (!c || paused || state.locked || !msg.body) { reply({ ok: false, paused: paused }); return true; }
      var ch = msg.channel === "mouse" ? "mouse" : "keystroke";
      // Turned off by the organisation: nothing is sent; its settings are read again every 30 s while the
      // user is active, so switching the channel back on takes effect without waiting.
      if (state.disabled[ch]) { maybeRefreshOrgConfig(30000); reply({ ok: false, disabled: true }); return true; }
      var path = ch === "mouse" ? "/v1/sdk/mouse/check" : "/v1/sdk/keystroke/check";
      var body = msg.body;
      if (c.kind === "study") body = Object.assign({}, msg.body, { study: studyContext(msg.sessionId, msg.clientTs, ch === "mouse" ? { windowKeys: msg.windowKeys || [] } : null) });
      gw(path, body)
        .then(function (r) { onVerdict(ch, r, msg.sessionId); reply({ ok: true, status: r.status }); })
        .catch(function (e) { state.error = (e && e.message) || "gateway unreachable"; refreshAllBadges(); reply({ ok: false, error: state.error }); });
      return true;
    }
    case "cg:open-verify":
      openVerify();
      return;
    case "cg:verified":
      // The step-up passed on the gateway's page; the gateway already cleared the server lock.
      if (fromGatewayPage(sender, "/study.html") || fromGatewayPage(sender, "/connect.html")) {
        promptEvent("passed");
        openPrompt = null;
        probation = true;
        releaseLock();
        closeSenderTab(sender);
      }
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
        state.error = "Sign-in failed: " + ((e && e.message) || e);
        console.warn("[continuum-guard] " + state.error);
        refreshAllBadges();
      });
      return;
    // ---- from the options page and the popup ----
    case "cg:sign-in":
      startSignIn(msg.gateway, msg.siteKey).then(function () { reply({ ok: true }); }).catch(function (e) { reply({ ok: false, error: (e && e.message) || String(e) }); });
      return true;
    case "cg:sign-out":
      // Locked: verify first. Signing out would otherwise be a way round the lock.
      if (state.locked) { reply({ ok: false, error: "locked" }); return true; }
      if (account) revoke(account);
      api.storage.local.remove("cg_account", function () { reply({ ok: true }); });
      return true;
    case "cg:open-enrol":
      openEnrol();
      return;
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
});
