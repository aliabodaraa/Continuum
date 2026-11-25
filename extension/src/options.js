// options.js — the settings page: where one signs in (a personal Continuum account, or an organisation's
// account), the display switches, and the experimenter's research-study settings. Signing in itself runs
// in the service worker (background.js, "signing in") and on the gateway's /connect.html.
var api = globalThis.browser || globalThis.chrome;
var DEFAULT_GATEWAY = "http://localhost:8080";
var PERSONAL_KEY = "pk_personal";   // the gateway's built-in tenant for people with no organisation
function $(id) { return document.getElementById(id); }
function msg(id, text, ok) { $(id).textContent = text || ""; $(id).className = "msg " + (ok ? "ok" : "bad"); }

$("extId").textContent = api.runtime.id;

// ---- account ----
var ERRORS = {
  locked: "This browser is locked. Verify with your passkey on the locked page first.",
};
var lastAcc = null, lastStatus = null;   // the stored account, the worker's last status
function renderAccount(acc) {
  lastAcc = acc || null;
  $("signedIn").classList.toggle("hidden", !acc);
  $("signedOut").classList.toggle("hidden", !!acc);
  if (!acc) return;
  var personal = acc.kind === "personal";
  $("whoTitle").textContent = "Signed in as " + (acc.label || "user " + acc.userId);
  $("whoLine").textContent = (personal ? "Personal Continuum account" : "Organisation: " + (acc.tenantName || acc.siteKey)) + " · " + acc.gateway;
  var ob = acc.onboarding || {};
  var parts = [["Passkey", ob.passkey], ["Typing", ob.keystroke], ["Mouse", ob.mouse]].map(function (p) { return p[0] + (p[1] ? " ✓" : " —"); });
  $("enrolLine").textContent = "Enrolled: " + parts.join(" · ");
  renderEnrol();
}
// Only when something the organisation has on is missing, and never while locked or with the server away (2026-11-25): the
// enrolment page skips a channel that is off, asked for the passkey a second time while locked, and cannot load then.
function renderEnrol() {
  var ob = (lastAcc && lastAcc.onboarding) || {}, s = lastStatus || {}, off = s.disabled || {};
  var missing = !ob.passkey || (!off.keystroke && !ob.keystroke && !ob.keystrokeTraining) || (!off.mouse && !ob.mouse);
  $("enrolBtn").classList.toggle("hidden", !lastAcc || !missing || !!s.locked || !!s.offline);
}
api.storage.local.get(["cg_account", "cg_gateway"], function (d) {
  renderAccount(d && d.cg_account);
  $("gateway").value = (d && d.cg_gateway) || DEFAULT_GATEWAY;
});
api.storage.onChanged.addListener(function (changes, area) {
  if (area === "local" && changes.cg_account) { renderAccount(changes.cg_account.newValue); msg("signInMsg", ""); msg("accountMsg", ""); }
  if (area === "local" && changes.cg_study) studyRules(changes.cg_study.newValue);
});
// Errors the worker reports (a failed sign-in, an unreachable server), and what the account's buttons can do now.
function poll() {
  api.runtime.sendMessage({ type: "cg:status" }, function (s) {
    if (api.runtime.lastError || !s) return;
    if (s.error && /^Sign-in failed/.test(s.error)) msg(lastAcc ? "accountMsg" : "signInMsg", s.error);
    lastStatus = s;
    renderEnrol();
    // Locked: signing out is refused (it would be a way round the lock), so the button is off and says why (2026-11-25).
    $("signOutBtn").disabled = !!s.locked;
    $("lockNote").textContent = s.locked ? ERRORS.locked : "";
    // The sign-in itself expired: signing in again keeps the account, and its lock if there is one (2026-11-25).
    $("reSignInBtn").classList.toggle("hidden", !s.signInExpired);
  });
}
poll();
setInterval(poll, 2000);

function gatewayValue() { return $("gateway").value.trim().replace(/\/+$/, "") || DEFAULT_GATEWAY; }
function signIn(siteKey) {
  var g = gatewayValue();
  api.storage.local.set({ cg_gateway: g });
  msg("signInMsg", "A sign-in window opened. Finish there.", true);
  api.runtime.sendMessage({ type: "cg:sign-in", gateway: g, siteKey: siteKey }, function (r) {
    if (api.runtime.lastError) return msg("signInMsg", "The extension did not answer. Reload it and try again.");
    if (r && !r.ok) msg("signInMsg", "Could not start: " + r.error);
  });
}
$("personalBtn").addEventListener("click", function () { signIn(PERSONAL_KEY); });
$("orgBtn").addEventListener("click", function () {
  var k = $("orgKey").value.trim();
  if (!/^pk_[A-Za-z0-9_]+$/.test(k)) return msg("signInMsg", "Enter the organisation code you were given (it starts with pk_).");
  signIn(k);
});
$("enrolBtn").addEventListener("click", function () { api.runtime.sendMessage({ type: "cg:open-enrol" }, function () { void api.runtime.lastError; }); });
$("reSignInBtn").addEventListener("click", function () {
  msg("accountMsg", "A sign-in window opened. Finish there.", true);
  api.runtime.sendMessage({ type: "cg:sign-in-again" }, function (r) {
    if (api.runtime.lastError) return msg("accountMsg", "The extension did not answer. Reload it and try again.");
    if (r && !r.ok) msg("accountMsg", "Could not start: " + r.error);
  });
});
$("signOutBtn").addEventListener("click", function () {
  api.runtime.sendMessage({ type: "cg:sign-out" }, function (r) {
    if (api.runtime.lastError) return;
    if (r && !r.ok) msg("accountMsg", ERRORS[r.error] || r.error);
  });
});

