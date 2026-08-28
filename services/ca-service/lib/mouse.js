// Mouse-dynamics decision logic for the CA service. Mirrors the keystroke path:
// accumulate enrollment windows across sessions, fine-tune a per-user model from
// the SapiMouse base (transfer learning) via the model-api, and score live
// windows with a Lu-style packet vote. The per-SESSION strike debounce and the
// passkey step-up stay in the demo (they are session/policy concerns).
const db = require("../db");

const MODEL_API_URL = process.env.MODEL_API_URL || "http://localhost:5000";
// Model storage (base model, scaler, negatives, per-user save paths) is OWNED
// by the model-api: we send `modality: "mouse"` and it derives everything.

const RECENT_WINDOW_COUNT = 6;
// Sustained mouse vote — MUST stay equal to MOUSE_SUSTAIN_WINDOW / MOUSE_SUSTAIN_LOW in
// extension/src/background.js, or the same movement yields different verdicts depending on
// whether it was seen by the SDK or the extension. See the rationale at the decision site.
const MOUSE_SUSTAIN_WINDOW = 20;
const MOUSE_SUSTAIN_LOW = 15;
const WINDOW_DECISION_THRESHOLD = 0.5;
const PACKET_VOTE_FRACTION = 0.5;
const MIN_ENROLL_WINDOWS = 150;
const MAX_TRAIN_WINDOWS = 1200;
// Must match sdk/js/mouse-features.js WINDOW_STRIDE — windows overlap by
// (WINDOW_SIZE - WINDOW_STRIDE) steps, so clicks are reconstructed from the
// non-overlapping slice of each window rather than summed across all of them.
const WINDOW_STRIDE = 10;
// is_click (feature index 6) is a trained model feature, not just movement —
// mirrors MOUSE_ENROLL_CLICKS in sdk/guard.js. Enforced here because the client
// gate is UI-only and can be bypassed by calling the endpoint directly.
const MOUSE_ENROLL_CLICKS = 10;

