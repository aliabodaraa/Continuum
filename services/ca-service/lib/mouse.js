// Mouse-dynamics decision logic for the CA service. Mirrors the keystroke path:
// accumulate enrollment windows across sessions, fine-tune a per-user model from
// the SapiMouse base (transfer learning) via the model-api, and score live
// windows with a Lu-style packet vote. The per-SESSION strike debounce and the
// passkey step-up stay in the demo (they are session/policy concerns).
const db = require("../db");
const studyLog = require("./studyLog");

// Model storage (base model, scaler, negatives, per-user save paths) is OWNED
// by the model-api: we send `modality: "mouse"` and it derives everything.
// The hop itself is authenticated + deadline-bounded — see lib/modelClient.js.
const { postModelApi } = require("./modelClient");
const decisionState = require("./decisionState");
const trainingQueue = require("./trainingQueue");

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

// ---- Enrolment and decision: S1 (AMENDMENT_J1.md §2), the owner's decision of 2026-09-23 ----
// Enrolment = 440 windows, 8 samples of 55 (~2 min of movement). It ACCUMULATES over sessions: a
// session is stored once it passes the per-session gate, and a model is owed once the total reaches
// 440. The model is always trained on the user's LATEST 440 windows, the amount the lockbox
// evaluated (previously 330, trained on up to 1200).
// Threshold = the 20th percentile of the user's LEAVE-ONE-SAMPLE-OUT scores: eight fold models each
// score the enrolment sample they never saw (model-api train_user_loso_payload, the recipe
// protocol_j_p1.py evaluated). The old threshold, the 1st percentile of the final model's scores on
// its own training windows, collapsed to 0.009-0.054 for some users, which let nearly any movement
// pass (TODO §7). A window is "low" below the threshold; the session is suspicious when VOTE_K of
// the last VOTE_N windows are low (~17 s of movement).
// On the untouched first lockbox (P6, 20 users, base-80 network) S1 caught 95.0% of 40-s impostor
// runs against 77.1% for the old rule (2 users below 80% capture instead of 8), at 0.33 instead of
// 0.17 genuine passkey prompts per minute of movement (16 and 18 of 20 users never prompted). The
// pre-registered test did not adopt it, because the prompt increase (+0.15 [0.00, +0.31]) missed its
// +0.10 margin: S0 stands in the record, and S1 is deployed as a disclosed deviation (RUN_LOG).
// The browser extension trains a different model and uses its own measured point (Experiment I:
// mean of the last 60 windows below the 2nd percentile); it is unchanged.
const MIN_ENROLL_WINDOWS = 440;
const MIN_SESSION_WINDOWS = 55;      // ~16 s; shorter submissions are not stored
// The unit users see: one SAMPLE = MIN_SESSION_WINDOWS windows (~16 s of movement), and a profile
// needs SAMPLES_REQUIRED of them (8 x 55 = 440), shown as "sample 2 of 8" like the typing channel.
// It is also the unit the leave-one-sample-out folds hold out.
const SAMPLE_WINDOWS = MIN_SESSION_WINDOWS;
const SAMPLES_REQUIRED = Math.ceil(MIN_ENROLL_WINDOWS / SAMPLE_WINDOWS);
// Spread (interquartile range) of step sizes in the submission, px. Real SapiMouse batches of
// 55 windows: 1st percentile 7.1 px, 5th 9.8 px. Constant-speed or jittering motion scores ~0.
// Replaces the old click gate: the model no longer reads clicks.
const MIN_STEP_IQR_PX = 5;

const THRESHOLD_PERCENTILE = 20;
const THRESHOLD_SOURCE = "leave-one-sample-out";
const VOTE_N = 60;
const VOTE_K = 33;
// Stored with every profile. A profile trained under another rule (the old in-sample threshold goes
// with 30 of 60, not 33) is retrained, never scored against this vote.
const MOUSE_DECISION_VERSION = "s1-loso-p20-33of60";
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

  // Enough for a model. It is trained by the durable queue (lib/trainingQueue.js), not inside this
  // request: the leave-one-sample-out recipe fits nine models (8 folds + the final one), 2-3 minutes
  // on CPU (145-158 s measured). Clients poll /status, which reports `training` until the profile
  // is stored.
  const wasEnrolled = mouseEnrolled(userId);
  const job = trainingQueue.enqueue(userId, "mouse", wasEnrolled ? "extra-sample" : "enrol");
  return {
    status: 202,
    body: {
      ok: true,
      trained: false,
      training: true,
      message: wasEnrolled
        ? "Sample saved. Your mouse model is being rebuilt from your latest samples."
        : `Saved sample ${SAMPLES_REQUIRED} of ${SAMPLES_REQUIRED}. Building your mouse model — two to three minutes.`,
      samplesOnFile: Math.min(SAMPLES_REQUIRED, Math.floor(total / SAMPLE_WINDOWS)),
      samplesRequired: SAMPLES_REQUIRED,
      sampleWindows: SAMPLE_WINDOWS,
      totalWindows: total,
      need: MIN_ENROLL_WINDOWS,
      sessionWindows: windows.length,
      sessionCount,
      jobId: job.id,
    },
  };
}

