// popup.js — who is signed in, the live verdict of each channel (unless hidden: the research study
// never shows participants their scores), the pause, and the per-site exclusion. In the organisation's language
// and colours (the `look` in the worker's status: panelLanguage, panelTheme; "auto" = the browser's language, the
// device's mode); the Arabic is in ../lang-ar.js, English is written here.
var api = globalThis.browser || globalThis.chrome;
var curOrigin = "";
var curUrl = "";
var curTabId = null;
var curRestricted = false;   // page where Chrome forbids content scripts entirely
var look = { lang: "auto", theme: "auto" }, lookKey = "";
function q(id) { return document.getElementById(id); }
function show(id, visible) { q(id).style.display = visible ? "" : "none"; }
function lang() {
  if (look.lang === "en" || look.lang === "ar") return look.lang;
  var ui = ""; try { ui = api.i18n && api.i18n.getUILanguage ? api.i18n.getUILanguage() : navigator.language; } catch (e) {}
  return String(ui || "").toLowerCase().indexOf("ar") === 0 ? "ar" : "en";
}
// T("saved {when}", { when }) : the phrase in the popup's language, its {slots} filled
function T(s, vars) {
  var d = lang() === "ar" ? self.CG_AR : null, out = (d && d[s]) || s;
  return vars ? out.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] == null ? "" : String(vars[k]); }) : out;
}
// The language and colours changed (first status, or the organisation changed them): the document's lang, dir and
// theme, and the fixed texts (data-t holds the English).
function applyLook(l) {
  if (l && l.lang) look = l;
  var key = lang() + ":" + look.theme;
  if (key === lookKey) return;
  lookKey = key;
  var h = document.documentElement;
  h.lang = lang(); h.dir = lang() === "ar" ? "rtl" : "ltr";
  if (look.theme === "light" || look.theme === "dark") h.setAttribute("data-theme", look.theme); else h.removeAttribute("data-theme");
  var nodes = document.querySelectorAll("[data-t]");
  for (var i = 0; i < nodes.length; i++) nodes[i].textContent = T(nodes[i].getAttribute("data-t"));
}
applyLook(null);

// Chrome refuses to inject content scripts into its own pages (chrome://, the New Tab page, the Web
// Store, devtools, other extensions). Nothing is captured there, so say so instead of looking stuck.
function isRestrictedUrl(u) {
  if (!u) return true;
  if (/^(chrome|edge|brave|about|chrome-extension|moz-extension|devtools|view-source|file):/i.test(u)) return true;
  return /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(u);
}

api.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  curUrl = (tabs && tabs[0] && tabs[0].url) || "";
  curTabId = tabs && tabs[0] ? tabs[0].id : null;
  curRestricted = isRestrictedUrl(curUrl);
  try { curOrigin = new URL(curUrl).origin; } catch (e) { curOrigin = ""; }
  refresh();
});
setInterval(refresh, 1000);   // live verdicts while the popup is open

// Before a verdict, this page's progress (the icon's left bar): the organisation's packet + 1 windows
// decide (21 by default, at least 250 keystrokes).
function keysText(v, bar) {
  if (!v || v.status === "analyzing") return bar ? T("first verdict: {bar}", { bar: bar }) : (v ? T("first verdict: {packet}/{need} windows", { packet: v.packet, need: v.need }) : T("waiting for typing"));
  return T(v.status === "suspicious" ? "⚠ suspicious {mean}%" : "✓ genuine {mean}%", { mean: v.mean });
}
// Before a verdict, this page's progress (the icon's right bar): 60 windows decide, about 17 s of movement.
function mouseText(v, bar) {
  if (!v || v.status === "analyzing") return bar ? T("collecting {bar}", { bar: bar }) : (v ? T("warming up {buffer}/{max}", { buffer: v.buffer || 0, max: v.bufferMax || 60 }) : T("waiting for movement"));
  var low = v.low != null && v.bufferMax ? T(" · {low}/{max} low", { low: v.low, max: v.bufferMax }) : "";
  return T(v.status === "suspicious" ? "⚠ suspicious" : "✓ genuine") + low;
}
// True when every channel the organisation has on gets no verdict because its model cannot score (the worker's
// state.unavailable): the gateway answers, but nothing is checked.
function noneChecked(s) {
  var un = s.unavailable || {}, off = s.disabled || {};
  var on = ["keystroke", "mouse"].filter(function (c) { return !off[c]; });
  return on.length > 0 && on.every(function (c) { return !!un[c]; });
}

