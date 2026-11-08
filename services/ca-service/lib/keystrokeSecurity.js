const MIN_TRAINING_SAMPLES = 5;
const MIN_POSITIVE_WINDOWS = 12;
const MAX_TRAINING_SAMPLES = 80;
// WINDOW_SIZE must match the input shape of the trained model the model-api
// serves (MODEL_PATH in docker-compose). WS50 keeps the full rhythm context the
// GRU needs to detect sustained pace changes (e.g. slow-typing impersonation);
// shorter windows recover faster but lose that timing sensitivity.
const WINDOW_SIZE = 50;
const WINDOW_STRIDE = 10;
// Minimum typed characters before continuous-auth verification begins. Sized so
// the packet has several full windows of stable timing statistics before any
// verdict. At WS50 that is ~80 chars (~3-4 windows). The frontend reads this via
// GET /api/text/config so the client and server never drift out of sync.
const CHECK_MIN_TEXT_CHARS = 80;
const DEFAULT_CNN_THRESHOLD = 0.5;
// Version 3 = Continuum dataset digraph features [id1,id2,dwell1,dwell2,dd,ud].
// Profiles trained on the older feature scheme are treated as untrained so
// the user re-enrolls instead of being scored by an incompatible model.
const PROFILE_VERSION = 3;
// Continuous-auth decision is made on the most recent windows only
// (Lu et al. packet structure): averaging over the whole session lets a
// takeover hide behind earlier genuine typing.
// 20 windows (was 6). The 99-user paired sweep (artifacts/xai/decision_sweep.json,
// decision_paired.json) measured vote 10-of-20 against 3-of-6 on identical scores:
// false lock -8.84 pts [-10.57, -6.41], impostor capture +0.40 pts [+0.11, +0.74].
// The sweep scores full packets only; server.js keeps the same rule by treating
// windowCount <= RECENT_WINDOW_COUNT as warmup (the paste / un-verifiable /
// overwhelming-impostor fast paths still fire early). Cost: the first packet
// verdict needs 21 windows (>= 250 digraph steps) instead of 7 (>= 110); on
// stored real sessions 20 windows took about 400 keydowns.
const RECENT_WINDOW_COUNT = 20;
// The packets an organisation may choose instead (console, Protection; the operator's default;
// KEYSTROKE_DECISION_WINDOWS), always with the simple-majority vote. Only lengths measured on the
// same 99-user scores are offered (manuscript tables 9-b and 11; artifacts/xai/decision_sweep.json,
// decision_paired.json): a shorter packet gives its first verdict sooner (about 18 s of steady
// typing at 6 against 42 s at 20) but flags the genuine user more often (FRR at 0.50: 23.6% at 6,
// 18.8% at 10, 14.8% at 20); impostor capture is about the same. 20 stays the default, and every
// figure in the paper is for it. 2 and 4 (2026-11-05, the owner's option for sensitive systems; thesis only, not
// the paper) were measured the same way on the all-impostors parts (analysis/phase3/packet_length_all_2_4.py):
// the same simple-majority vote (1 of 2, 2 of 4), first verdict at 71 / 91 keystrokes (about 12 / 15 s), FRR at
// 0.50 13.9% / 12.3% against 10.1% at 6 and 3.3% at 20, FAR about 13% throughout, per-user AUC 0.934 / 0.941.
const DECISION_WINDOW_CHOICES = [2, 4, 6, 10, 20];
function decisionWindows(n) { return DECISION_WINDOW_CHOICES.includes(Number(n)) ? Number(n) : RECENT_WINDOW_COUNT; }
// The typed-text gate for a packet: CHECK_MIN_TEXT_CHARS, unless the packet's first verdict comes sooner than
// that (packet + 1 windows = WINDOW_SIZE + WINDOW_STRIDE * packet steps): 70 at 2, 80 from 4 up.
function minTextChars(packet) { return Math.min(CHECK_MIN_TEXT_CHARS, WINDOW_SIZE + WINDOW_STRIDE * decisionWindows(packet)); }
// Warm-up fast path (server.js): before the first full packet, a check whose scored windows number
// k >= WARMUP_FAST_MIN_WINDOWS with at least ceil(WARMUP_FAST_FRACTION * k) below 0.50 challenges at
// once. It was 4 windows; the OWNER chose 8 on 2026-09-26, before the user study, on exploratory
// numbers from experiment KS's A200 scores (99 users, a check after every window;
// _backups/warmup_fastpath_rate.py): genuine users locked at session start 8.1% -> 2.0%, impostor
// runs caught within warm-up 91.1% -> 87.0%. Runs it misses still meet the 10-of-20 vote after
// warm-up. A single long pause among a genuine user's first ~90 keys used to be enough.
const WARMUP_FAST_MIN_WINDOWS = 8;
const WARMUP_FAST_FRACTION = 0.75;
// An adaptive sample (the popup's "Contribute sample") is the typing behind the user's last
// SAMPLE_WINDOW_COUNT windows. All of them are scored and judged, the mean is taken over all of them, and
// only they are stored, so nothing is learned that was not judged (lastWindowsSample). Before 2026-10-19 a
// sample was the whole stretch since the previous one, of any length, of which only the last 20 windows
// were scored (mean over the last 18) while every window of it was stored and later trained on. 20 is
// also the length of the live packet.
const SAMPLE_WINDOW_COUNT = 20;
// Each of the last SAMPLE_FLOOR_WINDOWS windows of a sample must clear the window floor (server.js): a high
// mean can hide a weak window at the very end, and the end is where a takeover shows first. Three, the number
// of consecutive checks that offer a sample (the SDK's clean run), since 2026-10-19 (OWNER); it was six, the
// size of the old live packet, which is the form experiment AR measured.
const SAMPLE_FLOOR_WINDOWS = 3;
// Windows scored per check: enough for both the packet (at most 20) and a sample.
const SCORED_WINDOW_COUNT = Math.max(RECENT_WINDOW_COUNT, SAMPLE_WINDOW_COUNT);
// Fraction of recent windows scoring below the user threshold that flags the
// session. Lu et al. (2020): flag when ≥ p of packet windows score < 50%.
// At 20 windows: 10/20 = 0.50 ≥ 0.50 → SUSPICIOUS; 9/20 → tolerated.
// Raised from 1/3 to 0.50 to reduce false rejections for genuine users
// who momentarily type differently, while still catching impostors.
const PACKET_VOTE_FRACTION = 0.50;
// Fixed window decision boundary, exactly as in Lu et al. (2020): a window is
// "low" when its genuine probability < 0.50 (the natural softmax boundary). The
// per-user model provides the personalisation; the threshold is NOT tuned per
// user for the live decision. The per-user EER is still computed at training
// time but only as a reported research metric (profile.threshold).
const WINDOW_DECISION_THRESHOLD = 0.50;
// Warmup cap. A genuine typist forms a full 50-step window within ~60–80
// keystrokes. If FAR more keys than that (this many) still produce zero scorable
// windows, the input is un-modelable — key-rollover, held keys (autorepeat, no
// key-ups) or synthetic batching — which is exactly how an impostor could evade
// evaluation by never leaving "warmup". Past this bound we stop treating a
// window-less session as warmup and flag it so the passkey challenge can fire.
const UNVERIFIABLE_KEY_COUNT = 120;
// Negatives for per-user training (T3.3): real typists from the Aalto 136M-keystroke study,
// the 200 of experiment KS's A200 arm, instead of other app users' samples. Until then the
// live negatives were the 40 seeded KeyRecs accounts, i.e. KS's REF arm, and all three Aalto
// arms beat it: A1000 - REF +0.020 [+0.010, +0.031] per-user AUC of 20-window decisions
// (confirmatory), A200 - REF +0.027 [+0.017, +0.039] (docs/recovery/RESULTS_KS.md). A200 was
// picked post hoc among the three. A mix of app users and Aalto was not tested, so app-user
// samples are no longer sent. The file (build_aalto_negatives.py) lives on model-api's side;
// all its windows are eligible and model-api groups them by typist for the validation split.
const NEGATIVES_SOURCE = "aalto-A200";
const NEGATIVES_DATASET_PATH = process.env.KEYSTROKE_NEGATIVES_PATH || "/app/data/aalto_neg_A200.h5";
// MODEL_API_URL now lives in lib/modelClient.js — the single, authenticated, bounded hop.

