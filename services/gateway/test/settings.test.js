// Unit tests for the two-level settings (organisation > operator > .env > built-in). node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The environment must not leak into the expected defaults.
for (const k of ["CONTINUUM_PANEL", "CONTINUUM_KEYSTROKE", "CONTINUUM_MOUSE", "ONBOARDING_MODE", "ADAPTIVE_RETRAINING",
  "ADAPTIVE_MIN_GAP_HOURS", "MONITOR_EXCLUDE_TYPES", "KEYSTROKE_DECISION_WINDOWS", "GATEWAY_AUTO_APPROVE_TENANTS",
  "GATEWAY_ALLOW_PRIVATE_WEBHOOKS"]) delete process.env[k];
const createSettings = require("../settings");

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-settings-"));
  return { dir, s: createSettings(dir) };
}

test("built-in defaults apply when nothing is set", () => {
  const { s } = fresh();
  const { values, sources } = s.effective(null);
  assert.equal(values.panel, "show");
  assert.equal(values.keystroke, "on");
  assert.equal(values.keystrokeDecisionWindows, 20);
  assert.equal(values.adaptiveGapHours, 3);
  assert.deepEqual(values.excludeFieldTypes, ["hidden"]);
  assert.ok(Object.values(sources).every((src) => src === "default"));
});

test("precedence: organisation over operator over .env over built-in", () => {
  process.env.CONTINUUM_MOUSE = "off";
  try {
    const { s } = fresh();
    assert.deepEqual([s.effective(null).values.mouse, s.effective(null).sources.mouse], ["off", "env"]);
    s.updateOperator({ defaults: { mouse: "on" } });
    assert.deepEqual([s.effective(null).values.mouse, s.effective(null).sources.mouse], ["on", "operator"]);
    const tenant = { settings: s.updateTenant({ settings: {} }, { mouse: "off" }).settings };
    assert.deepEqual([s.effective(tenant).values.mouse, s.effective(tenant).sources.mouse], ["off", "organisation"]);
    s.updateOperator({ defaults: { mouse: null } });   // clearing the operator value falls back to .env
    assert.equal(s.effective(null).sources.mouse, "env");
  } finally {
    delete process.env.CONTINUUM_MOUSE;
  }
});

test("only the measured decision packets are accepted (6, 10, 20)", () => {
  const { s } = fresh();
  assert.equal(s.updateTenant({ settings: {} }, { keystrokeDecisionWindows: "6" }).settings.keystrokeDecisionWindows, 6);
  assert.equal(s.updateTenant({ settings: {} }, { keystrokeDecisionWindows: 10 }).settings.keystrokeDecisionWindows, 10);
  assert.throws(() => s.updateTenant({ settings: {} }, { keystrokeDecisionWindows: 7 }), { code: "bad_setting" });
});

test("on-demand enrolment needs the panel", () => {
  const { s } = fresh();
  assert.throws(() => s.updateTenant({ settings: {} }, { panel: "hide", onboarding: "lazy" }), { code: "lazy_needs_panel" });
  assert.throws(() => s.updateOperator({ defaults: { panel: "hide", onboarding: "lazy" } }), { code: "lazy_needs_panel" });
});

test("bad values and unknown settings are refused", () => {
  const { s } = fresh();
  assert.throws(() => s.updateTenant({ settings: {} }, { adaptiveGapHours: 500 }), { code: "bad_setting" });
  assert.throws(() => s.updateTenant({ settings: {} }, { excludeFieldTypes: ["Email!"] }), { code: "bad_setting" });
  assert.throws(() => s.updateTenant({ settings: {} }, { nope: 1 }), { code: "unknown_setting" });
  assert.deepEqual(s.updateTenant({ settings: {} }, { excludeFieldTypes: "Email, hidden, email" }).settings.excludeFieldTypes, ["email", "hidden"]);
});

test("the signed claim carries the values and marks only explicit choices as managed", () => {
  const { s } = fresh();
  s.updateOperator({ defaults: { adaptiveGapHours: 2.5 } });
  const tenant = { settings: s.updateTenant({ settings: {} }, { panel: "hide", keystrokeDecisionWindows: 6 }).settings };
  const c = s.claim(tenant);
  assert.equal(c.panel, "hide");
  assert.equal(c.kw, 6);
  assert.equal(c.gap, 2.5);
  assert.deepEqual(new Set(c.m), new Set(["panel", "keystrokeDecisionWindows", "adaptiveGapHours"]));
});

test("operator settings survive a restart (settings.json)", () => {
  const { dir, s } = fresh();
  s.updateOperator({ defaults: { panel: "hide" }, server: { autoApproveTenants: true } });
  const again = createSettings(dir);
  assert.equal(again.effective(null).values.panel, "hide");
  assert.equal(again.server("autoApproveTenants"), true);
});

test("an unreadable settings.json stops start-up instead of silently resetting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-settings-"));
  fs.writeFileSync(path.join(dir, "settings.json"), "{ not json");
  assert.throws(() => createSettings(dir), /unreadable/);
});
