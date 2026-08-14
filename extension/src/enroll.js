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
// Keystroke enrollment captures FREE COMPOSITION only: the user answers a prompt in their
// own words. Copy-typing a supplied passage was measured (diag-keystroke.html) to be a
// different motor task from real use — a passage-only profile scored 0.84 on copy-typing but
// 0.60 on the same person composing freely, and the guard only ever sees composition. So the
// enrolment task is now the task that gets scored, with nothing to copy at all.
var TARGET = 12;                  // NEW windows this session
var MAX_STORED_KEY_WINDOWS = 60;  // cap on accumulated keystroke windows across all sessions
var MAX_STORED_MOUSE_WINDOWS = 120;
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
// Prompts for the free-composition phase. Chosen so the answer needs no research and no
// recall effort — the goal is the user's natural composing rhythm (think-pauses, bursts,
// backspaces), not a hard question that would stall them into unrepresentative timing.
var FREE_PROMPTS = [
  "What did you do this morning, before sitting down here?",
  "Reply to a friend who just asked how your week is going.",
  "Describe the room you are sitting in right now.",
  "What are you working on at the moment? Explain it to someone who knows nothing about it.",
  "Where would you like to travel next, and why?",
  "Tell someone about a film, show, or book you enjoyed recently.",
  "Write a short note to a colleague saying you will be late and why.",
  "What does your ideal weekend look like?",
  "What is something you would like to learn, and what is stopping you?",
  "Describe a meal you know how to cook, in your own words.",
];
var lastPromptIdx = -1;
function nextFreePrompt() {
  var i;
  do { i = Math.floor(Math.random() * FREE_PROMPTS.length); } while (FREE_PROMPTS.length > 1 && i === lastPromptIdx);
  lastPromptIdx = i;
  return FREE_PROMPTS[i];
}

var lastPassageIdx = -1;
function nextPassage() {
  var i;
  do { i = Math.floor(Math.random() * A1_PASSAGES.length); } while (A1_PASSAGES.length > 1 && i === lastPassageIdx);
  lastPassageIdx = i;
  return A1_PASSAGES[i];
}

// ---- account gate: samples/models are keyed to whichever Chrome/Google account this
// browser is signed into (background.js resolves it via chrome.identity). Without one
// there's no account to link samples to, so the whole wizard stays hidden. ----
var currentAccountId = null, currentAccountEmail = null;
function getProfileId(cb) { cb(currentAccountId); }

