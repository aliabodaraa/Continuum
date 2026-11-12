// Continuum UI helpers shared by the gateway's pages (console, operator, extension sign-in).
// No framework: small DOM builders, icons, toasts, a modal, copy buttons, plain-language errors and the
// passkey ceremonies of a Continuum account (WebAuthn via the vendored SimpleWebAuthn browser library).
(function () {
  "use strict";
  var ICONS = {
    logo: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    puzzle: '<path d="M15.4 4.2a2.5 2.5 0 1 1 3.3 3.3c-.5.2-.9.5-1 1-.1.4.1.8.4 1.1l1.5 1.5a2.4 2.4 0 0 1 0 3.4l-1.6 1.6c-.2.2-.5.3-.8.3-.5-.1-.8-.5-1-.9a2.5 2.5 0 1 0-3.2 3.2c.4.2.8.5.9 1 .1.3-.1.6-.3.8l-1.6 1.6a2.4 2.4 0 0 1-3.4 0l-1.5-1.5c-.3-.3-.7-.4-1.1-.4-.5.1-.8.5-1 1a2.5 2.5 0 1 1-3.3-3.3c.5-.2.9-.5 1-1 .1-.4-.1-.8-.4-1.1L2.7 13.7a2.4 2.4 0 0 1 0-3.4l1.6-1.6c.2-.2.5-.3.8-.3.5.1.8.5 1 1a2.5 2.5 0 1 0 3.3-3.3c-.5-.2-.9-.5-1-1-.1-.3.1-.7.3-.9l1.6-1.6a2.4 2.4 0 0 1 3.4 0l1.5 1.5c.3.3.7.4 1.1.4.5-.1.8-.5 1.1-.3z"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    fingerprint: '<path d="M12 10a2 2 0 0 0-2 2c0 1-.1 2.5-.3 4M14 13.1c0 2.4 0 6.4-1 8.9M17.3 21c.1-.6.4-2.3.5-3M2 12a10 10 0 0 1 18-6M2 16h.01M21.8 16c.2-2 .1-5.4 0-6M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .3-2M8.7 22c.2-.7.4-1.3.6-2M9 6.8a6 6 0 0 1 9 5.2v2"/>',
    keyboard: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
    mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  };
  var FLIP = { chevron: 1, back: 1, logout: 1 };   // point the other way in a right-to-left page
  function icon(name, cls) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", "icon" + (cls ? " " + cls : "") + (FLIP[name] ? " flip" : ""));
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = ICONS[name] || ICONS.info;
    return s;
  }
  // el("div.card.card-pad", {onclick: f, "data-x": 1}, [children | "text"]). Text children and these attributes
  // are UI strings: they are translated while Arabic is on (see "language" below). User data goes in as text().
  var TR_ATTR = { placeholder: 1, title: 1, "aria-label": 1 };
  function el(spec, attrs, kids) {
    if (Array.isArray(attrs) || typeof attrs === "string" || (attrs && attrs.nodeType)) { kids = attrs; attrs = null; }
    var parts = String(spec).split(/(?=[.#])/), node = document.createElement(parts[0] || "div");
    for (var i = 1; i < parts.length; i++) {
      if (parts[i][0] === ".") node.classList.add(parts[i].slice(1));
      else if (parts[i][0] === "#") node.id = parts[i].slice(1);
    }
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k.indexOf("on") === 0 && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "text") node.textContent = tr(v);
      else if (k === "value") node.value = v;
      else if (k === "checked" || k === "disabled") node[k] = !!v;
      else node.setAttribute(k, v === true ? "" : TR_ATTR[k] ? tr(String(v)) : v);
    }
    append(node, kids);
    return node;
  }
  function append(node, kids) {
    if (kids == null) return node;
    if (!Array.isArray(kids)) kids = [kids];
    kids.forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(tr(String(c))) : c);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function brand(sub) {
    var m = el("span.brand-mark"); m.appendChild(icon("logo"));
    return el("div.brand", [m, el("div", ["Continuum", sub ? el("small", sub) : null])]);
  }

  // ---- language: English, or Arabic right-to-left ----
  // The pages are written in English; ui/i18n-ar.js maps each of their strings to Arabic. While Arabic is on,
  // el() looks every text child and placeholder/title/aria-label up there, t() does the same for strings with
  // {placeholders}, and plural() picks the Arabic form for a count. Names, emails, keys and URLs are appended
  // with text(), which is never translated. The choice is kept in this browser (localStorage) and applied to
  // <html lang dir> before the page renders; the pages re-render themselves through onLang.
  var LANG_KEY = "continuumLang", lang = "en", langHooks = [];
  try { if (localStorage.getItem(LANG_KEY) === "ar") lang = "ar"; } catch (e) {}
  function dict() { return lang === "ar" && window.CUI_AR ? window.CUI_AR : null; }
  function tr(s) {
    var d = dict();
    if (!d || typeof s !== "string") return s;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s), v = m && d[m[2]];
    return typeof v === "string" ? m[1] + v + m[3] : s;
  }
  function fill(s, vars) { return s.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] == null ? "" : String(vars[k]); }); }
  // t("Delete {name}?", { name: "Acme" }) -> "Delete Acme?"; a node among the vars -> an array of text nodes and nodes
  function t(s, vars) {
    var out = tr(s);
    if (!vars) return out;
    var hasNode = Object.keys(vars).some(function (k) { return vars[k] && vars[k].nodeType; });
    if (!hasNode) return fill(out, vars);
    var parts = [], re = /\{(\w+)\}/g, last = 0, m;
    while ((m = re.exec(out))) {
      if (m.index > last) parts.push(text(out.slice(last, m.index)));
      parts.push(vars[m[1]] == null ? "" : vars[m[1]]);
      last = re.lastIndex;
    }
    if (last < out.length) parts.push(text(out.slice(last)));
    return parts;
  }
  // plural(3, "{n} website", "{n} websites"): English by n === 1; Arabic has one form per CLDR category
  // ({zero, one, two, few, many, other} under the plural key), "other" when the category has none.
  function plural(n, one, other, vars) {
    vars = Object.assign({ n: n }, vars || {});
    var d = dict(), spec = d && d[other];
    if (spec && typeof spec === "object") {
      var r = n % 100, cat = n === 0 ? "zero" : n === 1 ? "one" : n === 2 ? "two" : r >= 3 && r <= 10 ? "few" : r >= 11 ? "many" : "other";
      return fill(spec[cat] || spec.other || other, vars);
    }
    return fill(tr(n === 1 ? one : other), vars);
  }
  function text(s) { return document.createTextNode(s == null ? "" : String(s)); }
  function locale() { return lang === "ar" ? "ar-SY-u-nu-latn" : undefined; }   // Arabic month names, Western digits
  function applyLang() {
    var h = document.documentElement;
    h.lang = lang; h.dir = lang === "ar" ? "rtl" : "ltr";
    if (!h.getAttribute("data-title")) h.setAttribute("data-title", document.title);
    document.title = tr(h.getAttribute("data-title"));
  }
  function setLang(l) {
    lang = l === "ar" ? "ar" : "en";
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
    applyLang();
    langHooks.forEach(function (f) { f(lang); });
  }
  function onLang(f) { langHooks.push(f); }
  // the switch: it names the other language, in that language
  function langButton() {
    var other = lang === "ar" ? "en" : "ar";
    var b = el("button.btn.btn-ghost.btn-sm.lang-btn", { type: "button", lang: other, title: other === "ar" ? "التبديل إلى العربية" : "Switch to English" },
      [icon("globe", "sm"), other === "ar" ? "العربية" : "English"]);
    b.addEventListener("click", function () { setLang(other); });
    return b;
  }
  applyLang();

  // ---- plain-language errors ----
  var MESSAGES = {
    email_taken: "There is already an account with this email. Sign in instead.",
    no_account: "No account uses this email. Check it, or create an account.",
    bad_email: "That doesn't look like an email address.",
    ceremony_expired: "That took too long. Please try again.",
    passkey_cancelled: "The passkey prompt was closed or timed out. Try again when you're ready.",
    passkey_unavailable: "This browser can't use passkeys here.",
    invalid_console_session: "Your session has ended. Please sign in again.",
    invalid_admin_key: "That admin key is not right.",
    too_many_attempts: "Too many wrong keys. For safety, operator sign-in is paused for a while.",
    not_found: "This page is only available on the operator's own machine.",
    name_required: "Give the organisation a name.",
    origins_required: "Add at least one website, or allow the browser extension.",
    bad_origin: "A website must look like https://app.example.com (no path after the address).",
    extension_id_required: "This server doesn't know the extension's id yet. Paste it from chrome://extensions.",
    bad_sign_in_url: "The sign-in page must be a full web address, like https://app.example.com/continuum/link.",
    bad_webhook_url: "The webhook must be a full web address.",
    webhook_not_public: "The webhook must be a public https:// address (not localhost, an internal name or a private IP).",
    no_webhook: "Add a webhook address first.",
    tenant_limit_reached: "You've reached the limit of organisations for one account.",
    unknown_tenant: "This organisation doesn't exist, or it isn't yours.",
    tenant_revoked: "This organisation was revoked, so it can't be changed.",
    confirm_name_mismatch: "The name you typed doesn't match. Nothing was revoked.",
    server_managed_secret: "This organisation is built into the server: its secret is set in the server's .env file, so it can't be changed here.",
    server_managed_tenant: "This organisation is built into the server, so only the operator can switch it off or remove it.",
    delete_incomplete: "Some users' data couldn't be erased right now, so the organisation was switched off instead of deleted. Try again in a minute.",
    tenant_registry_write_failed: "The server couldn't save that. Please try again.",
    store_write_failed: "The server couldn't save that. Please try again.",
    unknown_organisation: "No organisation has this code. Check it and try again.",
    organisation_pending_approval: "This organisation is waiting for the operator's approval, so it can't be used yet.",
    organisation_revoked: "This organisation has been switched off.",
    organisation_not_active: "This organisation is not active.",
    no_extension_sign_in: "This organisation hasn't set up sign-in for the browser extension yet. Ask its administrator.",
    extension_not_allowed: "This organisation doesn't allow the browser extension.",
    link_expired: "This sign-in expired or was already used. Start again from the extension.",
    invalid_identity_token: "The organisation's sign-in couldn't be verified. Start again from the extension.",
    bad_code_challenge: "This page was opened incorrectly. Start again from the extension.",
    origin_not_allowed: "This page isn't allowed to do that from here.",
    network: "Can't reach the Continuum server. Is it running?",
    lazy_needs_panel: "Enrolment on demand needs the panel, because users turn a channel on there. Show the panel, or make enrolment required.",
    bad_setting: "That value isn't allowed for this setting.",
    unknown_setting: "This server doesn't know that setting.",
    ca_settings_failed: "The scoring service didn't accept the change. Is it running?",
  };
  function explain(e) {
    if (!e) return tr("Something went wrong.");
    if (e.name === "NotAllowedError" || e.name === "AbortError") return tr(MESSAGES.passkey_cancelled);
    if (e.name === "NotSupportedError" || e.name === "SecurityError") return tr(MESSAGES.passkey_unavailable);
    if (e.code && MESSAGES[e.code]) return tr(MESSAGES[e.code]);
    if (/No passkeys registered/i.test(e.message || "")) return tr("This account has no passkey yet.");
    return e.message || tr("Something went wrong.");
  }
  function msg(code) { return tr(MESSAGES[code] || code); }   // one of MESSAGES, in the page's language
  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (opts.token) headers.Authorization = "Bearer " + opts.token;
    return fetch(path, { method: opts.method || (opts.body ? "POST" : "GET"), headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .catch(function () { var e = new Error(MESSAGES.network); e.code = "network"; throw e; })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok || d.error) {
            var e = new Error(d.note || d.error || ("HTTP " + r.status));
            e.code = d.error; e.status = r.status; e.data = d;
            throw e;
          }
          return d;
        });
      });
  }

  // ---- toasts, modal, copy ----
  var toastBox = null;
  function toast(kind, text) {
    if (!toastBox) { toastBox = el("div.toasts", { role: "status", "aria-live": "polite" }); document.body.appendChild(toastBox); }
    var t = el("div.toast." + kind, [icon(kind === "ok" ? "check" : kind === "bad" ? "alert" : "info"), el("div", text)]);
    toastBox.appendChild(t);
    setTimeout(function () { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(function () { t.remove(); }, 320); }, kind === "bad" ? 6000 : 3500);
  }
  // modal({ title, text, body: node, actions: [{label, kind, onClick(close) -> promise|void}], onClose })
  function modal(o) {
    var back = el("div.modal-back"), box = el("div.modal", { role: "dialog", "aria-modal": "true" });
    function close() { back.remove(); document.removeEventListener("keydown", esc); if (o.onClose) o.onClose(); }
    function esc(e) { if (e.key === "Escape" && !o.sticky) close(); }
    var foot = el("div.card-foot");
    (o.actions || [{ label: "Close", kind: "secondary" }]).forEach(function (a) {
      var b = el("button.btn.btn-" + (a.kind || "secondary"), { type: "button", id: a.id || null }, a.label);
      b.addEventListener("click", function () {
        if (!a.onClick) return close();
        var r = a.onClick(close, b);
        if (r && r.then) { b.disabled = true; r.then(function () {}, function () {}).then(function () { b.disabled = false; }); }
      });
      foot.appendChild(b);
    });
    append(box, [
      el("div.card-head", [el("div", [el("h3", o.title), o.text ? el("p.muted.small", o.text) : null]), el("span.spacer"),
        o.sticky ? null : el("button.btn.btn-ghost.btn-icon", { type: "button", "aria-label": "Close", onclick: close }, icon("x"))]),
      o.body ? el("div.card-body", o.body) : null,
      foot,
    ]);
    back.appendChild(box);
    back.addEventListener("click", function (e) { if (e.target === back && !o.sticky) close(); });
    document.addEventListener("keydown", esc);
    document.body.appendChild(back);
    var first = box.querySelector("input,textarea,button.btn-primary,button.btn-danger");
    if (first) setTimeout(function () { first.focus(); }, 30);
    return close;
  }
  function copyText(text, btn) {
    var done = function () {
      if (btn) { var old = btn.innerHTML; btn.innerHTML = ""; btn.appendChild(icon("check", "sm")); btn.appendChild(text(tr(" Copied"))); setTimeout(function () { btn.innerHTML = old; }, 1500); }
      else toast("ok", "Copied");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    else fallback();
    function fallback() { var ta = el("textarea", { style: "position:fixed;opacity:0" }); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); done(); } catch (e) {} ta.remove(); }
  }
  function copyField(value, opts) {
    opts = opts || {};
    var btn = el("button.btn.btn-secondary.btn-sm", { type: "button", "aria-label": "Copy" }, [icon("copy", "sm"), "Copy"]);
    btn.addEventListener("click", function () { copyText(value, btn); });
    return el("div.copy" + (opts.reveal ? ".reveal" : ""), [el("code", { class: opts.cls || null, "data-value": value }, value), btn]);
  }
  function codeBlock(text) {
    var pre = el("pre.code"), btn = el("button.copy-btn", { type: "button" }, "Copy");
    pre.textContent = text;
    btn.addEventListener("click", function () { copyText(text, null); btn.textContent = tr("Copied"); setTimeout(function () { btn.textContent = tr("Copy"); }, 1500); });
    pre.appendChild(btn);
    return pre;
  }
  function badge(status) {
    var label = { active: "Active", pending: "Waiting for approval", revoked: "Revoked" }[status] || status;
    return el("span.badge.badge-" + (["active", "pending", "revoked"].indexOf(status) >= 0 ? status : "neutral"), label);
  }
  function when(iso) {
    if (!iso) return "—";
    var d = new Date(iso), s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return tr("just now");
    if (s < 3600) return plural(Math.floor(s / 60), "{n} min ago", "{n} min ago");
    if (s < 86400) return plural(Math.floor(s / 3600), "{n} h ago", "{n} h ago");
    if (s < 7 * 86400) return plural(Math.floor(s / 86400), "{n} d ago", "{n} d ago");
    return d.toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric" });
  }
  function fullDate(iso) { return iso ? new Date(iso).toLocaleString(locale()) : ""; }

  // ---- Continuum account passkeys ----
  // purpose "console" -> { consoleToken, email }; "link" (+ linkId) -> { linkId, code, email }
  function passkeyRegister(email, extra) {
    var W = window.SimpleWebAuthnBrowser;
    if (!W) return Promise.reject(Object.assign(new Error(MESSAGES.passkey_unavailable), { code: "passkey_unavailable" }));
    return api("/v1/accounts/register/options", { body: Object.assign({ email: email }, extra) }).then(function (o) {
      return W.startRegistration(o.options).then(function (cred) { return api("/v1/accounts/register/complete", { body: { ceremonyId: o.ceremonyId, credential: cred } }); });
    });
  }
  function passkeyLogin(email, extra) {
    var W = window.SimpleWebAuthnBrowser;
    if (!W) return Promise.reject(Object.assign(new Error(MESSAGES.passkey_unavailable), { code: "passkey_unavailable" }));
    return api("/v1/accounts/login/options", { body: Object.assign({ email: email }, extra) }).then(function (o) {
      return W.startAuthentication(o.options).then(function (a) { return api("/v1/accounts/login/complete", { body: { ceremonyId: o.ceremonyId, assertion: a } }); });
    });
  }

  // ---- settings form (an organisation's Protection tab, and the operator's defaults) ----
  // items: the server's describe() rows { key, value, source, operatorDefault, builtIn, envValue, choices, range, list }.
  // level: "organisation" | "operator" -- the level whose own values this form edits.
  var SETTING_TEXT = {
    panel: ["Panel on your pages", "The small Continuum panel in the corner of each page. When it is hidden, users can't switch protection or add samples themselves, so the choices below apply to everyone."],
    panelLanguage: ["Panel language", "The language of the Continuum panel and its windows (the passkey check, enrolment, training) on your pages and in the browser extension. Automatic: the page's own language on your site, the browser's in the extension. The enrolment passages stay English either way: the typing model is trained on them."],
    panelTheme: ["Panel colours", "Light or dark colours for the panel and its windows. Automatic follows the device's light or dark mode."],
    keystroke: ["Typing protection", "Check that the person typing is the account's owner."],
    keystrokeDecisionWindows: ["Typing windows per decision", "How much typing each verdict looks at; half of these windows must look wrong. Fewer windows give the first verdict sooner (about 12 s of steady typing at 2, 15 s at 4, 18 s at 6, 25 s at 10, 42 s at 20) but flag the real user more often (about 14% of their verdicts at 2, 12% at 4, 10% at 6, 6% at 10, 3% at 20); impostors are caught about as often (~87%). Measured on 99 users. 2 and 4 suit sensitive systems that accept the extra passkey prompts."],
    pasteAllowance: ["Pastes allowed per field", "How many times a user may paste into the same field before the passkey is asked for. Every paste counts, however short, and the count starts again after each passkey verification. Pasted text is never judged as typing, so each allowed paste lets whoever is at the keyboard enter text without being checked. Unlimited never asks."],
    mouse: ["Mouse protection", "Check that the person moving the mouse is the account's owner."],
    onboarding: ["Enrolment", "Required: users enrol their typing and mouse when they first sign in. On demand: only when they turn a channel on in the panel."],
    adaptive: ["Adaptive retraining", "Offer to add clean stretches of typing as training samples (no two share a keystroke). After the number of samples set below, the user retrains the model, confirming with their passkey."],
    adaptiveRetrainEvery: ["Samples before a retrain", "How many accepted samples a user collects before they can retrain their typing model, confirming with their passkey. A sample is 20 windows of typing, about 250 characters. 3 is the setting that was measured. With 1 or 2 the user retrains sooner, on less new typing each time."],
    adaptiveSampleFrom: ["Where a sample is taken from", "End: the last 20 windows the user typed (the default). Anywhere: the newest 20 windows in the recent typing that would be accepted, and the rest of it is ignored. Anywhere gives a mixed stretch more chances to produce a sample, so a stretch that is not the user's has more chances to pass. This has not been measured."],
    adaptiveGapHours: ["Pause after each retrain", "After a retrain, no new samples are offered for this many hours (3 by default)."],
    excludeFieldTypes: ["Fields never watched", "Field types Continuum ignores completely, separated by commas: an input's type (for example password, email), textarea, or contenteditable for rich-text editors."],
  };
  var CHOICE_TEXT = { show: "Shown", hide: "Hidden", eager: "Required at sign-in", lazy: "On demand" };
  // Labels that belong to one setting only (a bare number means different things in different settings).
  var KEY_CHOICE_TEXT = {
    panelLanguage: { auto: "Automatic (the page's language)", en: "English", ar: "Arabic" },
    panelTheme: { auto: "Automatic (the device's mode)", light: "Light", dark: "Dark" },
    keystrokeDecisionWindows: { 2: "2 (fastest)", 4: "4", 6: "6", 10: "10", 20: "20 (most accurate)" },
    pasteAllowance: { 0: "0 (ask at the first paste)", 1: "1", 2: "2", 3: "3", 5: "5", unlimited: "Unlimited" },
    adaptiveRetrainEvery: { 1: "1", 2: "2", 3: "3 (measured)" },
    adaptiveSampleFrom: { end: "End (what was typed last)", any: "Anywhere in the typing" },
  };
  // Which setting each one belongs under: it is placed in that setting's section and hidden while it is off.
  // Adaptive retraining retrains the typing model, so it is a section inside typing protection (2026-11-12).
  var SUB_OF = { panelLanguage: "panel", panelTheme: "panel", keystrokeDecisionWindows: "keystroke", pasteAllowance: "keystroke", adaptive: "keystroke",
    adaptiveRetrainEvery: "adaptive", adaptiveSampleFrom: "adaptive", adaptiveGapHours: "adaptive" };
  function choiceText(key, v) { var k = KEY_CHOICE_TEXT[key]; return (k && k[v]) || CHOICE_TEXT[v] || String(v); }
  var SOURCE_TEXT = { organisation: "Your setting", operator: "Operator default", env: "Server default (.env)", "default": "Built-in default" };
  function showValue(v, key) { return Array.isArray(v) ? (v.join(", ") || "none") : v === true ? "on" : v === false ? "off" : choiceText(key, v); }
  function settingsForm(items, opts) {
    opts = opts || {};
    var level = opts.level || "organisation", rows = {}, nodes = {}, figs = {}, node = el("div.settings-list");
    var ILL = window.CUI_ILLUS || null;   // ui/illus.js: the panel preview and the figures, when loaded
    var current = function () { var o = {}; Object.keys(rows).forEach(function (k) { o[k] = rows[k].effective(); }); return o; };
    items.forEach(function (it) {
      var txt = SETTING_TEXT[it.key] || [it.key, ""];
      var own = it.source === level, cleared = false, ctl, read;
      if (it.choices && it.choices.join() === "on,off") {
        var cb = el("input", { type: "checkbox", checked: it.value === "on", id: "set-" + it.key });
        ctl = el("label.switch", [cb, el("span")]);
        read = function () { return cb.checked ? "on" : "off"; };
        cb.addEventListener("change", function () { cleared = false; sync(); });
      } else if (it.choices) {
        var seg = el("div.seg", { id: "set-" + it.key });
        var cur = it.value;
        it.choices.forEach(function (c) {
          var b = el("button" + (c === cur ? ".on" : ""), { type: "button", "data-v": c }, choiceText(it.key, c));
          b.addEventListener("click", function () { if (b.disabled) return; cur = c; cleared = false; seg.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); }); sync(); });
          seg.appendChild(b);
        });
        ctl = seg; read = function () { return cur; };
      } else {
        var input = el("input.input" + (it.range ? "" : ".mono"), { id: "set-" + it.key, value: showValue(it.value) === "none" ? "" : (Array.isArray(it.value) ? it.value.join(", ") : it.value),
          type: it.range ? "number" : "text", min: it.range ? it.range[0] : null, max: it.range ? it.range[1] : null, step: it.range ? "0.5" : null, style: it.range ? "width:110px" : "width:260px" });
        input.addEventListener("input", function () { cleared = false; sync(); });
        ctl = input; read = function () { return it.range ? Number(input.value) : input.value.split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean); };
      }
      if (opts.disabled) {
        if (ctl.tagName === "INPUT") ctl.disabled = true;
        else ctl.querySelectorAll("input,button").forEach(function (x) { x.disabled = true; });
      }
      var fallback = level === "organisation" ? it.operatorDefault : (it.envValue != null ? it.envValue : it.builtIn);
      var badge = el("span.badge.badge-neutral.small");
      var reset = el("a.small", { href: "#", style: "margin-inline-start:8px" }, "Use the default");
      reset.addEventListener("click", function (e) { e.preventDefault(); cleared = true; sync(); });
      function sync() {
        var changed = !cleared && JSON.stringify(read()) !== JSON.stringify(it.value);
        badge.textContent = cleared ? t("Default: {v} (after saving)", { v: tr(showValue(fallback, it.key)) }) : changed ? tr("Changed (not saved)") : tr(SOURCE_TEXT[it.source] || it.source);
        reset.style.display = (own && !cleared && !opts.disabled) ? "" : "none";
        if (figs[it.key]) figs[it.key].update(cleared ? fallback : read());
        if (opts.onChange) opts.onChange();
      }
      rows[it.key] = { it: it, read: read, isCleared: function () { return cleared; }, ctl: ctl,
        effective: function () { return cleared ? fallback : read(); } };
      var fig = ILL && ILL.figure ? ILL.figure(it.key, it.value, current) : null;
      nodes[it.key] = el("div.setting-row" + (SUB_OF[it.key] ? ".sub" : ""), [
        el("div.setting-text", [el("b", txt[0]), el("p.muted.small", txt[1]), fig ? fig.node : null, el("div", [badge, reset])]),
        el("div.setting-ctl", ctl)]);
      if (fig) figs[it.key] = fig;
      sync();
    });
    // The preview of the panel, above the list, redrawn after every change (the figures that depend on two
    // settings too). Only where the panel's own settings are in the form.
    var pv = ILL && ILL.preview && rows.panel ? ILL.preview() : null;
    function redraw() {
      var v = current();
      if (pv) pv.update(v);
      Object.keys(figs).forEach(function (k) { figs[k].update(v[k]); });
    }
    if (pv) node.appendChild(pv.node);
    // A setting and the ones that mean nothing while it is off form one section: typing protection with its windows,
    // its pastes and adaptive retraining; adaptive retraining with its three settings; the panel with its language and
    // colours. A section may hold a section. Each hides while its setting, or any setting above it, is off.
    var groups = {};
    function section(k) {
      var subs = Object.keys(SUB_OF).filter(function (s) { return SUB_OF[s] === k && nodes[s]; });
      if (!subs.length) return nodes[k];
      groups[k] = el("div.setting-group", [nodes[k]].concat(subs.map(section)));
      return groups[k];
    }
    Object.keys(nodes).forEach(function (k) { if (!(SUB_OF[k] && nodes[SUB_OF[k]])) node.appendChild(section(k)); });
    function offAbove(k) { for (var p = SUB_OF[k]; p; p = SUB_OF[p]) if (rows[p] && rows[p].effective() === "off") return true; return false; }
    function syncGroup() {
      Object.keys(SUB_OF).forEach(function (s) { if (nodes[s]) (groups[s] || nodes[s]).style.display = offAbove(s) ? "none" : ""; });
    }
    node.addEventListener("change", function () { setTimeout(function () { syncGroup(); redraw(); }, 0); });
    // "On demand" enrolment needs the panel: keep the form from offering an impossible pair.
    function constrain() {
      if (!rows.panel || !rows.onboarding) return;
      var hidden = rows.panel.read() === "hide";
      var lazy = rows.onboarding.ctl.querySelector('[data-v="lazy"]');
      if (lazy) { lazy.disabled = hidden || !!opts.disabled; lazy.title = hidden ? tr("Needs the panel") : ""; if (hidden && rows.onboarding.read() === "lazy") rows.onboarding.ctl.querySelector('[data-v="eager"]').click(); }
    }
    node.addEventListener("click", function () { setTimeout(function () { constrain(); syncGroup(); redraw(); }, 0); });
    constrain();
    syncGroup();
    redraw();
    return {
      node: node,
      collect: function () {
        var out = {};
        Object.keys(rows).forEach(function (k) {
          var r = rows[k];
          if (r.isCleared()) { if (r.it.source === level) out[k] = null; return; }
          var v = r.read();
          if (JSON.stringify(v) !== JSON.stringify(r.it.value)) out[k] = v;
        });
        return out;
      },
    };
  }

  window.CUI = { icon: icon, el: el, append: append, clear: clear, brand: brand, api: api, explain: explain, MESSAGES: MESSAGES, msg: msg,
    toast: toast, modal: modal, copyText: copyText, copyField: copyField, codeBlock: codeBlock, badge: badge, when: when, fullDate: fullDate,
    passkeyRegister: passkeyRegister, passkeyLogin: passkeyLogin, settingsForm: settingsForm, showValue: showValue, SOURCE_TEXT: SOURCE_TEXT,
    tr: tr, t: t, plural: plural, text: text, lang: function () { return lang; }, setLang: setLang, onLang: onLang, langButton: langButton };
})();
