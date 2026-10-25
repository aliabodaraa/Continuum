// Unit tests for the two-level settings (organisation > operator > .env > built-in). node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The environment must not leak into the expected defaults.
for (const k of ["CONTINUUM_PANEL", "CONTINUUM_KEYSTROKE", "CONTINUUM_MOUSE", "ONBOARDING_MODE", "ADAPTIVE_RETRAINING",
  "ADAPTIVE_MIN_GAP_HOURS", "ADAPTIVE_RETRAIN_EVERY", "ADAPTIVE_SAMPLE_FROM", "MONITOR_EXCLUDE_TYPES", "KEYSTROKE_DECISION_WINDOWS", "GATEWAY_AUTO_APPROVE_TENANTS",
  "GATEWAY_ALLOW_PRIVATE_WEBHOOKS", "PASTE_ALLOWANCE"]) delete process.env[k];
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
  assert.equal(values.adaptiveRetrainEvery, 3);
  assert.equal(values.adaptiveSampleFrom, "end");
  assert.deepEqual(values.excludeFieldTypes, ["hidden"]);
  assert.ok(Object.values(sources).every((src) => src === "default"));
});

test("precedence: organisation over operator over .env over built-in", async () => {
  process.env.CONTINUUM_MOUSE = "off";
  try {
    const { s } = fresh();
    assert.deepEqual([s.effective(null).values.mouse, s.effective(null).sources.mouse], ["off", "env"]);
    await s.updateOperator({ defaults: { mouse: "on" } });
    assert.deepEqual([s.effective(null).values.mouse, s.effective(null).sources.mouse], ["on", "operator"]);
    const tenant = { settings: s.updateTenant({ settings: {} }, { mouse: "off" }).settings };
    assert.deepEqual([s.effective(tenant).values.mouse, s.effective(tenant).sources.mouse], ["off", "organisation"]);
    await s.updateOperator({ defaults: { mouse: null } });   // clearing the operator value falls back to .env
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

test("adaptive samples: 1, 2 or 3 before a retrain, taken from the end or from anywhere, and ca-service is told", () => {
  const { s } = fresh();
  for (const n of [1, 2, 3]) assert.equal(s.updateTenant({ settings: {} }, { adaptiveRetrainEvery: String(n) }).settings.adaptiveRetrainEvery, n);
  for (const n of [0, 4, "x"]) assert.throws(() => s.updateTenant({ settings: {} }, { adaptiveRetrainEvery: n }), { code: "bad_setting" });
  assert.equal(s.updateTenant({ settings: {} }, { adaptiveSampleFrom: "any" }).settings.adaptiveSampleFrom, "any");
  assert.throws(() => s.updateTenant({ settings: {} }, { adaptiveSampleFrom: "middle" }), { code: "bad_setting" });
  const tenant = { settings: s.updateTenant({ settings: {} }, { adaptiveRetrainEvery: 1, adaptiveSampleFrom: "any" }).settings };
  const c = s.claim(tenant);
  assert.equal(c.re, 1);
  assert.equal(c.sf, "any");
  assert.ok(c.m.includes("adaptiveRetrainEvery") && c.m.includes("adaptiveSampleFrom"));
  const defaults = s.claim(null);
  assert.equal(defaults.re, 3);
  assert.equal(defaults.sf, "end");
});

test("pastes allowed per field: 0, 1, 2, 3, 5 or unlimited, unlimited by default, and ca-service is told", () => {
  const { s } = fresh();
  assert.equal(s.effective(null).values.pasteAllowance, "unlimited");
  assert.equal(s.claim(null).pa, "unlimited");
  for (const v of ["0", 2, "5", "unlimited"]) {
    const tenant = { settings: s.updateTenant({ settings: {} }, { pasteAllowance: v }).settings };
    assert.equal(s.effective(tenant).values.pasteAllowance, String(v));
    assert.equal(s.claim(tenant).pa, String(v));
  }
  for (const v of ["4", -1, "lots"]) assert.throws(() => s.updateTenant({ settings: {} }, { pasteAllowance: v }), { code: "bad_setting" });
});

test("on-demand enrolment needs the panel", async () => {
  const { s } = fresh();
  assert.throws(() => s.updateTenant({ settings: {} }, { panel: "hide", onboarding: "lazy" }), { code: "lazy_needs_panel" });
  await assert.rejects(s.updateOperator({ defaults: { panel: "hide", onboarding: "lazy" } }), { code: "lazy_needs_panel" });
});

test("bad values and unknown settings are refused", () => {
  const { s } = fresh();
  assert.throws(() => s.updateTenant({ settings: {} }, { adaptiveGapHours: 500 }), { code: "bad_setting" });
  assert.throws(() => s.updateTenant({ settings: {} }, { excludeFieldTypes: ["Email!"] }), { code: "bad_setting" });
  assert.throws(() => s.updateTenant({ settings: {} }, { nope: 1 }), { code: "unknown_setting" });
  assert.deepEqual(s.updateTenant({ settings: {} }, { excludeFieldTypes: "Email, hidden, email" }).settings.excludeFieldTypes, ["email", "hidden"]);
});

test("the signed claim carries the values and marks only explicit choices as managed", async () => {
  const { s } = fresh();
  await s.updateOperator({ defaults: { adaptiveGapHours: 2.5 } });
  const tenant = { settings: s.updateTenant({ settings: {} }, { panel: "hide", keystrokeDecisionWindows: 6 }).settings };
  const c = s.claim(tenant);
  assert.equal(c.panel, "hide");
  assert.equal(c.kw, 6);
  assert.equal(c.gap, 2.5);
  assert.deepEqual(new Set(c.m), new Set(["panel", "keystrokeDecisionWindows", "adaptiveGapHours"]));
});

test("operator settings survive a restart (settings.json)", async () => {
  const { dir, s } = fresh();
  await s.updateOperator({ defaults: { panel: "hide" }, server: { autoApproveTenants: true } });
  const again = createSettings(dir);
  assert.equal(again.effective(null).values.panel, "hide");
  assert.equal(again.server("autoApproveTenants"), true);
});

test("an unreadable settings.json stops start-up instead of silently resetting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-settings-"));
  fs.writeFileSync(path.join(dir, "settings.json"), "{ not json");
  assert.throws(() => createSettings(dir), /unreadable/);
});

test("a failed save keeps the previous settings and says so", async () => {
  const s = createSettings({ initial: { defaults: { panel: "show" } }, persist: async () => { throw new Error("disk full"); } });
  await assert.rejects(s.updateOperator({ defaults: { panel: "hide" } }), { code: "store_write_failed" });
  assert.equal(s.effective(null).values.panel, "show");
});

test("settings changed by another gateway copy are taken over (replace)", () => {
  const s = createSettings({ initial: {}, persist: async () => {} });
  s.replace({ defaults: { keystrokeDecisionWindows: 6 }, server: { autoApproveTenants: true } });
  assert.equal(s.effective(null).values.keystrokeDecisionWindows, 6);
  assert.equal(s.effective(null).sources.keystrokeDecisionWindows, "operator");
  assert.equal(s.server("autoApproveTenants"), true);
});
