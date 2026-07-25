// enroll.js — the enrollment wizard (runs in its own extension page, has a DOM). Captures
// the user's typing of a passage, builds the same [50 x 6] feature windows as the guard,
// and stores them locally keyed to a per-profile id. Only timing features are kept — never
// the characters. Re-running the wizard ACCUMULATES windows on top of prior sessions (capped)
// instead of discarding them, so the personal model gets more robust over time.
var api = globalThis.browser || globalThis.chrome;
// Which modality this run trains. Keystroke and mouse enroll INDEPENDENTLY (separate
// storage, window counts, trained heads, and session counters), so the wizard runs one
// at a time instead of forcing both every session. Defaults to keystroke for a bare URL.
var MODE = (new URLSearchParams(location.search).get("mode") === "mouse") ? "mouse" : "keystroke";
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

// Enrollment passages, kept deliberately at A1 (beginner) English — only the most common
// words, simple present tense, and short everyday sentences. The point of enrollment is to
// capture the user's NATURAL rhythm, so the text must never make them stop to read, think,
// or hunt for an unfamiliar word. We previously fetched varied text (Wikipedia, then Aesop's
// Fables); even the "simple" fetched text still had words that made people hesitate and
// corrupted the timing. A curated pool gives guaranteed simplicity AND variety (a different
// one each session), with zero network dependency. Each is long enough for a full packet.
var A1_PASSAGES = [
  "I get up early every day. I make a cup of tea and open the window. The birds sing in the tree near my house. I like to sit and drink my tea in the morning. After that I walk to work. I say hello to my friends on the way. We talk about the day and the weather. At night I read a book and go to sleep.",
  "My family is small but we are happy. My mum cooks good food for us. We eat dinner at the table every night. After we eat, we talk and we laugh. My dad likes to watch films. My sister plays with the dog in the garden. On the weekend we go to the park. We take some food and sit on the grass in the sun.",
  "I like to cook easy food at home. Today I make rice and eggs for lunch. First I wash the rice and put it in a pot. Then I cook the eggs in a pan. I add some salt and a little oil. When the food is ready, I sit down to eat. I drink a glass of water with my meal. Cooking is easy and fun for me every day.",
  "My friend and I like to walk in the park. We go there when the sun is out. We see many dogs and children play. The trees are tall and green. Some people sit on the grass and read. We walk near the lake and feed the birds. Then we buy ice cream from a small shop. We sit on a bench and talk for a long time.",
  "I work in a small shop near my home. I open the shop at nine in the morning. People come in to buy bread, milk, and fruit. I help them find the things they need. I like to talk to the people who come in. At noon I stop and eat a sandwich for lunch. In the afternoon more people come to the shop to buy things.",
  "The weather is nice today. The sun is out and the sky is blue. There are no clouds and there is no rain. I want to go for a walk in the park. I put on my shoes and a light coat. The air is warm and the wind is soft. I see many people out today. Some ride bikes and some walk their dogs on the long path.",
  "I like to read books in my free time. I have many books at home on a shelf. Some are about animals and some are about far away places. In the evening I sit in my chair and read. I make a cup of tea and turn on the lamp. The house is quiet and calm at night. I read for one hour and then I go to sleep.",
  "On Saturday I clean my house. First I open all the windows for fresh air. Then I wash the floor and the dishes. I put my clothes in the machine to wash. I make the bed and I clean the shelves. When the house is clean, I feel very good. After that I sit down and rest for a while and watch a film with my tea.",
  "I have a small garden behind my house. I grow flowers and some green plants. Every morning I give them water. The flowers are red, yellow, and white. Bees and birds come to the garden too. I like to sit outside and look at my plants. In the summer the garden is full of colour. I pick some flowers for the table.",
  "My town is small and quiet. There is one shop, one school, and a park. The people here are kind and friendly. In the morning I hear the birds and the wind. I walk to the shop to buy bread and milk. On the way I meet my neighbours and say hello. The streets are clean and there are many green trees on them.",
];
var lastPassageIdx = -1;
function nextPassage() {
  var i;
  do { i = Math.floor(Math.random() * A1_PASSAGES.length); } while (A1_PASSAGES.length > 1 && i === lastPassageIdx);
  lastPassageIdx = i;
  return A1_PASSAGES[i];
}

