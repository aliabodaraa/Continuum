// enroll.js — the enrollment wizard (runs in its own extension page, has a DOM). Captures
// the user's typing of a passage, builds the same [50 x 6] feature windows as the guard,
// and stores them locally keyed to a per-profile id. Only timing features are kept — never
// the characters. A later stage trains/loads a personal model from these windows.
var api = globalThis.browser || globalThis.chrome;
var TARGET = 12;                 // enrollment windows to collect (~700+ keystrokes)
var events = [], t0 = performance.now();

var PASSAGE =
  "Continuous authentication works best when the system observes ordinary writing over time. " +
  "I am typing this paragraph naturally so Continuum can learn my own rhythm from the small " +
  "timing between each key. Every pair of keys I press carries a little piece of how my hands " +
  "move across the keyboard, and together these quick measurements describe the way I type. " +
  "The quick brown fox jumps over the lazy dog while I keep a steady, comfortable pace.";

document.getElementById("passage").textContent = PASSAGE;
var ta = document.getElementById("ta");
var prog = document.getElementById("prog");
var status = document.getElementById("status");
var saveBtn = document.getElementById("save");

ta.addEventListener("keydown", function (e) { rec("keydown", e); }, true);
ta.addEventListener("keyup", function (e) { rec("keyup", e); }, true);

function rec(type, e) {
  events.push({ keyCode: e.keyCode || 0, type: type, t: performance.now() - t0, field: "enroll" });
  update();
}

function currentWindows() {
  var F = globalThis.ContinuumFeatures;
  if (!F) return [];
  return F.stepsToWindows(F.eventSteps(events));
}

function update() {
  var w = currentWindows();
  var n = w.length;
  prog.style.width = Math.min(100, Math.round((n / TARGET) * 100)) + "%";
  status.textContent = n + " / " + TARGET + " windows captured";
  saveBtn.disabled = n < TARGET;
}

function getProfileId(cb) {
  api.storage.local.get(["cg_profile_id"], function (d) {
    var id = d && d.cg_profile_id;
    if (!id) {
      id = "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      api.storage.local.set({ cg_profile_id: id });
    }
    cb(id);
  });
}

document.getElementById("regpk").addEventListener("click", function () {
  try { api.runtime.sendMessage({ type: "cg:open-register" }); } catch (e) {}
});

saveBtn.addEventListener("click", function () {
  var w = currentWindows();
  var ts = document.getElementById("trainStatus");
  saveBtn.disabled = true;
  ta.disabled = true;
  ts.style.display = "block";
  ts.textContent = "training your personal model… (stays on this device)";
  getProfileId(function (id) {
    var rec = {};
    rec["cg_enroll_" + id] = w;                 // the enrollment windows
    rec["cg_enrolled_at"] = Date.now();
    api.storage.local.set(rec, function () {
      // Fine-tune the base model on these windows, entirely in-page (see trainer.js).
      ContinuumTrainer.train(
        w,
        api.runtime.getURL("data/impostors.json"),
        api.runtime.getURL("model/base-extractor/model.json"),
        api.runtime.getURL("model/scaler.json"),
        function (p) { ts.textContent = "training… epoch " + p.epoch + "/" + p.epochs + " — accuracy " + Math.round(p.acc * 100) + "%"; }
      ).then(function (r) {
        ts.style.display = "none";
        document.getElementById("done").style.display = "block";
        try { api.runtime.sendMessage({ type: "cg:enrolled", count: w.length, accuracy: r.accuracy }); } catch (e) {}
      }).catch(function (e) {
        ts.textContent = "training failed: " + ((e && e.message) || e) + " — profile windows were saved; you can retry.";
        saveBtn.disabled = false;
        ta.disabled = false;
      });
    });
  });
});
