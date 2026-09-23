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

document.getElementById("save").addEventListener("click", function () {
  var v = input.value.trim().replace(/\/+$/, "") || DEFAULT_RP_BASE;
  api.storage.local.set({ cg_rp_base: v }, function () {
    saved.style.display = "block";
    setTimeout(function () { saved.style.display = "none"; }, 2000);
  });
});
