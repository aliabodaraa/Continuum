// popup.js — reads status from the background worker and drives the on/off + per-site
// exclusion controls.
var api = globalThis.browser || globalThis.chrome;
var curOrigin = "";
var curUrl = "";
var curRestricted = false;   // page where Chrome forbids content scripts entirely
function q(id) { return document.getElementById(id); }

// Chrome refuses to inject content scripts into its own pages (chrome://, the New Tab
// page, the Web Store, devtools, other extensions) no matter what the manifest asks for.
// Without the content script NEITHER channel receives events, so the panel would sit at
// "0/50 steps" and "watching…" forever and look broken — say so instead.
function isRestrictedUrl(u) {
  if (!u) return true;
  if (/^(chrome|edge|brave|about|chrome-extension|moz-extension|devtools|view-source|file):/i.test(u)) return true;
  return /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(u);
}

api.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  var url = (tabs && tabs[0] && tabs[0].url) || "";
  curUrl = url;
  curRestricted = isRestrictedUrl(url);
  try { curOrigin = new URL(url).origin; } catch (e) { curOrigin = ""; }
  refresh();
});
// Poll so the model-ready state and live verdict update while the popup is open.
setInterval(refresh, 1000);

function show(id, visible) { q(id).style.display = visible ? "" : "none"; }

// ---- collapsible per-modality sections ----
// Open/closed is remembered across popup openings (the popup is torn down every time it
// closes, so without this every open would reset to the default and undo the user's choice).
// localStorage is synchronous, so the state is applied before first paint — no flash of the
// wrong state, and no animation on load: the .anim class that enables the transition is
// added only after the initial state is set.
function initSection(sectId, headId, storeKey) {
  var sect = q(sectId), head = q(headId);
  var stored = null;
  try { stored = localStorage.getItem(storeKey); } catch (e) {}   // never let storage break the panel
  // Default COLLAPSED: both sections open is ~730px, past Chrome's ~600px popup cap (which
  // forces Chrome's own scrollbar and flattens the panel's rounded corners). Collapsed the
  // panel is ~420px, and the header summary still shows each channel's verdict at a glance.
  var open = stored === "1";
  sect.classList.toggle("open", open);
  head.setAttribute("aria-expanded", String(open));
  requestAnimationFrame(function () { sect.classList.add("anim"); });   // animate only from here on
  head.addEventListener("click", function () {
    var nowOpen = !sect.classList.contains("open");
    sect.classList.toggle("open", nowOpen);
    head.setAttribute("aria-expanded", String(nowOpen));
    try { localStorage.setItem(storeKey, nowOpen ? "1" : "0"); } catch (e) {}
  });
}
initSection("sectKeys", "headKeys", "cg_sect_keys");
initSection("sectMouse", "headMouse", "cg_sect_mouse");

