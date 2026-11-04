// The pages' Arabic (public/ui/i18n-ar.js) and the language helpers of public/ui/ui.js, loaded in node with the
// few browser objects ui.js touches at load. node --test services/gateway/test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PUB = path.join(__dirname, "..", "public", "ui");
function load(lang) {
  const stored = { continuumLang: lang };
  const html = { attrs: {}, lang: "en", dir: "ltr", getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; } };
  const ctx = { console, Object, Array, JSON, Date, Math, String, Number, RegExp, Error, Promise, setTimeout, Intl,
    localStorage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; } },
    document: { documentElement: html, title: "Continuum Console", createTextNode: (s) => ({ nodeType: 3, data: String(s) }) },
    navigator: {}, fetch: () => Promise.reject(new Error("no network")) };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(PUB, "i18n-ar.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(PUB, "ui.js"), "utf8"), ctx);
  return { C: ctx.CUI, AR: ctx.CUI_AR, html, stored };
}
const ARABIC = /[؀-ۿ]/;
const holes = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(" ");

test("the dictionary: Arabic for every entry, the same {placeholders} as the English, every plural form present", () => {
  const { AR } = load("en");
  const keys = Object.keys(AR);
  assert.ok(keys.length > 250, `${keys.length} entries`);
  for (const k of keys) {
    const v = AR[k];
    assert.ok(/[A-Za-z]/.test(k), `key without letters: ${k}`);
    assert.equal(k, k.trim(), `key with outer spaces: "${k}"`);
    if (typeof v === "string") {
      assert.ok(ARABIC.test(v) || v === k, `no Arabic for: ${k}`);
      assert.equal(holes(v), holes(k), `placeholders differ for: ${k}`);
    } else {
      assert.ok(/\{n\}/.test(k), `a plural must count {n}: ${k}`);
      assert.ok(v.one && v.two && v.few && v.other, `plural forms missing for: ${k}`);
      for (const form of Object.values(v)) {
        assert.ok(ARABIC.test(form), `no Arabic in a plural form of: ${k}`);
        assert.ok(!/\{(?!n\})\w+\}/.test(form), `a plural form names a placeholder other than {n}: ${k}`);
      }
    }
  }
});

test("every plain-language error and every settings label has Arabic", () => {
  const { C, AR } = load("en");
  for (const [code, text] of Object.entries(C.MESSAGES)) assert.ok(typeof AR[text] === "string", `MESSAGES.${code} not translated`);
  for (const text of Object.values(C.SOURCE_TEXT)) assert.ok(typeof AR[text] === "string", `source label not translated: ${text}`);
  // the settings texts are not exported: read them from the source
  const src = fs.readFileSync(path.join(PUB, "ui.js"), "utf8");
  const block = src.slice(src.indexOf("var SETTING_TEXT"), src.indexOf("var SUB_OF"));
  const literals = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((s) => /[A-Za-z]{2}/.test(s) && !/^[a-z]+$/.test(s));
  assert.ok(literals.length > 30, `${literals.length} setting literals found`);
  for (const s of literals) assert.ok(typeof AR[s] === "string", `setting text not translated: ${s.slice(0, 60)}`);
});

test("English is untouched: tr, t, plural and when behave as before", () => {
  const { C, html } = load("en");
  assert.equal(html.dir, "ltr");
  assert.equal(C.tr("Sign in"), "Sign in");
  assert.equal(C.t("Delete {name}?", { name: "Acme" }), "Delete Acme?");
  assert.equal(C.plural(1, "{n} website", "{n} websites"), "1 website");
  assert.equal(C.plural(4, "{n} website", "{n} websites"), "4 websites");
  assert.equal(C.when(new Date(Date.now() - 5 * 60000).toISOString()), "5 min ago");
  assert.equal(C.when(new Date(Date.now() - 2 * 86400000).toISOString()), "2 d ago");
  assert.equal(C.msg("bad_email"), C.MESSAGES.bad_email);
});

test("Arabic: the page is right-to-left, the title and strings translate, spaces around a string survive", () => {
  const { C, html } = load("ar");
  assert.equal(C.lang(), "ar");
  assert.equal(html.dir, "rtl");
  assert.equal(html.lang, "ar");
  assert.equal(C.tr("Sign in"), "تسجيل الدخول");
  assert.equal(C.tr(" Loading…"), " جارٍ التحميل…");
  assert.equal(C.tr("Acme Notes"), "Acme Notes", "unknown text passes through");
  assert.equal(C.tr("pk_live_1"), "pk_live_1");
  assert.equal(C.t("Delete {name}?", { name: "Acme" }), "حذف Acme؟");
  assert.equal(C.msg("bad_email"), "هذا لا يبدو بريداً إلكترونياً.");
  assert.equal(C.explain({ code: "network" }), "لا يمكن الوصول إلى خادم Continuum. هل هو يعمل؟");
  // a node among the variables: text nodes around it, the node itself in place
  const b = { nodeType: 1, tag: "b" };
  const parts = C.t("Type {name} to confirm", { name: b });
  assert.equal(parts.length, 3);
  assert.equal(parts[0].data, "اكتب ");
  assert.equal(parts[1], b);
  assert.equal(parts[2].data, " للتأكيد");
});

test("Arabic plurals follow the count: one, two, 3-10, 11 and up, zero", () => {
  const { C } = load("ar");
  assert.equal(C.plural(0, "{n} website", "{n} websites"), "لا مواقع");
  assert.equal(C.plural(1, "{n} website", "{n} websites"), "موقع واحد");
  assert.equal(C.plural(2, "{n} website", "{n} websites"), "موقعان");
  assert.equal(C.plural(7, "{n} website", "{n} websites"), "7 مواقع");
  assert.equal(C.plural(14, "{n} website", "{n} websites"), "14 موقعاً", "many falls back to other");
  assert.equal(C.plural(3, "Saved: {n} change.", "Saved: {n} changes."), "تم الحفظ: 3 تغييرات.");
  assert.equal(C.plural(5, "{n} min ago", "{n} min ago"), "قبل 5 دقائق");
});

test("Arabic dates: relative times in Arabic, older dates with Arabic month names and Western digits", () => {
  const { C } = load("ar");
  assert.equal(C.when(new Date(Date.now() - 30000).toISOString()), "الآن");
  assert.equal(C.when(new Date(Date.now() - 2 * 3600000).toISOString()), "قبل ساعتين");
  const old = C.when("2026-03-15T10:00:00Z");
  assert.match(old, /2026/);
  assert.ok(ARABIC.test(old), `month in Arabic: ${old}`);
  assert.doesNotMatch(old, /[٠-٩]/, `Western digits: ${old}`);
  assert.doesNotMatch(C.fullDate("2026-03-15T10:00:00Z"), /[٠-٩]/);
});

test("switching: setLang stores the choice, flips the document and calls the pages back", () => {
  const { C, html, stored } = load("en");
  let calls = [];
  C.onLang((l) => calls.push(l));
  C.setLang("ar");
  assert.deepEqual(calls, ["ar"]);
  assert.equal(stored.continuumLang, "ar");
  assert.equal(html.dir, "rtl");
  assert.equal(C.tr("Overview"), "نظرة عامة");
  C.setLang("en");
  assert.equal(html.dir, "ltr");
  assert.equal(C.tr("Overview"), "Overview");
  assert.equal(stored.continuumLang, "en");
});
