// Mouse-dynamics decision logic for the CA service. Mirrors the keystroke path:
// accumulate enrollment windows across sessions, fine-tune a per-user model from
// the SapiMouse base (transfer learning) via the model-api, and score live
// windows with a Lu-style packet vote. The per-SESSION strike debounce and the
// passkey step-up stay in the demo (they are session/policy concerns).
const db = require("../db");

// Model storage (base model, scaler, negatives, per-user save paths) is OWNED
// by the model-api: we send `modality: "mouse"` and it derives everything.
// The hop itself is authenticated + deadline-bounded — see lib/modelClient.js.
const { postModelApi } = require("./modelClient");
const decisionState = require("./decisionState");

const RECENT_WINDOW_COUNT = 6;

// ---- Representation -- pre-registered study, continuum/artifacts/repr_arch_study ----
// Base paper: SapiMouse (Antal, Fejer & Buza, IEEE SACI 2021). Each step is [|dx|, |dy|] in
// pixels (its best raw representation, Table I); 50-step windows, stride 10. MUST match
// sdk/js/mouse-features.js and extension/src/features-mouse.js (verified bit-identical to the
// training pipeline on 1,145,000 values).
const MOUSE_WINDOW_SIZE = 50;
const WINDOW_STRIDE = 10;
const MOUSE_FEATURES = 2;
const MOUSE_FEATURE_VERSION = "a5-absdxdy-v1";

// ---- Enrolment (Experiment C and the final enrolment curve) ----
// 330 windows (~90 s of movement) is the smallest enrolment non-inferior to 440 within 0.02 AUC,
// measured for this exact pipeline. It ACCUMULATES over sessions: a session is stored once it
// passes the per-session gate, and a model is trained once the total reaches 330.
const MIN_ENROLL_WINDOWS = 330;
const MIN_SESSION_WINDOWS = 55;      // ~16 s; shorter submissions are not stored
// The unit users see: one SAMPLE = MIN_SESSION_WINDOWS windows (~16 s of movement), and a profile
// needs SAMPLES_REQUIRED of them (6 x 55 = 330), shown as "sample 2 of 6" like the typing channel.
const SAMPLE_WINDOWS = MIN_SESSION_WINDOWS;
const SAMPLES_REQUIRED = Math.ceil(MIN_ENROLL_WINDOWS / SAMPLE_WINDOWS);
// Spread (interquartile range) of step sizes in the submission, px. Real SapiMouse batches of
// 55 windows: 1st percentile 7.1 px, 5th 9.8 px. Constant-speed or jittering motion scores ~0.
// Replaces the old click gate: the model no longer reads clicks.
const MIN_STEP_IQR_PX = 5;
const MAX_TRAIN_WINDOWS = 1200;

// ---- Decision (Experiment I; the project owner's choice of the comfort-first point) ----
// Per-user threshold = the THRESHOLD_PERCENTILE-th percentile of the user's own enrolment scores
// (returned by the model-api at training time); a window is "low" below it; the session is
// suspicious when VOTE_K of the last VOTE_N windows are low (~17 s of movement).
// Replaying the live loop on 19 held-out users: 0.29 false passkey prompts per minute of movement
// on average (89% of users never prompted), 86.5% of impostor runs caught within ~40 s, typically
// after 17 s. Experiment F's point (5th percentile, 12 of 20) caught 99.4% within 6.5 s but
// prompted genuine users 2.85 times per minute of movement; the pre-registered rule of Experiment I
// kept it (the comfort-first point misses its 90% capture guard), and the owner chose comfort.
// The browser extension trains a different model and uses its own measured point (Experiment I:
// mean of the last 60 windows below the 2nd percentile).
const THRESHOLD_PERCENTILE = 1;
const VOTE_N = 60;
const VOTE_K = 30;
// Kept under the old names for callers that report them (SDK panel, gateway).
const MOUSE_SUSTAIN_WINDOW = VOTE_N;
const MOUSE_SUSTAIN_LOW = VOTE_K;