function normalizeEvents(events) {
  if (!Array.isArray(events)) return [];

  return events
    .map((evt) => ({
      keyCode: Number(evt.keyCode),
      eventType:
        evt.eventType === "keyup"
          ? "keyup"
          : evt.eventType === "paste"
            ? "paste"
            : "keydown",
      timestampRelative: Number(evt.timestampRelative),
      fieldName: evt.fieldName || "unknown",
      fieldType: evt.fieldType || "unknown",
      pastedLength: Number(evt.pastedLength || 0),
    }))
    .filter(
      (evt) =>
        Number.isFinite(evt.keyCode) &&
        Number.isFinite(evt.timestampRelative) &&
        evt.timestampRelative >= 0,
    )
    .sort((a, b) => a.timestampRelative - b.timestampRelative);
}

function analyzeKeystrokeTiming(events) {
  const normalized = normalizeEvents(events);
  if (normalized.length < 2) {
    return {
      avgDwellTime: 0,
      avgFlightTime: 0,
      maxFlightTime: 0,
      totalDwellTime: 0,
      totalFlightTime: 0,
      eventCount: normalized.length,
      keyCount: 0,
      durationMs: 0,
      avgTimePerKey: 0,
      windowCount: 0,
    };
  }

  const dwellTimes = [];
  const flightTimes = [];
  const lastDownByFieldAndKey = new Map();
  let previousKeyUp = null;
  let keyCount = 0;

  for (const evt of normalized) {
    const keyId = `${evt.fieldName}:${evt.keyCode}`;

    if (evt.eventType === "paste") {
      continue;
    }

    if (evt.eventType === "keydown") {
      keyCount += 1;
      if (previousKeyUp) {
        const flight = evt.timestampRelative - previousKeyUp.timestampRelative;
        if (flight >= 0 && flight < 10000) flightTimes.push(flight);
      }
      lastDownByFieldAndKey.set(keyId, evt);
      continue;
    }

    const matchingDown = lastDownByFieldAndKey.get(keyId);
    if (matchingDown) {
      const dwell = evt.timestampRelative - matchingDown.timestampRelative;
      if (dwell >= 0 && dwell < 5000) dwellTimes.push(dwell);
      lastDownByFieldAndKey.delete(keyId);
    }
    previousKeyUp = evt;
  }

  const avg = (arr) =>
    arr.length > 0 ? arr.reduce((total, value) => total + value, 0) / arr.length : 0;
  const durationMs =
    normalized[normalized.length - 1].timestampRelative - normalized[0].timestampRelative;
  const avgTimePerKey = keyCount > 1 && durationMs > 0 ? durationMs / keyCount : 0;

  return {
    avgDwellTime: avg(dwellTimes),
    avgFlightTime: avg(flightTimes),
    maxFlightTime: flightTimes.length > 0 ? Math.max(...flightTimes) : 0,
    totalDwellTime: dwellTimes.reduce((total, value) => total + value, 0),
    totalFlightTime: flightTimes.reduce((total, value) => total + value, 0),
    eventCount: normalized.length,
    keyCount,
    durationMs,
    avgTimePerKey,
    windowCount: eventsToFeatureWindows(normalized).length,
  };
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// Pause filtering. Down-down gaps beyond ~1 s are COMPOSITION pauses (thinking
// between phrases / away from the keys), not typing rhythm, so they are
// dropped unconditionally. Free-text writing naturally produces CLUSTERS of
// such gaps (think → type → think); an earlier rule that kept clustered gaps
// (to expose slow-typing impostors) made those genuine windows score ~0.2 and
// false-locked the real user. Impostor detection is unaffected: the rhythm
// signature lives in the kept sub-second digraph statistics.
const PAUSE_DD_SECONDS = 1.0; // gaps above this are composition pauses — dropped
// Physically-impossible timing guard. Browser event batching (main-thread
// jank) can stamp several key events with the same handler-run time, yielding
// dd ≈ 0 ms and dwell ≈ 10 ms rows — no human types two sequential keys
// <15 ms apart (dataset p1: dd 46 ms, dwell 47 ms). Such rows are measurement
// artifacts, not rhythm, and crash genuine windows as out-of-distribution.
const MIN_HUMAN_DD_SECONDS = 0.015;
const MIN_HUMAN_DWELL_SECONDS = 0.01;

/**
 * Convert raw key events into Continuum dataset digraph steps:
 *   [id1, id2, dwell1, dwell2, dd, ud]
 * with key codes normalized by 254 and all times in seconds, matching the
 * Rand_WS*.h5 training data format exactly so the pre-trained CNN+GRU base
 * model can be fine-tuned on and applied to live typing.
 */
function eventSteps(events) {
  return eventStepsTimed(events).map((s) => s.row);
}

// eventSteps with each step's client timestamps (t0 = first keydown, t1 = second keydown, up1 = the second
// key's release), which identify a window across overlapping checks for the user-study log and mark where a
// run of windows begins and ends. The rows are eventSteps'.
function eventStepsTimed(events) {
  const normalized = normalizeEvents(events);
  const lastDownByFieldAndKey = new Map();
  const keyUps = new Map();
  const downs = [];

  for (const evt of normalized) {
    const keyId = `${evt.fieldName}:${evt.keyCode}`;
    if (evt.eventType === "paste") {
      continue;
    }

    if (evt.eventType === "keydown") {
      lastDownByFieldAndKey.set(keyId, evt);
      downs.push(evt);
      continue;
    }

    const down = lastDownByFieldAndKey.get(keyId);
    if (down) {
      keyUps.set(down, evt);
      lastDownByFieldAndKey.delete(keyId);
    }
  }

  // First pass: build all valid candidate digraphs together with their gap.
  const raw = [];
  for (let i = 0; i + 1 < downs.length; i += 1) {
    const first = downs[i];
    const second = downs[i + 1];
    if (first.fieldName !== second.fieldName) continue;

    const firstUp = keyUps.get(first);
    const secondUp = keyUps.get(second);
    if (!firstUp || !secondUp) continue;

    const dwell1 = (firstUp.timestampRelative - first.timestampRelative) / 1000;
    const dwell2 = (secondUp.timestampRelative - second.timestampRelative) / 1000;
    const dd = (second.timestampRelative - first.timestampRelative) / 1000;
    const ud = (second.timestampRelative - firstUp.timestampRelative) / 1000;
    if (dwell1 < 0 || dwell2 < 0 || dd < 0) continue;
    // Drop event-batching artifacts (impossible timings), not slow/fast typing.
    if (
      dd < MIN_HUMAN_DD_SECONDS ||
      dwell1 < MIN_HUMAN_DWELL_SECONDS ||
      dwell2 < MIN_HUMAN_DWELL_SECONDS
    )
      continue;

    raw.push({
      row: [
        clamp01(first.keyCode / 254),
        clamp01(second.keyCode / 254),
        dwell1,
        dwell2,
        dd,
        ud,
      ],
      dd,
      t0: first.timestampRelative,
      t1: second.timestampRelative,
      up1: secondUp.timestampRelative,
    });
  }

  // Second pass: drop ALL long gaps (> PAUSE_DD_SECONDS) unconditionally.
  // Gaps beyond ~1 s are COMPOSITION pauses (thinking between phrases), not
  // typing rhythm. We previously kept CLUSTERED long gaps so a slow-typing
  // impostor would stay visible, but real free-text writing produces exactly
  // such clusters (think → type → think), and windows containing several
  // 0.8–1.9 s gaps scored 0.19–0.21 for the genuine user → false locks.
  // Impostor detection is unaffected: an impostor's rhythm signature lives in
  // the sub-second digraphs (dwell, dd, ud statistics), which are all kept —
  // only the between-phrase silences are removed. Decisions remain stable
  // because each drop depends only on the digraph's own dd value.
  const steps = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i].dd > PAUSE_DD_SECONDS) continue; // composition pause — not rhythm
    steps.push({ row: raw[i].row, t0: raw[i].t0, t1: raw[i].t1, up1: raw[i].up1 });
  }
  return steps;
}

