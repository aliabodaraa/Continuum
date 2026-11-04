// The settings ca-service takes from the gateway's signed claim (lib/appSettings.js forRequest), here the panel's
// language and colours, which the config route passes on to the SDK and the extension. node --test
const test = require("node:test");
const assert = require("node:assert/strict");

delete process.env.CONTINUUM_PANEL_LANGUAGE;
delete process.env.CONTINUUM_PANEL_THEME;
const { ENV, forRequest } = require("../lib/appSettings");

test("without a claim: the deployment defaults, automatic language and colours", () => {
  assert.deepEqual([ENV.panelLanguage, ENV.panelTheme], ["auto", "auto"]);
  const st = forRequest({});
  assert.deepEqual([st.panelLanguage, st.panelTheme], ["auto", "auto"]);
});

test("the organisation's choice from the claim, and an unknown value falls back to the default", () => {
  const req = (cfg) => ({ identity: { settings: cfg } });
  let st = forRequest(req({ lang: "ar", theme: "dark", m: ["panelLanguage", "panelTheme"] }));
  assert.deepEqual([st.panelLanguage, st.panelTheme], ["ar", "dark"]);
  assert.deepEqual(st.managed, ["panelLanguage", "panelTheme"]);
  st = forRequest(req({ lang: "en", theme: "light" }));
  assert.deepEqual([st.panelLanguage, st.panelTheme], ["en", "light"]);
  st = forRequest(req({ lang: "fr", theme: "<script>" }));
  assert.deepEqual([st.panelLanguage, st.panelTheme], ["auto", "auto"]);
});
