// Continuous authentication (typing and mouse behaviour), as this app's backend uses it. Every call goes
// through Continuum's tenant API (services/continuumApi.js); `userId` below is always THIS app's own
// users.id, which the gateway maps to the Continuum user. Results come back as { status, ok, data }.
const { request } = require("./continuumApi");

module.exports = {
  // the organisation's settings for its users (console / operator page): typing packet, channels, ...
  config: (userId) => request("GET", "/keystroke/config", userId),
  onboarding: (userId) => request("GET", "/onboarding", userId),
  keystrokeStatus: (userId) => request("GET", "/keystroke/status", userId),

  // keystroke operations
  keystrokeEnroll: (userId, body) => request("POST", "/keystroke/enroll", userId, body),
  keystrokeCheck: (userId, body) => request("POST", "/keystroke/check", userId, body),
  keystrokeContribute: (userId, body) => request("POST", "/keystroke/contribute", userId, body),
  // Pending adaptive samples -> retrain. Continuum asks for proof of a passkey verified moments ago: the
  // stepUpToken that passkeyClient.authComplete returned (2 minutes, once).
  keystrokeAdaptiveConfirm: (userId, stepUpToken) => request("POST", "/keystroke/adaptive/confirm", userId, { stepUpToken }),
  keystrokeReset: (userId) => request("POST", "/keystroke/reset", userId, {}),
  keystrokeRetrain: (userId) => request("POST", "/keystroke/retrain", userId, {}),
  maybeRetrainImpostors: (userId) => request("POST", "/keystroke/maybe-retrain-impostors", userId, {}),

  // reads: this user's history, and (tenant-wide) the organisation's decisions and metrics
  keystrokeHistory: (userId) => request("GET", "/keystroke/history", userId),
  keystrokeStats: (userId) => request("GET", "/keystroke/stats", userId),
  keystrokeDecisions: (userId) => request("GET", "/keystroke/decisions", userId),
  keystrokeDecisionsAll: (userId) => request("GET", "/keystroke/decisions-all", userId),
  keystrokeMetrics: (userId) => request("GET", "/keystroke/metrics", userId),

  // mouse
  mouseEnroll: (userId, windows) => request("POST", "/mouse/enroll", userId, { windows }),
  mouseCheck: (userId, windows) => request("POST", "/mouse/check", userId, { windows }),
  mouseStatus: (userId) => request("GET", "/mouse/status", userId),
  // Destructive: the route that calls this must verify a passkey first.
  mouseReset: (userId) => request("POST", "/mouse/reset", userId, {}),
  // The suspicious-packet count is kept by Continuum; this says "we acted on it".
  mouseStreakReset: (userId) => request("POST", "/mouse/streak/reset", userId, {}),

  // The shared step-up lock: set when this app decides to challenge, cleared after a passkey verification.
  lockSet: (userId) => request("POST", "/lock/set", userId, {}),
  lockClear: (userId) => request("POST", "/lock/clear", userId, {}),
};