// eventsToFeatureWindows plus one key per window: "<first step t0>-<last step t1>" in client
// milliseconds. Two windows with the same key hold the same 50 steps.
function featureWindowsWithKeys(events) {
  const steps = eventStepsTimed(events);
  if (steps.length < WINDOW_SIZE) return { windows: [], keys: [] };
  const windows = [];
  const keys = [];
  for (let start = 0; start <= steps.length - WINDOW_SIZE; start += WINDOW_STRIDE) {
    const w = steps.slice(start, start + WINDOW_SIZE);
    windows.push(w.map((s) => s.row));
    keys.push(`${w[0].t0}-${w[WINDOW_SIZE - 1].t1}`);
  }
  return { windows, keys };
}

function eventsToFeatureWindows(events) {
  const steps = eventSteps(events);
  // The model was trained on full windows only; padded windows would be
  // out-of-distribution, so short samples produce no windows.
  if (steps.length < WINDOW_SIZE) return [];
  const windows = [];

  // STRIDE-ALIGNED windows ONLY — exactly like the training data. We previously
  // appended an extra end-anchored "tail" window when the step count wasn't a
  // multiple of the stride, but that window is out-of-spec (the model never saw
  // arbitrarily-offset windows in training), its content SHIFTS with every new
  // keystroke (unstable scores between checks), and it double-weights the very
  // newest digraphs. In practice it was the tie-breaker that flipped genuine
  // packets from a tolerated 2/6 low vote to a 3/6 FAIL → false passkey locks.
  for (let start = 0; start <= steps.length - WINDOW_SIZE; start += WINDOW_STRIDE) {
    windows.push(steps.slice(start, start + WINDOW_SIZE));
  }

  return windows;
}

// What an adaptive contribution is made of: the typing behind `n` consecutive windows of `events`, windows
// `start` to `start + n - 1`, from the first key press of the first to the release of the last key of the
// last. Windows are aligned to the start of the events they come from, and window `start` begins a whole
// number of strides after that start, so cutting there and windowing again gives exactly those `n` windows.
// That is checked row by row: a cut that does not reproduce them is not returned, because a sample must
// contain nothing that was not judged. Returns how many windows the stretch has and the events to judge and
// store, or events: null when there are no such windows or the cut does not reproduce them.
function windowsSample(events, start, n = SAMPLE_WINDOW_COUNT) {
  const steps = eventStepsTimed(events);
  const windows = steps.length >= WINDOW_SIZE ? Math.floor((steps.length - WINDOW_SIZE) / WINDOW_STRIDE) + 1 : 0;
  if (!Number.isInteger(start) || start < 0 || start + n > windows) return { windows, events: null };
  const from = steps[start * WINDOW_STRIDE].t0;
  const to = start + n === windows ? Infinity : steps[(start + n - 1) * WINDOW_STRIDE + WINDOW_SIZE - 1].up1;
  const kept = events.filter((e) => Number(e.timestampRelative) >= from && Number(e.timestampRelative) <= to);
  const wanted = eventsToFeatureWindows(events).slice(start, start + n);
  const got = eventsToFeatureWindows(kept);
  if (got.length !== n || JSON.stringify(got) !== JSON.stringify(wanted)) return { windows, events: null, cutFailed: true };
  return { windows, events: kept };
}

// The default: the last `n` windows of the stretch, what the user typed last.
function lastWindowsSample(events, n = SAMPLE_WINDOW_COUNT) {
  const windows = eventsToFeatureWindows(events).length;
  return windows < n ? { windows, events: null } : windowsSample(events, windows - n, n);
}

// Every window of `events` with its genuine probability from the user's model, in one request; the windows
// are the ones eventsToFeatureWindows gives. Null when the user has no model or the model service does not
// answer.
async function scoreStretch({ events, userId, db }) {
  const profile = await getUserTypingProfile(userId, db);
  if (!profile || profile.type !== "per-user-cnn-lstm" || Number(profile.version) < PROFILE_VERSION) return null;
  const windows = eventsToFeatureWindows(events);
  if (!windows.length) return { windows: 0, scores: [] };
  try {
    const result = await postModelApi("/api/user/predict", {
      userId, windows, modelPath: profile.modelPath, threshold: WINDOW_DECISION_THRESHOLD,
    });
    return { windows: windows.length, scores: Array.isArray(result.prediction) ? result.prediction.map((p) => Number(p[1])) : [] };
  } catch (err) {
    return null;
  }
}

// The organisation's choice "anywhere in the typing" (adaptiveSampleFrom): the NEWEST run of `n` consecutive
// windows of the stretch that would be accepted, and the rest of the stretch is ignored. Every window is
// scored once and a run qualifies on the rule server.js applies to a sample: a mean of at least `meanMin` and
// each of its last SAMPLE_FLOOR_WINDOWS windows at least `floor`. When none qualifies, or there is no model to
// ask, the last `n` windows are returned, so the usual checks refuse them with their own reason.
async function newestQualifyingSample({ events, userId, db, meanMin, floor, n = SAMPLE_WINDOW_COUNT }) {
  const end = lastWindowsSample(events, n);
  if (!end.events) return end;
  const scored = await scoreStretch({ events, userId, db });
  if (!scored || scored.scores.length !== end.windows) return end;
  for (let start = end.windows - n; start >= 0; start -= 1) {
    const run = scored.scores.slice(start, start + n);
    const mean = run.reduce((a, b) => a + b, 0) / n;
    if (mean >= meanMin && Math.min(...run.slice(-SAMPLE_FLOOR_WINDOWS)) >= floor) {
      const picked = windowsSample(events, start, n);
      if (picked.events) return picked;
    }
  }
  return end;
}

// Key presses that type something (space, digits, letters, numpad, punctuation): the unit the SDK reports as
// the length of a sample, since it never sends the text.
function printableKeyCount(events) {
  return normalizeEvents(events).filter((e) => {
    const k = e.keyCode;
    return e.eventType === "keydown" && (k === 32 || (k >= 48 && k <= 90) || (k >= 96 && k <= 111) || (k >= 186 && k <= 222));
  }).length;
}

