// Learning from real use, stage 1 (the owner's plan of 2026-10-23): samples of ordinary mouse use, recorded right after
// a passkey verification, are stored for a later evaluation. Nothing here trains or changes a profile: retrainMouse
// (lib/mouse.js) reads only mouse_samples, the enrolment.
//
// Why only after a passkey. A user's profile learned from clicking dots, but it checks the user while they browse, and
// browsing scores lower (docs/recovery/RESULTS_OWNER_MOUSE.md). Learning from browsing needs movement known to be the
// user's: right after a verified passkey it is. The movement before a lock never is (it may be an impostor's), the same
// reason learning from the lock was rejected for typing.
//
//   1. The gateway verifies a passkey and, in the same request, reports it here (recordUseAnchor). The moment is
//      recorded with the server's clock, and the answer says whether a sample may be recorded now.
//   2. The client asks the user (a small popup); if they agree it records about 16 s of fresh movement and sends it
//      (addUseSample). The sample must arrive within USE_ANCHOR_TTL_MS of the passkey, one per passkey, at most one
//      every USE_SAMPLE_GAP_HOURS, and passes the enrolment's own checks plus the repeated-movement check.
// The server can tell when a sample arrives, not when its first window was moved: the clients start a fresh recorder
// only after the user's answer and drop it at a lock (sdk/guard.js, extension/src/content.js).
const db = require("../db");
const mouse = require("./mouse");
const { postModelApi } = require("./modelClient");

const USE_SAMPLE_SOURCE = "use-after-passkey";
// Our choices, not a paper's: the window covers the popup, the answer and about 16 s of movement in ordinary browsing,
// and the gap is the typing popup's default pause (lib/appSettings.js adaptiveGapHours).
const USE_ANCHOR_TTL_MS = Number(process.env.MOUSE_USE_ANCHOR_TTL_MS || 3 * 60 * 1000);
const USE_SAMPLE_GAP_HOURS = Number(process.env.MOUSE_USE_SAMPLE_GAP_HOURS || 3);
// Stage 2 (25 Oct 2026, artifacts/phase7/PREREGISTRATION_RU.md, amendment A1) found that a profile mixing these samples
// does not lower the owner's false passkey requests: it only makes the profile stricter. The owner rolled the feature
// back, so it is off unless MOUSE_USE_SAMPLES=on. Off, a passkey is answered with no offer, no anchor is recorded and no
// sample is accepted. The code stays for the record and for a later study.
const USE_SAMPLES_ON = String(process.env.MOUSE_USE_SAMPLES || "off").toLowerCase() === "on";

// Timestamps as SQLite writes them ("YYYY-MM-DD HH:MM:SS", UTC), from this process's clock on both backends.
const timeText = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const timeMs = (s) => (s ? Date.parse(String(s).replace(" ", "T") + "Z") : NaN);

// When the next real-use sample may be stored: USE_SAMPLE_GAP_HOURS after the last one, or now.
async function nextUseSampleAt(userId) {
  const last = await db.get("SELECT received_at FROM mouse_use_samples WHERE user_id = ? ORDER BY id DESC LIMIT 1", userId);
  return last ? timeMs(last.received_at) + USE_SAMPLE_GAP_HOURS * 3600 * 1000 : null;
}