async function postModelApi(path, body) {
  const r = await fetch(`${MODEL_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `model-api ${path} failed`);
  return data;
}

function validWindows(windows) {
  return (
    Array.isArray(windows) &&
    windows.length > 0 &&
    Array.isArray(windows[0]) &&
    windows[0].length === 50 &&
    Array.isArray(windows[0][0]) &&
    windows[0][0].length === 7
  );
}

// Reconstruct the underlying step sequence's click count from overlapping
// windows: the first window in full, then only the new (non-overlapping)
// tail of each subsequent one.
function countClicks(windows) {
  if (!windows.length) return 0;
  let clicks = windows[0].filter((step) => step[6]).length;
  for (let i = 1; i < windows.length; i++) {
    clicks += windows[i].slice(-WINDOW_STRIDE).filter((step) => step[6]).length;
  }
  return clicks;
}

// Enroll: store this session's windows, then (re)train on ALL accumulated
// sessions so enrollment builds up over visits — the mouse analogue of the
// keystroke multi-sample profile. Transfer-learns from the SapiMouse base.
async function enrollMouse(userId, windows) {
  if (!validWindows(windows)) {
    return { status: 400, body: { ok: false, error: "windows must be an array of 50x7 matrices" } };
  }
  if (windows.length < MIN_ENROLL_WINDOWS) {
    return {
      status: 422,
      body: {
        ok: false,
        error: `Keep moving the mouse — need ${MIN_ENROLL_WINDOWS} windows, have ${windows.length}.`,
        have: windows.length,
        need: MIN_ENROLL_WINDOWS,
      },
    };
  }
  const clickCount = countClicks(windows);
  if (clickCount < MOUSE_ENROLL_CLICKS) {
    return {
      status: 422,
      body: {
        ok: false,
        error: `Click a few times while moving — need ${MOUSE_ENROLL_CLICKS} clicks, have ${clickCount}.`,
        haveClicks: clickCount,
        needClicks: MOUSE_ENROLL_CLICKS,
      },
    };
  }

  db.prepare(
    "INSERT INTO mouse_samples (user_id, windows, window_count) VALUES (?, ?, ?)",
  ).run(userId, JSON.stringify(windows), windows.length);

  const rows = db
    .prepare("SELECT windows FROM mouse_samples WHERE user_id = ? ORDER BY id DESC")
    .all(userId);
  let positiveWindows = [];
  for (const row of rows) {
    const w = JSON.parse(row.windows);
    if (positiveWindows.length + w.length > MAX_TRAIN_WINDOWS) {
      positiveWindows = positiveWindows.concat(w.slice(0, MAX_TRAIN_WINDOWS - positiveWindows.length));
      break;
    }
    positiveWindows = positiveWindows.concat(w);
  }
  const sessionCount = rows.length;

  const result = await postModelApi("/api/user/train", {
    userId,
    positiveWindows,
    minPositiveWindows: MIN_ENROLL_WINDOWS,
    modality: "mouse",
    epochs: 25,
    batchSize: 32,
  });

  db.prepare(
    `INSERT INTO mouse_profiles (user_id, model_path, sample_windows, balanced_accuracy, trained_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       model_path=excluded.model_path, sample_windows=excluded.sample_windows,
       balanced_accuracy=excluded.balanced_accuracy, trained_at=CURRENT_TIMESTAMP`,
  ).run(userId, result.modelPath, positiveWindows.length, result.balancedAccuracy ?? null);

  return {
    status: 200,
    body: {
      ok: true,
      message: "Mouse model trained.",
      windowsUsed: positiveWindows.length,
      sessionWindows: windows.length,
      sessionCount,
      balancedAccuracy: result.balancedAccuracy,
      trainedFrom: result.trainedFrom,
    },
  };
}

// Live check: score the recent windows and packet-vote. Returns a SINGLE-packet
// verdict; the demo applies the consecutive-strike debounce + step-up.
async function checkMouse(userId, windows) {
  if (!validWindows(windows)) {
    return { status: 200, body: { ok: true, checked: false, message: "Need more mouse movement." } };
  }
  const profile = db.prepare("SELECT model_path FROM mouse_profiles WHERE user_id = ?").get(userId);
  if (!profile) {
    return { status: 422, body: { ok: false, error: "No mouse model — enroll first.", enrolled: false } };
  }

  // Must supply at least MOUSE_SUSTAIN_WINDOW windows, or the sustained buffer below can
  // never fill and every check reports warmup — silently disabling mouse enforcement. This
  // was 18, chosen for an earlier 6-of-18 rule.
  const recent = windows.slice(-MOUSE_SUSTAIN_WINDOW);
  const result = await postModelApi("/api/user/predict", {
    userId,
    windows: recent,
    modality: "mouse",
    threshold: WINDOW_DECISION_THRESHOLD,
  });
  const scores = (result.prediction || []).map((p) => Number(p[1]));
  // The MOUSE channel decides on a SUSTAINED vote, not the 6-window packet the keystroke
  // channel uses, and this must match extension/src/background.js (MOUSE_SUSTAIN_LOW of
  // MOUSE_SUSTAIN_WINDOW) so the SDK and the extension reach the same verdict from the same
  // motion. Reason for the difference between the two CHANNELS: mouse windows are produced
  // far more often than keystroke windows, so re-evaluating a 3-of-6 rule that frequently
  // turns a normal per-window false-reject rate into a steady stream of false locks. Measured
  // in the browser, genuine browsing leaves ~22% of windows below the threshold, at which
  // 3-of-6 fires on roughly one evaluation in eight; requiring 15 of the last 20 drops that
  // to about 1e-5% while still catching an impostor (~90% low) within twenty windows.
  const buffer = scores.slice(-MOUSE_SUSTAIN_WINDOW);
  const lows = buffer.filter((s) => s < WINDOW_DECISION_THRESHOLD).length;
  const voteFraction = buffer.length ? lows / buffer.length : 0;
  const isWarmup = buffer.length < MOUSE_SUSTAIN_WINDOW;
  const isSuspicious = !isWarmup && lows >= MOUSE_SUSTAIN_LOW;
  const packet = buffer;   // reported below as recentWindowScores

  return {
    status: 200,
    body: {
      ok: true,
      checked: true,
      warmup: isWarmup,
      isSuspicious,
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
        ? `${lows}/${packet.length} mouse windows scored < 50% (sustained vote)`
        : "Mouse rhythm matches.",
    },
  };
}

function mouseStatus(userId) {
  const row = db
    .prepare("SELECT sample_windows, balanced_accuracy, trained_at FROM mouse_profiles WHERE user_id = ?")
    .get(userId);
  const agg = db
    .prepare("SELECT COUNT(*) AS sessions, COALESCE(SUM(window_count),0) AS totalWindows FROM mouse_samples WHERE user_id = ?")
    .get(userId);
  return {
    enrolled: !!row,
    profile: row || null,
    sessions: agg ? agg.sessions : 0,
    totalWindows: agg ? agg.totalWindows : 0,
  };
}

function mouseEnrolled(userId) {
  return !!db.prepare("SELECT 1 FROM mouse_profiles WHERE user_id = ?").get(userId);
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
  return { removedSessions: before ? before.n : 0 };
}

module.exports = {
  enrollMouse,
  checkMouse,
  mouseStatus,
  mouseEnrolled,
  resetMouseProfile,
  MIN_ENROLL_WINDOWS,
  RECENT_WINDOW_COUNT,
};