// Rhythm-consistency check for adaptive contributions. Every other adaptive-learning
// gate (confidence floor, dedup, per-day cap) judges a candidate sample through the
// CURRENT model's own opinion — circular for a still-young model that hasn't reliably
// learned this person's rhythm yet. This check is model-independent: it compares the
// candidate's own timing statistics directly against this same user's already-enrolled
// history, so it can catch an inconsistent sample even before the model is any good.
//
// Indexes into an eventSteps() row [id1,id2,dwell1,dwell2,dd,ud]: only the three
// INDEPENDENT timing features are checked (dwell1, dwell2, dd) — id1/id2 are which-key
// identity, not rhythm, and ud is algebraically redundant (ud = dd - dwell1 exactly).
const RHYTHM_FEATURE_INDEXES = [2, 3, 4];
const RHYTHM_FEATURE_LABELS = ["dwell1", "dwell2", "dd"];
// A conservative starting bound, not a data-derived optimum — see the "quality-filtered
// enrolment volume" experiment on the roadmap, which would calibrate this from evidence
// rather than a heuristic guess.
const RHYTHM_Z_SCORE_LIMIT = 3.0;
// Below this many historical digraphs, per-feature std is too noisy to judge against —
// fail OPEN (treat as consistent) rather than block early contributions a fresh
// enrolment needs.
const RHYTHM_MIN_HISTORY_DIGRAPHS = 100;

function digraphFeatureMeans(events) {
  const steps = eventSteps(events);
  if (!steps.length) return null;
  const sums = RHYTHM_FEATURE_INDEXES.map(() => 0);
  for (const row of steps) {
    RHYTHM_FEATURE_INDEXES.forEach((idx, i) => { sums[i] += row[idx]; });
  }
  return { means: sums.map((s) => s / steps.length), count: steps.length };
}

// Pooled mean/std per feature across every historical DIGRAPH (not a mean-of-per-sample
// means) — pooling at the digraph level is what makes the std reflect this user's true
// spread rather than being understated by averaging away sample-to-sample variation.
function digraphFeatureStats(eventsList) {
  const sums = RHYTHM_FEATURE_INDEXES.map(() => 0);
  const sqSums = RHYTHM_FEATURE_INDEXES.map(() => 0);
  let n = 0;
  for (const events of eventsList) {
    const steps = eventSteps(events);
    for (const row of steps) {
      RHYTHM_FEATURE_INDEXES.forEach((idx, i) => {
        sums[i] += row[idx];
        sqSums[i] += row[idx] * row[idx];
      });
      n += 1;
    }
  }
  if (n < RHYTHM_MIN_HISTORY_DIGRAPHS) return null;
  const means = sums.map((s) => s / n);
  const stds = sqSums.map((sq, i) => Math.sqrt(Math.max(sq / n - means[i] * means[i], 1e-8)));
  return { means, stds, n };
}

// historicalEventsList = one raw keystrokeEvents array per already-enrolled sample for
// this user (fetch via each sample's stored events, NOT the derived windows — the
// comparison is on raw digraph timing, before scaling/model scoring).
function checkRhythmConsistency(candidateEvents, historicalEventsList) {
  const history = digraphFeatureStats(historicalEventsList || []);
  if (!history) return { consistent: true, reason: "not enough enrolled history to judge yet" };
  const candidate = digraphFeatureMeans(candidateEvents);
  if (!candidate) return { consistent: true, reason: "no scorable digraphs in candidate" };
  const zScores = candidate.means.map((m, i) => (m - history.means[i]) / (history.stds[i] || 1e-8));
  let worstIdx = 0;
  zScores.forEach((z, i) => { if (Math.abs(z) > Math.abs(zScores[worstIdx])) worstIdx = i; });
  return {
    consistent: Math.abs(zScores[worstIdx]) <= RHYTHM_Z_SCORE_LIMIT,
    worstFeature: RHYTHM_FEATURE_LABELS[worstIdx],
    worstZ: zScores[worstIdx],
    zScores,
    historyDigraphCount: history.n,
  };
}

// `knownLength` lets a client send the trimmed text LENGTH instead of the text (the user-study
// extension does): the length is all this uses.
function typingQuality(textContent, events, knownLength = null) {
  const normalized = normalizeEvents(events);
  const textLength = textContent != null || !Number.isFinite(Number(knownLength))
    ? String(textContent || "").trim().length
    : Math.max(0, Math.floor(Number(knownLength)));
  const keydownCount = normalized.filter((evt) => evt.eventType === "keydown").length;
  const pasteEvents = normalized.filter((evt) => evt.eventType === "paste");
  const pastedLength = pasteEvents.reduce((total, evt) => total + Number(evt.pastedLength || 0), 0);
  const coverage = textLength > 0 ? keydownCount / textLength : 0;
  const windows = eventsToFeatureWindows(normalized);

  return {
    textLength,
    keydownCount,
    pasteCount: pasteEvents.length,
    pastedLength,
    typedCoverage: coverage,
    windowCount: windows.length,
    acceptableForEnrollment:
      textLength >= 120 &&
      pasteEvents.length === 0 &&
      coverage >= 0.75 &&
      windows.length > 0,
  };
}

// Pastes into each field (owner, 2026-10-25): an organisation allows a number of pastes per field
// (lib/appSettings.js pasteAllowance, "unlimited" by default) and every paste counts, however short. A field
// is its name and type as the client reported them. The count covers the events a check carries, which the
// clients clear after each passkey verification, so it starts again after every verification. It replaced
// "more than 80 pasted characters in all".
function pasteCountsByField(events) {
  const counts = {};
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.eventType !== "paste") continue;
    const field = `${String(e.fieldName || "page")}|${String(e.fieldType || "")}`;
    counts[field] = (counts[field] || 0) + 1;
  }
  return counts;
}
function pastePolicyViolation(events, allowance) {
  if (!Number.isFinite(allowance)) return false;   // unlimited
  return Object.values(pasteCountsByField(events)).some((n) => n > allowance);
}

// Ties (equal timestamps, about a third of the samples have some) are broken by id, the order the
// events were stored in. SQLite already returned them in that order; saying so makes PostgreSQL return
// the same windows (checked on the real data: no sample's result changes).
async function getSampleEvents(textId, db) {
  return (await db.all(
      `SELECT key_code, event_type, timestamp_relative, field_name, field_type
       FROM keystroke_events
       WHERE keystroke_text_id = ?
       ORDER BY timestamp_relative ASC, id ASC`,
      textId))
    .map((row) => ({
      keyCode: row.key_code,
      eventType: row.event_type,
      timestampRelative: row.timestamp_relative,
      fieldName: row.field_name,
      fieldType: row.field_type,
    }));
}

async function getTrainingSampleRows(userId, db) {
  // Uses ALL training samples (enrollment + adaptive), newest first. We tested
  // capping the adaptive share to 2× enrollment to counter template narrowing,
  // but a held-out validation (80 genuine activity windows) showed the capped
  // model scored WORSE (mean 0.74 vs 0.92, 21 vs 3 windows below 0.5): the cap
  // starves the positive class and over-weights months-old enrollment typing.
  // More genuine data — even if skewed clean — beats less-but-balanced here.
  // Samples stored in the same second are ordered by id, as SQLite already did.
  return db.all(
      `SELECT id
       FROM keystroke_texts
       WHERE user_id = ?
         AND is_training = 1
         AND is_suspicious = 0
       ORDER BY submitted_at DESC, id ASC
       LIMIT ?`,
      userId, MAX_TRAINING_SAMPLES);
}

// Windows slide with an 80% overlap, so two windows from the SAME sample share
// most of their rows. The model-api needs to know which sample each window came
// from, or its train/validation split puts near-duplicates on both sides and
// every validation figure — including the calibrated threshold — is measured
// against data the model already saw. So carry the sample id alongside.
async function getTrainingWindowsGrouped(userId, db, rows) {
  rows = rows || await getTrainingSampleRows(userId, db);
  const windows = [];
  const groups = [];
  for (const row of rows) {
    for (const w of eventsToFeatureWindows(await getSampleEvents(row.id, db))) {
      windows.push(w);
      groups.push(row.id);
    }
  }
  return { windows, groups };
}