// The gateway verified this user's passkey in the request it is answering. `reason`: what the passkey answered
// ("mouse" or "keystroke" step-up, else "other"); a label for the analysis, never a check.
async function recordUseAnchor(userId, { reason } = {}) {
  if (!USE_SAMPLES_ON) return { offer: false, why: "off" };
  const now = Date.now();
  const label = reason === "mouse" || reason === "keystroke" ? reason : "other";
  let why = null, next = null;
  if (!(await mouse.mouseEnrolled(userId))) why = "not_enrolled";
  else {
    next = await nextUseSampleAt(userId);
    if (next && next > now) why = "paused";
  }
  await db.insert(`INSERT INTO mouse_use_anchors (user_id, verified_at, reason, offered, not_offered, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    userId, timeText(now), label, why ? 0 : 1, why, why ? null : timeText(now + USE_ANCHOR_TTL_MS));
  if (why) return { offer: false, why, ...(why === "paused" ? { nextAt: new Date(next).toISOString() } : {}) };
  return { offer: true, expiresInMs: USE_ANCHOR_TTL_MS, sampleWindows: mouse.SAMPLE_WINDOWS };
}

const refuse = (status, error, extra = {}) => ({ status, body: { ok: false, stored: false, error, ...extra } });

// A sample of the movement after the user's latest offered passkey. Stored, never trained on.
async function addUseSample(userId, windows, { client } = {}) {
  if (!USE_SAMPLES_ON) return refuse(403, "off", { note: "Learning from real use is switched off." });
  if (mouse.staleClientWindows(windows)) return refuse(400, "This client sends the retired 7-feature mouse windows. Reload the page or update the extension.");
  if (!mouse.validWindows(windows)) return refuse(400, "windows must be an array of 50x2 matrices");
  if (windows.length < mouse.SAMPLE_WINDOWS) {
    return refuse(422, `A sample is ${mouse.SAMPLE_WINDOWS} windows of movement; this one has ${windows.length}.`, { have: windows.length });
  }
  // The first windows after the passkey: the ones nearest to it.
  const sample = windows.slice(0, mouse.SAMPLE_WINDOWS);
  const spread = mouse.stepSpreadPx(sample);
  if (spread < mouse.MIN_STEP_IQR_PX) return refuse(422, "This movement is too uniform to learn from.", { stepSpreadPx: spread });
  const profile = await db.get("SELECT model_path, threshold, trained_at, feature_version, decision_version FROM mouse_profiles WHERE user_id = ?", userId);
  if (!profile || profile.feature_version !== mouse.MOUSE_FEATURE_VERSION || profile.decision_version !== mouse.MOUSE_DECISION_VERSION) {
    return refuse(409, "not_enrolled", { note: "Real-use samples are kept only for a trained mouse profile." });
  }
  const now = Date.now();
  const anchor = await db.get("SELECT id, verified_at, expires_at FROM mouse_use_anchors WHERE user_id = ? AND offered = 1 AND used_at IS NULL ORDER BY id DESC LIMIT 1", userId);
  if (!anchor) return refuse(403, "no_anchor", { note: "A real-use sample is taken only right after a passkey verification." });
  if (!(timeMs(anchor.expires_at) >= now)) return refuse(403, "anchor_expired", { note: "The sample came too long after the passkey." });
  const next = await nextUseSampleAt(userId);
  if (next && next > now) return refuse(409, "paused", { nextAt: new Date(next).toISOString() });
  const runs = mouse.stepRuns(sample);
  for (const table of ["mouse_samples", "mouse_use_samples"]) {
    for (const s of await db.all(`SELECT windows FROM ${table} WHERE user_id = ?`, userId)) {
      const share = mouse.repeatShare(runs, mouse.stepRuns(JSON.parse(s.windows)));
      if (share > mouse.REPEAT_LIMIT) return refuse(422, "This movement is already in one of your samples.", { repeatedShare: share });
    }
  }
  // The scores the profile in force gives these windows: for the evaluation (stage 2), never a gate. A model service
  // that does not answer leaves them empty; the windows are kept, and can be scored later.
  let scores = null, lows = null;
  try {
    const r = await postModelApi("/api/user/predict", { userId, windows: sample, modality: "mouse", modelPath: profile.model_path, threshold: profile.threshold });
    scores = (r.prediction || []).map((p) => Number(p[1]));
    lows = scores.filter((v) => v < profile.threshold).length;
  } catch (e) { console.warn(`[mouse-use] user ${userId}: sample stored without scores (${e.message})`); }
  // One sample per passkey: the anchor is claimed in the same transaction that stores the sample.
  const sampleId = await db.tx(async () => {
    const claimed = await db.run("UPDATE mouse_use_anchors SET used_at = ? WHERE id = ? AND used_at IS NULL", timeText(now), anchor.id);
    if (claimed.changes !== 1) return null;
    const id = await db.insert(
      `INSERT INTO mouse_use_samples (user_id, anchor_id, anchor_at, received_at, source, client, windows, window_count, step_spread_px,
         profile_trained_at, decision_version, threshold, scores, low_windows)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId, anchor.id, anchor.verified_at, timeText(now), USE_SAMPLE_SOURCE, client === "extension" ? "extension" : "sdk",
      JSON.stringify(sample), sample.length, spread, profile.trained_at, profile.decision_version, profile.threshold,
      scores ? JSON.stringify(scores) : null, lows);
    await db.run("UPDATE mouse_use_anchors SET sample_id = ? WHERE id = ?", id, anchor.id);
    return id;
  });
  if (!sampleId) return refuse(409, "anchor_used", { note: "This passkey already gave a sample." });
  return { status: 200, body: { ok: true, stored: true, sampleId, nextAt: new Date(now + USE_SAMPLE_GAP_HOURS * 3600 * 1000).toISOString(),
    message: "Saved. It is kept to test learning from real use; your profile does not change." } };
}

async function useStatus(userId) {
  const agg = await db.get("SELECT COUNT(*) AS n, MAX(received_at) AS last FROM mouse_use_samples WHERE user_id = ?", userId);
  const next = await nextUseSampleAt(userId);
  return { useSamplesOn: USE_SAMPLES_ON, useSamples: agg ? agg.n : 0, lastUseSampleAt: agg && agg.last ? new Date(timeMs(agg.last)).toISOString() : null,
    nextUseSampleAt: USE_SAMPLES_ON && next && next > Date.now() ? new Date(next).toISOString() : null };
}

module.exports = { recordUseAnchor, addUseSample, useStatus, USE_SAMPLE_SOURCE, USE_ANCHOR_TTL_MS, USE_SAMPLE_GAP_HOURS, USE_SAMPLES_ON };