function validWindows(windows) {
  return (
    Array.isArray(windows) &&
    windows.length > 0 &&
    Array.isArray(windows[0]) &&
    windows[0].length === 50 &&
    Array.isArray(windows[0][0]) &&
    windows[0][0].length === MOUSE_FEATURES
  );
}

// A 7-column window is the retired representation: an out-of-date client, not bad data.
function staleClientWindows(windows) {
  return (
    Array.isArray(windows) && windows.length > 0 && Array.isArray(windows[0]) &&
    Array.isArray(windows[0][0]) && windows[0][0].length === 7
  );
}

// Reconstruct the submission's step stream from its overlapping windows (the first window in
// full, then only the new tail of each later one) and return the interquartile range of the
// step sizes. Genuine pointing varies a lot in step size; scripted or jittering motion does not.
function stepSpreadPx(windows) {
  if (!windows.length) return 0;
  const steps = windows[0].concat(...windows.slice(1).map((w) => w.slice(-WINDOW_STRIDE)));
  const mags = steps.map((r) => Math.hypot(r[0], r[1])).sort((a, b) => a - b);
  const q = (p) => mags[Math.min(mags.length - 1, Math.floor(p * (mags.length - 1)))];
  return q(0.75) - q(0.25);
}

// Enroll: store this session's windows, then (re)train on ALL accumulated
// sessions so enrollment builds up over visits — the mouse analogue of the
// keystroke multi-sample profile. Transfer-learns from the SapiMouse base.
async function enrollMouse(userId, windows) {
  if (staleClientWindows(windows)) {
    return { status: 400, body: { ok: false, error: "This client sends the retired 7-feature mouse windows. Reload the page or update the extension." } };
  }
  if (!validWindows(windows)) {
    return { status: 400, body: { ok: false, error: `windows must be an array of ${MOUSE_WINDOW_SIZE}x${MOUSE_FEATURES} matrices` } };
  }
  if (windows.length < MIN_SESSION_WINDOWS) {
    return {
      status: 422,
      body: {
        ok: false,
        error: `Keep moving the mouse a little longer — this session has ${windows.length} of the ${MIN_SESSION_WINDOWS} windows needed to count.`,
        have: windows.length,
        needSession: MIN_SESSION_WINDOWS,
      },
    };
  }
  const spread = stepSpreadPx(windows);
  if (spread < MIN_STEP_IQR_PX) {
    return {
      status: 422,
      body: {
        ok: false,
        error: "Move between the targets at your natural speed — this movement is too uniform to learn from.",
        stepSpreadPx: spread,
        needStepSpreadPx: MIN_STEP_IQR_PX,
      },
    };
  }

  db.prepare(
    "INSERT INTO mouse_samples (user_id, windows, window_count) VALUES (?, ?, ?)",
  ).run(userId, JSON.stringify(windows), windows.length);

  const total = db
    .prepare("SELECT COALESCE(SUM(window_count), 0) AS n FROM mouse_samples WHERE user_id = ?")
    .get(userId).n;
  const rows = db
    .prepare("SELECT windows FROM mouse_samples WHERE user_id = ? ORDER BY id DESC")
    .all(userId);
  const sessionCount = rows.length;
  if (total < MIN_ENROLL_WINDOWS) {
    // Stored and counted, but not enough yet for a model that meets the measured plateau.
    const samplesOnFile = Math.floor(total / SAMPLE_WINDOWS);
    const samplesLeft = Math.max(1, SAMPLES_REQUIRED - samplesOnFile);
    return {
      status: 202,
      body: {
        ok: true,
        trained: false,
        message: `Saved sample ${samplesOnFile} of ${SAMPLES_REQUIRED}. ${samplesLeft} more to go — about ${samplesLeft * 16} s of movement.`,
        samplesOnFile,
        samplesRequired: SAMPLES_REQUIRED,
        sampleWindows: SAMPLE_WINDOWS,
        totalWindows: total,
        need: MIN_ENROLL_WINDOWS,
        sessionWindows: windows.length,
        sessionCount,
      },
    };
  }

  return retrainMouse(userId, { sessionWindows: windows.length });
}