async function getTrainingWindows(userId, db) {
  return (await getTrainingWindowsGrouped(userId, db)).windows;
}

// A user may exist under more than one id — a demo account id and a hashed CA
// uid for the same human. Those aliases land in the negative pool, so the model
// is trained to reject its own owner's typing. Observed live: 44 of user 1's
// negative samples belonged to an id sharing all 71 of user 1's distinct texts.
//
// Aliases are detected by verbatim text overlap, but the test cannot be "shares
// any text": the fixed enrolment prompts are typed by EVERY user by design, so a
// genuine impostor legitimately shares a handful. An alias shares nearly
// everything. So compare the SHARE of the candidate's own distinct long texts
// that also belong to the target, and drop it only past a majority.
const ALIAS_TEXT_OVERLAP = 0.5;   // >50% of a candidate's own texts are the target's
const ALIAS_MIN_TEXTS = 4;        // below this, overlap is not evidence either way

async function aliasUserIds(userId, db) {
  const own = new Set(
    (await db.all(
        "SELECT DISTINCT text_hash t FROM keystroke_texts WHERE user_id = ? AND text_hash IS NOT NULL AND char_count > 40",
        userId))
      .map((r) => r.t),
  );
  if (own.size === 0) return new Set();
  const candidates = (await db.all(
      `SELECT DISTINCT user_id u FROM keystroke_texts
       WHERE user_id <> ? AND is_training = 1 AND is_suspicious = 0`,
      userId))
    .map((r) => r.u);
  const aliases = new Set();
  for (const u of candidates) {
    const texts = (await db.all(
        "SELECT DISTINCT text_hash t FROM keystroke_texts WHERE user_id = ? AND text_hash IS NOT NULL AND char_count > 40",
        u))
      .map((r) => r.t);
    if (texts.length < ALIAS_MIN_TEXTS) continue;
    const shared = texts.filter((t) => own.has(t)).length;
    if (shared / texts.length > ALIAS_TEXT_OVERLAP) {
      aliases.add(u);
      console.log(
        `[negatives] excluding user ${u} from user ${userId}'s negatives: ${shared}/${texts.length} texts shared — same person under another id`,
      );
    }
  }
  return aliases;
}

// THE definition of which samples may serve as negatives for a user. Exported for
// validation so a test asserts against the shipped selection rather than a copy of
// the query that could drift away from it.
async function negativeSampleRows(userId, db) {
  const aliases = await aliasUserIds(userId, db);
  return (await db.all(
      `SELECT id, user_id, text_hash
       FROM keystroke_texts
       WHERE user_id <> ?
         AND is_training = 1
         AND is_suspicious = 0
       ORDER BY submitted_at DESC, id ASC
       LIMIT ?`,
      userId, MAX_TRAINING_SAMPLES))
    .filter((r) => !aliases.has(r.user_id));
}

// Was this profile trained on other negatives than the current NEGATIVES_SOURCE? Such a profile
// is retrained once (server.js activity path and the login hook below). This replaces the old
// pool-growth refresh: negatives no longer come from other app users, so new enrolments do not
// change what a retrain would learn from.
async function needsNegativesRefresh(userId, db) {
  const profile = await getUserTypingProfile(userId, db);
  return isServedProfile(profile) && profile.negatives !== NEGATIVES_SOURCE;
}

// A profile the live check actually scores with. Rows from an older feature scheme are kept
// but treated as untrained; retraining them is the enrolment flow's job, not a refresh's (two
// such rows have samples that give no window under the current scheme, so a refresh would be
// queued on every visit and never save anything).
function isServedProfile(profile) {
  return !!profile && profile.type === "per-user-cnn-lstm" && Number(profile.version) >= PROFILE_VERSION;
}

// Authenticated + deadline-bounded. See lib/modelClient.js for why the local copy of this
// function (a bare, credential-less, unbounded fetch) had to go.
const { postModelApi, ModelUnavailableError } = require("./modelClient");
const studyLog = require("./studyLog");
// The live keystroke decision rule, as the user-study log records it: fixed 0.50 window boundary,
// packet vote over the last `packet` windows (the organisation's choice, 20 by default), and the
// warm-up fast path's minimum.
function ruleVersion(packet) {
  const n = decisionWindows(packet);
  return `lu-050-${Math.ceil(n * PACKET_VOTE_FRACTION)}of${n}-warm${WARMUP_FAST_MIN_WINDOWS}`;
}
const RULE_VERSION = ruleVersion(RECENT_WINDOW_COUNT);

async function saveProfile(userId, db, profile) {
  await db.run(
    `INSERT INTO user_typing_profiles (user_id, model_json, sample_count, trained_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       model_json = excluded.model_json,
       sample_count = excluded.sample_count,
       trained_at = CURRENT_TIMESTAMP`,
    userId, JSON.stringify(profile), profile.sampleCount);
}

// Held-out genuine typing for the model-update acceptance test: typing by the user that NEITHER model was fitted on.
// It used to be the activity samples (is_training = 0) that /submit stored, but nothing has written those since samples
// come only from the passkey-confirmed popup (2026-10-05), so the test found no held-out windows and every retrain was
// accepted (found 2026-11-08). A retrain now holds its NEWEST training sample out of the new fit. In an adaptive retrain
// that is one of the samples just confirmed, so the model in use never saw it either, and both models are scored on
// the same unseen typing. The sample is not lost: it stays a training sample and is fitted from the next retrain on.
// 20 windows = one popup sample, which is exactly 20 windows.
const GATE_MIN_WINDOWS = 20;

// Whether the samples a fit was made from are still this user's training samples. A reset clears them
// (POST /v1/keystroke/reset), and a fit that ran across a reset must not be saved: it was, so a reset during training
// was silently undone by the model built from the samples it had just removed (2026-11-08).
async function samplesStillTraining(userId, db, ids) {
  if (!ids.length) return false;
  const r = await db.get(
    `SELECT COUNT(*) AS n FROM keystroke_texts
     WHERE user_id = ? AND is_training = 1 AND is_suspicious = 0 AND id IN (${ids.map(() => "?").join(",")})`,
    userId, ...ids);
  return Number(r && r.n) === ids.length;
}

async function scoreWindowsWithModel(userId, windows, modelPath) {
  const res = await postModelApi("/api/user/predict", {
    userId,
    windows,
    modelPath,
    threshold: DEFAULT_CNN_THRESHOLD,
  });
  return Array.isArray(res.prediction) ? res.prediction.map((p) => Number(p[1])) : [];
}

