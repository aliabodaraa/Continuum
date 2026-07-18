// popup.js — reads status from the background worker and drives the on/off + per-site
// exclusion controls.
var api = globalThis.browser || globalThis.chrome;
var curOrigin = "";
function q(id) { return document.getElementById(id); }

api.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  try { curOrigin = new URL(tabs[0].url).origin; } catch (e) { curOrigin = ""; }
  refresh();
});

function refresh() {
  api.runtime.sendMessage({ type: "cg:status" }, function (s) {
    if (!s) return;
    var excluded = (s.exclusions || []).indexOf(curOrigin) >= 0;
    q("state").textContent = s.enabled ? "on" : "off";
    q("dot").className = "dot" + (s.enabled ? "" : " off");
    q("wins").textContent = s.totalWindows;
    q("site").textContent = curOrigin ? (excluded ? curOrigin + " (excluded)" : curOrigin) : "—";
    q("toggle").textContent = s.enabled ? "Turn off" : "Turn on";
    q("toggle").className = s.enabled ? "" : "off";
    q("exclude").textContent = excluded ? "Include this site" : "Exclude this site";
  });
}

q("toggle").addEventListener("click", function () {
  api.runtime.sendMessage({ type: "cg:status" }, function (s) {
    api.runtime.sendMessage({ type: "cg:setEnabled", value: !(s && s.enabled) }, refresh);
  });
});

q("exclude").addEventListener("click", function () {
  if (!curOrigin) return;
  api.runtime.sendMessage({ type: "cg:toggleExclude", origin: curOrigin }, refresh);
});
