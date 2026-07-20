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

// DIAGNOSTIC: dump per-feature stats [id1,id2,dwell1,dwell2,dd,ud] for a set of windows,
// so real captured data can be compared across sessions (open this page's DevTools
// console — F12 on the enroll.html tab — to read it).
function logWindowStats(label, windows) {
  var F = 6, mins = new Array(F).fill(Infinity), maxs = new Array(F).fill(-Infinity), sums = new Array(F).fill(0), n = 0;
  windows.forEach(function (w) { w.forEach(function (row) { for (var c = 0; c < F; c++) { var v = row[c]; if (v < mins[c]) mins[c] = v; if (v > maxs[c]) maxs[c] = v; sums[c] += v; } n++; }); });
  var means = sums.map(function (s) { return n ? s / n : 0; });
  console.log("[continuum-guard/diag] " + label + ": windows=" + windows.length + " steps=" + n);
  console.log("  min :", mins.map(function (v) { return Number(v.toFixed(3)); }));
  console.log("  mean:", means.map(function (v) { return Number(v.toFixed(3)); }));
  console.log("  max :", maxs.map(function (v) { return Number(v.toFixed(3)); }));
}

// FIXED passage by default. Earlier this fetched a fresh random Wikipedia passage every
// session (varied text was assumed to teach more rhythm); but a fixed, familiar passage
// verified correctly and random-per-session text did not (confirmed: 1 session ~45%,
// even 3 sessions only ~37%). The likely reason: typing the SAME text each session is
// naturally more repeatable (you're not reading+composing something new each time), which
// is exactly what a few-shot personal model needs to learn a stable signature from. The
// random-Wikipedia path is kept as an opt-in via "New passage" for whoever wants variety.
var PASSAGE_FALLBACKS = [
  "Continuous authentication works best when the system observes ordinary writing over time. I am typing this paragraph naturally so Continuum can learn my own rhythm from keydown and keyup timing. Every pair of keys I press carries a small piece of my personal pattern, and together these quick measurements describe how my hands move across the keyboard.",
  "My typing pattern is personal and quite hard to imitate. The time I hold each key down and the pause between two keys creates a behavioral signal that can support account protection after login. Just like a signature on paper, the speed and flow of my fingers form a private mark that follows me whenever I write a message or a longer document.",
  "This enrollment sample helps the application build a private rhythm profile for my account. Later, unusual typing during protected actions can require passkey verification. The more natural text I provide now, the better the model will recognize me in the future, because varied words and different letter combinations teach it the full shape of my typing.",
  "The model should learn from repeated samples collected from the real user. These samples are separate from the password and are used only after passkey setup. When somebody else types on my account, their holding times and the gaps between their keys will not match my profile, and the system can then ask for stronger proof of identity right away.",
];
var fbIdx = Math.floor(Math.random() * PASSAGE_FALLBACKS.length);

// Lower score = simpler/more natural to type. Penalizes long/unfamiliar words, digits
// (dates), parentheses (asides), and non-ASCII (names/diacritics) — the things that make
// someone pause, re-read, or hunt-and-peck instead of typing at their normal rhythm.
function complexityScore(text) {
  var words = text.split(/\s+/).filter(Boolean);
  if (words.length < 15) return Infinity;
  var longWords = words.filter(function (w) { return w.replace(/[^a-zA-Z]/g, "").length > 9; }).length;
  var digits = (text.match(/[0-9]/g) || []).length;
  var parens = (text.match(/[()]/g) || []).length;
  var nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  var avgWordLen = words.reduce(function (s, w) { return s + w.length; }, 0) / words.length;
  return (longWords / words.length) * 3 + (digits / text.length) * 4 + (parens / text.length) * 3 + (nonAscii / text.length) * 5 + Math.max(0, avgWordLen - 5) * 0.6;
}

// Simple English Wikipedia — same API shape as en.wikipedia.org but written in short
// sentences and plain vocabulary by design, which is far less likely to trip someone up
// mid-sentence than the general encyclopedia. Fetch a few candidates and keep the
// simplest-scoring one, since even Simple Wikipedia occasionally lands on a dense topic.
async function fetchRandomText() {
  var candidates = [];
  for (var i = 0; i < 4; i++) {
    try {
      var res = await fetch("https://simple.wikipedia.org/api/rest_v1/page/random/summary", { cache: "no-store" });
      if (!res.ok) continue;
      var data = await res.json();
      var text = (data.extract || "").replace(/\n+/g, " ").trim();
      if (text.length >= 150 && text.indexOf("<") < 0) {
        var t = text.slice(0, 420);
        candidates.push({ text: t, score: complexityScore(t) });
      }
    } catch (e) { /* retry */ }
  }
  if (!candidates.length) return null;
  candidates.sort(function (a, b) { return a.score - b.score; });
  return candidates[0].text;
}
async function nextPassage() { return (await fetchRandomText()) || PASSAGE_FALLBACKS[fbIdx++ % PASSAGE_FALLBACKS.length]; }