// Train (or retrain) the user's model from ALL stored sessions. Used by enrolment once the
// accumulated total reaches MIN_ENROLL_WINDOWS, and by the one-off migration of profiles built on
// the retired representation (scripts/migrate_mouse_a5.js), so both go through the same code.
async function retrainMouse(userId, extra = {}) {
  const total = db
    .prepare("SELECT COALESCE(SUM(window_count), 0) AS n FROM mouse_samples WHERE user_id = ?")
    .get(userId).n;
  if (total < MIN_ENROLL_WINDOWS) {
    return { status: 409, body: { ok: false, error: `only ${total} of ${MIN_ENROLL_WINDOWS} windows stored`, totalWindows: total } };
  }
  const rows = db
    .prepare("SELECT windows FROM mouse_samples WHERE user_id = ? ORDER BY id DESC")
    .all(userId);
  const sessionCount = rows.length;
  // Keep the most recent sessions up to MAX_TRAIN_WINDOWS, then put them back in time order and
  // let model-api take its validation set as ONE contiguous tail (20%, with a gap of
  // ceil(50/10) windows at the boundary so no overlapping pair straddles it) -- the recipe the
  // held-out evaluation measured (Experiment F). Sending each session as its own validation group
  // made api.py hold out whole sessions: up to half the windows (200 of 374), or two of six equal
  // sessions, so the deployed model trained on far less than the evaluated one.
  const kept = [];
  let n = 0;
  for (const row of rows) {
    let w = JSON.parse(row.windows);
    if (n + w.length > MAX_TRAIN_WINDOWS) w = w.slice(0, MAX_TRAIN_WINDOWS - n);
    kept.push(w);
    n += w.length;
    if (n >= MAX_TRAIN_WINDOWS) break;
  }
  const positiveWindows = kept.reverse().flat();

  // epochs 15 / batch 32: the settings the final held-out evaluation measured.
  const result = await postModelApi("/api/user/train", {
    userId,
    positiveWindows,
    overlapGap: Math.ceil(MOUSE_WINDOW_SIZE / WINDOW_STRIDE),
    minPositiveWindows: MIN_ENROLL_WINDOWS,
    modality: "mouse",
    epochs: 15,
    batchSize: 32,
  });
  const pct = result.enrolScorePercentiles || {};
  const threshold = Number(pct[String(THRESHOLD_PERCENTILE)]);
  if (!Number.isFinite(threshold)) {
    return { status: 502, body: { ok: false, error: "model-api did not return enrolment score percentiles; is it on the current version?" } };
  }

  // The whole percentile table is kept with the profile, so a change of operating point can
  // re-derive the threshold without retraining anyone.
  db.prepare(
    `INSERT INTO mouse_profiles (user_id, model_path, sample_windows, balanced_accuracy, threshold, feature_version, enrol_percentiles, trained_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       model_path=excluded.model_path, sample_windows=excluded.sample_windows,
       balanced_accuracy=excluded.balanced_accuracy, threshold=excluded.threshold,
       feature_version=excluded.feature_version, enrol_percentiles=excluded.enrol_percentiles,
       trained_at=CURRENT_TIMESTAMP`,
  ).run(userId, result.modelPath, positiveWindows.length, result.balancedAccuracy ?? null,
        threshold, MOUSE_FEATURE_VERSION, JSON.stringify(pct));

  return {
    status: 200,
    body: {
      ok: true,
      trained: true,
      message: "Mouse model trained.",
      windowsUsed: positiveWindows.length,
      totalWindows: total,
      ...extra,
      sessionCount,
      threshold,
      balancedAccuracy: result.balancedAccuracy,
      trainedFrom: result.trainedFrom,
    },
  };
}