function refresh() {
  api.runtime.sendMessage({ type: "cg:status" }, function (s) {
    // Reading lastError is what marks the failure handled. The popup polls once a second,
    // so every moment the MV3 worker is asleep or restarting would otherwise log
    // "Unchecked runtime.lastError: No SW". There is nothing to do about it — the next poll
    // wakes the worker and succeeds — but it has to be read rather than ignored.
    if (api.runtime.lastError || !s) return;
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
    q("dot").className = "dot" + (live && !curRestricted ? "" : " off");

    // Per-modality rows: only show a modality's rows once THAT modality is trained.
    show("rowModel", ksOn);
    show("rowSteps", ksOn);
    show("rowWins", ksOn);
    show("rowMouse", mouseOn);
    show("rowMouseTrack", mouseOn);   // user on/off toggle, only once a mouse model exists
    if (mouseOn) q("mouseTrackToggle").checked = s.mouseTracking !== false;
    // Lock-sensitivity slider — only meaningful while the mouse channel is on.
    show("rowMouseSens", mouseOn && s.mouseTracking !== false);
    show("mouseSensHint", mouseOn && s.mouseTracking !== false);
    if (mouseOn && document.activeElement !== q("mouseSensRange")) {   // don't fight a live drag
      var pct = s.mouseSustainPct || 75;
      q("mouseSensRange").value = pct;
      q("mouseSensVal").textContent = pct + "%";
      setMouseHint(pct);
    }
    // Each modality reports its own sample count inside its own section.
    show("rowKeySamples", ksOn);
    show("rowMouseSamples", mouseOn);
    if (ksOn) q("keySamples").textContent = (s.keySamples || 0) + " window" + ((s.keySamples || 0) === 1 ? "" : "s");
    if (mouseOn) q("mouseSamples").textContent = (s.mouseSamples || 0) + " window" + ((s.mouseSamples || 0) === 1 ? "" : "s");
    // Passkey (re)registration is only meaningful once a profile exists to protect.
    show("passkeyLine", trained);
    q("regPasskey").textContent = s.hasPasskey ? "🔑 Re-register passkey" : "🔑 Set up your passkey";

    if (ksOn) {
      q("model").textContent = s.modelReady ? "ready — personal" : (s.modelError ? "error" : "loading…");
      q("wins").textContent = s.totalWindows;
      var st = s.steps || 0, nd = s.needSteps || 50;
      q("steps").textContent = st >= nd ? "ready ✓" : st + "/" + nd;
    }
    if (mouseOn) {
      // What the user needs to see is how close the channel is to asking for the passkey —
      // i.e. how much of the sustained buffer is low against their configured threshold.
      // The old readout was the mean of the last 6 windows, which jumps on every movement
      // and never reveals the distance to a lock.
      var mv = s.mouseVerdict;
      q("mouse").textContent = s.mouseTracking === false ? "off"
        : !mv ? "watching…"
        : mv.low == null ? (mv.status === "suspicious" ? "⚠ " + mv.mean + "%" : "✓ " + mv.mean + "%")
        : mv.low + " / " + mv.bufferMax + " low (" + mv.riskPct + "%)";
    }

    // Section headers carry a one-glance summary so a COLLAPSED section is still informative.
    var kvs = s.verdict;   // NOT the `v` below — that is assigned later in this function
    q("sumKeys").textContent = !ksOn ? "not trained"
      : !kvs ? "idle"
      : kvs.status === "analyzing" ? "analyzing " + kvs.packet + "/" + kvs.need
      : kvs.status === "suspicious" ? "⚠ " + kvs.mean + "%"
      : "✓ " + kvs.mean + "%";
    var mvs = s.mouseVerdict;
    q("sumMouse").textContent = !mouseOn ? "not trained"
      : s.mouseTracking === false ? "off"
      : !mvs ? "idle"
      : mvs.low == null ? (mvs.status === "suspicious" ? "⚠ " + mvs.mean + "%" : "✓ " + mvs.mean + "%")
      : (mvs.riskPct >= (s.mouseSustainPct || 75) - 15 ? "⚠ " : "") + mvs.riskPct + "% of "
        + (s.mouseSustainPct || 75) + "%";

    q("profile").textContent = active
      ? [ksOn ? "typing ✓" : null, mouseOn ? "mouse ✓" : null].filter(Boolean).join(" · ")
      : (s.enrolled ? "training…" : "not trained yet");
    q("site").textContent = curRestricted ? (curOrigin || "browser page") + " (not monitorable)"
      : curOrigin ? (excluded ? curOrigin + " (excluded)" : curOrigin) : "—";

    // Verdict banner — theme-aware colouring via CSS classes (v-ok / v-warn / neutral).
    var vd = q("verdict"), v = s.verdict, cls = "", txt;
    // Restricted page first: on chrome:// / the New Tab page / the Web Store, Chrome blocks
    // the content script, so no typing or pointer events reach the worker at all. Without
    // this the panel just shows 0/50 and "watching…" and reads as a broken model.
    if (curRestricted) {
      // Name the New Tab page explicitly: it shows the Google logo and a search box, so it
      // is routinely mistaken for google.com — but it is a chrome:// page where no extension
      // can run, and the resulting "nothing happens" reads as a broken model.
      txt = /^chrome:\/\/(newtab|new-tab-page)/i.test(curUrl)
        ? "⚠ This is Chrome's New Tab page (not google.com) — extensions can't run here. Type a site in the address bar to monitor."
        : "⚠ Chrome blocks extensions on this page — open a normal website (http/https) to monitor";
    }
    else if (!active) { txt = "⚙️ Set up your profile below to start monitoring"; }
    else if (!s.modelReady) { txt = s.modelError ? ("⚠ model error: " + s.modelError) : "⏳ loading model…"; }
    else if (s.locked) {
      var by = s.lockReason === "mouse" ? "mouse movement" : "keystroke rhythm";
      txt = "🔒 Locked — passkey required (" + by + " didn't match)"; cls = "v-warn";
    }
    else if (ksOn) {   // keystroke is the enforcing channel — it drives the banner when trained
      if (!v) { txt = "Idle — type on any web page to begin"; }
      else if (v.status === "analyzing") { txt = "Analyzing your typing… (" + v.packet + "/" + v.need + ")"; }
      else if (v.status === "suspicious") { txt = "⚠ Suspicious — " + v.mean + "%"; cls = "v-warn"; }
      else { txt = "✓ Verified — " + v.mean + "%"; cls = "v-ok"; }
    } else {   // mouse trained only — now enforcing via the sustained vote
      var mv2 = s.mouseVerdict;
      if (mv2 && mv2.status === "suspicious") { txt = "🖱️ Suspicious mouse movement — " + mv2.mean + "%"; cls = "v-warn"; }
      else if (mv2 && mv2.status !== "analyzing") { txt = "🖱️ Mouse ✓ " + mv2.mean + "%"; cls = "v-ok"; }
      else { txt = "Monitoring your mouse movement"; }
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
q("regPasskey").addEventListener("click", function (e) {
  e.preventDefault();
  api.runtime.sendMessage({ type: "cg:open-register" });
});

// User on/off toggle for the mouse channel (independent of keystroke).
q("mouseTrackToggle").addEventListener("change", function () {
  api.runtime.sendMessage({ type: "cg:set-mouse-tracking", on: this.checked }, refresh);
});

// Mouse lock-sensitivity slider: live label on drag, persist on release. The hint spells the
// percentage out in windows — the number that actually decides when the passkey is demanded.
var MOUSE_BUFFER = 20;   // MOUSE_SUSTAIN_WINDOW in background.js
function setMouseHint(pct) {
  var n = Math.max(1, Math.round((pct / 100) * MOUSE_BUFFER));
  q("mouseSensHint").textContent = "Asks for your passkey after " + n + " of the last "
    + MOUSE_BUFFER + " mouse windows look wrong.";
}
q("mouseSensRange").addEventListener("input", function () {
  q("mouseSensVal").textContent = this.value + "%";
  setMouseHint(parseInt(this.value, 10));
});
q("mouseSensRange").addEventListener("change", function () {
  api.runtime.sendMessage({ type: "cg:set-mouse-sustain", pct: parseInt(this.value, 10) }, refresh);
});

// Open the options page where the passkey-service (RP) URL is configured.
q("openSettings").addEventListener("click", function () {
  if (api.runtime.openOptionsPage) api.runtime.openOptionsPage();
  else api.tabs.create({ url: api.runtime.getURL("src/options.html") });
});