// Reachability check, before signing in: an unreachable server is the usual reason sign-in "does nothing".
$("test").addEventListener("click", function () {
  var base = gatewayValue();
  msg("probe", "Checking " + base + " …", true);
  var settled = false;
  function done(ok, text) { if (settled) return; settled = true; msg("probe", (ok ? "✓ " : "✗ ") + text, ok); }
  setTimeout(function () { done(false, "No response within 3 s — is the Continuum server running?"); }, 3000);
  fetch(base + "/health", { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) return done(false, "Responded HTTP " + r.status);
      return r.json().then(function (j) {
        if (j.service !== "gateway") return done(false, "That is not a Continuum gateway (" + (j.service || "?") + ")");
        return publicAddress(base).then(function (pub) { done(!pub, pub ? "Reachable, but this server's own address is " + pub + ". Use that one: sign-in is refused at any other." : "Reachable"); });
      });
    })
    .catch(function (e) { done(false, "Unreachable: " + ((e && e.message) || "connection refused")); });
});
// The gateway's own address (publicUrl, from its console's config) when it is not the one typed here: its sign-in page
// refuses any other address at the first step, without naming the right one (2026-11-25). "" when they agree or it is unknown.
function publicAddress(base) {
  return fetch(base + "/v1/console/config", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (c) { var u = c && c.publicUrl; return u && new URL(u).origin !== new URL(base).origin ? String(u).replace(/\/+$/, "") : ""; })
    .catch(function () { return ""; });
}

// ---- display ----
api.storage.local.get(["cg_show_verdict", "cg_debug"], function (d) {
  $("showVerdict").checked = !(d && d.cg_show_verdict === false);
  $("debug").checked = !!(d && d.cg_debug);
});
$("showVerdict").addEventListener("change", function () { api.storage.local.set({ cg_show_verdict: $("showVerdict").checked }); });
$("debug").addEventListener("change", function () { api.storage.local.set({ cg_debug: $("debug").checked }); });   // the worker watches storage

// ---- research study (background.js; extension/STUDY_MODE.md) ----
var PSEUDONYM = /^[A-Za-z0-9_-]{1,32}$/;
var sOn = $("studyOn"), sGw = $("studyGateway"), sKey = $("studyKey"), sP = $("studyParticipant"), sCond = $("studyCondition"),
    sImp = $("studyImpostor"), sClient = $("studyClient"), sShow = $("studyShow");
sCond.addEventListener("change", function () { sImp.style.display = sCond.value === "impostor" ? "block" : "none"; });
api.storage.local.get(["cg_study"], function (d) {
  var v = (d && d.cg_study) || {};
  sOn.checked = v.on === true; sGw.value = v.gateway || DEFAULT_GATEWAY; sKey.value = v.siteKey || ""; sP.value = v.participant || "";
  var imp = String(v.condition || "genuine").indexOf("impostor:") === 0;
  sCond.value = imp ? "impostor" : "genuine"; sImp.value = imp ? v.condition.slice(9) : ""; sImp.style.display = imp ? "block" : "none";
  sClient.value = v.client === "lab" ? "lab" : "extension-study";
  sShow.checked = v.showVerdict === true;
  if (v.on) $("studyBox").open = true;
  studyRules(v);
});
// While study mode is on its own "Show verdicts while testing" decides (background.js showVerdict), so the display switch
// above changed nothing then (2026-11-25).
function studyRules(v) {
  var on = !!(v && v.on === true && v.gateway && v.siteKey && v.participant);
  $("showVerdict").disabled = on;
  $("verdictNote").classList.toggle("hidden", !on);
}
$("studySave").addEventListener("click", function () {
  var p = sP.value.trim(), imp = sImp.value.trim();
  if (sOn.checked && (!PSEUDONYM.test(p) || !sKey.value.trim() || !sGw.value.trim())) return msg("studyMsg", "Gateway, site key and a pseudonym (letters, digits, - or _) are required.");
  if (sCond.value === "impostor" && (!PSEUDONYM.test(imp) || imp === p)) return msg("studyMsg", "An impostor session needs the pseudonym of the person typing, different from the account's.");
  var v = { on: sOn.checked, gateway: sGw.value.trim().replace(/\/+$/, ""), siteKey: sKey.value.trim(), participant: p,
            condition: sCond.value === "impostor" ? "impostor:" + imp : "genuine", client: sClient.value === "lab" ? "lab" : "extension-study",
            showVerdict: sShow.checked };
  api.storage.local.set({ cg_study: v }, function () { msg("studyMsg", v.on ? "Saved. Study mode is ON for " + p + " (" + v.condition + ")." : "Saved. Study mode is off.", true); });
});
$("studyEnrol").addEventListener("click", function () {
  // The participant saved here (2026-11-25): with study mode off, or another pseudonym typed but not saved, this opened the
  // enrolment of whoever was signed in above, or of the participant saved before.
  api.storage.local.get(["cg_study"], function (d) {
    var v = (d && d.cg_study) || {};
    if (!(v.on === true && v.gateway && v.siteKey && v.participant) || v.participant !== sP.value.trim()) {
      return msg("studyMsg", "Save these settings with study mode on first: the page enrols the participant saved here.");
    }
    api.runtime.sendMessage({ type: "cg:open-enrol" }, function (r) {
      if (api.runtime.lastError) return;
      if (r && r.error === "locked") msg("studyMsg", ERRORS.locked);
    });
  });
});