async function trainUserTypingProfile(userId, db) {
  const rows = await getTrainingSampleRows(userId, db);   // newest first
  const sampleIds = rows.map((r) => r.id);
  const previous = await getUserTypingProfile(userId, db);
  // A retrain holds out its newest sample for the acceptance test (above) when the rest still makes a model; the first
  // training (enrolment) uses every sample.
  // The newest is the one stored last (ids grow with each insert; rows sharing a second are ordered by id ASC).
  // A sample too short to test is not held out: it is fitted like the rest.
  let held = previous && previous.modelPath && rows.length > MIN_TRAINING_SAMPLES ? rows.reduce((a, r) => (Number(r.id) > Number(a.id) ? r : a)) : null;
  let heldOut = held ? eventsToFeatureWindows(await getSampleEvents(held.id, db)) : [];
  if (heldOut.length < GATE_MIN_WINDOWS) { held = null; heldOut = []; }
  let positive = await getTrainingWindowsGrouped(userId, db, held ? rows.filter((r) => r !== held) : rows);
  if (held && positive.windows.length < MIN_POSITIVE_WINDOWS) {
    held = null; heldOut = [];
    positive = await getTrainingWindowsGrouped(userId, db, rows);
  }
  const sampleCount = rows.length - (held ? 1 : 0);   // the samples this fit is made from
  const positiveWindows = positive.windows;
  if (sampleCount < MIN_TRAINING_SAMPLES || positiveWindows.length < MIN_POSITIVE_WINDOWS) {
    return null;
  }

  const result = await postModelApi("/api/user/train", {
    userId,
    positiveWindows,
    // all max(2 x positives, 60) negatives come from the Aalto file (NEGATIVES_SOURCE)
    negativeWindows: [],
    negativeDatasetPath: NEGATIVES_DATASET_PATH,
    negativeDatasetMaxWindows: 0,
    // one source-sample id per window, so the split keeps whole samples together
    positiveGroups: positive.groups,
    overlapGap: Math.ceil(WINDOW_SIZE / WINDOW_STRIDE),
    minPositiveWindows: MIN_POSITIVE_WINDOWS,
    // Model storage is OWNED by the model-api: we say what (userId + modality),
    // it decides where. No filesystem coupling between the services.
    modality: "keystroke",
    // The evaluated recipe (KS, EC, AR2: up to 30 epochs, patience 6). It was 25 here until 2026-10-23, which cut
    // training short for the ~3 in 4 owners whose validation loss was still falling after epoch 25.
    epochs: 30,
    batchSize: 16,
    // the version in use: the model service keeps it when it removes old versions
    currentModelPath: previous ? previous.modelPath : null,
  });
  // A model service with versions (model_store.py) returns a new version and keeps every older one as
  // it was: the previous model is the one this profile points at, and a rejected fit is discarded. One
  // without versions overwrote the folder, kept a snapshot (previousModelPath) and restores it.
  const previousPath = result && result.versioned ? (previous ? previous.modelPath : null) : result && result.previousModelPath;
  const discardNew = () => postModelApi("/api/user/rollback",
    result.versioned ? { userId, modelPath: result.modelPath } : { userId });

  // A degraded negative pool produces a weak model that still trains "successfully".
  // It used to pass unremarked; surface it so a broken dataset path is visible in
  // the service log instead of only in the resulting accuracy months later.
  // With no app-user negatives any more, a missing Aalto file would fall through to synthetic
  // noise, so this is now a failed training: the new model is rolled back and the previous
  // profile keeps serving.
  if (result && (result.datasetNegativeError || result.negativeSource !== "dataset")) {
    console.error(
      `[train] DEGRADED NEGATIVES user=${userId} source=${result.negativeSource} ` +
        `reason=${result.datasetNegativeError || "no dataset negatives available"}`,
    );
    if (result.versioned || result.previousModelPath) await discardNew();
    throw new Error(`keystroke training needs the ${NEGATIVES_SOURCE} negatives: ` +
      `${result.datasetNegativeError || `got ${result.negativeSource}`}`);
  }
  // The evaluated recipe fine-tunes the base model. The model service trains from scratch when the base is missing or
  // does not fit (a broken image or volume): a different, never evaluated model that still "trains". It was served
  // until 2026-11-08; now it is a failed training like the one above.
  if (result && result.trainedFrom === "scratch") {
    console.error(`[train] NO BASE MODEL user=${userId}: the model service trained from scratch, not from the base`);
    if (result.versioned || result.previousModelPath) await discardNew();
    throw new Error("keystroke training needs the base model: the model service trained from scratch");
  }

  // A reset during the fit (the samples it was made from are no longer training samples): nothing is saved, and the
  // new model goes. A reset just as the profile is saved is caught after the save (below).
  const discardMoot = async (when) => {
    console.warn(`[train] user=${userId}: the typing samples were reset ${when}; the new model is discarded`);
    await discardNew().catch((e) => console.error(`[train] user=${userId}: discarding the new model failed: ${e.message}`));
    return null;
  };
  if (!(await samplesStillTraining(userId, db, sampleIds))) return discardMoot("during the training");

  // ---- Model-update ACCEPTANCE TEST (validation-gated update) ----
  // Retraining is stochastic: on identical data, successive fits scored a
  // held-out genuine set anywhere from mean 0.92 down to 0.74. A bad fit that
  // silently replaces a good live model causes immediate false rejections
  // ("it fails right after I contribute"). So before accepting the new model
  // we score both the new fit and the pre-retrain snapshot on held-out
  // genuine windows; if the new one is clearly worse we ROLL BACK and keep
  // the proven model. The stored samples still count toward future retrains.
  // The gate guards against a bad fit of the SAME recipe. A deliberate recipe change, tested before
  // it was deployed, skips it (a rollback there would re-save the old profile, which would ask for
  // this retrain again): the one retrain that moves a profile to NEGATIVES_SOURCE (tested in KS), and
  // the first retrain on a new base (result.baseModel). On 2026-10-25 the base moved from ws50-gru
  // (GRU 32) to ws50-gru-v2 (GRU 16), the base every typing result in the paper was measured with;
  // profiles from before record no base. Both models are still scored and logged, for the record.
  const negativesChange = !!previous && previous.negatives !== NEGATIVES_SOURCE;
  const baseChange = !!previous && !!result.baseModel && previous.baseModel !== result.baseModel;
  const migrating = negativesChange || baseChange;
  if (migrating) {
    console.log(`[retrain-gate] user=${userId} ` + [
      negativesChange && `negatives ${previous.negatives || "app-users"} -> ${NEGATIVES_SOURCE}`,
      baseChange && `base ${previous.baseModel || "unrecorded"} -> ${result.baseModel}`,
    ].filter(Boolean).join(", ") + ": recipe change, gate skipped");
  }
  // The held-out sample (above) is scored by both models. A new fit that cannot score it is a failed training (it would
  // fail every check too); a model in use that cannot score it (its files gone) leaves the new fit, which can. Until
  // 2026-11-08 any error here accepted the new model unchecked.
  if (previousPath && heldOut.length >= GATE_MIN_WINDOWS) {
    const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    const lows = (a) => a.filter((v) => v < DEFAULT_CNN_THRESHOLD).length;
    let newScores = [];
    try { newScores = await scoreWindowsWithModel(userId, heldOut, result.modelPath); }
    catch (e) { console.error(`[retrain-gate] user=${userId} the new fit could not score: ${e.message}`); }
    if (newScores.length !== heldOut.length) {
      await discardNew();
      throw new Error(`the new typing model scored ${newScores.length} of ${heldOut.length} held-out windows`);
    }
    let prevScores = null;
    try { prevScores = await scoreWindowsWithModel(userId, heldOut, previousPath); }
    catch (e) { console.error(`[retrain-gate] user=${userId} the model in use could not score (${e.message}): the new fit is kept`); }
    if (prevScores && prevScores.length === newScores.length) {
      const newMean = mean(newScores);
      const prevMean = mean(prevScores);
      const regressed = newMean < prevMean - 0.02 || lows(newScores) > lows(prevScores) + 2;
      console.log(
        `[retrain-gate] user=${userId} heldOut=${heldOut.length} (sample ${held.id}) prevMean=${prevMean.toFixed(3)} newMean=${newMean.toFixed(3)} prevLows=${lows(prevScores)} newLows=${lows(newScores)} → ${migrating ? "recipe change, kept" : regressed ? "ROLLBACK" : "accept"}`,
      );
      if (regressed && !migrating) {
        await discardNew();
        // Keep serving the proven model, and consume the retrain: trained_at moves on, so the samples-since-retrain
        // count starts again, and the samples stay in the training pool for the next attempt. An UPDATE, not a re-save:
        // a reset during the fit deleted the profile, and it must stay deleted.
        await db.run("UPDATE user_typing_profiles SET trained_at = CURRENT_TIMESTAMP WHERE user_id = ?", userId);
        return getUserTypingProfile(userId, db);
      }
    }
  } else if (previousPath) {
    console.log(`[retrain-gate] user=${userId} no held-out sample (${heldOut.length} windows): not gated`);
  }

  const profile = {
    version: PROFILE_VERSION,
    type: "per-user-cnn-lstm",
    modelPath: result.modelPath,
    inputShape: result.inputShape,
    threshold: Number(result.threshold || DEFAULT_CNN_THRESHOLD),
    thresholdSource: result.thresholdSource || "default",
    sampleCount,
    positiveWindowCount: result.positiveWindowCount,
    negativeWindowCount: result.negativeWindowCount,
    negativeSource: result.negativeSource,
    negatives: NEGATIVES_SOURCE,
    trainedFrom: result.trainedFrom,
    baseModel: result.baseModel || null,
    trainingAccuracy: result.accuracy,
    balancedAccuracy: result.balancedAccuracy,
    trainedAt: new Date().toISOString(),
  };

  await saveProfile(userId, db, profile);
  // A reset just as it was saved: the reset clears the samples first and the profile second, so either its delete
  // removed this profile or this check finds the samples gone and removes it.
  if (!(await samplesStillTraining(userId, db, sampleIds))) {
    await db.run("DELETE FROM user_typing_profiles WHERE user_id = ? AND model_json = ?", userId, JSON.stringify(profile));
    return discardMoot("as the new model was saved");
  }
  // User study: the live cutoff is the fixed 0.50, so the threshold-source scores are the per-user
  // validation (held-out genuine) scores model-api computed for this model.
  await studyLog.recordProfile(userId, {
    channel: "keystroke", ruleVersion: [RULE_VERSION, NEGATIVES_SOURCE, result.baseModel].filter(Boolean).join(";"), threshold: WINDOW_DECISION_THRESHOLD,
    thresholdSource: "fixed-0.50; scores = validation genuine", modelPath: result.modelPath, modelSha256: result.modelSha256,
    windowCount: result.positiveWindowCount, thresholdScores: result.validationGenuineScores,
  });
  return profile;
}

