// Unit tests for the decision rule and the organisation settings as ca-service applies them. node --test
// A throwaway database: never the real ca.db.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ca-rules-")), "test.db");
for (const k of ["CONTINUUM_KEYSTROKE", "CONTINUUM_MOUSE", "MONITOR_EXCLUDE_TYPES", "KEYSTROKE_DECISION_WINDOWS",
  "ADAPTIVE_MIN_GAP_HOURS", "ADAPTIVE_RETRAIN_EVERY", "ADAPTIVE_SAMPLE_FROM", "PASTE_ALLOWANCE"]) delete process.env[k];

const test = require("node:test");
const assert = require("node:assert/strict");
const appSettings = require("../lib/appSettings");
const ks = require("../lib/keystrokeSecurity");

test("decision packet: only 6, 10 and 20 windows; anything else means the default 20", () => {
  for (const n of [6, 10, 20]) assert.equal(ks.decisionWindows(n), n);
  for (const n of [7, 0, undefined, "abc", null]) assert.equal(ks.decisionWindows(n), 20);
  assert.equal(ks.decisionWindows("10"), 10);
});

test("the rule version names the packet and the warm-up minimum", () => {
  assert.equal(ks.ruleVersion(6), "lu-050-3of6-warm8");
  assert.equal(ks.ruleVersion(10), "lu-050-5of10-warm8");
  assert.equal(ks.RULE_VERSION, "lu-050-10of20-warm8");
});

test("settings: without a signed claim the deployment defaults apply", () => {
  const st = appSettings.forRequest({});
  assert.equal(st.keystroke, "on");
  assert.equal(st.keystrokeDecisionWindows, 20);
  assert.equal(st.adaptiveRetrainEvery, 3);
  assert.equal(st.adaptiveSampleFrom, "end");
  assert.deepEqual(st.managed, []);
});

test("settings: samples before a retrain are 1, 2 or 3, and a sample is taken from the end or from anywhere", () => {
  const at = (cfg) => appSettings.forRequest({ identity: { settings: cfg } });
  for (const n of [1, 2, 3]) assert.equal(at({ re: n }).adaptiveRetrainEvery, n);
  for (const n of [0, 4, "x", null]) assert.equal(at({ re: n }).adaptiveRetrainEvery, 3, `re ${n} falls back to 3`);
  assert.equal(at({ sf: "any" }).adaptiveSampleFrom, "any");
  assert.equal(at({ sf: "end" }).adaptiveSampleFrom, "end");
  assert.equal(at({ sf: "middle" }).adaptiveSampleFrom, "end", "an unknown value falls back to the end");
});

test("settings: the signed claim decides, with safe fallbacks", () => {
  const st = appSettings.forRequest({ identity: { settings: { ks: "off", ms: "maybe", kw: 10, ex: ["Email"], gap: -1, m: ["keystroke"] } } });
  assert.equal(st.keystroke, "off");
  assert.equal(st.mouse, "on");                // an invalid value falls back to the default
  assert.equal(st.keystrokeDecisionWindows, 10);
  assert.deepEqual(st.excludeFieldTypes, ["email"]);
  assert.equal(st.adaptiveGapHours, 3);        // a negative gap is not a gap
  assert.deepEqual(st.managed, ["keystroke"]);
});

test("settings: pastes allowed per field are 0, 1, 2, 3, 5 or unlimited, and unlimited by default", () => {
  const at = (cfg) => appSettings.forRequest({ identity: { settings: cfg } });
  assert.equal(appSettings.forRequest({}).pasteAllowance, Infinity);
  for (const v of ["0", "1", "2", "3", "5"]) assert.equal(at({ pa: v }).pasteAllowance, Number(v));
  assert.equal(at({ pa: 2 }).pasteAllowance, 2);
  assert.equal(at({ pa: "unlimited" }).pasteAllowance, Infinity);
  for (const v of ["4", "-1", "lots", null]) assert.equal(at({ pa: v }).pasteAllowance, Infinity, `pa ${v} falls back to unlimited`);
});

test("paste rule: every paste counts, per field, against the allowance; unlimited never asks", () => {
  const paste = (field, type = "textarea", len = 3) => ({ keyCode: 0, eventType: "paste", timestampRelative: 1, fieldName: field, fieldType: type, pastedLength: len });
  const key = { keyCode: 65, eventType: "keydown", timestampRelative: 2, fieldName: "a", fieldType: "textarea" };
  assert.deepEqual(ks.pasteCountsByField([paste("a"), paste("a"), paste("b", "text"), key]), { "a|textarea": 2, "b|text": 1 });
  assert.equal(ks.pastePolicyViolation([paste("a", "textarea", 1)], 0), true, "0: the first paste asks, however short");
  assert.equal(ks.pastePolicyViolation([paste("a"), paste("a")], 2), false);
  assert.equal(ks.pastePolicyViolation([paste("a"), paste("a"), paste("a")], 2), true, "the third paste into one field");
  assert.equal(ks.pastePolicyViolation([paste("a"), paste("b"), paste("c")], 1), false, "one paste into each of three fields");
  assert.equal(ks.pastePolicyViolation(Array(50).fill(paste("a")), Infinity), false);
  assert.equal(ks.pastePolicyViolation(undefined, 0), false);
});

test("excluded fields: their events are dropped, whatever the case; an empty list keeps everything", () => {
  const ev = [{ fieldType: "text" }, { fieldType: "EMAIL" }, { fieldType: "password" }, {}];
  assert.deepEqual(appSettings.withoutExcludedFields(ev, ["email"]).map((e) => e.fieldType), ["text", "password", undefined]);
  assert.equal(appSettings.withoutExcludedFields(ev, []).length, 4);
  assert.equal(appSettings.withoutExcludedFields(undefined, ["email"]), undefined);
});

test("adaptive pause: counted from the last retrain, in SQLite's UTC text format too", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  assert.equal(appSettings.contributionWaitMs(null, now, 3), 0);
  assert.equal(appSettings.contributionWaitMs("2026-10-06 11:00:00", now, 3), 2 * 3600000);
  assert.equal(appSettings.contributionWaitMs("2026-10-06T08:00:00Z", now, 3), 0);
  assert.equal(appSettings.contributionWaitMs("2026-10-06 11:00:00", now, 0), 0);
});

test("typing quality: typed text has full coverage; a paste is counted", () => {
  const ev = [];
  for (let i = 0; i < 130; i++) {
    ev.push({ keyCode: 65 + (i % 26), eventType: "keydown", timestampRelative: i * 180, fieldName: "f" });
    ev.push({ keyCode: 65 + (i % 26), eventType: "keyup", timestampRelative: i * 180 + 90, fieldName: "f" });
  }
  const q = ks.typingQuality(null, ev, 130);
  assert.equal(q.keydownCount, 130);
  assert.ok(q.typedCoverage >= 1);
  assert.ok(q.windowCount > 0);
  // as the SDK sends a paste: key code 0, a timestamp, the pasted length only
  const pasted = ks.typingQuality(null, [{ keyCode: 0, eventType: "paste", timestampRelative: 10, pastedLength: 200, fieldName: "f" }], 200);
  assert.equal(pasted.pasteCount, 1);
  assert.equal(pasted.pastedLength, 200);
  assert.equal(pasted.acceptableForEnrollment, false);
  // malformed events (no key code or timestamp) are ignored, never counted
  assert.equal(ks.typingQuality(null, [{ eventType: "paste", pastedLength: 200 }], 200).pasteCount, 0);
});
