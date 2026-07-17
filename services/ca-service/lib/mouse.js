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
const WINDOW_DECISION_THRESHOLD = 0.5;
const PACKET_VOTE_FRACTION = 0.5;
const MIN_ENROLL_WINDOWS = 150;
const MAX_TRAIN_WINDOWS = 1200;

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

  const recent = windows.slice(-18);
  const result = await postModelApi("/api/user/predict", {
    userId,
    windows: recent,
    modality: "mouse",
    threshold: WINDOW_DECISION_THRESHOLD,
  });
  const scores = (result.prediction || []).map((p) => Number(p[1]));
  const packet = scores.slice(-RECENT_WINDOW_COUNT);
  const lows = packet.filter((s) => s < WINDOW_DECISION_THRESHOLD).length;
  const voteFraction = packet.length ? lows / packet.length : 0;
  const isWarmup = packet.length < RECENT_WINDOW_COUNT;
  const isSuspicious = !isWarmup && voteFraction >= PACKET_VOTE_FRACTION;

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
      reason: isSuspicious
        ? `${lows}/${packet.length} mouse windows scored < 50% (packet vote)`
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

module.exports = {
  enrollMouse,
  checkMouse,
  mouseStatus,
  mouseEnrolled,
  MIN_ENROLL_WINDOWS,
  RECENT_WINDOW_COUNT,
};
