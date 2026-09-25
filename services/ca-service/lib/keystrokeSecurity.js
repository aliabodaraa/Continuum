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
// Wider recent span used for the adaptive "contribute" rolling mean. Requires
// sustained clean typing (≈3 of the former 6-window packets) rather than a single
// lucky stretch, and rolls forward so an earlier rough patch ages out instead of
// permanently blocking eligibility.
const ROLLING_WINDOW_COUNT = 18;
// Adaptive contribution is judged on the former 6-window packet: /contribute needs
// at least this many scored windows, every one of the last this-many above the
// window floor, and the SDK's cooldown between offers is this many strides. Kept
// separate from RECENT_WINDOW_COUNT so the packet change leaves adaptive learning
// exactly as it was.
const CONTRIBUTE_WINDOW_COUNT = 6;
// Windows scored per check: enough for both the packet and the rolling mean.
const SCORED_WINDOW_COUNT = Math.max(RECENT_WINDOW_COUNT, ROLLING_WINDOW_COUNT);
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
 * Rand_WS*.h5 training data format exactly so the pre-trained CNN+LSTM base
 * model can be fine-tuned on and applied to live typing.
 */
function eventSteps(events) {
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
    steps.push(raw[i].row);
  }
  return steps;
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

function typingQuality(textContent, events) {
  const normalized = normalizeEvents(events);
  const textLength = String(textContent || "").trim().length;
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

function getSampleEvents(textId, db) {
  return db
    .prepare(
      `SELECT key_code, event_type, timestamp_relative, field_name, field_type
       FROM keystroke_events
       WHERE keystroke_text_id = ?
       ORDER BY timestamp_relative ASC`,
    )
    .all(textId)
    .map((row) => ({
      keyCode: row.key_code,
      eventType: row.event_type,
      timestampRelative: row.timestamp_relative,
      fieldName: row.field_name,
      fieldType: row.field_type,
    }));
}

function getTrainingSampleRows(userId, db) {
  // Uses ALL training samples (enrollment + adaptive), newest first. We tested
  // capping the adaptive share to 2× enrollment to counter template narrowing,
  // but a held-out validation (80 genuine activity windows) showed the capped
  // model scored WORSE (mean 0.74 vs 0.92, 21 vs 3 windows below 0.5): the cap
  // starves the positive class and over-weights months-old enrollment typing.
  // More genuine data — even if skewed clean — beats less-but-balanced here.
  return db
    .prepare(
      `SELECT id
       FROM keystroke_texts
       WHERE user_id = ?
         AND is_training = 1
         AND is_suspicious = 0
       ORDER BY submitted_at DESC
       LIMIT ?`,
    )
    .all(userId, MAX_TRAINING_SAMPLES);
}

// Windows slide with an 80% overlap, so two windows from the SAME sample share
// most of their rows. The model-api needs to know which sample each window came
// from, or its train/validation split puts near-duplicates on both sides and
// every validation figure — including the calibrated threshold — is measured
// against data the model already saw. So carry the sample id alongside.
function getTrainingWindowsGrouped(userId, db) {
  const rows = getTrainingSampleRows(userId, db);
  const windows = [];
  const groups = [];
  for (const row of rows) {
    for (const w of eventsToFeatureWindows(getSampleEvents(row.id, db))) {
      windows.push(w);
      groups.push(row.id);
    }
  }
  return { windows, groups };
}

function getTrainingWindows(userId, db) {
  return getTrainingWindowsGrouped(userId, db).windows;
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

function aliasUserIds(userId, db) {
  const own = new Set(
    db
      .prepare(
        "SELECT DISTINCT text_hash t FROM keystroke_texts WHERE user_id = ? AND text_hash IS NOT NULL AND char_count > 40",
      )
      .all(userId)
      .map((r) => r.t),
  );
  if (own.size === 0) return new Set();
  const candidates = db
    .prepare(
      `SELECT DISTINCT user_id u FROM keystroke_texts
       WHERE user_id <> ? AND is_training = 1 AND is_suspicious = 0`,
    )
    .all(userId)
    .map((r) => r.u);
  const aliases = new Set();
  for (const u of candidates) {
    const texts = db
      .prepare(
        "SELECT DISTINCT text_hash t FROM keystroke_texts WHERE user_id = ? AND text_hash IS NOT NULL AND char_count > 40",
      )
      .all(u)
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
function negativeSampleRows(userId, db) {
  const aliases = aliasUserIds(userId, db);
  return db
    .prepare(
      `SELECT id, user_id, text_hash
       FROM keystroke_texts
       WHERE user_id <> ?
         AND is_training = 1
         AND is_suspicious = 0
       ORDER BY submitted_at DESC
       LIMIT ?`,
    )
    .all(userId, MAX_TRAINING_SAMPLES)
    .filter((r) => !aliases.has(r.user_id));
}

// Was this profile trained on other negatives than the current NEGATIVES_SOURCE? Such a profile
// is retrained once (server.js activity path and the login hook below). This replaces the old
// pool-growth refresh: negatives no longer come from other app users, so new enrolments do not
// change what a retrain would learn from.
function needsNegativesRefresh(userId, db) {
  const profile = getUserTypingProfile(userId, db);
  return !!profile && profile.negatives !== NEGATIVES_SOURCE;
}

// Authenticated + deadline-bounded. See lib/modelClient.js for why the local copy of this
// function (a bare, credential-less, unbounded fetch) had to go.
const { postModelApi } = require("./modelClient");

function saveProfile(userId, db, profile) {
  db.prepare(
    `INSERT INTO user_typing_profiles (user_id, model_json, sample_count, trained_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       model_json = excluded.model_json,
       sample_count = excluded.sample_count,
       trained_at = CURRENT_TIMESTAMP`,
  ).run(userId, JSON.stringify(profile), profile.sampleCount);
}

// Held-out genuine windows for the model-update acceptance test: recent
// ACTIVITY samples (is_training = 0) were typed by the real user but are never
// part of the training set, so they measure how a model handles the user's
// NORMAL typing, not just the clean samples it was fitted on.
function getHeldOutWindows(userId, db, maxSamples = 12, maxWindows = 120) {
  const rows = db
    .prepare(
      `SELECT id FROM keystroke_texts
       WHERE user_id = ? AND is_training = 0 AND is_suspicious = 0
         AND sample_purpose = 'activity'
       ORDER BY id DESC LIMIT ?`,
    )
    .all(userId, maxSamples);
  let windows = [];
  for (const row of rows) {
    windows = windows.concat(eventsToFeatureWindows(getSampleEvents(row.id, db)));
    if (windows.length >= maxWindows) break;
  }
  return windows.slice(0, maxWindows);
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
  const sampleCount = getTrainingSampleRows(userId, db).length;
  const positive = getTrainingWindowsGrouped(userId, db);
  const positiveWindows = positive.windows;
  if (sampleCount < MIN_TRAINING_SAMPLES || positiveWindows.length < MIN_POSITIVE_WINDOWS) {
    return null;
  }

  const previous = getUserTypingProfile(userId, db);
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
    epochs: 25,
    batchSize: 16,
  });

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
    if (result.previousModelPath) await postModelApi("/api/user/rollback", { userId });
    throw new Error(`keystroke training needs the ${NEGATIVES_SOURCE} negatives: ` +
      `${result.datasetNegativeError || `got ${result.negativeSource}`}`);
  }

  // ---- Model-update ACCEPTANCE TEST (validation-gated update) ----
  // Retraining is stochastic: on identical data, successive fits scored a
  // held-out genuine set anywhere from mean 0.92 down to 0.74. A bad fit that
  // silently replaces a good live model causes immediate false rejections
  // ("it fails right after I contribute"). So before accepting the new model
  // we score both the new fit and the pre-retrain snapshot on held-out
  // genuine windows; if the new one is clearly worse we ROLL BACK and keep
  // the proven model. The stored samples still count toward future retrains.
  // The gate guards against a bad fit of the SAME recipe. The one retrain that moves a profile
  // to NEGATIVES_SOURCE is a deliberate recipe change, tested in KS, and it skips the gate:
  // a rollback there would re-save the old profile, which would ask for this retrain again.
  const migrating = !!previous && previous.negatives !== NEGATIVES_SOURCE;
  if (migrating) {
    console.log(`[retrain-gate] user=${userId} negatives ${previous.negatives || "app-users"} -> ` +
      `${NEGATIVES_SOURCE}: recipe change, gate skipped`);
  }
  try {
    if (result.previousModelPath && !migrating) {
      const heldOut = getHeldOutWindows(userId, db);
      if (heldOut.length >= 30) {
        const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
        const lows = (a) => a.filter((v) => v < DEFAULT_CNN_THRESHOLD).length;
        const newScores = await scoreWindowsWithModel(userId, heldOut, result.modelPath);
        const prevScores = await scoreWindowsWithModel(userId, heldOut, result.previousModelPath);
        const newMean = mean(newScores);
        const prevMean = mean(prevScores);
        const regressed =
          newScores.length === prevScores.length &&
          (newMean < prevMean - 0.02 || lows(newScores) > lows(prevScores) + 2);
        console.log(
          `[retrain-gate] user=${userId} heldOut=${heldOut.length} prevMean=${prevMean.toFixed(3)} newMean=${newMean.toFixed(3)} prevLows=${lows(prevScores)} newLows=${lows(newScores)} → ${regressed ? "ROLLBACK" : "accept"}`,
        );
        if (regressed) {
          await postModelApi("/api/user/rollback", { userId });
          // Keep serving the proven model — but CONSUME the retrain trigger by
          // re-saving the existing profile (bumps trained_at). Otherwise
          // adaptiveSamplesSinceRetrain stays stuck ≥ RETRAIN_EVERY forever:
          // the UI shows "retraining now" indefinitely, its poll keeps setting
          // _retrainInProgress, and the contribute panel never reappears. The
          // samples themselves stay in the training pool for the next attempt.
          const existing = getUserTypingProfile(userId, db);
          if (existing) saveProfile(userId, db, existing);
          return existing;
        }
      }
    }
  } catch (gateErr) {
    console.error("[retrain-gate] validation gate failed (accepting new model):", gateErr.message);
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
    trainingAccuracy: result.accuracy,
    balancedAccuracy: result.balancedAccuracy,
    trainedAt: new Date().toISOString(),
  };

  saveProfile(userId, db, profile);
  return profile;
}

function getUserTypingProfile(userId, db) {
  if (!userId || !db) return null;
  const row = db
    .prepare("SELECT model_json, sample_count, trained_at FROM user_typing_profiles WHERE user_id = ?")
    .get(userId);

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

function resetUserTypingProfile(userId, db) {
  if (!userId || !db) return;
  db.prepare("DELETE FROM user_typing_profiles WHERE user_id = ?").run(userId);
}

function getUserTypingStatus(userId, db) {
  const sampleCount = getTrainingSampleRows(userId, db).length;
  const positiveWindowCount = getTrainingWindows(userId, db).length;
  const profile = getUserTypingProfile(userId, db);
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

function getUserTypingBaseline(userId, db) {
  const profile = getUserTypingProfile(userId, db);
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

async function evaluateKeystrokes({ events, timings, userId, db }) {
  const normalized = normalizeEvents(events);
  const metrics = {
    ...analyzeKeystrokeTiming(normalized),
    ...(timings || {}),
  };
  const allWindows = eventsToFeatureWindows(normalized);
  // We score the last SCORED_WINDOW_COUNT windows in one prediction: the last
  // RECENT_WINDOW_COUNT of them (the packet) drive the live Lu vote, while the
  // mean over the last ROLLING_WINDOW_COUNT is the "rolling mean" used to decide
  // when a stretch of typing is clean enough to offer as an adaptive-learning sample.
  const windows = allWindows.slice(-SCORED_WINDOW_COUNT);
  const profile = getUserTypingProfile(userId, db);

  if (
    !profile ||
    profile.type !== "per-user-cnn-lstm" ||
    Number(profile.version) < PROFILE_VERSION
  ) {
    return {
      modelConfidence: 0,
      isSuspicious: false,
      reason: "CNN/LSTM user model is not trained yet",
      modelAvailable: false,
      modelType: "per-user-cnn-lstm",
      metrics,
      baseline: getUserTypingBaseline(userId, db),
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
        : "not enough keystroke events for CNN/LSTM window",
      modelAvailable: true,
      modelType: "per-user-cnn-lstm",
      metrics,
      baseline: getUserTypingBaseline(userId, db),
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
    const rollingScores = scoredScores.slice(-ROLLING_WINDOW_COUNT);
    // The packet = the most recent RECENT_WINDOW_COUNT windows; the live vote
    // and the on-screen tiles use only these.
    const perWindowScores = scoredScores.slice(-RECENT_WINDOW_COUNT);
    const lowWindows = perWindowScores.filter((s) => s < LU_WINDOW_THRESHOLD).length;
    const voteFraction = perWindowScores.length > 0 ? lowWindows / perWindowScores.length : 0;
    // Live verdict = pure Lu et al. (2020) packet vote at the fixed 0.50 boundary.
    // (The wider rolling mean below is computed ONLY for adaptive-contribution
    // eligibility — it deliberately has NO part in this verdict.)
    const isSuspicious = voteFraction >= PACKET_VOTE_FRACTION;
    const rollingMean = mean(rollingScores);

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
      // Rolling mean over the wider recent window — drives adaptive eligibility ONLY.
      rollingMean,
      rollingWindowCount: rollingScores.length,
      isSuspicious,
      reason: isSuspicious
        ? `${lowWindows} of ${perWindowScores.length} windows scored < 50% (Lu et al. vote)`
        : "All recent windows scored ≥ 50% — genuine user rhythm",
      modelAvailable: true,
      modelType: "per-user-cnn-lstm",
      metrics,
      baseline: getUserTypingBaseline(userId, db),
      profile,
      windowCount: allWindows.length,
      recentWindowScores: perWindowScores,
      cnnLstm: result,
    };
  } catch (err) {
    return {
      modelConfidence: 0,
      isSuspicious: false,
      reason: `CNN/LSTM model temporarily unavailable — session continues`,
      modelAvailable: false,
      modelType: "per-user-cnn-lstm",
      metrics,
      baseline: getUserTypingBaseline(userId, db),
      profile,
      windowCount: allWindows.length,
      modelError: err.message,
    };
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

function logAuthDecision(userId, db, { source, evaluation, passkeyTriggered = false, passkeyOutcome = null }) {
  try {
    const scores = evaluation.recentWindowScores;
    db.prepare(
      `INSERT INTO auth_decisions
         (user_id, source, window_count, mean_score, threshold, verdict, passkey_triggered, passkey_outcome, per_window_scores)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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
function maybeRetrainForNewImpostors(userId, db) {
  if (!needsNegativesRefresh(userId, db)) return null;
  return trainingQueue.enqueue(userId, "keystroke", "negatives-refresh");
}

module.exports = {
  // Continuous-auth window configuration — single source of truth, also served
  // to the frontend via GET /api/text/config so client and server stay in sync.
  WINDOW_SIZE,
  WINDOW_STRIDE,
  RECENT_WINDOW_COUNT,
  ROLLING_WINDOW_COUNT,
  CONTRIBUTE_WINDOW_COUNT,
  PACKET_VOTE_FRACTION,
  WINDOW_DECISION_THRESHOLD,
  CHECK_MIN_TEXT_CHARS,
  analyzeKeystrokeTiming,
  checkRhythmConsistency,
  NEGATIVES_SOURCE,
  evaluateKeystrokes,
  eventsToFeatureWindows,
  logAuthDecision,
  needsNegativesRefresh,
  typingQuality,
  getUserTypingBaseline,
  getUserTypingProfile,
  getUserTypingStatus,
  maybeRetrainForNewImpostors,
  negativeSampleRows,
  normalizeEvents,
  resetUserTypingProfile,
  trainUserTypingProfile,
};
