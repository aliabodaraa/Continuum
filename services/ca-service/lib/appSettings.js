/**
 * The settings an organisation (or the operator, for every organisation) chose for its apps,
 * as they apply to ONE request.
 *
 * The gateway owns these settings (its operator page and each organisation's console). It signs
 * the effective values of the caller's organisation into the identity assertion it already sends
 * with every request (claim `cfg`, see gateway mintAssertion), so this service never stores them
 * and cannot disagree with the gateway; a forged value would fail the RS256 signature. Without a
 * claim (an unauthenticated read such as /v1/keystroke/config called with no identity), the
 * deployment defaults from the environment apply.
 *
 * Claim shape (short keys keep the assertion small):
 *   { panel: "show"|"hide", ks: "on"|"off", ms: "on"|"off", ob: "eager"|"lazy",
 *     ad: "on"|"off", gap: hours, re: 1|2|3, sf: "end"|"any", ex: ["hidden", ...], kw: 6|10|20,
 *     pa: "0"|"1"|"2"|"3"|"5"|"unlimited", m: [explicitly set keys] }
 */
const onOff = (v, d) => (v === "on" || v === "off" ? v : d);
// Pastes allowed into one field before the passkey is asked for (owner, 2026-10-25): a number, or Infinity
// for "unlimited", the default. Every paste counts, however short (lib/keystrokeSecurity.js pastePolicyViolation).
const PASTE_ALLOWANCE_CHOICES = ["0", "1", "2", "3", "5"];
const pasteAllowance = (v, d) => (v === "unlimited" ? Infinity : PASTE_ALLOWANCE_CHOICES.includes(String(v)) ? Number(v) : d);
const hours = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
const RETRAIN_EVERY_CHOICES = [1, 2, 3];
const retrainEvery = (v, d) => (RETRAIN_EVERY_CHOICES.includes(Number(v)) ? Number(v) : d);

// Deployment defaults (.env). The gateway's operator page can override every one of them.
const ENV = {
  panel: process.env.CONTINUUM_PANEL === "hide" ? "hide" : "show",
  keystroke: process.env.CONTINUUM_KEYSTROKE === "off" ? "off" : "on",
  mouse: process.env.CONTINUUM_MOUSE === "off" ? "off" : "on",
  onboarding: process.env.ONBOARDING_MODE === "lazy" ? "lazy" : "eager",
  adaptive: process.env.ADAPTIVE_RETRAINING === "off" ? "off" : "on",
  // The pause after each adaptive retrain (lib/adaptive.js): no new samples for this many hours.
  adaptiveGapHours: hours(process.env.ADAPTIVE_MIN_GAP_HOURS, 3),
  // Accepted samples that make a retrain possible (lib/adaptive.js): 1, 2 or 3. Only 3 was measured (experiment AR).
  adaptiveRetrainEvery: retrainEvery(process.env.ADAPTIVE_RETRAIN_EVERY, 3),
  // Where in the recent typing a sample is taken from. "end": the last windows, what the user typed last.
  // "any": the newest run of windows that would be accepted, anywhere in it, and the rest ignored.
  adaptiveSampleFrom: process.env.ADAPTIVE_SAMPLE_FROM === "any" ? "any" : "end",
  excludeFieldTypes: (process.env.MONITOR_EXCLUDE_TYPES || "hidden").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  // Windows in the typing decision's packet; lib/keystrokeSecurity.js decisionWindows() accepts only
  // the measured lengths and falls back to 20.
  keystrokeDecisionWindows: Number(process.env.KEYSTROKE_DECISION_WINDOWS) || 20,
  pasteAllowance: pasteAllowance(process.env.PASTE_ALLOWANCE, Infinity),
};

function forRequest(req) {
  const c = (req && req.identity && req.identity.settings) || null;
  if (!c) return { ...ENV, managed: [] };
  return {
    panel: c.panel === "hide" || c.panel === "show" ? c.panel : ENV.panel,
    keystroke: onOff(c.ks, ENV.keystroke),
    mouse: onOff(c.ms, ENV.mouse),
    onboarding: c.ob === "lazy" || c.ob === "eager" ? c.ob : ENV.onboarding,
    adaptive: onOff(c.ad, ENV.adaptive),
    adaptiveGapHours: hours(c.gap, ENV.adaptiveGapHours),
    adaptiveRetrainEvery: retrainEvery(c.re, ENV.adaptiveRetrainEvery),
    adaptiveSampleFrom: c.sf === "any" || c.sf === "end" ? c.sf : ENV.adaptiveSampleFrom,
    excludeFieldTypes: Array.isArray(c.ex) ? c.ex.map((s) => String(s).toLowerCase()) : ENV.excludeFieldTypes,
    keystrokeDecisionWindows: c.kw != null ? Number(c.kw) : ENV.keystrokeDecisionWindows,
    pasteAllowance: pasteAllowance(c.pa, ENV.pasteAllowance),
    managed: Array.isArray(c.m) ? c.m.map(String) : [],
  };
}

/**
 * Milliseconds until adaptive samples may be added again (0 = now), counted from the last retrain.
 * lastSubmittedAt is SQLite's datetime('now') text (UTC, "YYYY-MM-DD HH:MM:SS") or an ISO string.
 */
function contributionWaitMs(lastSubmittedAt, nowMs, gapHours) {
  if (!lastSubmittedAt || !(gapHours > 0)) return 0;
  const s = String(lastSubmittedAt);
  const last = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, last + gapHours * 3600000 - nowMs);
}

// The organisation's "fields never watched", enforced here too: events from those field types are
// dropped before anything scores or stores them, whatever the client sent.
function withoutExcludedFields(events, types) {
  if (!Array.isArray(events) || !Array.isArray(types) || !types.length) return events;
  const ex = new Set(types.map((t) => String(t).toLowerCase()));
  return events.filter((e) => !ex.has(String((e && e.fieldType) || "").toLowerCase()));
}

module.exports = { ENV, forRequest, contributionWaitMs, withoutExcludedFields };
