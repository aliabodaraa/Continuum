/**
 * Durable per-user decision counters.
 *
 * The escalation rules are evidence ACCUMULATED ACROSS CHECKS — 2 suspicious keystroke
 * checks out of the last 3, N consecutive suspicious mouse packets. Holding that evidence
 * in a `Map` made every restart an amnesty: an impostor one check short of a step-up
 * resumed from zero after any deploy, crash, or OOM kill, and nothing in the logs said so.
 *
 * It also scattered one fact across three owners — a Map in ca-service (keystroke), a Map
 * in the gateway (mouse), and `req.session.mouseSuspiciousStreak` in the demo — so the SDK
 * and the demo could disagree about how suspicious the same person had just been.
 *
 * Both problems have the same fix: the service that owns the behavioral data owns the
 * evidence derived from it. Callers keep their own THRESHOLD (the gateway steps up at 3
 * strikes, the demo at 1 — a deliberate difference, see apps/demo/routes/auth/mouse.js);
 * they no longer keep their own COUNT.
 *
 * Values are stored as JSON text so a counter and a sliding window use the same table.
 */
const db = require("../db");

const readStmt = db.prepare("SELECT value FROM decision_state WHERE user_id = ? AND key = ?");
const writeStmt = db.prepare(
  `INSERT INTO decision_state (user_id, key, value, updated_at)
   VALUES (?, ?, ?, CURRENT_TIMESTAMP)
   ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
);
const clearStmt = db.prepare("DELETE FROM decision_state WHERE user_id = ? AND key = ?");

function get(userId, key, fallback) {
  const row = readStmt.get(userId, key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch (e) { return fallback; }
}

function set(userId, key, value) {
  writeStmt.run(userId, key, JSON.stringify(value));
  return value;
}

function clear(userId, key) {
  clearStmt.run(userId, key);
}

// ---- keystroke challenge debounce -------------------------------------------------
// A SLIDING window of the last N verdicts, not a consecutive run: sustained-but-intermittent
// abnormal typing (high-speed mashing that is suspicious on many packets but rarely twice in
// a row) must still escalate. See the KS_SUSPICIOUS_* constants in server.js.
const KS_HISTORY = "ks_suspicious_history";

/** Append one verdict, trim to `windowSize`, and return how many of the retained are suspicious. */
function pushKeystrokeVerdict(userId, isSuspicious, windowSize) {
  const hist = get(userId, KS_HISTORY, []).filter((v) => typeof v === "boolean");
  hist.push(!!isSuspicious);
  const trimmed = hist.slice(-windowSize);
  set(userId, KS_HISTORY, trimmed);
  return { history: trimmed, suspiciousCount: trimmed.filter(Boolean).length };
}

/** Called when a step-up fires: the evidence has been acted on, so it is spent. */
function resetKeystrokeHistory(userId) {
  clear(userId, KS_HISTORY);
}

// ---- mouse suspicious streak --------------------------------------------------------
// CONSECUTIVE, unlike the keystroke window: any clean scored packet clears it. Mouse
// windows arrive far more often than keystroke windows, so a sliding window would keep
// stale evidence alive across minutes of normal use.
const MOUSE_STREAK = "mouse_suspicious_streak";

/**
 * Advance the streak for one scored packet and return its new value.
 * Warm-up packets carry no verdict, so they neither increment nor clear.
 */
function updateMouseStreak(userId, { isSuspicious, warmup }) {
  if (warmup) return get(userId, MOUSE_STREAK, 0);
  if (!isSuspicious) { clear(userId, MOUSE_STREAK); return 0; }
  const next = Number(get(userId, MOUSE_STREAK, 0)) + 1;
  set(userId, MOUSE_STREAK, next);
  return next;
}

function getMouseStreak(userId) {
  return Number(get(userId, MOUSE_STREAK, 0));
}

/** Spent on a step-up, or invalidated when the profile it was measured against is deleted. */
function resetMouseStreak(userId) {
  clear(userId, MOUSE_STREAK);
}

/** Everything derived from a model that no longer exists (profile reset, re-enrollment). */
function resetAll(userId) {
  db.prepare("DELETE FROM decision_state WHERE user_id = ?").run(userId);
}

module.exports = {
  get, set, clear,
  pushKeystrokeVerdict, resetKeystrokeHistory,
  updateMouseStreak, getMouseStreak, resetMouseStreak,
  resetAll,
};