function refresh() {
  api.runtime.sendMessage({ type: "cg:status", tabId: curTabId }, function (s) {
    // Reading lastError marks the failure handled: while the worker sleeps or restarts, the next poll wakes it.
    if (api.runtime.lastError || !s) return;
    applyLook(s.look);
    show("setupCard", !s.connected);
    show("mainPanel", s.connected);
    if (!s.connected) { q("dot").className = "dot off"; return; }

    // Who: the study's participant, or the signed-in account.
    if (s.study) {
      q("acctLine").textContent = T("Continuum study · {p}", { p: s.study.participant })
        + (s.study.condition && s.study.condition.indexOf("impostor:") === 0 ? T(" · impostor session") : "")
        + (s.study.client === "lab" ? T(" · lab") : "");
    } else if (s.account) {
      q("acctLine").textContent = (s.account.label || T("Signed in")) + " · " + (s.account.kind === "personal" ? T("personal account") : s.account.tenantName);
    }
    var excluded = (s.exclusions || []).indexOf(curOrigin) >= 0;
    q("site").textContent = curRestricted ? T("{origin} (not monitorable)", { origin: curOrigin || T("browser page") })
      : curOrigin ? (excluded ? T("{origin} (excluded)", { origin: curOrigin }) : curOrigin) : "—";
    q("dot").className = "dot" + (s.paused || s.locked || s.offline || curRestricted || excluded ? " off" : "");

    // What is missing on the server before anything can be scored.
    var ob = (s.account && !s.study && s.account.onboarding) || null;
    // Typing enrolment done, its model being built on the server (about a minute): nothing is missing.
    var ksBuilding = !!(ob && ob.keystrokeTraining && !ob.keystroke);
    var incomplete = (ob && !(ob.passkey && (ob.keystroke || ksBuilding) && ob.mouse)) || (!!s.notEnrolled && !(s.notEnrolled === "keystroke" && ksBuilding));
    show("enrolBtn", incomplete);

    // The banner.
    var vd = q("verdict"), cls = "", txt;
    if (s.locked) { txt = T("🔒 Locked — verify with your passkey on the page ({why} didn't match)", { why: T(s.lockReason === "mouse" ? "mouse movement" : "typing rhythm") }); cls = "v-warn"; }
    else if (s.paused) { txt = T("⏸ Paused: nothing is recorded"); }
    // Never "Protected" while the server cannot be reached: nothing is collected or checked then.
    else if (s.offline) { txt = T("⚠ Can't reach Continuum: nothing is checked, this page is not protected"); cls = "v-warn"; }
    else if (curRestricted) {
      txt = T(/^chrome:\/\/(newtab|new-tab-page)/i.test(curUrl)
        ? "This is Chrome's New Tab page (not google.com): extensions can't run here."
        : "Chrome blocks extensions on this page. Open a normal website.");
    }
    else if (incomplete) { txt = T("Finish enrolment to start: {what}", { what: s.notEnrolled ? T("the server has no {ch} profile yet", { ch: T(s.notEnrolled) }) : T("passkey, typing and mouse") }); }
    else if (ksBuilding) { txt = T("⏳ Your typing model is being built (about a minute). Typing protection starts by itself."); }
    // Every channel that is on has a model that cannot score right now: never "Protected" then either.
    else if (noneChecked(s)) { txt = T("⚠ The checks are unavailable right now: nothing is checked"); cls = "v-warn"; }
    else if (!s.showVerdict) { txt = T(s.study ? "● Recording" : "✓ Protected"); cls = s.study ? "" : "v-ok"; }
    else {
      var v = s.verdict, mv = s.mouseVerdict;
      if ((v && v.status === "suspicious") || (mv && mv.status === "suspicious")) { txt = T("⚠ Suspicious — a step-up may follow"); cls = "v-warn"; }
      else if ((v && v.status === "genuine") || (mv && mv.status === "genuine")) { txt = T("✓ It's you"); cls = "v-ok"; }
      else { txt = T("Analyzing… type or move the mouse on any website"); }
    }
    if (s.study && !s.locked) q("verdict").style.color = s.paused ? "" : "#dc2626";
    else q("verdict").style.color = "";
    vd.textContent = txt;
    vd.className = cls;

    show("verdictCard", true);
    show("rowKeys", s.showVerdict);
    show("rowMouse", s.showVerdict);
    if (s.showVerdict) {
      var bars = s.bars || {}, off = s.disabled || {}, un = s.unavailable || {};
      q("keys").textContent = off.keystroke ? T("off (organisation setting)") : s.offline ? T("not checked (server unreachable)") : un.keystroke ? T("not checked (model unavailable)") : ksBuilding ? T("building your model…") : keysText(s.verdict, bars.keystroke);
      q("mouse").textContent = off.mouse ? T("off (organisation setting)") : s.offline ? T("not checked (server unreachable)") : un.mouse ? T("not checked (model unavailable)") : mouseText(s.mouseVerdict, bars.mouse);
    }

    // Learning from real use, stage 1: a sample being recorded after a passkey, or how the last one went.
    var us = s.useSample || {}, lastUse = us.last;
    show("rowUse", !!(us.recording || lastUse));
    if (us.recording) q("useSample").textContent = T("recording… keep browsing as usual");
    else if (lastUse) {
      var when = new Date(lastUse.at).toLocaleString(lang() === "ar" ? "ar-SY-u-nu-latn" : undefined);
      q("useSample").textContent = lastUse.ok ? T("saved {when}", { when: when }) : T("not saved ({why}) {when}", { why: lastUse.error, when: when });
    }

    q("pauseBtn").textContent = T(s.paused ? "Resume recording" : "Pause recording");
    q("pauseBtn").style.background = s.paused ? "#16a34a" : "#dc2626";
    show("errLine", !!s.error);
    if (s.error) q("errLine").textContent = s.offline ? T("Can't reach Continuum at {gw} ({why}): nothing is checked", { gw: s.gateway, why: s.offline.message }) : s.error;
    q("exclude").textContent = T(excluded ? "Include this site" : "Exclude this site");
  });
}

q("pauseBtn").addEventListener("click", function () {
  api.storage.local.get(["cg_paused"], function (d) { api.storage.local.set({ cg_paused: !(d && d.cg_paused === true) }, refresh); });
});
q("exclude").addEventListener("click", function () {
  if (!curOrigin) return;
  api.runtime.sendMessage({ type: "cg:toggleExclude", origin: curOrigin }, refresh);
});
q("enrolBtn").addEventListener("click", function () { api.runtime.sendMessage({ type: "cg:open-enrol" }, function () { void api.runtime.lastError; }); });
function openSettings() {
  if (api.runtime.openOptionsPage) api.runtime.openOptionsPage();
  else api.tabs.create({ url: api.runtime.getURL("src/options.html") });
}
q("openSettings").addEventListener("click", openSettings);
q("setupBtn").addEventListener("click", openSettings);