async function getUserTypingProfile(userId, db) {
  if (!userId || !db) return null;
  const row = await db.get("SELECT model_json, sample_count, trained_at FROM user_typing_profiles WHERE user_id = ?", userId);

  if (!row) return null;

  try {
    const profile = JSON.parse(row.model_json);
    profile.sampleCount = row.sample_count;
    profile.trainedAt = row.trained_at;
    return profile;
  } catch (err) {
    return null;
  }
}

async function resetUserTypingProfile(userId, db) {
  if (!userId || !db) return;
  await db.run("DELETE FROM user_typing_profiles WHERE user_id = ?", userId);
}

async function getUserTypingStatus(userId, db) {
  const sampleCount = (await getTrainingSampleRows(userId, db)).length;
  const positiveWindowCount = (await getTrainingWindows(userId, db)).length;
  const profile = await getUserTypingProfile(userId, db);
  const trained =
    !!profile &&
    profile.type === "per-user-cnn-lstm" &&
    Number(profile.version) >= PROFILE_VERSION;

  return {
    requiredSamples: MIN_TRAINING_SAMPLES,
    requiredPositiveWindows: MIN_POSITIVE_WINDOWS,
    sampleCount,
    positiveWindowCount,
    remainingSamples: Math.max(MIN_TRAINING_SAMPLES - sampleCount, 0),
    remainingPositiveWindows: Math.max(MIN_POSITIVE_WINDOWS - positiveWindowCount, 0),
    trained,
    trainedAt: profile ? profile.trainedAt : null,
    modelType: "per-user-cnn-lstm",
    modelPath: profile ? profile.modelPath : null,
    threshold: profile ? profile.threshold : null,
    trainingAccuracy: profile ? profile.trainingAccuracy : null,
    balancedAccuracy: profile ? profile.balancedAccuracy : null,
  };
}

async function getUserTypingBaseline(userId, db) {
  const profile = await getUserTypingProfile(userId, db);
  if (!profile) return null;
  return {
    sampleCount: profile.sampleCount,
    positiveWindowCount: profile.positiveWindowCount,
    negativeWindowCount: profile.negativeWindowCount,
    threshold: profile.threshold,
    trainedAt: profile.trainedAt,
    modelType: profile.type,
  };
}

