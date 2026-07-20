// popup.js — reads status from the background worker and drives the on/off + per-site
// exclusion controls.
var api = globalThis.browser || globalThis.chrome;
var curOrigin = "";
function q(id) { return document.getElementById(id); }

api.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  try { curOrigin = new URL(tabs[0].url).origin; } catch (e) { curOrigin = ""; }
  refresh();
});
// Poll so the model-ready state and live verdict update while the popup is open.
setInterval(refresh, 1000);

function refresh() {
  api.runtime.sendMessage({ type: "cg:status" }, function (s) {
    if (!s) return;
    var excluded = (s.exclusions || []).indexOf(curOrigin) >= 0;
    q("state").textContent = s.enabled ? "monitoring" : "off — train first";
    q("dot").className = "dot" + (s.enabled ? "" : " off");
    q("wins").textContent = s.totalWindows;
    var st = s.steps || 0, nd = s.needSteps || 50;
    q("steps").textContent = st >= nd ? "ready ✓" : st + "/" + nd;
    q("profile").textContent = s.modelPersonal ? "personalized ✓" : (s.enrolled ? "training…" : "not trained yet");
    var mv = s.mouseVerdict;
    q("mouse").textContent = !s.mouseReady ? "not trained"
      : !mv ? "watching…"
      : mv.status === "analyzing" ? "analyzing (" + mv.packet + "/" + mv.need + ")"
      : mv.status === "suspicious" ? "⚠ " + mv.mean + "%"
      : "✓ " + mv.mean + "%";
    q("model").textContent = s.modelReady ? ("ready — " + (s.modelPersonal ? "personal" : "base")) : (s.modelError ? "error" : "loading…");
    q("site").textContent = curOrigin ? (excluded ? curOrigin + " (excluded)" : curOrigin) : "—";

    // Verdict banner
    var vd = q("verdict"), v = s.verdict;
    if (!s.enabled) { vd.textContent = "🎓 Train your profile below to start monitoring"; vd.style.background = "var(--card)"; vd.style.borderColor = "var(--card-border)"; }
    else if (!s.modelReady) { vd.textContent = s.modelError ? ("⚠ model error: " + s.modelError) : "⏳ loading model…"; vd.style.background = "var(--card)"; vd.style.borderColor = "var(--card-border)"; }
    else if (s.locked) { vd.textContent = "🔒 locked — passkey verification required"; vd.style.background = "rgba(239,68,68,.18)"; vd.style.borderColor = "rgba(239,68,68,.45)"; }
    else if (!v) { vd.textContent = "idle — type on any web page to begin"; vd.style.background = "var(--card)"; vd.style.borderColor = "var(--card-border)"; }
    else if (v.status === "analyzing") { vd.textContent = "analyzing your typing… (" + v.packet + "/" + v.need + ")"; vd.style.background = "var(--card)"; vd.style.borderColor = "var(--card-border)"; }
    else if (v.status === "suspicious") { vd.textContent = "⚠ suspicious — " + v.mean + "%"; vd.style.background = "rgba(239,68,68,.18)"; vd.style.borderColor = "rgba(239,68,68,.45)"; }
    else { vd.textContent = "✓ verified — " + v.mean + "%"; vd.style.background = "rgba(22,163,74,.18)"; vd.style.borderColor = "rgba(22,163,74,.45)"; }
    q("exclude").textContent = excluded ? "Include this site" : "Exclude this site";
  });
}

q("exclude").addEventListener("click", function () {
  if (!curOrigin) return;
  api.runtime.sendMessage({ type: "cg:toggleExclude", origin: curOrigin }, refresh);
});

q("enroll").addEventListener("click", function () {
  api.tabs.create({ url: api.runtime.getURL("src/enroll.html") });
});