// Live check: score the recent windows and packet-vote. Returns a SINGLE-packet
// verdict; the demo applies the consecutive-strike debounce + step-up.
async function checkMouse(userId, windows) {
  if (staleClientWindows(windows)) {
    return { status: 400, body: { ok: false, error: "This client sends the retired 7-feature mouse windows. Reload the page or update the extension." } };
  }
  if (!validWindows(windows)) {
    return { status: 200, body: { ok: true, checked: false, message: "Need more mouse movement." } };
  }
  const profile = db
    .prepare("SELECT model_path, threshold, feature_version FROM mouse_profiles WHERE user_id = ?")
    .get(userId);
  if (!profile) {
    return { status: 422, body: { ok: false, error: "No mouse model — enroll first.", enrolled: false } };
  }
  if (profile.feature_version !== MOUSE_FEATURE_VERSION || !Number.isFinite(profile.threshold)) {
    // A profile trained on the retired representation cannot score these windows.
    return { status: 422, body: { ok: false, error: "Mouse profile predates the current model — retrain it.", enrolled: false, retrain: true } };
  }
  const userThreshold = profile.threshold;

  // Must supply at least MOUSE_SUSTAIN_WINDOW windows, or the sustained buffer below can
  // never fill and every check reports warmup — silently disabling mouse enforcement. This
  // was 18, chosen for an earlier 6-of-18 rule.
  const recent = windows.slice(-MOUSE_SUSTAIN_WINDOW);
  const result = await postModelApi("/api/user/predict", {
    userId,
    windows: recent,
    modality: "mouse",
    threshold: userThreshold,
  });
  const scores = (result.prediction || []).map((p) => Number(p[1]));
  // The MOUSE channel decides on a SUSTAINED vote, not the 6-window packet the keystroke
  // channel uses: mouse windows are produced far more often than keystroke windows, so a 3-of-6
  // rule re-evaluated that often turns the normal per-window false-reject rate into a steady
  // stream of false locks. The vote (VOTE_K of the last VOTE_N below the user's own threshold)
  // and the percentile were chosen together by replaying the live loop on calibration data and
  // counting genuine passkey prompts per minute of movement (Experiment I; owner's choice, see the
  // constants above).
  const buffer = scores.slice(-MOUSE_SUSTAIN_WINDOW);
  const lows = buffer.filter((s) => s < userThreshold).length;
  const voteFraction = buffer.length ? lows / buffer.length : 0;
  const isWarmup = buffer.length < MOUSE_SUSTAIN_WINDOW;
  const isSuspicious = !isWarmup && lows >= MOUSE_SUSTAIN_LOW;
  const packet = buffer;   // reported below as recentWindowScores

  // Advance the PERSISTED streak and report it. The count is state derived from behavioral
  // data, so it belongs to the service that owns that data — previously the gateway and the
  // demo each kept their own copy in memory, which meant a restart amnestied an impostor
  // mid-escalation and the two callers could disagree about the same user. Callers still
  // own their strike THRESHOLD (gateway and demo both 1, the measured operating point); they no
  // longer own the count. Warm-up packets carry no verdict and neither raise nor clear it.
  const suspiciousStreak = decisionState.updateMouseStreak(userId, { isSuspicious, warmup: isWarmup });
  // Every scored check is logged, so a user's report ("it keeps asking me") can be checked against
  // what the model actually saw: scores, threshold, how many were low, and the verdict.
  try {
    db.prepare(
      `INSERT INTO mouse_decisions (user_id, window_count, threshold, low_windows, vote_k, vote_n, warmup, suspicious, scores)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, scores.length, userThreshold, lows, VOTE_K, VOTE_N, isWarmup ? 1 : 0, isSuspicious ? 1 : 0,
          JSON.stringify(scores.map((v) => Math.round(v * 1e4) / 1e4)));
  } catch (e) { /* logging must never block a verdict */ }

  return {
    status: 200,
    body: {
      ok: true,
      checked: true,
      warmup: isWarmup,
      isSuspicious,
      suspiciousStreak,
      windowCount: scores.length,
      recentWindowScores: packet,
      meanScore: packet.length ? packet.reduce((a, b) => a + b, 0) / packet.length : 0,
      lowWindows: lows,
      // Reported so the SDK panel can show the same reading the extension popup does: how
      // much of the sustained buffer is low, against the count that triggers the step-up.
      // A per-window mean says nothing about how close the session is to being challenged.
      bufferMax: MOUSE_SUSTAIN_WINDOW,
      lockAt: MOUSE_SUSTAIN_LOW,
      riskPct: Math.round((100 * lows) / MOUSE_SUSTAIN_WINDOW),
      reason: isSuspicious
        ? `${lows}/${packet.length} mouse windows below this user's threshold (${VOTE_K}-of-${VOTE_N} vote)`
        : "Mouse rhythm matches.",
    },
  };
}

