// enroll.js — the enrollment wizard (runs in its own extension page, has a DOM). Captures
// the user's typing of a passage, builds the same [50 x 6] feature windows as the guard,
// and stores them locally keyed to a per-profile id. Only timing features are kept — never
// the characters. Re-running the wizard ACCUMULATES windows on top of prior sessions (capped)
// instead of discarding them, so the personal model gets more robust over time.
var api = globalThis.browser || globalThis.chrome;
var TARGET = 12;                 // NEW windows this session (~700+ keystrokes)
var MAX_STORED_KEY_WINDOWS = 60;  // cap on accumulated keystroke windows across all sessions
var MAX_STORED_MOUSE_WINDOWS = 80;
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
  var wNew = currentWindows();
  var ts = document.getElementById("trainStatus");
  saveBtn.disabled = true;
  ta.disabled = true;
  ts.style.display = "block";
  ts.textContent = "capturing complete — training your personal model on-device…";
  getProfileId(function (id) {
    var key = "cg_enroll_" + id;
    api.storage.local.get([key], function (d) {
      // ACCUMULATE: prior sessions' windows + this session's, capped to the most recent N —
      // more of the user's natural variation makes the personal model more robust over time.
      var prior = (d && d[key]) || [];
      var merged = prior.concat(wNew);
      if (merged.length > MAX_STORED_KEY_WINDOWS) merged = merged.slice(-MAX_STORED_KEY_WINDOWS);

      var rec = {};
      rec[key] = merged;
      rec["cg_enrolled_at"] = Date.now();
      api.storage.local.set(rec, function () {
        // Fine-tune the base model on ALL accumulated windows, entirely in-page (trainer.js).
        ContinuumTrainer.train(merged, {
          impostorsUrl: api.runtime.getURL("data/impostors.json"),
          extractorUrl: api.runtime.getURL("model/base-extractor/model.json"),
          scalerUrl: api.runtime.getURL("model/scaler.json"),
          saveTo: "indexeddb://cg-personal-head",
          onProgress: function (p) { ts.textContent = "training… epoch " + p.epoch + "/" + p.epochs + " — accuracy " + Math.round(p.acc * 100) + "% (" + merged.length + " windows total)"; },
        }).then(function (r) {
          ts.style.display = "none";
          startMouseStage();
        }).catch(function (e) {
          ts.textContent = "training failed: " + ((e && e.message) || e) + " — your samples were saved; you can retry.";
          saveBtn.disabled = false;
          ta.disabled = false;
        });
      });
    });
  });
});

// ---- Step 2: mouse enrollment (chase-the-dot) ----
// 20 windows (validated sweep: held-out genuine windows win 95%, impostors stay low 85%
// — 12 was too few, the head memorized). ~1 minute of dot-chasing.
var MOUSE_TARGET = 20;
function startMouseStage() {
  var stage = document.getElementById("mouseStage");
  var area = document.getElementById("playArea");
  var dot = document.getElementById("dot");
  var mprog = document.getElementById("mprog");
  var mstatus = document.getElementById("mstatus");
  var mts = document.getElementById("mtrainStatus");
  stage.style.display = "block";
  stage.scrollIntoView({ behavior: "smooth" });

  var M = globalThis.ContinuumMouseFeatures;
  var mEvents = [], down = false, doneTraining = false;

  function push(x, y, st) { if (!doneTraining) { mEvents.push({ t: performance.now(), x: x, y: y, state: st }); if (mEvents.length % 10 === 0) update(); } }
  area.addEventListener("mousemove", function (e) { push(e.clientX, e.clientY, down ? "Drag" : "Move"); });
  area.addEventListener("mousedown", function (e) { down = true; push(e.clientX, e.clientY, "Pressed"); });
  area.addEventListener("mouseup", function (e) { down = false; push(e.clientX, e.clientY, "Released"); });
  dot.addEventListener("click", function () {
    dot.style.left = (8 + Math.random() * 84) + "%";
    dot.style.top = (8 + Math.random() * 78) + "%";
  });

  function windows() { return M ? M.stepsToWindows(M.eventsToSteps(mEvents)) : []; }
  function update() {
    var w = windows();
    mprog.style.width = Math.min(100, Math.round((w.length / MOUSE_TARGET) * 100)) + "%";
    mstatus.textContent = w.length + " / " + MOUSE_TARGET + " mouse windows captured";
    if (w.length >= MOUSE_TARGET && !doneTraining) {
      doneTraining = true;
      mts.style.display = "block";
      mts.textContent = "capturing complete — training your mouse model on-device…";
      getProfileId(function (id) {
        var key = "cg_enroll_mouse_" + id;
        api.storage.local.get([key], function (d) {
          var prior = (d && d[key]) || [];
          var merged = prior.concat(w.slice(0, MOUSE_TARGET));
          if (merged.length > MAX_STORED_MOUSE_WINDOWS) merged = merged.slice(-MAX_STORED_MOUSE_WINDOWS);
          var rec = {}; rec[key] = merged;
          api.storage.local.set(rec, function () {
            ContinuumTrainer.train(merged, {
              impostorsUrl: api.runtime.getURL("data/mouse-impostors.json"),
              extractorUrl: api.runtime.getURL("model/mouse-extractor/model.json"),
              scalerUrl: api.runtime.getURL("model/mouse-scaler.json"),
              saveTo: "indexeddb://cg-personal-mouse-head",
              jitterCols: [2, 3, 4, 5],   // never jitter the is_click flag
              onProgress: function (p) { mts.textContent = "training mouse… epoch " + p.epoch + "/" + p.epochs + " — accuracy " + Math.round(p.acc * 100) + "% (" + merged.length + " windows total)"; },
            }).then(function () {
              mts.style.display = "none";
              document.getElementById("done").style.display = "block";
              document.getElementById("done").scrollIntoView({ behavior: "smooth" });
              try { api.runtime.sendMessage({ type: "cg:enrolled" }); } catch (e) {}
            }).catch(function (e) {
              mts.textContent = "mouse training failed: " + ((e && e.message) || e) + " — keystroke model is active; you can re-run enrollment for mouse.";
              document.getElementById("done").style.display = "block";
              try { api.runtime.sendMessage({ type: "cg:enrolled" }); } catch (er) {}
            });
          });
        });
      });
    }
  }
}
