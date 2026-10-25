/**
 * Durable per-user decision counters.
 *
 * The mouse escalation rule is evidence ACCUMULATED ACROSS CHECKS: N consecutive suspicious
 * mouse packets. Holding that evidence in a `Map` made every restart an amnesty: an impostor
 * one check short of a step-up resumed from zero after any deploy, crash, or OOM kill, and
 * nothing in the logs said so.
 *
 * It also scattered one fact across owners — a Map in the gateway, and
 * `req.session.mouseSuspiciousStreak` in the demo — so the SDK and the demo could disagree
 * about how suspicious the same person had just been.
 *
 * Both problems have the same fix: the service that owns the behavioral data owns the
 * evidence derived from it. Callers keep their own THRESHOLD (the gateway steps up at 3
 * strikes, the demo at 1 — a deliberate difference, see apps/demo/routes/auth/mouse.js);
 * they no longer keep their own COUNT.
 *
 * Values are stored as JSON text so counters of any shape use the same table.
 *
 * Each update is a read and a write of one row; both happen in one transaction with that row locked
 * (FOR UPDATE with postgres; SQLite's single writer), so two checks of one user handled at once by two
 * copies of the service cannot both read the old value and lose one of the two verdicts.
 */
const db = require("../db");

async function get(userId, key, fallback) {
  const row = await db.get("SELECT value FROM decision_state WHERE user_id = ? AND key = ?", userId, key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback; }
}

async function set(userId, key, value) {
  await db.run(
    `INSERT INTO decision_state (user_id, key, value, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    userId, key, JSON.stringify(value),
  );
  return value;
}

async function clear(userId, key) {
  await db.run("DELETE FROM decision_state WHERE user_id = ? AND key = ?", userId, key);
}

// Read-modify-write of one (user, key) under its row lock. The row is made first if missing, so there is
// always a row to lock; `fn(current)` returns the new value, or undefined to delete it.
async function update(userId, key, fallback, fn) {
  return db.tx(async () => {
    await db.run("INSERT INTO decision_state (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING",
      userId, key, JSON.stringify(fallback));
    const row = await db.get(`SELECT value FROM decision_state WHERE user_id = ? AND key = ?${db.kind === "postgres" ? " FOR UPDATE" : ""}`, userId, key);
    let current = fallback;
    try { current = JSON.parse(row.value); } catch (e) { /* a damaged row reads as the fallback */ }
    const next = fn(current);
    if (next === undefined) await clear(userId, key);
    else await set(userId, key, next);
    return next;
  });
}

// ---- mouse suspicious streak --------------------------------------------------------
// CONSECUTIVE: any clean scored packet clears it. Mouse packets arrive often, so a sliding
// window would keep stale evidence alive across minutes of normal use.
const MOUSE_STREAK = "mouse_suspicious_streak";

/**
 * Advance the streak for one scored packet and return its new value.
 * Warm-up packets carry no verdict, so they neither increment nor clear.
 */
async function updateMouseStreak(userId, { isSuspicious, warmup }) {
  if (warmup) return get(userId, MOUSE_STREAK, 0);
  if (!isSuspicious) { await clear(userId, MOUSE_STREAK); return 0; }
  return update(userId, MOUSE_STREAK, 0, (n) => Number(n || 0) + 1);
}

async function getMouseStreak(userId) {
  return Number(await get(userId, MOUSE_STREAK, 0));
}

/** Spent on a step-up, or invalidated when the profile it was measured against is deleted. */
async function resetMouseStreak(userId) {
  await clear(userId, MOUSE_STREAK);
}

/** Everything derived from a model that no longer exists (profile reset, re-enrollment). */
async function resetAll(userId) {
  await db.run("DELETE FROM decision_state WHERE user_id = ?", userId);
}

module.exports = {
  get, set, clear,
  updateMouseStreak, getMouseStreak, resetMouseStreak,
  resetAll,
};