// Train (or retrain) the user's model on their latest MIN_ENROLL_WINDOWS windows. Runs from the
// training queue (registered in server.js), and directly from scripts/retrain_mouse_profiles.js
// and the one-off migration of profiles built on the retired representation
// (scripts/migrate_mouse_a5.js), so every path goes through the same code.
async function retrainMouse(userId, extra = {}) {
  const rows = db
    .prepare("SELECT id, windows, window_count FROM mouse_samples WHERE user_id = ? ORDER BY id DESC")
    .all(userId);
  const total = rows.reduce((a, r) => a + r.window_count, 0);
  if (total < MIN_ENROLL_WINDOWS) {
    return { status: 409, body: { ok: false, error: `only ${total} of ${MIN_ENROLL_WINDOWS} windows stored`, totalWindows: total } };
  }
  const sessionCount = rows.length;
  // The newest sessions back to MIN_ENROLL_WINDOWS windows (the oldest of them contributing only
  // its most recent windows), put back in time order: 8 consecutive 55-window samples, as in the
  // evaluation. The SDK stores one sample per session, so each fold normally holds out one real
  // session; the boundary purge in model-api covers samples cut from a longer session.
  const kept = [];
  const usedIds = [];
  let n = 0;
  for (const row of rows) {
    let w = JSON.parse(row.windows);
    if (n + w.length > MIN_ENROLL_WINDOWS) w = w.slice(-(MIN_ENROLL_WINDOWS - n));
    kept.push(w);
    usedIds.push(row.id);
    n += w.length;
    if (n >= MIN_ENROLL_WINDOWS) break;
  }
  const positiveWindows = kept.reverse().flat();

  // epochs 15 / batch 32 / overlap gap 5: the settings the lockbox evaluation used.
  const result = await postModelApi("/api/user/train", {
    userId,
    positiveWindows,
    modality: "mouse",
    thresholdScheme: THRESHOLD_SOURCE,
    sampleWindows: SAMPLE_WINDOWS,
    overlapGap: Math.ceil(MOUSE_WINDOW_SIZE / WINDOW_STRIDE),
    epochs: 15,
    batchSize: 32,
  });
  const loso = result.losoScorePercentiles || {};
  const threshold = Number(loso[String(THRESHOLD_PERCENTILE)]);
  if (!Number.isFinite(threshold)) {
    return { status: 502, body: { ok: false, error: "model-api did not return leave-one-sample-out percentiles; is it on the current version?" } };
  }
  // A reset during training deletes the samples this model was built from. Storing the profile
  // then would bring back an enrolment the user asked to discard.
  const stillThere = db
    .prepare(`SELECT COUNT(*) AS n FROM mouse_samples WHERE user_id = ? AND id IN (${usedIds.map(() => "?").join(",")})`)
    .get(userId, ...usedIds).n;
  if (stillThere !== usedIds.length) {
    return { status: 409, body: { ok: false, error: "mouse samples changed during training (reset); profile not stored" } };
  }

  // Both percentile tables are kept with the profile (out-of-sample, which the threshold uses, and
  // the in-sample one it replaced), so an operating-point change needs no retraining.
  db.prepare(
    `INSERT INTO mouse_profiles (user_id, model_path, sample_windows, balanced_accuracy, threshold, feature_version,
       enrol_percentiles, loso_percentiles, decision_version, trained_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       model_path=excluded.model_path, sample_windows=excluded.sample_windows,
       balanced_accuracy=excluded.balanced_accuracy, threshold=excluded.threshold,
       feature_version=excluded.feature_version, enrol_percentiles=excluded.enrol_percentiles,
       loso_percentiles=excluded.loso_percentiles, decision_version=excluded.decision_version,
       trained_at=CURRENT_TIMESTAMP`,
  ).run(userId, result.modelPath, positiveWindows.length, result.balancedAccuracy ?? null,
        threshold, MOUSE_FEATURE_VERSION, JSON.stringify(result.enrolScorePercentiles || {}),
        JSON.stringify(loso), MOUSE_DECISION_VERSION);
  // User study: all 440 leave-one-sample-out scores, the source of the threshold.
  studyLog.recordProfile(userId, {
    channel: "mouse", ruleVersion: MOUSE_DECISION_VERSION, threshold,
    thresholdSource: `loso-p${THRESHOLD_PERCENTILE}`, modelPath: result.modelPath,
    windowCount: positiveWindows.length, thresholdScores: result.losoScores,
  });

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
      thresholdSource: THRESHOLD_SOURCE,
      balancedAccuracy: result.balancedAccuracy,
      trainedFrom: result.trainedFrom,
    },
  };
}

