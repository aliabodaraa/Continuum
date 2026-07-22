// options.js — lets a deployer point the extension's fixed-RP passkey step-up at a real
// passkey-service instead of localhost, without repackaging the extension.
var api = globalThis.browser || globalThis.chrome;
var DEFAULT_RP_BASE = "http://localhost:4000";
var input = document.getElementById("rpBase");
var saved = document.getElementById("saved");

api.storage.local.get(["cg_rp_base"], function (d) {
  input.value = (d && d.cg_rp_base) || DEFAULT_RP_BASE;
});

document.getElementById("save").addEventListener("click", function () {
  var v = input.value.trim().replace(/\/+$/, "") || DEFAULT_RP_BASE;
  api.storage.local.set({ cg_rp_base: v }, function () {
    saved.style.display = "block";
    setTimeout(function () { saved.style.display = "none"; }, 2000);
  });
});
