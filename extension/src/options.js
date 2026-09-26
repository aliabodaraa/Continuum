// options.js — lets a deployer point the extension's fixed-RP passkey step-up at a real
// passkey-service instead of localhost, without repackaging the extension.
var api = globalThis.browser || globalThis.chrome;
var DEFAULT_RP_BASE = "http://localhost:4000";
var input = document.getElementById("rpBase");
var saved = document.getElementById("saved");

api.storage.local.get(["cg_rp_base"], function (d) {
  input.value = (d && d.cg_rp_base) || DEFAULT_RP_BASE;
});

// Verbose diagnostics: default OFF. The per-window logging used to be unconditional, which
// buried genuine page errors under continuum-guard output in every site's DevTools.
var debugBox = document.getElementById("debug");
api.storage.local.get(["cg_debug"], function (d) { debugBox.checked = !!(d && d.cg_debug); });
debugBox.addEventListener("change", function () {
  api.storage.local.set({ cg_debug: debugBox.checked });   // background watches storage.onChanged
});

// Reachability check. The step-up ceremony is the ONLY way to clear a lock, so a wrong or
// unreachable address here is what turns a normal lock into an apparent dead end — this
// button surfaces that before it happens rather than at the moment the user is locked out.
var probe = document.getElementById("probe");
document.getElementById("test").addEventListener("click", function () {
  var base = input.value.trim().replace(/\/+$/, "") || DEFAULT_RP_BASE;
  probe.style.display = "block";
  probe.style.color = "var(--muted)";
  probe.textContent = "Checking " + base + " …";
  var settled = false;
  function done(ok, msg) {
    if (settled) return; settled = true;
    probe.style.color = ok ? "var(--ok)" : "#dc2626";
    probe.textContent = (ok ? "✓ " : "✗ ") + msg;
  }
  setTimeout(function () { done(false, "No response within 3s — is passkey-service running?"); }, 3000);
  fetch(base + "/health", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json().then(function (j) { done(true, "Reachable (" + (j.service || "ok") + ")"); }) : done(false, "Responded HTTP " + r.status); })
    .catch(function (e) { done(false, "Unreachable: " + ((e && e.message) || "connection refused")); });
});

// ---- user study mode (background.js "USER STUDY MODE") ----
var PSEUDONYM = /^[A-Za-z0-9_-]{1,32}$/;
var sOn = document.getElementById("studyOn"), sGw = document.getElementById("studyGateway"), sKey = document.getElementById("studyKey"),
    sP = document.getElementById("studyParticipant"), sCond = document.getElementById("studyCondition"), sImp = document.getElementById("studyImpostor"),
    sMsg = document.getElementById("studyMsg");
function studyMsg(text, ok) { sMsg.style.display = "block"; sMsg.style.color = ok ? "var(--ok)" : "#dc2626"; sMsg.textContent = text; }
sCond.addEventListener("change", function () { sImp.style.display = sCond.value === "impostor" ? "block" : "none"; });
api.storage.local.get(["cg_study"], function (d) {
  var v = (d && d.cg_study) || {};
  sOn.checked = v.on === true; sGw.value = v.gateway || "http://localhost:8080"; sKey.value = v.siteKey || ""; sP.value = v.participant || "";
  var imp = String(v.condition || "genuine").indexOf("impostor:") === 0;
  sCond.value = imp ? "impostor" : "genuine"; sImp.value = imp ? v.condition.slice(9) : ""; sImp.style.display = imp ? "block" : "none";
});
document.getElementById("studySave").addEventListener("click", function () {
  var p = sP.value.trim(), imp = sImp.value.trim();
  if (sOn.checked && (!PSEUDONYM.test(p) || !sKey.value.trim() || !sGw.value.trim())) return studyMsg("Gateway, site key and a pseudonym (letters, digits, - or _) are required.", false);
  if (sCond.value === "impostor" && (!PSEUDONYM.test(imp) || imp === p)) return studyMsg("An impostor session needs the pseudonym of the person typing, different from the account's.", false);
  var v = { on: sOn.checked, gateway: sGw.value.trim().replace(/\/+$/, ""), siteKey: sKey.value.trim(), participant: p,
            condition: sCond.value === "impostor" ? "impostor:" + imp : "genuine" };
  api.storage.local.set({ cg_study: v }, function () { studyMsg(v.on ? "Saved. Study mode is ON for " + p + " (" + v.condition + ")." : "Saved. Study mode is off.", true); });
});
document.getElementById("studyEnrol").addEventListener("click", function () {
  api.runtime.sendMessage({ type: "cg:study-open-enrol" }, function () { void api.runtime.lastError; });
});

document.getElementById("save").addEventListener("click", function () {
  var v = input.value.trim().replace(/\/+$/, "") || DEFAULT_RP_BASE;
  api.storage.local.set({ cg_rp_base: v }, function () {
    saved.style.display = "block";
    setTimeout(function () { saved.style.display = "none"; }, 2000);
  });
});
