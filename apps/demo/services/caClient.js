// Thin client for the standalone CA (continuous-auth) service. This is the ONLY
// place the demo talks to the behavioral engine — keystroke/mouse models + data
// live entirely in that service. The demo keeps session + passkey policy.
const CA_API_URL = process.env.CA_API_URL || "http://localhost:4100";
const API_KEY = process.env.CA_API_KEY || "";

async function call(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-Api-Key"] = API_KEY;
  const res = await fetch(`${CA_API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

module.exports = {
  // config + onboarding
  config: () => call("GET", "/v1/keystroke/config"),
  onboarding: (userId) => call("GET", `/v1/users/${Number(userId)}/onboarding`),
  keystrokeStatus: (userId) => call("GET", `/v1/keystroke/status/${Number(userId)}`),

  // keystroke operations
  keystrokeEnroll: (userId, body) => call("POST", "/v1/keystroke/enroll", { userId, ...body }),
  keystrokeCheck: (userId, body) => call("POST", "/v1/keystroke/check", { userId, ...body }),
  keystrokeSubmit: (userId, body) => call("POST", "/v1/keystroke/submit", { userId, ...body }),
  keystrokeContribute: (userId, body) => call("POST", "/v1/keystroke/contribute", { userId, ...body }),
  keystrokeReset: (userId) => call("POST", "/v1/keystroke/reset", { userId }),
  keystrokeRetrain: (userId) => call("POST", "/v1/keystroke/retrain", { userId }),
  maybeRetrainImpostors: (userId) => call("POST", "/v1/keystroke/maybe-retrain-impostors", { userId }),

  // reads
  keystrokeHistory: (userId) => call("GET", `/v1/keystroke/history/${Number(userId)}`),
  keystrokeStats: (userId) => call("GET", `/v1/keystroke/stats/${Number(userId)}`),
  keystrokeDecisions: (userId) => call("GET", `/v1/keystroke/decisions/${Number(userId)}`),
  keystrokeDecisionsAll: () => call("GET", "/v1/keystroke/decisions-all"),
  keystrokeMetrics: () => call("GET", "/v1/keystroke/metrics"),

  // mouse
  mouseEnroll: (userId, windows) => call("POST", "/v1/mouse/enroll", { userId, windows }),
  mouseCheck: (userId, windows) => call("POST", "/v1/mouse/check", { userId, windows }),
  mouseStatus: (userId) => call("GET", `/v1/mouse/status/${Number(userId)}`),
  // Destructive — the route that calls this must verify a passkey first.
  mouseReset: (userId) => call("POST", "/v1/mouse/reset", { userId }),

  // Shared step-up lock (see ca-service/lib/lock.js) — set from here when the
  // mouse strike debounce fires (keystroke sets it directly inside ca-service),
  // cleared on a successful passkey verification.
  lockSet: (userId) => call("POST", "/v1/lock/set", { userId }),
  lockClear: (userId) => call("POST", "/v1/lock/clear", { userId }),
};
