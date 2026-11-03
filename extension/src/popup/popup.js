// popup.js — who is signed in, the live verdict of each channel (unless hidden: the research study
// never shows participants their scores), the pause, and the per-site exclusion.
var api = globalThis.browser || globalThis.chrome;
var curOrigin = "";
var curUrl = "";
var curTabId = null;
var curRestricted = false;   // page where Chrome forbids content scripts entirely
function q(id) { return document.getElementById(id); }
function show(id, visible) { q(id).style.display = visible ? "" : "none"; }

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
  if (!v || v.status === "analyzing") return bar ? "first verdict: " + bar : (v ? "first verdict: " + v.packet + "/" + v.need + " windows" : "waiting for typing");
  return (v.status === "suspicious" ? "⚠ suspicious " : "✓ genuine ") + v.mean + "%";
}
// Before a verdict, this page's progress (the icon's right bar): 60 windows decide, about 17 s of movement.
function mouseText(v, bar) {
  if (!v || v.status === "analyzing") return bar ? "collecting " + bar : (v ? "warming up " + (v.buffer || 0) + "/" + (v.bufferMax || 60) : "waiting for movement");
  var low = v.low != null && v.bufferMax ? " · " + v.low + "/" + v.bufferMax + " low" : "";
  return (v.status === "suspicious" ? "⚠ suspicious" : "✓ genuine") + low;
}

function refresh() {
  api.runtime.sendMessage({ type: "cg:status", tabId: curTabId }, function (s) {
    // Reading lastError marks the failure handled: while the worker sleeps or restarts, the next poll wakes it.
    if (api.runtime.lastError || !s) return;
    show("setupCard", !s.connected);
    show("mainPanel", s.connected);
    if (!s.connected) { q("dot").className = "dot off"; return; }

    // Who: the study's participant, or the signed-in account.
    if (s.study) {
      q("acctLine").textContent = "Continuum study · " + s.study.participant
        + (s.study.condition && s.study.condition.indexOf("impostor:") === 0 ? " · impostor session" : "")
        + (s.study.client === "lab" ? " · lab" : "");
    } else if (s.account) {
      q("acctLine").textContent = (s.account.label || "Signed in") + " · " + (s.account.kind === "personal" ? "personal account" : s.account.tenantName);
    }
    var excluded = (s.exclusions || []).indexOf(curOrigin) >= 0;
    q("site").textContent = curRestricted ? (curOrigin || "browser page") + " (not monitorable)"
      : curOrigin ? (excluded ? curOrigin + " (excluded)" : curOrigin) : "—";
    q("dot").className = "dot" + (s.paused || s.locked || s.offline || curRestricted || excluded ? " off" : "");

    // What is missing on the server before anything can be scored.
    var ob = (s.account && !s.study && s.account.onboarding) || null;
    // Typing enrolment done, its model being built on the server (about a minute): nothing is missing.
    var ksBuilding = !!(ob && ob.keystrokeTraining && !ob.keystroke);
    var incomplete = (ob && !(ob.passkey && (ob.keystroke || ksBuilding) && ob.mouse)) || (!!s.notEnrolled && !(s.notEnrolled === "keystroke" && ksBuilding));
    show("enrolBtn", incomplete);

    // The banner.
    var vd = q("verdict"), cls = "", txt;
    if (s.locked) { txt = "🔒 Locked — verify with your passkey on the page (" + (s.lockReason === "mouse" ? "mouse movement" : "typing rhythm") + " didn't match)"; cls = "v-warn"; }
    else if (s.paused) { txt = "⏸ Paused: nothing is recorded"; }
    // Never "Protected" while the server cannot be reached: nothing is collected or checked then.
    else if (s.offline) { txt = "⚠ Can't reach Continuum: nothing is checked, this page is not protected"; cls = "v-warn"; }
    else if (curRestricted) {
      txt = /^chrome:\/\/(newtab|new-tab-page)/i.test(curUrl)
        ? "This is Chrome's New Tab page (not google.com): extensions can't run here."
        : "Chrome blocks extensions on this page. Open a normal website.";
    }
    else if (incomplete) { txt = "Finish enrolment to start: " + (s.notEnrolled ? "the server has no " + s.notEnrolled + " profile yet" : "passkey, typing and mouse"); }
    else if (ksBuilding) { txt = "⏳ Your typing model is being built (about a minute). Typing protection starts by itself."; }
    else if (!s.showVerdict) { txt = s.study ? "● Recording" : "✓ Protected"; cls = s.study ? "" : "v-ok"; }
    else {
      var v = s.verdict, mv = s.mouseVerdict;
      if ((v && v.status === "suspicious") || (mv && mv.status === "suspicious")) { txt = "⚠ Suspicious — a step-up may follow"; cls = "v-warn"; }
      else if ((v && v.status === "genuine") || (mv && mv.status === "genuine")) { txt = "✓ It's you"; cls = "v-ok"; }
      else { txt = "Analyzing… type or move the mouse on any website"; }
    }
    if (s.study && !s.locked) q("verdict").style.color = s.paused ? "" : "#dc2626";
    else q("verdict").style.color = "";
    vd.textContent = txt;
    vd.className = cls;

    show("verdictCard", true);
    show("rowKeys", s.showVerdict);
    show("rowMouse", s.showVerdict);
    if (s.showVerdict) {
      var bars = s.bars || {}, off = s.disabled || {};
      q("keys").textContent = off.keystroke ? "off (organisation setting)" : s.offline ? "not checked (server unreachable)" : ksBuilding ? "building your model…" : keysText(s.verdict, bars.keystroke);
      q("mouse").textContent = off.mouse ? "off (organisation setting)" : s.offline ? "not checked (server unreachable)" : mouseText(s.mouseVerdict, bars.mouse);
    }

    // Learning from real use, stage 1: a sample being recorded after a passkey, or how the last one went.
    var us = s.useSample || {}, lastUse = us.last;
    show("rowUse", !!(us.recording || lastUse));
    if (us.recording) q("useSample").textContent = "recording… keep browsing as usual";
    else if (lastUse) q("useSample").textContent = (lastUse.ok ? "saved " : "not saved (" + lastUse.error + ") ") + new Date(lastUse.at).toLocaleString();

    q("pauseBtn").textContent = s.paused ? "Resume recording" : "Pause recording";
    q("pauseBtn").style.background = s.paused ? "#16a34a" : "#dc2626";
    show("errLine", !!s.error);
    if (s.error) q("errLine").textContent = s.error;
    q("exclude").textContent = excluded ? "Include this site" : "Exclude this site";
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
