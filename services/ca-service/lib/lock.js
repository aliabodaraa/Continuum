// Persisted "passkey step-up pending" flag, keyed by userId. Shared source of
// truth so ANY app embedding the SDK — not just apps/demo's own Express
// session — can tell on page load whether the user must be logged out
// instead of silently resuming (see sdk/guard.js init()).
const db = require("../db");

function setLocked(userId) {
  db.prepare(
    "INSERT INTO session_locks (user_id, locked_at) VALUES (?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(user_id) DO UPDATE SET locked_at = CURRENT_TIMESTAMP",
  ).run(userId);
}

function clearLocked(userId) {
  db.prepare("DELETE FROM session_locks WHERE user_id = ?").run(userId);
}

function isLocked(userId) {
  return !!db.prepare("SELECT 1 FROM session_locks WHERE user_id = ?").get(userId);
}

module.exports = { setLocked, clearLocked, isLocked };
