// Who may read every user's records in this app: the all-users decision CSV and the per-user metrics table. The
// usernames in DEMO_ADMIN_USERS (comma-separated, case-insensitive); nobody when it is empty. Everyone else gets
// their own records only. Before 2026-11-03 any signed-in user could download every user's decision log with the
// usernames (Continuum's tenant API scopes those reads to the organisation, so the app has to decide who sees them).
const db = require("../db/init");

function adminNames(env = process.env) {
  return new Set(String(env.DEMO_ADMIN_USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function isAdminName(username, env = process.env) {
  return !!username && adminNames(env).has(String(username).toLowerCase());
}

// The signed-in user of this request is an admin (by the username in the database, not the session's copy).
function isAdmin(req, env = process.env) {
  if (!req.session || !req.session.userId) return false;
  const u = db.prepare("SELECT username FROM users WHERE id = ?").get(req.session.userId);
  return isAdminName(u && u.username, env);
}

module.exports = { adminNames, isAdminName, isAdmin };