// A user with enough samples but no current profile is owed a model: an enrolment whose job was
// lost, or a profile trained under an earlier decision rule. Record that (enqueue is idempotent)
// unless the last attempt failed: that needs a person, and retrying on every status poll would spin.
function ensureModelOwed(userId, totalWindows, current) {
  if (current || totalWindows < MIN_ENROLL_WINDOWS) return null;
  const { pending, jobs } = trainingQueue.statusFor(userId, "mouse");
  if (pending) return pending;
  if (jobs.length && jobs[0].state === "failed") return null;
  return trainingQueue.enqueue(userId, "mouse", "owed");
}

// Live check: score the recent windows and packet-vote. Returns a SINGLE-packet
// verdict; the demo applies the consecutive-strike debounce + step-up.
async function checkMouse(userId, windows, study = null) {
  if (staleClientWindows(windows)) {
    return { status: 400, body: { ok: false, error: "This client sends the retired 7-feature mouse windows. Reload the page or update the extension." } };
  }
  if (!validWindows(windows)) {
    return { status: 200, body: { ok: true, checked: false, message: "Need more mouse movement." } };
  }
  const profile = db
    .prepare("SELECT model_path, threshold, feature_version, decision_version FROM mouse_profiles WHERE user_id = ?")
    .get(userId);
  if (!profile) {
    return { status: 422, body: { ok: false, error: "No mouse model — enroll first.", enrolled: false } };
  }
  if (profile.feature_version !== MOUSE_FEATURE_VERSION || !Number.isFinite(profile.threshold)) {
    // A profile trained on the retired representation cannot score these windows.
    return { status: 422, body: { ok: false, error: "Mouse profile predates the current model — retrain it.", enrolled: false, retrain: true } };
  }
  if (profile.decision_version !== MOUSE_DECISION_VERSION) {
    // Trained under an earlier decision rule: its threshold does not belong with this vote. The
    // stored samples are enough to rebuild it, so the rebuild is queued rather than asked for.
    const total = db.prepare("SELECT COALESCE(SUM(window_count), 0) AS n FROM mouse_samples WHERE user_id = ?").get(userId).n;
    const owed = ensureModelOwed(userId, total, false);
    return {
      status: 422,
      body: { ok: false, enrolled: false, retrain: true, training: !!owed,
              error: owed ? "Your mouse profile is being rebuilt for the current decision rule." : "Mouse profile predates the current decision rule — retrain it." },
    };
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
          JSON.stringify(scores));   // full precision: EER/AUC are computed from these offline
  } catch (e) { /* logging must never block a verdict */ }
  // User study (lib/studyLog.js; a no-op outside it). The client numbers its windows per session.
  const studyCtx = studyLog.parseContext(study);
  const studyDecisionId = studyCtx ? studyLog.recordCheck(userId, studyCtx, {
    channel: "mouse", ruleVersion: MOUSE_DECISION_VERSION, threshold: userThreshold,
    scores: buffer, keys: Array.isArray(study.windowKeys) ? study.windowKeys.slice(-MOUSE_SUSTAIN_WINDOW).slice(-buffer.length) : null,
    lowWindows: lows, verdict: isWarmup ? "warmup" : isSuspicious ? "suspicious" : "ok", promptRequired: false,
  }) : null;

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
      ...(studyDecisionId ? { studyDecisionId } : {}),
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
    .prepare("SELECT sample_windows, balanced_accuracy, threshold, feature_version, decision_version, trained_at FROM mouse_profiles WHERE user_id = ?")
    .get(userId);
  const agg = db
    .prepare("SELECT COUNT(*) AS sessions, COALESCE(SUM(window_count),0) AS totalWindows FROM mouse_samples WHERE user_id = ?")
    .get(userId);
  const current = !!row && row.feature_version === MOUSE_FEATURE_VERSION && row.decision_version === MOUSE_DECISION_VERSION;
  const totalWindows = agg ? agg.totalWindows : 0;
  // Training runs from the queue, so a client that has sent the last sample polls here: `training`
  // while a job is queued or running, `enrolled` once the profile is stored, `trainingError` if the
  // last job failed without leaving a current profile.
  const owed = ensureModelOwed(userId, totalWindows, current);
  const { pending, jobs } = trainingQueue.statusFor(userId, "mouse");
  const failed = !current && !pending && jobs.length && jobs[0].state === "failed" ? jobs[0].last_error || "training failed" : null;
  return {
    enrolled: current,
    needsRetrain: !!row && !current,
    training: !!(pending || owed),
    trainingError: failed,
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
    thresholdSource: THRESHOLD_SOURCE,
  };
}

function mouseEnrolled(userId) {
  return !!db
    .prepare("SELECT 1 FROM mouse_profiles WHERE user_id = ? AND feature_version = ? AND decision_version = ?")
    .get(userId, MOUSE_FEATURE_VERSION, MOUSE_DECISION_VERSION);
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
  THRESHOLD_SOURCE,
  RECENT_WINDOW_COUNT,
  MOUSE_FEATURES,
  MOUSE_FEATURE_VERSION,
  MOUSE_DECISION_VERSION,
  VOTE_N,
  VOTE_K,
};