// packetWindows: the organisation's packet (DECISION_WINDOW_CHOICES); anything else means the default.
async function evaluateKeystrokes({ events, timings, userId, db, packetWindows }) {
  const packet = decisionWindows(packetWindows);
  const normalized = normalizeEvents(events);
  const metrics = {
    ...analyzeKeystrokeTiming(normalized),
    ...(timings || {}),
  };
  // The same windows as eventsToFeatureWindows, each with its key for the user-study log.
  const { windows: allWindows, keys: allKeys } = featureWindowsWithKeys(normalized);
  // We score the last SCORED_WINDOW_COUNT windows in one prediction: the last
  // RECENT_WINDOW_COUNT of them (the packet) drive the live Lu vote, while the last
  // SAMPLE_WINDOW_COUNT of them are what an adaptive-learning sample is judged on.
  const windows = allWindows.slice(-SCORED_WINDOW_COUNT);
  const windowKeys = allKeys.slice(-SCORED_WINDOW_COUNT);
  const profile = await getUserTypingProfile(userId, db);

  if (
    !profile ||
    profile.type !== "per-user-cnn-lstm" ||
    Number(profile.version) < PROFILE_VERSION
  ) {
    return {
      modelConfidence: 0,
      isSuspicious: false,
      reason: "typing model is not trained yet",
      modelAvailable: false,
      modelType: "per-user-cnn-lstm",
      metrics,
      baseline: await getUserTypingBaseline(userId, db),
      profile,
      windowCount: allWindows.length,
    };
  }

  if (windows.length === 0) {
    // Genuine typing forms a window well within UNVERIFIABLE_KEY_COUNT keys. If
    // the user has typed far past that but STILL can't produce one scorable
    // window, the input is un-modelable (rollover / held keys / batching) —
    // treat it as un-verifiable so the caller can challenge instead of granting
    // an indefinite "warmup" free pass (an otherwise trivial evasion vector).
    const unverifiable = Number(metrics.keyCount || 0) >= UNVERIFIABLE_KEY_COUNT;
    return {
      modelConfidence: unverifiable ? 0 : 0.5,
      isSuspicious: true,
      unverifiable,
      reason: unverifiable
        ? `${metrics.keyCount} keystrokes produced no scorable window — un-modelable typing`
        : "not enough keystroke events for a typing window",
      modelAvailable: true,
      modelType: "per-user-cnn-lstm",
      metrics,
      baseline: await getUserTypingBaseline(userId, db),
      profile,
      windowCount: 0,
    };
  }

  try {
    const result = await postModelApi("/api/user/predict", {
      userId,
      windows,
      modelPath: profile.modelPath,
      threshold: WINDOW_DECISION_THRESHOLD,
    });

    // Lu et al. (2020) packet decision — pure vote at the fixed 0.50 softmax
    // boundary, exactly as in the base paper. A window is "low" when its genuine
    // probability < 0.50. The per-user model already personalises the decision;
    // the per-user EER threshold is computed for *reporting* only (profile
    // .threshold) and is intentionally NOT used as the live cutoff.
    const LU_WINDOW_THRESHOLD = WINDOW_DECISION_THRESHOLD;
    const mean = (arr) =>
      arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    // Scores for all sent windows (up to SCORED_WINDOW_COUNT).
    const scoredScores = Array.isArray(result.prediction)
      ? result.prediction.map((p) => Number(p[1]))
      : [];
    const sampleScores = scoredScores.slice(-SAMPLE_WINDOW_COUNT);
    // The packet = the most recent `packet` windows; the live vote
    // and the on-screen tiles use only these.
    const perWindowScores = scoredScores.slice(-packet);
    const lowWindows = perWindowScores.filter((s) => s < LU_WINDOW_THRESHOLD).length;
    const voteFraction = perWindowScores.length > 0 ? lowWindows / perWindowScores.length : 0;
    // Live verdict = pure Lu et al. (2020) packet vote at the fixed 0.50 boundary.
    // (The sample scores below are used ONLY for adaptive-contribution
    // eligibility — they deliberately have NO part in this verdict.)
    const isSuspicious = voteFraction >= PACKET_VOTE_FRACTION;
    const sampleMean = mean(sampleScores);

    // TEMP DIAG: when a window crashes to ~0 while others are high, dump the
    // lowest window's per-feature min/avg/max + its last rows, so we can tell an
    // out-of-distribution feature ARTIFACT apart from a real rhythm change.
    try {
      let lo = 0;
      for (let i = 1; i < scoredScores.length; i += 1)
        if (scoredScores[i] < scoredScores[lo]) lo = i;
      if (scoredScores.length && scoredScores[lo] < 0.25) {
        const w = windows[lo] || [];
        const lbl = ["id1", "id2", "dw1", "dw2", "dd", "ud"];
        const stats = lbl.map((l, f) => {
          let mn = Infinity, mx = -Infinity, sum = 0;
          for (const r of w) { if (r[f] < mn) mn = r[f]; if (r[f] > mx) mx = r[f]; sum += r[f]; }
          return `${l}:${mn.toFixed(2)}/${(sum / (w.length || 1)).toFixed(2)}/${mx.toFixed(2)}`;
        });
        console.log(`[DIAG] user=${userId} keys=${metrics.keyCount} loScore=${scoredScores[lo].toFixed(4)} winLen=${w.length} (min/avg/max) ${stats.join(" ")}`);
        console.log(`[DIAG] lastRows=${JSON.stringify(w.slice(-3).map((r) => r.map((x) => +x.toFixed(2))))}`);
      }
    } catch (_) {}

    return {
      // Packet mean — keeps the existing "confidence" meaning (last packet).
      modelConfidence: mean(perWindowScores),
      // The last SAMPLE_WINDOW_COUNT scores and their mean: they drive adaptive eligibility ONLY.
      sampleMean,
      sampleWindowScores: sampleScores,
      isSuspicious,
      reason: isSuspicious
        ? `${lowWindows} of ${perWindowScores.length} windows scored < 50% (Lu et al. vote)`
        : "All recent windows scored ≥ 50% — genuine user rhythm",
      modelAvailable: true,
      modelType: "per-user-cnn-lstm",
      metrics,
      baseline: await getUserTypingBaseline(userId, db),
      profile,
      windowCount: allWindows.length,
      recentWindowScores: perWindowScores,
      recentWindowKeys: windowKeys.slice(-perWindowScores.length),
      cnnLstm: result,
    };
  } catch (err) {
    // No score, no verdict: the route answers 503 without a risk token (sendError), as the mouse channel does, and
    // the last known state stands. Until 2026-11-08 this returned isSuspicious:false with the full window count,
    // which the route read as a settled check and signed "genuine" ("Typing rhythm verified") whenever the model
    // service was down, slow to load a model, or had lost the user's model version.
    throw err instanceof ModelUnavailableError ? err : new ModelUnavailableError(`typing model could not score: ${err.message}`, err);
  }
}

// NOTE: passkey ownership now lives in the standalone passkey service. The app
// reads it via services/passkeyClient (cached in req.session.hasPasskey), so the
// old local-table lookup that used to live here has been removed.

function verdictFromEvaluation(evaluation) {
  if (evaluation.modelType === "paste-policy") return "paste";
  if (!evaluation.modelAvailable) return "untrained";
  return evaluation.isSuspicious ? "suspicious" : "genuine";
}

async function logAuthDecision(userId, db, { source, evaluation, passkeyTriggered = false, passkeyOutcome = null }) {
  try {
    const scores = evaluation.recentWindowScores;
    await db.run(
      `INSERT INTO auth_decisions
         (user_id, source, window_count, mean_score, threshold, verdict, passkey_triggered, passkey_outcome, per_window_scores)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      source,
      evaluation.windowCount != null ? evaluation.windowCount : 0,
      evaluation.modelConfidence != null ? evaluation.modelConfidence : null,
      evaluation.profile ? evaluation.profile.threshold : null,
      verdictFromEvaluation(evaluation),
      passkeyTriggered ? 1 : 0,
      passkeyOutcome || null,
      scores ? JSON.stringify(scores) : null,
    );
  } catch (err) {
    console.error("[auth-log] Failed to log auth decision:", err.message);
  }
}

// Duplicate suppression used to be an in-memory Set here. It is now a property of the
// durable queue: enqueue() is a no-op when a job for this (user, modality) is already
// queued or running, and unlike the Set that fact survives a restart — so an interrupted
// retrain is resumed rather than silently forgotten.
const trainingQueue = require("./trainingQueue");

// Called after login. It used to retrain whenever any other user had enrolled since this
// user's model was trained, so the model could learn from the new impostors. Negatives now
// come from the fixed Aalto file (NEGATIVES_SOURCE), so the one retrain still owed is the move
// of an older profile onto it. The route keeps its name for the SDK.
//
// This used to fire-and-forget a `setImmediate`. Both halves of that were lost on restart —
// the run itself, and the guard that stopped it being started twice — and nothing recorded
// that the work had been owed. Now it records a row and returns; the worker in
// lib/trainingQueue.js does the work and re-queues it if the service dies mid-run.
async function maybeRetrainForNewImpostors(userId, db) {
  if (!(await needsNegativesRefresh(userId, db))) return null;
  return trainingQueue.enqueue(userId, "keystroke", "negatives-refresh");
}

module.exports = {
  // Continuous-auth window configuration — single source of truth, also served
  // to the frontend via GET /api/text/config so client and server stay in sync.
  WINDOW_SIZE,
  WINDOW_STRIDE,
  RECENT_WINDOW_COUNT,
  SAMPLE_WINDOW_COUNT,
  SAMPLE_FLOOR_WINDOWS,
  PACKET_VOTE_FRACTION,
  WINDOW_DECISION_THRESHOLD,
  CHECK_MIN_TEXT_CHARS,
  minTextChars,
  analyzeKeystrokeTiming,
  checkRhythmConsistency,
  NEGATIVES_SOURCE,
  evaluateKeystrokes,
  eventsToFeatureWindows,
  windowsSample,
  lastWindowsSample,
  newestQualifyingSample,
  printableKeyCount,
  logAuthDecision,
  needsNegativesRefresh,
  isServedProfile,
  typingQuality,
  getUserTypingBaseline,
  getUserTypingProfile,
  getUserTypingStatus,
  maybeRetrainForNewImpostors,
  negativeSampleRows,
  normalizeEvents,
  resetUserTypingProfile,
  trainUserTypingProfile,
  featureWindowsWithKeys,
  RULE_VERSION,
  ruleVersion,
  DECISION_WINDOW_CHOICES,
  decisionWindows,
  WARMUP_FAST_MIN_WINDOWS,
  WARMUP_FAST_FRACTION,
  pasteCountsByField,
  pastePolicyViolation,
};