var FIXED_PASSAGE = PASSAGE_FALLBACKS[0];   // default every session — same text, on purpose
var passageEl = document.getElementById("passage");
var newPassageLink = document.getElementById("newPassage");
async function loadPassage() {          // only called when the user explicitly wants variety
  passageEl.style.opacity = "0.45";
  newPassageLink.style.pointerEvents = "none";
  passageEl.textContent = await nextPassage();
  passageEl.style.opacity = "1";
  newPassageLink.style.pointerEvents = "";
}
newPassageLink.addEventListener("click", function (e) { e.preventDefault(); loadPassage(); });
passageEl.textContent = FIXED_PASSAGE;   // default on load — NOT randomized

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

// ---- show what's already on file, and let the user wipe it instead of accumulating on
// top of samples that may have been captured while the passage text was confusing them ----
var existingBox = document.getElementById("existingProfile");
var existingCount = document.getElementById("existingCount");
var resetLink = document.getElementById("resetProfile");

getProfileId(function (id) {
  api.storage.local.get(["cg_enroll_" + id, "cg_enroll_mouse_" + id], function (d) {
    var nKey = ((d && d["cg_enroll_" + id]) || []).length;
    var nMouse = ((d && d["cg_enroll_mouse_" + id]) || []).length;
    if (nKey > 0 || nMouse > 0) {
      existingCount.textContent = nKey + " typing + " + nMouse + " mouse windows";
      existingBox.style.display = "block";
    }
  });
});

var resetArmed = false, resetTimer = null;
resetLink.addEventListener("click", function (e) {
  e.preventDefault();
  if (!resetArmed) {
    resetArmed = true;
    resetLink.textContent = "⚠ click again to confirm — deletes your trained model";
    resetTimer = setTimeout(function () { resetArmed = false; resetLink.textContent = "🗑️ clear & start fresh"; }, 4000);
    return;
  }
  clearTimeout(resetTimer);
  resetLink.textContent = "clearing…";
  getProfileId(function (id) {
    api.storage.local.remove(["cg_enroll_" + id, "cg_enroll_mouse_" + id, "cg_enrolled_at", "cg_enroll_sessions_" + id], function () {
      ContinuumTrainer.clearTrained().then(function () {
        try { api.runtime.sendMessage({ type: "cg:profile-reset" }); } catch (e2) {}
        location.reload();
      });
    });
  });
});

// A single ~1-minute session isn't enough real data to learn a stable rhythm against
// natural session-to-session variation (mood, time of day) — tested end-to-end: 1 session
// verified genuine typing at ~45% confidence (false-rejects), 3 accumulated sessions at
// ~84%. Track how many sessions this profile has done and nudge toward at least 3.
var RECOMMENDED_SESSIONS = 3;
function showSessionNudge() {
  getProfileId(function (id) {
    var key = "cg_enroll_sessions_" + id;
    api.storage.local.get([key], function (d) {
      var n = ((d && d[key]) || 0) + 1;
      var rec = {}; rec[key] = n;
      api.storage.local.set(rec);
      var box = document.getElementById("sessionNudge");
      if (n < RECOMMENDED_SESSIONS) {
        box.style.display = "block";
        box.textContent = "📈 Session " + n + " of " + RECOMMENDED_SESSIONS + " recommended — accuracy improves a lot with a few separate sessions (ideally at different times). Come back and train again soon.";
      } else {
        box.style.display = "none";
      }
    });
  });
}

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
      logWindowStats("accumulated-for-training", merged);
      logWindowStats("this-session-only", wNew);

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
              showSessionNudge();
              document.getElementById("done").style.display = "block";
              document.getElementById("done").scrollIntoView({ behavior: "smooth" });
              try { api.runtime.sendMessage({ type: "cg:enrolled" }); } catch (e) {}
            }).catch(function (e) {
              mts.textContent = "mouse training failed: " + ((e && e.message) || e) + " — keystroke model is active; you can re-run enrollment for mouse.";
              showSessionNudge();
              document.getElementById("done").style.display = "block";
              try { api.runtime.sendMessage({ type: "cg:enrolled" }); } catch (er) {}
            });
          });
        });
      });
    }
  }
}
