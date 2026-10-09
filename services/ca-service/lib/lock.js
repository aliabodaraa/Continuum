// Persisted "passkey step-up pending" flag, keyed by userId. Shared source of
// truth so ANY app embedding the SDK — not just apps/demo's own Express
// session — can tell on page load whether the user must be logged out
// instead of silently resuming (see sdk/guard.js init()).
const db = require("../db");

async function setLocked(userId) {
  await db.run(
    "INSERT INTO session_locks (user_id, locked_at) VALUES (?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(user_id) DO UPDATE SET locked_at = CURRENT_TIMESTAMP",
    userId,
  );
}

async function clearLocked(userId) {
  await db.run("DELETE FROM session_locks WHERE user_id = ?", userId);
}

async function isLocked(userId) {
  return !!(await db.get("SELECT 1 FROM session_locks WHERE user_id = ?", userId));
}

module.exports = { setLocked, clearLocked, isLocked };