function initWizard() {
var passageEl = document.getElementById("passage");
var newPassageLink = document.getElementById("newPassage");
function loadPassage() { passageEl.textContent = nextFreePrompt(); }
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

function windowsOf(buf) {
  var F = globalThis.ContinuumFeatures;
  if (!F) return [];
  return F.stepsToWindows(F.eventSteps(buf));
}
function currentWindows() { return windowsOf(events); }

function update() {
  var F = globalThis.ContinuumFeatures;
  var segments = F ? F.eventSteps(events) : [];
  var w = F ? F.stepsToWindows(segments) : [];
  var n = w.length;
  prog.style.width = Math.min(100, Math.round((n / TARGET) * 100)) + "%";
  status.textContent = n + " / " + TARGET + " windows captured";
  saveBtn.disabled = n < TARGET;
  if (events.length % 20 === 0) {
    console.log("[continuum-guard/diag] enroll: keys=" + events.length + " segments=" + JSON.stringify(segments.map(function (s) { return s.length; })) + " windows=" + n);
  }
}

document.getElementById("regpk").addEventListener("click", function () {
  try { api.runtime.sendMessage({ type: "cg:open-register" }); } catch (e) {}
});

// ---- show what's already on file, and let the user wipe it instead of accumulating on
// top of samples that may have been captured while the passage text was confusing them ----
var existingBox = document.getElementById("existingProfile");
var existingCount = document.getElementById("existingCount");
var resetLink = document.getElementById("resetProfile");

// Reset is MODALITY-SPECIFIC: keystroke and mouse are enrolled/trained/stored
// independently, so this page (which runs ONE modality per visit) clears only ITS OWN
// channel — wiping your mouse profile must never delete your typing profile, and vice
// versa. The other channel's counts are shown for context but left untouched.
var IS_MOUSE = (MODE === "mouse");
var RESET_LABEL = IS_MOUSE ? "🗑️ clear my mouse data & start fresh" : "🗑️ clear my typing data & start fresh";
resetLink.textContent = RESET_LABEL;
getProfileId(function (id) {
  api.storage.local.get(["cg_enroll_" + id, "cg_enroll_mouse_" + id], function (d) {
    var nKey = ((d && d["cg_enroll_" + id]) || []).length;
    var nMouse = ((d && d["cg_enroll_mouse_" + id]) || []).length;
    var mine = IS_MOUSE ? nMouse : nKey;
    if (mine > 0) {
      var other = IS_MOUSE ? (nKey + " typing") : (nMouse + " mouse");
      existingCount.textContent = mine + (IS_MOUSE ? " mouse" : " typing") + " windows on file"
        + (((IS_MOUSE ? nKey : nMouse) > 0) ? " (" + other + " windows kept separately)" : "");
      existingBox.style.display = "block";
    }
  });
});

var resetArmed = false, resetTimer = null;
resetLink.addEventListener("click", function (e) {
  e.preventDefault();
  if (!resetArmed) {
    resetArmed = true;
    resetLink.textContent = "⚠ click again to confirm — deletes your trained " + (IS_MOUSE ? "mouse" : "typing") + " model";
    resetTimer = setTimeout(function () { resetArmed = false; resetLink.textContent = RESET_LABEL; }, 4000);
    return;
  }
  clearTimeout(resetTimer);
  resetLink.textContent = "clearing…";
  getProfileId(function (id) {
    // Only THIS modality's storage keys + ready-flag + trained head; the other channel is preserved.
    var keys = IS_MOUSE
      ? ["cg_enroll_mouse_" + id, "cg_enroll_mouse_sessions_" + id, "cg_mouse_ready_" + id]
      : ["cg_enroll_" + id, "cg_enroll_sessions_" + id, "cg_model_personal_" + id, "cg_enrolled_at_" + id];
    api.storage.local.remove(keys, function () {
      ContinuumTrainer.clearTrained(id, MODE).then(function () {
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
  // Passkey control. This block is shared by BOTH modalities, so finishing mouse training
  // used to re-offer "Set up your passkey" to someone who already had one — and every click
  // ran a fresh WebAuthn ceremony, piling up duplicate credentials for the same account.
  // One passkey is all the step-up needs, so offer creation only when there ISN'T one, and
  // put re-registration behind a deliberate, clearly-labelled link.
  var regBtn = document.getElementById("regpk");
  var pkNote = document.getElementById("pkNote");
  api.runtime.sendMessage({ type: "cg:status" }, function (s) {
    var has = !!(s && s.hasPasskey);
    regBtn.style.display = has ? "none" : "block";
    pkNote.style.display = has ? "block" : "none";
    if (has) {
      pkNote.innerHTML = "🔑 Passkey already set up — it's used when the guard locks a page. "
        + "<a href='#' id='rereg' class='link'>Replace it</a> only if it stopped working.";
      pkNote.querySelector("#rereg").addEventListener("click", function (e) {
        e.preventDefault();
        if (!confirm("Register a NEW passkey for this account?\n\nYour existing one keeps working; this adds another. Only do this if the current passkey stopped working.")) return;
        try { api.runtime.sendMessage({ type: "cg:open-register" }); } catch (e2) {}
      });
    }
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
  // Log the two regimes separately: if a future profile drifts back toward passage-only,
  // this is where it shows up (see diag-keystroke.html for the enrol/use comparison).
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
      rec["cg_enrolled_at_" + id] = Date.now();
      api.storage.local.set(rec, function () {
        // Fine-tune the base model on ALL accumulated windows, entirely in-page (trainer.js).
        ContinuumTrainer.train(merged, {
          impostorsUrl: api.runtime.getURL("data/impostors.json"),
          extractorUrl: api.runtime.getURL("model/base-extractor/model.json"),
          scalerUrl: api.runtime.getURL("model/scaler.json"),
          saveTo: "indexeddb://cg-personal-head-" + id,
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

// ---- Step 2: mouse enrollment (full-viewport read + target-click) ----
// EVOLUTION: chase-the-dot (tiny box, one recurring target) -> read-and-click links in a
// 620px text column -> THIS: window-wide capture + reading links AND floating targets
// scattered across the WHOLE viewport. Two problems the previous version left on the table:
//   1. Train/live MISMATCH — enrollment captured motion only inside the small play area,
//      but the live guard (content.js) scores motion across the full browser viewport.
//      The enrolled profile was built from cramped, low-variety motion unlike real use.
//   2. Too little / too narrow data — 20 windows of short article-width hops under-express
//      the fast, long, directionally-varied "navigation" moves that most distinguish users.
// Fix: capture on `document` (full viewport, clientX/clientY — same as the guard) and drive
// long varied moves with floating targets placed far apart anywhere on screen, alongside the
// slow precise reading motion. This closes the mismatch so the head sees, at enrollment, the
// same distribution it will score live — realising the mouse model's real separability instead
// of squandering it in a box. (It does NOT change the model's inherent per-user ceiling.)
// 40 windows (was 20): the SapiMouse enroll sweep shows verification EER keeps dropping well
// past 20 windows (knee ~150), so more genuine motion = a stronger, better-separated profile.
// ~2 minutes of mixed reading + target-clicking.
var MOUSE_TARGET = 40;
var MOUSE_LINKS_PER_ROUND = 6;
var MOUSE_FLOATS_ACTIVE = 2;   // floating full-viewport targets kept on screen at once
// Enforce ENOUGH REAL interaction: completion needs both MOUSE_TARGET windows AND at least
// MOUSE_MIN_CLICKS deliberate target clicks. The click floor stops a degenerate enrollment
// (wiggling the cursor in one spot fills windows but produces no distinctive ballistic
// move-to-click motion) — you must actually navigate to and click targets across the screen.
var MOUSE_MIN_CLICKS = 12;
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
  var floatLayer = document.getElementById("floatLayer");
  var mEvents = [], down = false, doneTraining = false, clickCount = 0;
  function onTargetClick() { clickCount += 1; update(); }

  // Capture WINDOW-WIDE (document, viewport clientX/clientY) — not just inside the
  // small play area — so the enrolled motion matches exactly what the live guard sees
  // during real full-page browsing (content.js also uses clientX/clientY). Enrolling
  // in a cramped 620px box while the guard scores full-viewport motion was a
  // train/live mismatch that weakened the genuine profile.
  function push(x, y, st) { if (!doneTraining) { mEvents.push({ t: performance.now(), x: x, y: y, state: st }); if (mEvents.length % 10 === 0) update(); } }
  document.addEventListener("mousemove", function (e) { push(e.clientX, e.clientY, down ? "Drag" : "Move"); });
  document.addEventListener("mousedown", function (e) { down = true; push(e.clientX, e.clientY, "Pressed"); });
  document.addEventListener("mouseup", function (e) { down = false; push(e.clientX, e.clientY, "Released"); });

  // Floating full-viewport targets: force long, varied, cross-screen moves (the fast
  // ballistic navigation that most distinguishes users) alongside the slow, precise
  // reading motion from the inline links. Each spawns far from the last so distances
  // and directions stay varied; the pair keeps ~2 on screen at all times.
  var lastFX = window.innerWidth / 2, lastFY = window.innerHeight / 2;
  function spawnFloat() {
    if (doneTraining) return;
    var el = document.createElement("div");
    el.className = "ftarget";
    // pick a point in a random screen region that is FAR from the previous target
    var x, y, tries = 0;
    do {
      x = 60 + Math.random() * (window.innerWidth - 120);
      y = 60 + Math.random() * (window.innerHeight - 120);
      tries++;
    } while (Math.hypot(x - lastFX, y - lastFY) < Math.min(window.innerWidth, window.innerHeight) * 0.4 && tries < 12);
    lastFX = x; lastFY = y;
    el.style.left = x + "px"; el.style.top = y + "px";
    el.textContent = "●";
    el.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (el.parentNode) el.parentNode.removeChild(el);
      onTargetClick();
      if (!doneTraining) spawnFloat();   // respawn one far away — continuous target chase
    });
    floatLayer.appendChild(el);
  }
  function clearFloats() { if (floatLayer) floatLayer.innerHTML = ""; }
  for (var fi = 0; fi < MOUSE_FLOATS_ACTIVE; fi++) spawnFloat();

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
        onTargetClick();
        remaining -= 1;
        if (remaining <= 0 && !doneTraining) loadRound();   // fresh passage + links, same task
      });
    });
  }
  loadRound();

  function windows() { return M ? M.stepsToWindows(M.eventsToSteps(mEvents)) : []; }
  function update() {
    var w = windows();
    // Progress reflects BOTH requirements — the bar can't be maxed by movement alone; you
    // also have to actually click targets. It fills to whichever requirement is further behind.
    var wFrac = w.length / MOUSE_TARGET;
    var cFrac = clickCount / MOUSE_MIN_CLICKS;
    mprog.style.width = Math.min(100, Math.round(Math.min(wFrac, cFrac) * 100)) + "%";
    var enough = w.length >= MOUSE_TARGET && clickCount >= MOUSE_MIN_CLICKS;
    mstatus.textContent = enough
      ? "enough data captured"
      : w.length + " / " + MOUSE_TARGET + " windows · " + clickCount + " / " + MOUSE_MIN_CLICKS + " targets clicked"
        + (w.length >= MOUSE_TARGET ? " — keep clicking the dots/links" : (clickCount >= MOUSE_MIN_CLICKS ? " — keep moving the mouse" : ""));
    if (enough && !doneTraining) {
      doneTraining = true;
      clearFloats();
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
              saveTo: "indexeddb://cg-personal-mouse-head-" + id,
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
} // end initWizard

// ---- bootstrap: resolve the signed-in account before showing anything trainable ----
(function () {
  try {
    api.runtime.sendMessage({ type: "cg:get-account" }, function (res) {
      currentAccountId = (res && res.id) || null;
      currentAccountEmail = (res && res.email) || null;
      if (!currentAccountId) { document.getElementById("noAccountBlock").style.display = "block"; return; }
      var line = document.getElementById("accountLine");
      line.style.display = "block";
      line.textContent = "Training for: " + (currentAccountEmail || "this Chrome account");
      document.getElementById("wizardRoot").style.display = "block";
      initWizard();
    });
  } catch (e) { document.getElementById("noAccountBlock").style.display = "block"; }
})();