function mouseStatus(userId) {
  const row = db
    .prepare("SELECT sample_windows, balanced_accuracy, threshold, feature_version, trained_at FROM mouse_profiles WHERE user_id = ?")
    .get(userId);
  const agg = db
    .prepare("SELECT COUNT(*) AS sessions, COALESCE(SUM(window_count),0) AS totalWindows FROM mouse_samples WHERE user_id = ?")
    .get(userId);
  const current = !!row && row.feature_version === MOUSE_FEATURE_VERSION;
  const totalWindows = agg ? agg.totalWindows : 0;
  return {
    enrolled: current,
    needsRetrain: !!row && !current,
    profile: row || null,
    sessions: agg ? agg.sessions : 0,
    totalWindows,
    needWindows: MIN_ENROLL_WINDOWS,
    // Enrolment in the unit the popup shows: samples of SAMPLE_WINDOWS windows, SAMPLES_REQUIRED of them.
    sampleWindows: SAMPLE_WINDOWS,
    samplesRequired: SAMPLES_REQUIRED,
    samplesOnFile: Math.min(SAMPLES_REQUIRED, Math.floor(totalWindows / SAMPLE_WINDOWS)),
    // The live rule, so clients send enough windows per check and label the panel correctly.
    voteN: VOTE_N,
    voteK: VOTE_K,
    thresholdPercentile: THRESHOLD_PERCENTILE,
  };
}

function mouseEnrolled(userId) {
  return !!db
    .prepare("SELECT 1 FROM mouse_profiles WHERE user_id = ? AND feature_version = ?")
    .get(userId, MOUSE_FEATURE_VERSION);
}

// Delete this user's mouse enrollment: the trained profile AND the raw sessions it was built
// from, so a re-enrollment genuinely starts from zero rather than accumulating onto samples
// the user asked to discard. Mirrors ks.resetUserTypingProfile. Destructive and irreversible,
// which is why the caller gates it behind a completed passkey verification.
// Scoped strictly to one user_id — another account's data is never touched.
function resetMouseProfile(userId) {
  const before = db
    .prepare("SELECT COUNT(*) AS n FROM mouse_samples WHERE user_id = ?")
    .get(userId);
  db.prepare("DELETE FROM mouse_profiles WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM mouse_samples WHERE user_id = ?").run(userId);
  // The streak counted strikes against a model that no longer exists. Leaving it would
  // carry stale evidence into the next enrollment and could step the user up on their
  // first packet after re-enrolling.
  decisionState.resetMouseStreak(userId);
  return { removedSessions: before ? before.n : 0 };
}

module.exports = {
  enrollMouse,
  retrainMouse,
  checkMouse,
  mouseStatus,
  mouseEnrolled,
  resetMouseProfile,
  MIN_ENROLL_WINDOWS,
  MIN_SESSION_WINDOWS,
  SAMPLE_WINDOWS,
  SAMPLES_REQUIRED,
  THRESHOLD_PERCENTILE,
  RECENT_WINDOW_COUNT,
  MOUSE_FEATURES,
  MOUSE_FEATURE_VERSION,
  VOTE_N,
  VOTE_K,
};