var passageEl = document.getElementById("passage");
var newPassageLink = document.getElementById("newPassage");
function loadPassage() { passageEl.textContent = nextPassage(); }
newPassageLink.addEventListener("click", function (e) { e.preventDefault(); loadPassage(); });
if (MODE === "keystroke") loadPassage();   // mouse mode uses nextPassage() directly for its link text

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
  var F = globalThis.ContinuumFeatures;
  var segments = F ? F.eventSteps(events) : [];
  var w = F ? F.stepsToWindows(segments) : [];
  var n = w.length;
  prog.style.width = Math.min(100, Math.round((n / TARGET) * 100)) + "%";
  status.textContent = n + " / " + TARGET + " windows captured";
  saveBtn.disabled = n < TARGET;
  // DIAGNOSTIC: why is the count stuck? Shows every 20 keystrokes — segment lengths
  // reveal whether typing is being fragmented (many short pause-separated runs) instead
  // of accumulating into one run of 50+.
  if (events.length % 20 === 0) {
    console.log("[continuum-guard/diag] enroll: keys=" + events.length + " segments=" + JSON.stringify(segments.map(function (s) { return s.length; })) + " windows=" + n);
  }
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
    api.storage.local.remove(["cg_enroll_" + id, "cg_enroll_mouse_" + id, "cg_enrolled_at", "cg_enroll_sessions_" + id, "cg_enroll_mouse_sessions_" + id], function () {
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
function showSessionNudge(kind) {
  getProfileId(function (id) {
    var key = (kind === "mouse" ? "cg_enroll_mouse_sessions_" : "cg_enroll_sessions_") + id;
    api.storage.local.get([key], function (d) {
      var n = ((d && d[key]) || 0) + 1;
      var rec = {}; rec[key] = n;
      api.storage.local.set(rec);
      var box = document.getElementById("sessionNudge");
      var label = kind === "mouse" ? "mouse" : "typing";
      if (n < RECOMMENDED_SESSIONS) {
        box.style.display = "block";
        box.textContent = "📈 " + label + " session " + n + " of " + RECOMMENDED_SESSIONS + " recommended — accuracy improves a lot with a few separate sessions (ideally at different times). Come back and train again soon.";
      } else {
        box.style.display = "none";
      }
    });
  });
}

// Shared end-of-stage screen: nudge for THIS modality + a link to also train the OTHER one
// (each modality enrolls independently), then reveal the done panel and notify the worker.
function finishStage(kind) {
  var done = document.getElementById("done");
  document.getElementById("doneMsg").textContent = kind === "mouse"
    ? "Your mouse model is trained and active."
    : "Your typing model is trained and active. The guard now knows your rhythm.";
  showSessionNudge(kind);
  var cta = document.getElementById("crossTrainCta");
  var otherMode = kind === "mouse" ? "keystroke" : "mouse";
  var otherLabel = kind === "mouse" ? "⌨️ Also train your typing" : "🖱️ Also train your mouse movement";
  cta.innerHTML = '<a href="#" id="crossTrain" class="link">' + otherLabel + " →</a>";
  cta.querySelector("#crossTrain").addEventListener("click", function (e) {
    e.preventDefault();
    location.href = "enroll.html?mode=" + otherMode;
  });
  done.style.display = "block";
  done.scrollIntoView({ behavior: "smooth" });
  try { api.runtime.sendMessage({ type: "cg:enrolled" }); } catch (e) {}
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
          finishStage("keystroke");
        }).catch(function (e) {
          ts.textContent = "training failed: " + ((e && e.message) || e) + " — your samples were saved; you can retry.";
          saveBtn.disabled = false;
          ta.disabled = false;
        });
      });
    });
  });
});

// ---- Step 2: mouse enrollment (read & click links) ----
// REDESIGNED from "chase-the-dot" (a small fixed box, one recurring target, frequent
// clicks) to a read-and-click task over a full article-width passage with several links
// scattered at realistic, varied positions — much closer to how someone actually moves a
// mouse across a real page (reading, moving to a distant link, clicking, moving again)
// than repeatedly re-centering on one recurring dot in a tiny box. The capture/feature/
// training code is UNCHANGED; only the interaction that generates the movement changed.
// 20 windows (validated sweep: held-out genuine windows win 95%, impostors stay low 85%
// — 12 was too few, the head memorized). ~1 minute of natural reading + clicking.
var MOUSE_TARGET = 20;
var MOUSE_LINKS_PER_ROUND = 6;
function startMouseStage() {
  var stage = document.getElementById("mouseStage");
  var area = document.getElementById("playArea");
  var textEl = document.getElementById("mouseText");
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

  // Render a passage with MOUSE_LINKS_PER_ROUND random words turned into clickable
  // "links" (real hyperlink styling) scattered through the natural flow of the text —
  // clicking each requires moving to a different, unpredictable position, like following
  // links on a real page. When every link in a round is clicked, load a fresh passage.
  var remaining = 0;
  function loadRound() {
    if (doneTraining) return;
    var text = nextPassage();
    var words = text.split(/\s+/);
    var candidates = [];
    for (var i = 0; i < words.length; i++) { if (words[i].replace(/[^a-zA-Z]/g, "").length >= 4) candidates.push(i); }
    // Spread picks across the whole passage rather than clustering near the start.
    var picks = [];
    var bucket = Math.max(1, Math.floor(candidates.length / MOUSE_LINKS_PER_ROUND));
    for (var b = 0; b < MOUSE_LINKS_PER_ROUND && b * bucket < candidates.length; b++) {
      var slice = candidates.slice(b * bucket, (b + 1) * bucket);
      picks.push(slice[Math.floor(Math.random() * slice.length)]);
    }
    remaining = picks.length;
    var pickSet = {};
    picks.forEach(function (idx) { pickSet[idx] = true; });
    textEl.innerHTML = words.map(function (w, i) {
      return pickSet[i] ? '<a href="#" class="mlink">' + w + "</a>" : w;
    }).join(" ");
    Array.prototype.forEach.call(textEl.querySelectorAll(".mlink"), function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        if (a.classList.contains("done")) return;   // theme-aware styling lives in enroll.html's .mlink/.mlink.done
        a.classList.add("done");
        remaining -= 1;
        if (remaining <= 0 && !doneTraining) loadRound();   // fresh passage + links, same task
      });
    });
  }
  loadRound();

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
              finishStage("mouse");
            }).catch(function (e) {
              mts.textContent = "mouse training failed: " + ((e && e.message) || e) + " — your samples were saved; reload this page to try again.";
            });
          });
        });
      });
    }
  }
}

// ---- route to the requested modality (one stage per run) ----
if (MODE === "mouse") {
  document.title = "Continuum Guard — Train mouse";
  document.getElementById("pageTitle").textContent = "Train Continuum on your mouse movement";
  startMouseStage();
} else {
  document.title = "Continuum Guard — Train typing";
  document.getElementById("pageTitle").textContent = "Train Continuum on your typing";
  document.getElementById("keystrokeStage").style.display = "block";
  document.getElementById("ta").focus();
}
