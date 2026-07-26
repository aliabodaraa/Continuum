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

function show(id, visible) { q(id).style.display = visible ? "" : "none"; }

function refresh() {
  api.runtime.sendMessage({ type: "cg:status" }, function (s) {
    if (!s) return;
    // No Chrome/Google account signed in → the whole panel is inert (samples/models are
    // keyed to that account, so there is nothing to show or train against).
    var noAccount = s.accountChecked && !s.accountId;
    show("noAccount", noAccount);
    q("mainPanel").style.display = noAccount ? "none" : "";
    if (noAccount) { q("dot").className = "dot off"; return; }
    show("acctLine", !!s.accountEmail);
    if (s.accountEmail) q("acctLine").textContent = s.accountEmail;

    var excluded = (s.exclusions || []).indexOf(curOrigin) >= 0;
    var ksOn = !!s.modelPersonal;       // keystroke personal model trained
    var mouseOn = !!s.mouseReady;       // mouse personal model trained
    var trained = ksOn || mouseOn;      // at least one modality has a personal model
    // "live" = trained AND the on-device model is actually loaded in the offscreen doc.
    // The service worker sleeps when idle and reloads on the next event; until its model
    // is confirmed ready we say "starting…", never a false "monitoring".
    var live = trained && !!s.modelReady && !s.modelError;
    var active = trained;               // rows/verdict still keyed to what's trained

    q("state").textContent = !trained ? "off — train below"
      : s.modelError ? "error — reopen to retry"
      : live ? "monitoring" : "starting…";
    q("dot").className = "dot" + (live ? "" : " off");

    // Per-modality rows: only show a modality's rows once THAT modality is trained.
    show("rowModel", ksOn);
    show("rowSteps", ksOn);
    show("rowWins", ksOn);
    show("rowMouse", mouseOn);
    show("rowSamples", trained);

    if (trained) {
      var sampleParts = [];
      if (ksOn) sampleParts.push((s.keySamples || 0) + " typing");
      if (mouseOn) sampleParts.push((s.mouseSamples || 0) + " mouse");
      q("samples").textContent = sampleParts.join(" + ") + " window" + ((s.keySamples || 0) + (s.mouseSamples || 0) === 1 ? "" : "s");
    }

    if (ksOn) {
      q("model").textContent = s.modelReady ? "ready — personal" : (s.modelError ? "error" : "loading…");
      q("wins").textContent = s.totalWindows;
      var st = s.steps || 0, nd = s.needSteps || 50;
      q("steps").textContent = st >= nd ? "ready ✓" : st + "/" + nd;
    }
    if (mouseOn) {
      var mv = s.mouseVerdict;
      q("mouse").textContent = !mv ? "watching…"
        : mv.status === "analyzing" ? "analyzing (" + mv.packet + "/" + mv.need + ")"
        : mv.status === "suspicious" ? "⚠ " + mv.mean + "%"
        : "✓ " + mv.mean + "%";
    }

    q("profile").textContent = active
      ? [ksOn ? "typing ✓" : null, mouseOn ? "mouse ✓" : null].filter(Boolean).join(" · ")
      : (s.enrolled ? "training…" : "not trained yet");
    q("site").textContent = curOrigin ? (excluded ? curOrigin + " (excluded)" : curOrigin) : "—";

    // Verdict banner — theme-aware colouring via CSS classes (v-ok / v-warn / neutral).
    var vd = q("verdict"), v = s.verdict, cls = "", txt;
    if (!active) { txt = "⚙️ Set up your profile below to start monitoring"; }
    else if (!s.modelReady) { txt = s.modelError ? ("⚠ model error: " + s.modelError) : "⏳ loading model…"; }
    else if (s.locked) { txt = "🔒 Locked — passkey required (keystroke score " + (v ? v.mean + "%" : "?") + ")"; cls = "v-warn"; }
    else if (ksOn) {   // keystroke is the enforcing channel — it drives the banner when trained
      if (!v) { txt = "Idle — type on any web page to begin"; }
      else if (v.status === "analyzing") { txt = "Analyzing your typing… (" + v.packet + "/" + v.need + ")"; }
      else if (v.status === "suspicious") { txt = "⚠ Suspicious — " + v.mean + "%"; cls = "v-warn"; }
      else { txt = "✓ Verified — " + v.mean + "%"; cls = "v-ok"; }
    } else {   // mouse trained only (info-only channel, no lock)
      var mv2 = s.mouseVerdict;
      txt = (mv2 && mv2.status !== "analyzing")
        ? ("🖱️ Mouse " + (mv2.status === "suspicious" ? "⚠ " : "✓ ") + mv2.mean + "% (info only)")
        : "Monitoring your mouse movement (info only)";
    }
    vd.textContent = txt;
    vd.className = cls;
    q("exclude").textContent = excluded ? "Include this site" : "Exclude this site";

    // Once both modalities are trained the card alone has 8 rows — tall enough to risk
    // Chrome's own popup-height cap (past which Chrome adds a native scrollbar AND flattens
    // the panel's rounded corners, since it takes over the viewport). The onboarding note
    // is only useful before that point, so drop it once things are actually live.
    show("note", !(ksOn && mouseOn && live));
  });
}

q("exclude").addEventListener("click", function () {
  if (!curOrigin) return;
  api.runtime.sendMessage({ type: "cg:toggleExclude", origin: curOrigin }, refresh);
});

q("enrollKeys").addEventListener("click", function () {
  api.tabs.create({ url: api.runtime.getURL("src/enroll.html?mode=keystroke") });
});
q("enrollMouse").addEventListener("click", function () {
  api.tabs.create({ url: api.runtime.getURL("src/enroll.html?mode=mouse") });
});
