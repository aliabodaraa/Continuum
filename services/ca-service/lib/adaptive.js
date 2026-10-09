/**
 * Adaptive retraining, the cycle the owner chose on 2026-10-04:
 *
 *   1. clean stretches of typing are offered as samples; each one that passes the gates is kept as
 *      PENDING (sample_purpose 'adaptive-pending', is_training 0): no retrain of any kind uses it yet;
 *   2. samples never overlap: the SDK sends only typing after the previous sample (plus one window's
 *      gap), and this module refuses a sample that shares key events with a pending or recent one;
 *   3. at RETRAIN_EVERY pending samples, the user retrains, and must pass the passkey to do so (the
 *      gateway and the demo backend check it before calling confirm()); the samples become training
 *      samples and the model is retrained;
 *   4. after a retrain the feature pauses for the organisation's gap (default 3 hours).
 *
 * The passkey makes injected samples useless to someone at an unlocked session: they can add pending
 * samples, but cannot turn them into a model.
 */
const db = require("../db");   // table adaptive_state: see db.js

const PENDING = "adaptive-pending";
const OVERLAP_LIMIT = 0.05;   // share of a new sample's key presses that may coincide with an earlier sample's

async function pendingIds(userId) {
  return (await db.all(`SELECT id FROM keystroke_texts WHERE user_id = ? AND sample_purpose = ? ORDER BY id`, userId, PENDING))
    .map((r) => r.id);
}
async function pendingCount(userId) { return (await pendingIds(userId)).length; }

async function lastRetrainAt(userId) {
  const row = await db.get(`SELECT last_retrain_at AS at FROM adaptive_state WHERE user_id = ?`, userId);
  return row ? row.at : null;
}

// Key presses as (time, key) pairs. Two samples from the same page share these exactly when they
// overlap; samples from different pages (each tracker starts its own clock) practically never do.
function keyMarks(events) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => e && e.eventType === "keydown")
    .map((e) => `${Number(e.timestampRelative)}|${Number(e.keyCode)}`);
}
async function overlapShare(userId, events) {
  const marks = keyMarks(events);
  if (!marks.length) return 0;
  const ids = (await pendingIds(userId)).concat(
    (await db.all(`SELECT id FROM keystroke_texts WHERE user_id = ? AND sample_purpose = 'adaptive' ORDER BY id DESC LIMIT 3`, userId))
      .map((r) => r.id));
  if (!ids.length) return 0;
  const prior = new Set((await db.all(
    `SELECT timestamp_relative AS t, key_code AS k FROM keystroke_events
      WHERE event_type = 'keydown' AND keystroke_text_id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  )).map((r) => `${Number(r.t)}|${Number(r.k)}`));
  return marks.filter((m) => prior.has(m)).length / marks.length;
}

// A sample's key sequence (what was typed, not when): the same phrase typed again is the same sample.
function keySequence(events) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => e && e.eventType === "keydown" && Number(e.keyCode) > 0)
    .map((e) => Number(e.keyCode)).join(",");
}

/** The pending samples become training samples and the pause starts. Returns how many. */
async function confirm(userId) {
  return db.tx(async () => {
    const ids = await pendingIds(userId);
    if (!ids.length) return 0;
    await db.run(`UPDATE keystroke_texts SET sample_purpose = 'adaptive', is_training = 1
                   WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
    await db.run(`INSERT INTO adaptive_state (user_id, last_retrain_at) VALUES (?, datetime('now'))
                   ON CONFLICT(user_id) DO UPDATE SET last_retrain_at = excluded.last_retrain_at`, userId);
    return ids.length;
  });
}

/** A profile reset forgets pending samples and the pause with it. */
async function forget(userId) {
  await db.tx(async () => {
    const ids = await pendingIds(userId);
    if (ids.length) {   // keystroke_events has no cascading key: remove a pending sample's events with it
      const list = ids.map(() => "?").join(",");
      await db.run(`DELETE FROM keystroke_events WHERE keystroke_text_id IN (${list})`, ...ids);
      await db.run(`DELETE FROM keystroke_texts WHERE id IN (${list})`, ...ids);
    }
    await db.run(`DELETE FROM adaptive_state WHERE user_id = ?`, userId);
  });
}

module.exports = { PENDING, OVERLAP_LIMIT, pendingCount, lastRetrainAt, overlapShare, keySequence, confirm, forget };
