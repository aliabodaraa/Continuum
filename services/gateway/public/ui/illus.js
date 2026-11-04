// Pictures beside the protection settings (an organisation's Protection tab, the operator's defaults): a live
// preview of the panel as the current choices would show it, and a small animated figure under each setting
// whose effect is easier to see than to read. Loaded after ui.js; settingsForm uses it when present
// (window.CUI_ILLUS). The figures are shapes only, so they need no translation; the preview's few words follow
// the panel language chosen (ui/i18n-ar.js has the console's own words).
(function () {
  "use strict";
  var C = window.CUI, el = C.el, icon = C.icon;
  var ICON = {
    logo: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    finger: '<path d="M12 10a2 2 0 0 0-2 2c0 1-.1 2.5-.3 4M14 13.1c0 2.4 0 6.4-1 8.9M17.3 21c.1-.6.4-2.3.5-3M2 12a10 10 0 0 1 18-6M2 16h.01M21.8 16c.2-2 .1-5.4 0-6M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .3-2M8.7 22c.2-.7.4-1.3.6-2M9 6.8a6 6 0 0 1 9 5.2v2"/>',
    keyboard: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
    mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/>',
    clip: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  };
  // an icon inside an SVG scene: a nested <svg> placed by x, y, size
  function g(name, x, y, s, cls, extra) {
    return '<svg x="' + x + '" y="' + y + '" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="' + (cls || "") + '"' + (extra || "") + ">" + ICON[name] + "</svg>";
  }
  var WORDS = { en: { Typing: "Typing", Mouse: "Mouse", Protected: "Protected", verified: "verified", watching: "watching", Hidden: "Hidden" },
                ar: { Typing: "الكتابة", Mouse: "الفأرة", Protected: "محمي", verified: "تم التحقق", watching: "يراقب", Hidden: "مخفية" } };
  var darkMq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  // ---- the live preview: a page with the panel in its corner ----
  function preview() {
    var page = el("div.pv-page", [el("div.pv-lines", [el("i"), el("i"), el("i")])]);
    var panel = el("div.pv-panel"), hiddenNote = el("div.pv-hidden");
    page.appendChild(panel); page.appendChild(hiddenNote);
    var node = el("div.preview", [el("div.pv-text", [el("b", "How the panel will look"),
      el("p.muted.small", "The panel in the corner of your pages, as these settings show it. The browser extension's popup follows the same language and colours.")]), page]);
    function row(ic, label, status, on) {
      var r = el("div.pv-row" + (on ? "" : ".off"));
      r.innerHTML = '<span class="pv-ring"><svg viewBox="0 0 36 36"><circle class="tr" cx="18" cy="18" r="15.9"/><circle class="pr" cx="18" cy="18" r="15.9" pathLength="100"/></svg><span class="ic"></span></span>'
        + '<span class="pv-lbl"></span><span class="pv-tgl"></span>';
      r.querySelector(".ic").appendChild(icon(ic));
      r.querySelector(".pv-lbl").appendChild(el("b", label));
      r.querySelector(".pv-lbl").appendChild(el("span", status));
      return r;
    }
    function update(v) {
      var lang = v.panelLanguage === "ar" || v.panelLanguage === "en" ? v.panelLanguage : C.lang();
      var theme = v.panelTheme === "light" || v.panelTheme === "dark" ? v.panelTheme : darkMq && darkMq.matches ? "dark" : "light";
      var w = WORDS[lang];
      panel.setAttribute("dir", lang === "ar" ? "rtl" : "ltr"); panel.setAttribute("lang", lang); panel.setAttribute("data-theme", theme);
      C.clear(panel);
      var hd = el("div.pv-hd"); var logo = el("span.pv-logo"); logo.innerHTML = '<svg viewBox="0 0 24 24">' + ICON.logo + "</svg>";
      hd.appendChild(logo); hd.appendChild(el("span", [el("b", "Continuum"), el("span.pv-sum", [el("i.pv-dot"), w.Protected])]));
      panel.appendChild(hd);
      panel.appendChild(row("keyboard", w.Typing, v.keystroke === "off" ? "off" : w.verified + " · 93%", v.keystroke !== "off"));
      panel.appendChild(row("mouse", w.Mouse, v.mouse === "off" ? "off" : w.watching, v.mouse !== "off"));
      var hidden = v.panel === "hide";
      panel.classList.toggle("pv-off", hidden);
      hiddenNote.textContent = hidden ? w.Hidden : "";
      hiddenNote.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
    }
    return { node: node, update: update };
  }

  // ---- figures: an SVG scene for the setting's value; update(v) redraws it ----
  var SCENES = {
    // the typing decision: N windows fill one after another, then the verdict
    keystrokeDecisionWindows: function (v) {
      var n = Number(v) || 20, w = (236 - (n - 1) * 3) / n, s = "";
      for (var i = 0; i < n; i++) s += '<rect class="il-fill" style="animation-delay:' + (i * 2.2 / n).toFixed(2) + 's" x="' + (i * (w + 3)).toFixed(1) + '" y="16" width="' + w.toFixed(1) + '" height="26" rx="' + Math.min(5, w / 2) + '"/>';
      return '<svg viewBox="0 0 280 58">' + s + '<g class="il-pop" style="animation-delay:2.2s;transform-origin:262px 29px"><circle cx="262" cy="29" r="15" fill="var(--ok)"/>' + g("check", 253, 20, 18, "", ' stroke="#fff" stroke-width="2.6"') + "</g></svg>";
    },
    // pastes into one field: stamps appear until the allowance, then the passkey is asked for
    pasteAllowance: function (v) {
      var unlimited = v === "unlimited", n = unlimited ? 4 : Number(v), s = "";
      for (var i = 0; i < Math.max(n, unlimited ? 4 : 0); i++) s += '<g class="il-stay" style="animation-delay:' + (0.3 + i * 0.5) + 's"><rect x="' + (14 + i * 34) + '" y="21" width="28" height="18" rx="5" fill="var(--accent-weak)" stroke="var(--accent)"/>' + g("clip", 21 + i * 34, 23, 14, "", ' stroke="var(--accent-text)"') + "</g>";
      var key = unlimited ? '<text x="196" y="36" font-size="22" fill="var(--muted)" font-weight="700">∞</text>'
        : '<g class="il-pop" style="animation-delay:' + (0.6 + n * 0.5) + 's;transform-origin:' + (28 + n * 34 + 20) + 'px 30px"><circle cx="' + (28 + n * 34 + 20) + '" cy="30" r="15" fill="var(--warn)"/>' + g("key", 28 + n * 34 + 11, 21, 18, "", ' stroke="#fff" stroke-width="2.2"') + "</g>";
      return '<svg viewBox="0 0 280 60"><rect x="4" y="8" width="272" height="44" rx="9" fill="var(--surface)" stroke="var(--border-strong)"/>' + s + key + "</svg>";
    },
    // enrolment: all three at sign-in, or the passkey only and each channel when its switch is turned on
    onboarding: function (v) {
      var lazy = v === "lazy", s = '<path d="M60 30H110M160 30H210" stroke="var(--border-strong)" stroke-width="2"/>';
      [["finger", 40, 0], ["keyboard", 140, 0.5], ["mouse", 240, 1]].forEach(function (p, i) {
        var late = lazy && i > 0, d = late ? 2.4 + i * 0.4 : p[2];
        s += '<g><circle class="il-fill" style="animation-delay:' + d + 's" cx="' + p[1] + '" cy="30" r="20" fill="var(--border-strong)"' + (late ? ' stroke="var(--accent)" stroke-dasharray="4 4"' : "") + "/>" + g(p[0], p[1] - 11, 19, 22, "", ' stroke="#fff" stroke-width="2"') + "</g>";
        if (late) s += '<rect x="' + (p[1] - 14) + '" y="56" width="28" height="12" rx="6" fill="var(--border-strong)" class="il-fill" style="animation-delay:' + (d - 0.3) + 's"/><circle cx="' + (p[1] - 8) + '" cy="62" r="4" fill="#fff"/>';
      });
      return '<svg viewBox="0 0 280 ' + (lazy ? 74 : 60) + '">' + s + "</svg>";
    },
    // adaptive retraining: samples, the passkey, then a pause
    adaptive: function (v, every, gap) {
      var on = v !== "off", n = Number(every) || 3, s = "";
      for (var i = 0; i < n; i++) s += '<circle class="' + (on ? "il-fill" : "") + '" style="animation-delay:' + (i * 0.45) + 's" cx="' + (22 + i * 32) + '" cy="30" r="11" fill="var(--border-strong)"/>';
      s += '<path d="M' + (22 + n * 32 - 2) + ' 30h22" stroke="var(--border-strong)" stroke-width="2"/>';
      var kx = 22 + n * 32 + 36;
      s += '<g class="' + (on ? "il-pop" : "") + '" style="animation-delay:' + (n * 0.45 + 0.4) + 's;transform-origin:' + kx + 'px 30px;' + (on ? "" : "opacity:.35") + '"><circle cx="' + kx + '" cy="30" r="16" fill="var(--accent)"/>' + g("key", kx - 10, 20, 20, "", ' stroke="#fff" stroke-width="2.2"') + "</g>";
      s += '<path d="M' + (kx + 20) + ' 30h22" stroke="var(--border-strong)" stroke-width="2"/>';
      var cx = kx + 60;
      s += '<circle cx="' + cx + '" cy="30" r="16" fill="var(--surface)" stroke="var(--border-strong)" stroke-width="2"/><line class="' + (on ? "il-sweep" : "") + '" style="transform-origin:' + cx + 'px 30px" x1="' + cx + '" y1="30" x2="' + cx + '" y2="19" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"/>'
        + '<text x="' + (cx + 22) + '" y="35" font-size="13" font-weight="700" fill="var(--muted)">' + (Number(gap) || 3) + " h</text>";
      return '<svg viewBox="0 0 280 60">' + s + "</svg>";
    },
    adaptiveRetrainEvery: function (v, ctx) { return SCENES.adaptive("on", v, ctx && ctx.adaptiveGapHours); },
    adaptiveGapHours: function (v, ctx) { return SCENES.adaptive("on", ctx && ctx.adaptiveRetrainEvery, v); },
    // where the sample is taken from the recent typing: its last windows, or the newest clean run anywhere
    adaptiveSampleFrom: function (v) {
      var s = "", any = v === "any";
      for (var i = 0; i < 18; i++) s += '<rect x="' + (6 + i * 15) + '" y="' + (22 + (i % 3) * 3) + '" width="11" height="' + (18 - (i % 3) * 3) + '" rx="3" fill="var(--border-strong)"/>';
      s += '<rect class="' + (any ? "il-slide" : "") + '" x="' + (any ? 96 : 186) + '" y="14" width="86" height="32" rx="8" fill="var(--accent-weak)" stroke="var(--accent)" stroke-width="2"/>';
      return '<svg viewBox="0 0 280 60">' + s + "</svg>";
    },
    // fields never watched: their text is greyed, the eye is crossed
    excludeFieldTypes: function (v) {
      var list = Array.isArray(v) ? v : String(v || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
      var fields = ["text"].concat(list.slice(0, 2)), s = "";
      fields.forEach(function (f, i) {
        var off = list.indexOf(f) >= 0, y = 6 + i * 20;
        s += '<rect x="4" y="' + y + '" width="200" height="16" rx="5" fill="' + (off ? "var(--surface-3)" : "var(--surface)") + '" stroke="var(--border-strong)"/>'
          + '<text x="12" y="' + (y + 11.5) + '" font-size="9" font-weight="600" fill="' + (off ? "var(--faint)" : "var(--text)") + '">' + f.replace(/[<>&]/g, "") + "</text>"
          + (off ? g("eyeOff", 182, y + 2, 12, "", ' stroke="var(--faint)"') : '<rect x="60" y="' + (y + 4) + '" width="' + (70 - i * 15) + '" height="8" rx="3" fill="var(--accent-weak)"/>');
      });
      return '<svg viewBox="0 0 210 ' + (6 + fields.length * 20) + '">' + s + "</svg>";
    },
  };
  // the figure under a setting's text; ctx() gives the other settings' current values (the adaptive cycle needs two)
  function figure(key, value, ctx) {
    var draw = SCENES[key];
    if (!draw) return null;
    var node = el("figure.illus");
    function update(v) { node.innerHTML = draw(v, ctx ? ctx() : null); }
    update(value);
    return { node: node, update: update };
  }
  window.CUI_ILLUS = { preview: preview, figure: figure };
})();
