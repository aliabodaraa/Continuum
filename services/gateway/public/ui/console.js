// Continuum Console — the organisation's dashboard. Hash routes:
//   #/organisations                 list
//   #/organisations/new             the setup wizard
//   #/organisations/<key>/<tab>     one organisation: overview, keys, websites, extension, alerts, activity, settings
//   #/activity                      everything this account did, and what was done to its organisations
//   #/quickstart                    how to connect a site and its server
(function () {
  "use strict";
  var C = window.CUI, el = C.el, icon = C.icon;
  var root = document.getElementById("app");
  var token = null;
  try { token = sessionStorage.getItem("continuumConsole"); } catch (e) {}
  var me = null, cfg = { extensionId: null, publicUrl: location.origin, autoApprove: false };
  var orgs = null;   // cached list; reloaded after every change

  function call(path, opts) {
    opts = opts || {}; opts.token = token;
    return C.api(path, opts).catch(function (e) {
      if (e.code === "invalid_console_session") { signOut(); C.toast("info", C.MESSAGES.invalid_console_session); }
      throw e;
    });
  }
  function signIn(t) { token = t; try { sessionStorage.setItem("continuumConsole", t); } catch (e) {} orgs = null; location.hash = "#/organisations"; route(); }
  // Back to the list as well: whoever signs in next must not land on the previous account's organisation.
  function signOut() { token = null; me = null; orgs = null; try { sessionStorage.removeItem("continuumConsole"); } catch (e) {} history.replaceState(null, "", location.pathname + "#/organisations"); route(); }
  function loadOrgs(force) {
    if (orgs && !force) return Promise.resolve(orgs);
    return call("/v1/console/tenants").then(function (d) { orgs = d.tenants; return orgs; });
  }
  function nonExt(origins) { return (origins || []).filter(function (o) { return o.indexOf("chrome-extension://") !== 0; }); }

  // ================= signed out =================
  function renderAuth(mode) {
    mode = mode || "signin";
    var creating = mode === "create";
    var email = el("input.input#authEmail", { type: "email", autocomplete: "username webauthn", placeholder: "you@company.com", required: true });
    var msg = el("div.field-error#authMsg");
    var btn = el("button.btn.btn-primary.btn-lg.btn-block#authBtn", { type: "submit" }, [icon("fingerprint"), creating ? "Create account with a passkey" : "Sign in with your passkey"]);
    var form = el("form", { novalidate: true }, [
      el("label.field", [el("span.label", "Work email"), email]),
      el("div", { style: "margin-top:18px" }, btn), msg,
    ]);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      msg.textContent = "";
      var v = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { msg.textContent = C.msg("bad_email"); email.focus(); return; }
      btn.disabled = true;
      var old = btn.innerHTML; btn.innerHTML = ""; append(btn, [el("span.spinner"), " Waiting for your passkey…"]);
      (creating ? C.passkeyRegister(v, { purpose: "console" }) : C.passkeyLogin(v, { purpose: "console" }))
        .then(function (r) { signIn(r.consoleToken); })
        .catch(function (e) { msg.textContent = C.explain(e); btn.disabled = false; btn.innerHTML = old; });
    });
    var bullet = function (ic, t, s) { return el("li", [icon(ic), el("div", [el("b", t), el("div", { style: "opacity:.85;font-size:13.5px" }, s)])]); };
    C.clear(root).appendChild(el("div.auth", [
      el("div.auth-art", [
        C.brand("Console"),
        el("div.pitch", [
          el("h1", "Continuous authentication for your users"),
          el("p.lead", "Continuum keeps checking that the person typing and moving the mouse is still your user, and asks for a passkey only when it isn't."),
          el("ul", [
            bullet("building", "Register your organisation", "Get your site key and secret in a minute."),
            bullet("shieldCheck", "Enrol once, protected everywhere", "On your site, and on any site through the browser extension."),
            bullet("bell", "React in real time", "A signed alert reaches your server when a user turns suspicious."),
          ]),
        ]),
        el("div.foot", "Your passkey is your password: no password is ever stored."),
      ]),
      el("div.auth-side", el("div.auth-card", [
        el("div.row", { style: "justify-content:flex-end;margin-bottom:10px" }, C.langButton()),
        el("h2", creating ? "Create your account" : "Sign in to the console"),
        el("p.sub", creating ? "For organisations that want to use Continuum." : "Welcome back. Use the passkey on this device."),
        form,
        el("div.passkey-note", [icon("info", "sm"), el("div", creating
          ? "Your device will ask you to create a passkey (fingerprint, face or PIN). The email is your account's name."
          : "Your device will ask for your fingerprint, face or PIN.")]),
        el("p.muted", { style: "margin-top:22px;text-align:center" }, [creating ? "Already have an account? " : "New to Continuum? ",
          el("a#authSwitch", { href: "#", onclick: function (e) { e.preventDefault(); renderAuth(creating ? "signin" : "create"); } }, creating ? "Sign in" : "Create an account")]),
      ])),
    ]));
    email.focus();
  }

  // ================= signed in: shell =================
  var shellMain = null, navLinks = {};
  function renderShell() {
    var side = el("aside.sidebar");
    var nav = el("nav.nav");
    var item = function (key, href, ic, label) { var a = el("a.nav-item", { href: href }, [icon(ic), label]); navLinks[key] = a; return a; };
    append(nav, [el("div.nav-label", "Build"), item("organisations", "#/organisations", "building", "Organisations"), item("quickstart", "#/quickstart", "code", "Quickstart"),
      el("div.nav-label", "Monitor"), item("activity", "#/activity", "history", "Activity")]);
    var who = el("div.account", [el("div.avatar#avatar", "·"), el("div.who", [el("b#meEmail", "…"), el("span", "Organisation admin")]), el("span.spacer"),
      el("button.btn.btn-ghost.btn-icon#signOutBtn", { type: "button", title: "Sign out", "aria-label": "Sign out", onclick: signOut }, icon("logout"))]);
    append(side, [C.brand("Console"), nav, el("div.sidebar-foot", [el("div.lang-row", C.langButton()), who])]);
    var menuBtn = el("button.btn.btn-ghost.btn-icon", { type: "button", "aria-label": "Menu", onclick: function () { side.classList.toggle("open"); } }, icon("menu"));
    shellMain = el("main.main");
    C.clear(root).appendChild(el("div.shell", [side, el("div", [el("div.mobilebar", [menuBtn, C.brand()]), shellMain])]));
    side.addEventListener("click", function (e) { if (e.target.closest && e.target.closest(".nav-item")) side.classList.remove("open"); });
    if (me) fillMe(); else call("/v1/console/me").then(function (d) { me = d; fillMe(); }).catch(function () {});
  }
  function fillMe() {
    var e = document.getElementById("meEmail"), a = document.getElementById("avatar");
    if (e) e.textContent = me.email;
    if (a) a.textContent = (me.email || "?")[0].toUpperCase();
  }
  var append = C.append;
  function setNav(key) { Object.keys(navLinks).forEach(function (k) { navLinks[k].classList.toggle("active", k === key); }); }
  function page(kids) { C.clear(shellMain); var p = el("div.page", kids); shellMain.appendChild(p); window.scrollTo(0, 0); return p; }
  function head(title, sub, actions, crumbs) {
    return el("div", [crumbs ? el("div.crumbs", crumbs) : null,
      el("div.page-head", [el("div", [el("h1", title), sub ? el("p.sub", sub) : null]), el("span.spacer"), actions ? el("div.row", actions) : null])]);
  }
  function loading() { return el("div.card.card-pad.muted", [el("span.spinner"), " Loading…"]); }
  function failed(e) { return el("div.callout.bad", [icon("alert"), el("div", C.explain(e))]); }

  // ================= organisations list =================
  function renderList() {
    setNav("organisations");
    var newBtn = el("a.btn.btn-primary#newOrgBtn", { href: "#/organisations/new" }, [icon("plus"), "New organisation"]);
    var body = el("div", loading());
    page([head("Organisations", "Each organisation is one app or company that protects its users with Continuum.", [newBtn]), body]);
    loadOrgs(true).then(function (list) {
      C.clear(body);
      if (!list.length) {
        body.appendChild(el("div.card", el("div.empty", [el("div.art", icon("building")), el("h3", "No organisations yet"),
          el("p", "Register your app or company to get a site key for your pages and a secret for your server."),
          el("a.btn.btn-primary", { href: "#/organisations/new" }, [icon("plus"), "Register your first organisation"])])));
        return;
      }
      var pending = list.filter(function (t) { return t.status === "pending"; }).length;
      if (pending) body.appendChild(el("div.callout.warn", { style: "margin-bottom:16px" }, [icon("clock"), el("div", [el("strong", C.plural(pending, "{n} organisation is waiting for approval.", "{n} organisations are waiting for approval.") + " "), "Their site keys start working as soon as the operator approves them."])]));
      var search = el("input.input", { type: "search", placeholder: "Search by name or site key", "aria-label": "Search" });
      var tbody = el("tbody");
      var draw = function () {
        var q = search.value.trim().toLowerCase();
        C.clear(tbody);
        list.filter(function (t) { return !q || t.name.toLowerCase().indexOf(q) >= 0 || t.siteKey.indexOf(q) >= 0; }).forEach(function (t) {
          var go = function () { location.hash = "#/organisations/" + t.siteKey; };
          tbody.appendChild(el("tr.click", { onclick: go, "data-key": t.siteKey }, [
            el("td", [el("div", { style: "font-weight:600" }, C.text(t.name)), el("div.mono.muted", t.siteKey)]),
            el("td", C.badge(t.status)),
            el("td.hide-sm", C.plural(nonExt(t.origins).length, "{n} website", "{n} websites")),
            el("td.hide-sm", t.allowExtension ? el("span.badge.badge-neutral.badge-plain", [icon("puzzle", "sm"), " Allowed"]) : el("span.muted", "Off")),
            el("td.hide-sm.muted.nowrap", { title: C.fullDate(t.createdAt) }, C.when(t.createdAt)),
            el("td", { style: "text-align:end;color:var(--faint)" }, icon("chevron")),
          ]));
        });
      };
      search.addEventListener("input", draw);
      draw();
      append(body, [el("div", { style: "margin-bottom:14px;max-width:360px" }, search),
        el("div.card", el("div.table-wrap", el("table.table", [el("thead", el("tr", [el("th", "Organisation"), el("th", "Status"), el("th.hide-sm", "Websites"), el("th.hide-sm", "Extension"), el("th.hide-sm", "Created"), el("th", "")])), tbody])))]);
    }).catch(function (e) { C.clear(body).appendChild(failed(e)); });
  }

  // ================= setup wizard =================
  function siteChips(list, onChange, readOnly) {
    var chips = el("div.chips");
    var draw = function () {
      C.clear(chips);
      if (!list.length) chips.appendChild(el("span.muted.small", "No websites yet."));
      list.forEach(function (o, i) {
        chips.appendChild(el("span.chip-item", [C.text(o), readOnly ? null : el("button", { type: "button", "aria-label": C.t("Remove {site}", { site: o }), onclick: function () { list.splice(i, 1); draw(); if (onChange) onChange(); } }, icon("x", "sm"))]));
      });
    };
    draw();
    return { node: chips, redraw: draw };
  }
  function siteAdder(list, chips, onChange, ids) {
    ids = ids || {};
    var input = el("input.input.mono", { id: ids.input || null, placeholder: "https://app.example.com", "aria-label": "Website address" });
    var err = el("div.field-error");
    var add = function () {
      err.textContent = "";
      var v = input.value.trim().replace(/\/+$/, "");
      if (!v) return;
      var u; try { u = new URL(v); } catch (e) { u = null; }
      if (!u || !/^https?:$/.test(u.protocol) || u.origin !== v) { err.textContent = C.MESSAGES.bad_origin; return; }
      if (list.indexOf(u.origin) < 0) list.push(u.origin);
      input.value = ""; chips.redraw(); if (onChange) onChange(); input.focus();
    };
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); add(); } });
    return el("div", [el("div.input-group", [input, el("button.btn.btn-secondary", { type: "button", id: ids.add || null, onclick: add }, [icon("plus", "sm"), "Add"])]), err]);
  }
  function renderWizard() {
    setNav("organisations");
    var st = { step: 0, name: "", sites: [], ext: false, signIn: "", extId: "", hook: "" };
    var STEPS = ["Details", "Websites", "Browser extension", "Alerts"];
    var stepper = el("div.steps"), card = el("div.card"), wrap = el("div", [stepper, card]);
    page([head("Register an organisation", "Four short steps. You can change everything later.", null,
      [el("a", { href: "#/organisations" }, "Organisations"), icon("chevron", "sm"), "New"]), wrap]);
    function draw() {
      C.clear(stepper);
      STEPS.forEach(function (s, i) {
        stepper.appendChild(el("div.step" + (i < st.step ? ".done" : i === st.step ? ".on" : ""), [el("span.num", i < st.step ? icon("check", "sm") : String(i + 1)), el("span.t", s)]));
      });
      C.clear(card);
      var body = el("div.card-body"), err = el("div.field-error#wErr");
      var back = el("button.btn.btn-ghost#wBack", { type: "button", onclick: function () { st.step--; draw(); } }, [icon("back", "sm"), "Back"]);
      var next = el("button.btn.btn-primary#wNext", { type: "button" }, st.step < 3 ? ["Continue", icon("chevron", "sm")] : [icon("check", "sm"), "Create organisation"]);
      if (st.step === 0) {
        var name = el("input.input#wName", { value: st.name, maxlength: 80, placeholder: "Acme Notes" });
        append(body, [el("h2", "What's it called?"), el("p.muted", { style: "margin:4px 0 18px" }, "Your users see this name when they sign in to the browser extension."),
          el("label.field", [el("span.label", "Organisation name"), name])]);
        next.addEventListener("click", function () { st.name = name.value.trim(); if (!st.name) { err.textContent = C.msg("name_required"); return; } st.step = 1; draw(); });
        setTimeout(function () { name.focus(); }, 20);
        name.addEventListener("keydown", function (e) { if (e.key === "Enter") next.click(); });
      } else if (st.step === 1) {
        var chips = siteChips(st.sites);
        append(body, [el("h2", "Which websites will use it?"), el("p.muted", { style: "margin:4px 0 18px" }, "Your site key appears in your pages, so only these websites may use it. Add the address only, without a page path."),
          siteAdder(st.sites, chips, null, { input: "wSiteInput", add: "wSiteAdd" }), el("div", { style: "margin-top:14px" }, chips.node),
          el("div.callout.info", { style: "margin-top:18px" }, [icon("info"), el("div", C.t("Examples: {a} or {b}.", { a: el("span.mono", "https://app.acme.com"), b: el("span.mono", "http://localhost:3000") }))])]);
        next.addEventListener("click", function () {
          var pendingInput = document.getElementById("wSiteInput");
          if (pendingInput && pendingInput.value.trim()) document.getElementById("wSiteAdd").click();
          if (!st.sites.length) { err.textContent = C.t("Add at least one website. (You can rely on the browser extension alone: skip this by allowing it in the next step.)"); st.allowSkip = true; }
          if (!st.sites.length && !st.allowSkipConfirmed) { st.allowSkipConfirmed = true; return; }
          st.step = 2; draw();
        });
      } else if (st.step === 2) {
        var sw = el("input#wExt", { type: "checkbox", checked: st.ext });
        var signIn = el("input.input.mono#wSignIn", { value: st.signIn, placeholder: (st.sites[0] || "https://app.acme.com") + "/continuum/link" });
        var extId = el("input.input.mono#wExtId", { value: st.extId, placeholder: "32 letters, from chrome://extensions" });
        var more = el("div", { style: "margin-top:18px" }, [
          el("label.field", [el("span.label", "Sign-in page for the extension"), signIn,
            el("p.hint", C.t("Your users prove who they are here, with their usual account at your app. With {pkg} it is {path} on your site.", { pkg: el("span.mono", "@continuum/node"), path: el("span.mono", "/continuum/link") }))]),
          cfg.extensionId ? null : el("label.field", [el("span.label", "Extension id"), extId]),
        ]);
        var sync = function () { more.classList.toggle("hidden", !sw.checked); };
        sw.addEventListener("change", sync); sync();
        append(body, [el("h2", "Browser extension"), el("p.muted", { style: "margin:4px 0 18px" }, "The Continuum Guard extension protects your users on every other website too, with the profile they enrolled in your app."),
          el("label.row", { style: "gap:12px;cursor:pointer" }, [el("span.switch", [sw, el("span")]), el("div", [el("b", "Let your users use the browser extension"), el("div.muted.small", "You can switch this off at any time.")])]), more]);
        next.addEventListener("click", function () {
          st.ext = sw.checked; st.signIn = signIn.value.trim(); st.extId = extId.value.trim();
          if (st.ext && !st.signIn) { err.textContent = C.t("Add the sign-in page your users will use for the extension."); return; }
          if (!st.ext && !st.sites.length) { err.textContent = C.msg("origins_required"); return; }
          st.step = 3; draw();
        });
      } else {
        var hook = el("input.input.mono#wHook", { value: st.hook, placeholder: "https://app.acme.com/continuum/events" });
        append(body, [el("h2", "Alerts (optional)"), el("p.muted", { style: "margin:4px 0 18px" }, "Continuum can tell your server the moment one of your users turns suspicious, so you can log them out or block a payment."),
          el("label.field", [el("span.label", "Risk-change webhook"), hook, el("p.hint", "A public https:// address on your server. Leave it empty to skip; you can add it later and send a test alert.")]),
          el("div.callout", { style: "margin-top:18px" }, [icon("info"), el("div", [el("strong", "Review: "), C.t("{name} · {sites} · {ext}", { name: st.name, sites: C.plural(st.sites.length, "{n} website", "{n} websites"), ext: C.t(st.ext ? "extension allowed" : "extension off") })])])]);
        next.addEventListener("click", function () {
          st.hook = hook.value.trim();
          next.disabled = true; err.textContent = "";
          var body2 = { name: st.name, origins: st.sites, allowExtension: st.ext, webhookUrl: st.hook };
          if (st.ext) { body2.signInUrl = st.signIn; if (!cfg.extensionId) body2.extensionId = st.extId; }
          call("/v1/console/tenants", { body: body2 }).then(function (r) { orgs = null; renderCreated(r); })
            .catch(function (e) { err.textContent = C.explain(e); next.disabled = false; });
        });
      }
      append(card, [body, el("div.card-foot", [err, el("span.spacer"), st.step ? back : el("a.btn.btn-ghost", { href: "#/organisations" }, "Cancel"), next])]);
    }
    draw();
  }
  function renderCreated(r) {
    var saved = el("input#savedCheck", { type: "checkbox" });
    var done = el("a.btn.btn-primary#doneBtn", { href: "#/organisations/" + r.siteKey, "aria-disabled": "true", style: "pointer-events:none;opacity:.55" }, [C.t("Go to {name}", { name: r.name }), icon("chevron", "sm")]);
    saved.addEventListener("change", function () { done.style.pointerEvents = saved.checked ? "" : "none"; done.style.opacity = saved.checked ? "" : ".55"; done.setAttribute("aria-disabled", String(!saved.checked)); });
    page([el("div.card", [
      el("div.card-body", { style: "padding:32px" }, [
        el("div.big-icon.ok", icon("check")),
        el("h1", C.t("{name} is registered", { name: r.name })),
        el("p.muted", { style: "margin-top:6px" }, r.status === "pending" ? "It starts working as soon as the operator approves it. Meanwhile, set up your site with the keys below." : "It is active. Set up your site with the keys below."),
        el("div", { style: "margin-top:18px" }, C.badge(r.status)),
        el("div.stack", { style: "margin-top:24px" }, [
          el("div", [el("div.label", "Site key (public)"), C.copyField(r.siteKey, { cls: "newSiteKey" }), el("p.hint", "Goes in your pages: <script data-site-key>.")]),
          el("div", [el("div.label", "Secret (private)"), C.copyField(r.secret, { reveal: true, cls: "newSecret" }), el("p.hint", "Goes on your server as CONTINUUM_SECRET. Never put it in a page.")]),
          el("div.callout.warn", [icon("alert"), el("div", [el("strong", "Copy the secret now. "), "For your safety it is shown only this once. If you lose it, make a new one on the Keys tab."])]),
        ]),
      ]),
      el("div.card-foot", [el("label.row", { style: "gap:8px;cursor:pointer;margin-inline-end:auto" }, [saved, "I've saved the secret somewhere safe"]), done]),
    ])]);
  }

  // ================= one organisation =================
  var TABS = [["overview", "Overview", "building"], ["keys", "Keys", "key"], ["websites", "Websites", "globe"], ["extension", "Extension", "puzzle"],
    ["protection", "Protection", "shieldCheck"], ["alerts", "Alerts", "bell"], ["activity", "Activity", "history"], ["settings", "Settings", "sliders"]];
  function renderOrg(key, tab) {
    setNav("organisations");
    tab = tab || "overview";
    var body = el("div", loading());
    page([body]);
    loadOrgs(true).then(function (list) {
      var t = list.filter(function (x) { return x.siteKey === key; })[0];
      C.clear(body);
      if (!t) { body.appendChild(failed({ code: "unknown_tenant" })); return; }
      var locked = t.status === "revoked";
      var tabs = el("div.tabs", TABS.map(function (x) { return el("a.tab" + (x[0] === tab ? ".active" : ""), { href: "#/organisations/" + key + "/" + x[0], id: "tab-" + x[0] }, [icon(x[2], "sm"), x[1]]); }));
      var pane = el("div", { style: "margin-top:22px" });
      append(body, [
        el("div.crumbs", [el("a", { href: "#/organisations" }, "Organisations"), icon("chevron", "sm"), C.text(t.name)]),
        el("div.page-head", [el("div", [el("div.row", [el("h1", C.text(t.name)), C.badge(t.status)]), el("div.row", { style: "margin-top:8px" }, [el("span.mono.muted", t.siteKey),
          el("button.btn.btn-ghost.btn-sm", { type: "button", onclick: function (e) { C.copyText(t.siteKey, e.currentTarget); } }, [icon("copy", "sm"), "Copy"])])]),
          el("span.spacer"), el("a.btn.btn-secondary", { href: "#/quickstart/" + key }, [icon("code", "sm"), "Connect your app"])]),
        t.status === "pending" ? el("div.callout.warn", { style: "margin-bottom:18px" }, [icon("clock"), el("div", [el("strong", "Waiting for approval. "), "The operator has to approve this organisation before its site key works. You can prepare everything meanwhile."])]) : null,
        locked ? el("div.callout.bad", { style: "margin-bottom:18px" }, [icon("lock"), el("div", [el("strong", "Revoked. "), "This organisation's site key no longer works and its settings can't be changed."])]) : null,
        tabs, pane,
      ]);
      ({ overview: tabOverview, keys: tabKeys, websites: tabWebsites, extension: tabExtension, protection: tabProtection, alerts: tabAlerts, activity: tabActivity, settings: tabSettings }[tab] || tabOverview)(t, pane, locked);
    }).catch(function (e) { C.clear(body).appendChild(failed(e)); });
  }
  function save(t, patch, btn) {
    if (btn) btn.disabled = true;
    return call("/v1/console/tenants/" + t.siteKey, { body: patch }).then(function (r) { C.toast("ok", "Saved"); orgs = null; return r; })
      .catch(function (e) { C.toast("bad", C.explain(e)); throw e; })
      .then(function (r) { if (btn) btn.disabled = false; return r; }, function (e) { if (btn) btn.disabled = false; throw e; });
  }
  function tabOverview(t, pane) {
    var tiles = el("div.stats", [0, 1, 2, 3].map(function () { return el("div.stat", [el("div.l", "…"), el("div.n", "—")]); }));
    append(pane, [tiles, el("div.card", { style: "margin-top:18px" }, [el("div.card-head", el("h3", "Details")), el("div.card-body", el("div.kv", [
      el("div.k", "Status"), el("div.v", C.badge(t.status)),
      el("div.k", "Site key"), el("div.v", el("span.mono", t.siteKey)),
      el("div.k", "Websites"), el("div.v", nonExt(t.origins).length ? nonExt(t.origins).join(", ") : el("span.muted", "None")),
      el("div.k", "Browser extension"), el("div.v", t.allowExtension ? ["Allowed", t.signInUrl ? el("div.muted.small.mono", t.signInUrl) : el("div.muted.small", "No sign-in page yet")] : el("span.muted", "Off")),
      el("div.k", "Risk-change alerts"), el("div.v", t.webhookUrl ? el("span.mono", t.webhookUrl) : el("span.muted", "Off")),
      el("div.k", "Created"), el("div.v", { title: C.fullDate(t.createdAt) }, C.when(t.createdAt)),
    ]))])]);
    call("/v1/console/tenants/" + t.siteKey + "/stats").then(function (s) {
      var pct = function (n) { return s.users ? Math.round(100 * n / s.users) : 0; };
      var tile = function (ic, label, n, bar) {
        return el("div.stat", [el("div.l", [icon(ic, "sm"), label]), el("div.n", String(n)), bar != null ? el("div.bar", el("i", { style: "width:" + bar + "%" })) : el("div.small.muted", { style: "margin-top:10px" }, s.anonymous ? C.plural(s.anonymous, "{n} anonymous visitor", "{n} anonymous visitors") : "signed-in people")]);
      };
      C.clear(tiles);
      append(tiles, [tile("users", "Users", s.users, null), tile("fingerprint", "With a passkey", s.passkey, pct(s.passkey)),
        tile("keyboard", "Typing enrolled", s.typing, pct(s.typing)), tile("mouse", "Mouse enrolled", s.mouse, pct(s.mouse))]);
    }).catch(function (e) { C.clear(tiles).appendChild(failed(e)); });
  }
  function tabKeys(t, pane, locked) {
    var rotate = el("button.btn.btn-secondary#rotateBtn", { type: "button", disabled: locked || t.serverManaged }, [icon("refresh", "sm"), "Make a new secret"]);
    rotate.addEventListener("click", function () {
      C.modal({ title: "Make a new secret?", text: "The current secret stops working immediately. Update your server right after, or its users' sign-ins will fail.",
        actions: [{ label: "Cancel" }, { label: "Make a new secret", kind: "danger", id: "rotateConfirm", onClick: function (close) {
          return call("/v1/console/tenants/" + t.siteKey + "/rotate", { body: {} }).then(function (r) {
            close(); orgs = null;
            C.modal({ title: "Your new secret", sticky: true, body: el("div.stack", [C.copyField(r.secret, { reveal: true, cls: "rotatedSecret" }),
              el("div.callout.warn", [icon("alert"), el("div", "Copy it now: it is shown only this once.")])]),
              actions: [{ label: "I've saved it", kind: "primary", id: "rotatedDone", onClick: function (c) { c(); renderOrg(t.siteKey, "keys"); } }] });
          }).catch(function (e) { C.toast("bad", C.explain(e)); });
        } }] });
    });
    append(pane, [
      el("div.card", [el("div.card-head", el("div", [el("h3", "Site key"), el("p.muted.small", "Public. It goes in your pages, and only your websites may use it.")])),
        el("div.card-body", [C.copyField(t.siteKey), el("p.hint", C.t("In your page: {code}", { code: el("span.mono", '<script src="' + cfg.publicUrl + '/guard.js" data-site-key="' + t.siteKey + '">') }))])]),
      el("div.card", { style: "margin-top:18px" }, [el("div.card-head", el("div", [el("h3", "Secret"), el("p.muted.small", "Private. It lives on your server as CONTINUUM_SECRET and proves who your users are.")])),
        el("div.card-body", [el("div.copy", [el("code", "••••••••••••••••••••••••••••••••••••••••••••••••"), el("span.badge.badge-neutral.badge-plain", [icon("lock", "sm"), " Kept hidden"])]),
          el("p.hint", t.serverManaged ? "Built into this server: the secret is CA_SIGNING_SECRET in the server's .env file, which the demo app reads too. Change it there and restart both." : t.secretRotatedAt ? C.t("Last changed {when}.", { when: C.when(t.secretRotatedAt) }) : "Shown once, when the organisation was created. Lost it? Make a new one.")]),
        el("div.card-foot", rotate)]),
      el("div.card", { style: "margin-top:18px" }, [el("div.card-head", el("div", [el("h3", "Verify verdicts"), el("p.muted.small", "Continuum signs every verdict. Check it with these public keys, in any language.")])),
        el("div.card-body", el("div.kv", [el("div.k", "JWKS"), el("div.v", C.copyField(cfg.publicUrl + "/.well-known/jwks.json")),
          el("div.k", "Discovery"), el("div.v", C.copyField(cfg.publicUrl + "/.well-known/continuum-configuration"))]))]),
    ]);
  }
  function tabWebsites(t, pane, locked) {
    var list = nonExt(t.origins).slice(), saveBtn = el("button.btn.btn-primary#sitesSave", { type: "button", disabled: true }, "Save changes");
    var chips = siteChips(list, function () { saveBtn.disabled = false; }, locked);
    saveBtn.addEventListener("click", function () { save(t, { origins: list, allowExtension: t.allowExtension }, saveBtn).then(function () { saveBtn.disabled = true; renderOrg(t.siteKey, "websites"); }, function () {}); });
    append(pane, el("div.card", [el("div.card-head", el("div", [el("h3", "Websites"), el("p.muted.small", "Only these websites may use your site key. Anyone else who copies it is refused.")])),
      el("div.card-body.stack", [locked ? null : siteAdder(list, chips, function () { saveBtn.disabled = false; }, { input: "siteInput", add: "siteAdd" }), chips.node]),
      locked ? null : el("div.card-foot", saveBtn)]));
  }
  function tabExtension(t, pane, locked) {
    var sw = el("input#extToggle", { type: "checkbox", checked: t.allowExtension, disabled: locked });
    var signIn = el("input.input.mono#extSignIn", { value: t.signInUrl || "", placeholder: (nonExt(t.origins)[0] || "https://app.acme.com") + "/continuum/link", disabled: locked });
    var extId = el("input.input.mono#extId", { placeholder: "32 letters, from chrome://extensions", disabled: locked });
    var btn = el("button.btn.btn-primary#extSave", { type: "button" }, "Save");
    btn.addEventListener("click", function () {
      var patch = { allowExtension: sw.checked, origins: nonExt(t.origins), signInUrl: sw.checked ? signIn.value.trim() : "" };
      if (sw.checked && !patch.signInUrl) { C.toast("bad", "Add the sign-in page your users will use."); return; }
      if (sw.checked && !cfg.extensionId) patch.extensionId = extId.value.trim();
      save(t, patch, btn).then(function () { renderOrg(t.siteKey, "extension"); }, function () {});
    });
    append(pane, [el("div.card", [el("div.card-head", el("div", [el("h3", "Browser extension"), el("p.muted.small", "Continuum Guard protects your users on every website, with the profile they enrolled in your app.")])),
      el("div.card-body.stack", [
        el("label.row", { style: "gap:12px;cursor:pointer" }, [el("span.switch", [sw, el("span")]), el("b", "Let your users use the browser extension")]),
        el("label.field", [el("span.label", "Sign-in page"), signIn, el("p.hint", C.t("Your users sign in here with their usual account. With {pkg} it is {path} on your site.", { pkg: el("span.mono", "@continuum/node"), path: el("span.mono", "/continuum/link") }))]),
        cfg.extensionId ? null : el("label.field", [el("span.label", "Extension id"), extId]),
      ]), locked ? null : el("div.card-foot", btn)]),
      el("div.card", { style: "margin-top:18px" }, [el("div.card-head", el("h3", "How your users sign in")), el("div.card-body", el("ol", { style: "margin:0;padding-inline-start:18px;color:var(--text-2)" }, [
        el("li", C.t("In the extension's settings they choose {org} and type your site key: {key}.", { org: el("b", "My organisation"), key: el("span.mono", t.siteKey) })),
        el("li", "The extension opens your sign-in page, and they log in with their usual account."),
        el("li", "Your server vouches for them; the extension never sees their password or your secret."),
        el("li", "From then on they are the same Continuum user as in your app, so their enrolled typing and mouse are used."),
      ]))])]);
  }
  // How Continuum behaves on this organisation's pages and in the extension. Each setting falls back to
  // the operator's default until the organisation chooses its own.
  function tabProtection(t, pane, locked) {
    var box = el("div.card", el("div.card-body", [el("span.spinner"), " Loading…"]));
    pane.appendChild(box);
    call("/v1/console/tenants/" + t.siteKey + "/settings").then(function (d) {
      var form = C.settingsForm(d.settings, { level: "organisation", disabled: locked });
      var btn = el("button.btn.btn-primary#protectionSave", { type: "button" }, "Save");
      btn.addEventListener("click", function () {
        var changes = form.collect();
        if (!Object.keys(changes).length) { C.toast("info", "Nothing changed."); return; }
        btn.disabled = true;
        call("/v1/console/tenants/" + t.siteKey + "/settings", { body: changes })
          .then(function () { C.toast("ok", "Saved. Pages pick it up on their next load."); renderOrg(t.siteKey, "protection"); })
          .catch(function (e) { C.toast("bad", C.explain(e)); btn.disabled = false; });
      });
      C.clear(box);
      append(box, [el("div.card-head", el("div", [el("h3", "Protection on your pages"), el("p.muted.small", "These apply to every page that loads your site key, and to your users in the browser extension. Until you choose, each one follows the operator's default.")])),
        el("div.card-body", form.node), locked ? null : el("div.card-foot", btn)]);
    }).catch(function (e) { C.clear(box).appendChild(el("div.card-body", el("div.callout.bad", [icon("alert"), el("div", C.explain(e))]))); });
  }
  function tabAlerts(t, pane, locked) {
    var hook = el("input.input.mono#hookInput", { value: t.webhookUrl || "", placeholder: "https://app.acme.com/continuum/events", disabled: locked });
    var saveBtn = el("button.btn.btn-primary#hookSave", { type: "button" }, "Save");
    var testBtn = el("button.btn.btn-secondary#hookTest", { type: "button", disabled: locked || !t.webhookUrl }, [icon("send", "sm"), "Send test alert"]);
    var result = el("div#hookResult");
    saveBtn.addEventListener("click", function () { save(t, { webhookUrl: hook.value.trim() }, saveBtn).then(function () { renderOrg(t.siteKey, "alerts"); }, function () {}); });
    testBtn.addEventListener("click", function () {
      testBtn.disabled = true; C.clear(result).appendChild(el("div.muted", [el("span.spinner"), " Sending…"]));
      call("/v1/console/tenants/" + t.siteKey + "/test-webhook", { body: {} }).then(function (r) {
        C.clear(result).appendChild(r.ok
          ? el("div.callout.ok", [icon("check"), el("div", [el("strong", "Delivered. "), C.t("Your server answered {status} in {ms} ms.", { status: r.status, ms: r.ms })])])
          : el("div.callout.bad", [icon("alert"), el("div", [el("strong", "Not delivered. "), r.error === "timeout" ? "Your server did not answer within 5 seconds." : r.error ? "Your server could not be reached." : C.t("Your server answered {status}.", { status: r.status })])]));
      }).catch(function (e) { C.clear(result).appendChild(failed(e)); }).then(function () { testBtn.disabled = false; });
    });
    append(pane, el("div.card", [el("div.card-head", el("div", [el("h3", "Risk-change alerts"), el("p.muted.small", "A signed message reaches your server the moment one of your users turns suspicious, and when they are back to normal.")])),
      el("div.card-body.stack", [el("label.field", [el("span.label", "Webhook address"), hook, el("p.hint", "A public https:// address on your server. Verify each message with the public keys on the Keys tab.")]), result]),
      locked ? null : el("div.card-foot", [testBtn, el("span.spacer"), saveBtn])]));
  }
  var ACTIONS = {
    "organisation.created": ["Organisation created", "plus", ""], "organisation.updated": ["Settings changed", "sliders", ""],
    "organisation.approved": ["Approved by the operator", "check", "ok"], "organisation.reactivated": ["Re-activated by the operator", "check", "ok"],
    "organisation.revoked": ["Revoked", "lock", "bad"], "secret.rotated": ["New secret made", "key", "warn"], "webhook.tested": ["Test alert sent", "send", ""],
    "account.created": ["Account created", "user", "ok"], "account.deleted": ["Account deleted", "trash", "bad"], "operator.locked_out": ["Operator sign-in paused after wrong keys", "lock", "bad"],
    "organisation.owner_set": ["Given to an account by the operator", "user", "ok"], "organisation.owner_cleared": ["Taken back by the operator", "user", ""],
    "organisation.deleted": ["Organisation deleted", "trash", "bad"],
    "organisation.settings_changed": ["Protection settings changed", "shieldCheck", ""],
    "webhook.undeliverable": ["An alert could not be delivered", "send", "bad"],
  };
  function timeline(entries, showOrg) {
    if (!entries.length) return el("div.empty", [el("div.art", icon("history")), el("h3", "Nothing yet"), el("p", "Changes to your organisations will appear here.")]);
    return el("ul.timeline", entries.map(function (e) {
      var a = ACTIONS[e.action] || [e.action, "info", ""];
      var who = e.actor && e.actor.type === "operator" ? C.t("the operator") : e.actor && e.actor.type === "system" ? "Continuum" : (e.actor && e.actor.email) || C.t("someone");
      var extra = e.detail && e.detail.changed ? " (" + e.detail.changed.join(", ") + ")" : e.detail && e.action === "webhook.tested" ? C.t(e.detail.ok ? " — delivered" : " — not delivered")
        : e.detail && e.action === "webhook.undeliverable" ? C.t(" — gave up after {n} tries ({error})", { n: e.detail.attempts, error: e.detail.error }) : "";
      return el("li", [el("span.dot" + (a[2] ? "." + a[2] : ""), icon(a[1], "sm")), el("div", [el("div.what", C.text(C.t(a[0]) + extra + (showOrg && e.name ? " · " + e.name : ""))), el("div.when", { title: C.fullDate(e.at) }, C.t("by {who} · {when}", { who: who, when: C.when(e.at) }))])]);
    }));
  }
  function tabActivity(t, pane) {
    var box = el("div.card.card-pad", loading());
    pane.appendChild(box);
    call("/v1/console/activity").then(function (d) { C.clear(box).appendChild(timeline(d.entries.filter(function (e) { return e.siteKey === t.siteKey; }), false)); })
      .catch(function (e) { C.clear(box).appendChild(failed(e)); });
  }
  function tabSettings(t, pane, locked) {
    var deleteBtn = el("button.btn.btn-danger#deleteBtn", { type: "button" }, [icon("trash", "sm"), "Delete organisation"]);
    deleteBtn.addEventListener("click", function () {
      var input = el("input.input#deleteConfirm", { autocomplete: "off" }); input.placeholder = t.name;
      C.modal({ title: C.t("Delete {name}?", { name: t.name }), text: "This removes the organisation, its keys and its settings, and erases every one of its users' passkeys and typing and mouse profiles. It can't be undone.",
        body: el("label.field", [el("span.label", C.t("Type {name} to confirm", { name: el("b", C.text(t.name)) })), input]),
        actions: [{ label: "Cancel" }, { label: "Delete for good", kind: "danger", id: "deleteGo", onClick: function (close) {
          if (input.value !== t.name) { C.toast("bad", "The name you typed doesn't match. Nothing was deleted."); return; }
          return call("/v1/console/tenants/" + t.siteKey + "/delete", { body: { confirm: input.value } })
            .then(function (r) { close(); orgs = null; C.toast("ok", r.users ? C.t("{name} was deleted, with its {users}.", { name: t.name, users: C.plural(r.users, "{n} user", "{n} users") }) : C.t("{name} was deleted.", { name: t.name })); location.hash = "#/organisations"; })
            .catch(function (e) { close(); orgs = null; C.toast("bad", C.explain(e)); renderOrg(t.siteKey, "settings"); });
        } }] });
    });
    var name = el("input.input#renameInput", { value: t.name, maxlength: 80, disabled: locked });
    var renameBtn = el("button.btn.btn-primary#renameSave", { type: "button" }, "Save");
    renameBtn.addEventListener("click", function () { save(t, { name: name.value.trim() }, renameBtn).then(function () { renderOrg(t.siteKey, "settings"); }, function () {}); });
    var revokeBtn = el("button.btn.btn-danger#revokeBtn", { type: "button", disabled: locked }, [icon("trash", "sm"), "Revoke organisation"]);
    revokeBtn.addEventListener("click", function () {
      var input = el("input.input#revokeConfirm", { autocomplete: "off" }); input.placeholder = t.name;
      C.modal({ title: C.t("Revoke {name}?", { name: t.name }), text: "Its site key stops working at once, for all its users. This can't be undone from the console.",
        body: el("label.field", [el("span.label", C.t("Type {name} to confirm", { name: el("b", C.text(t.name)) })), input]),
        actions: [{ label: "Cancel" }, { label: "Revoke", kind: "danger", id: "revokeGo", onClick: function (close) {
          if (input.value !== t.name) { C.toast("bad", C.msg("confirm_name_mismatch")); return; }
          return call("/v1/console/tenants/" + t.siteKey + "/revoke", { body: { confirm: input.value } })
            .then(function () { close(); orgs = null; C.toast("ok", C.t("{name} was revoked.", { name: t.name })); renderOrg(t.siteKey, "overview"); })
            .catch(function (e) { C.toast("bad", C.explain(e)); });
        } }] });
    });
    append(pane, [
      el("div.card", [el("div.card-head", el("h3", "Name")), el("div.card-body", el("label.field", [el("span.label", "Organisation name"), name, el("p.hint", "Shown to your users when they sign in to the extension.")])), locked ? null : el("div.card-foot", renameBtn)]),
      t.serverManaged
        ? el("div.callout.info", { style: "margin-top:18px" }, [icon("info"), el("div", [el("strong", "Built into this server. "), "This organisation comes with the server, so it can't be revoked here. The operator can switch it off."])])
        : el("div.card.danger", { style: "margin-top:18px" }, [el("div.card-head", el("div", [el("h3", { style: "color:var(--bad)" }, "Danger zone"), el("p.muted.small", "Both switch this organisation off for good.")])),
          locked ? null : el("div.card-body.row.wrap", { style: "border-bottom:1px solid var(--bad-border)" }, [el("div", { style: "flex:1;min-width:220px" }, [el("b", "Revoke this organisation"), el("div.muted.small", "Its site key and secret stop working immediately. It stays in your list, with its history.")]), revokeBtn]),
          el("div.card-body.row.wrap", [el("div", { style: "flex:1;min-width:220px" }, [el("b", "Delete this organisation"), el("div.muted.small", "Removes it and erases its users' passkeys and typing and mouse profiles. Can't be undone.")]), deleteBtn])]),
    ]);
  }

  // ================= activity, quickstart =================
  function renderActivity() {
    setNav("activity");
    var box = el("div.card.card-pad", loading());
    page([head("Activity", "What you did, and what was done to your organisations (approvals by the operator, for example)."), box]);
    call("/v1/console/activity").then(function (d) { C.clear(box).appendChild(timeline(d.entries, true)); }).catch(function (e) { C.clear(box).appendChild(failed(e)); });
  }
  function renderQuickstart(key) {
    setNav("quickstart");
    var body = el("div", loading());
    page([head("Connect your app", "Four steps to protect your users with Continuum."), body]);
    loadOrgs().then(function (list) {
      C.clear(body);
      if (!list.length) { body.appendChild(el("div.card", el("div.empty", [el("div.art", icon("code")), el("h3", "Register an organisation first"), el("p", "The steps below use its site key."), el("a.btn.btn-primary", { href: "#/organisations/new" }, [icon("plus"), "New organisation"])]))); return; }
      var t = list.filter(function (x) { return x.siteKey === key; })[0] || list[0];
      var pick = el("select.input", { "aria-label": "Organisation", style: "max-width:320px" }, list.map(function (x) { return el("option", { value: x.siteKey, selected: x.siteKey === t.siteKey }, C.text(x.name)); }));
      pick.addEventListener("change", function () { location.hash = "#/quickstart/" + pick.value; });
      var P = cfg.publicUrl;
      var step = function (n, title, text, kids) { return el("div.card", { style: "margin-top:18px" }, [el("div.card-head", [el("span.avatar", { style: "background:var(--accent-weak);color:var(--accent-text)" }, String(n)), el("div", [el("h3", title), el("p.muted.small", text)])]), el("div.card-body.stack", kids)]); };
      append(body, [el("div.row", [el("span.label", { style: "margin:0" }, "Organisation"), pick, el("span.spacer"), C.badge(t.status)]),
        step(1, "Add the script to your pages", "It watches typing and mouse rhythm and shows the passkey step-up when needed.", [
          C.codeBlock('<script src="' + P + '/guard.js"\n        data-site-key="' + t.siteKey + '"\n        data-api-base="' + P + '"\n        data-identity-url="/continuum/identity"></script>')]),
        step(2, "Add the middleware to your server", "One line serves your users' identity, the extension sign-in and the alerts; protect() guards sensitive routes.", [
          C.codeBlock("# .env on your server\nCONTINUUM_SECRET=<your secret>\nCONTINUUM_GATEWAY_URL=" + P + "\nCONTINUUM_JWKS_URI=" + P + "/.well-known/jwks.json"),
          C.codeBlock('const continuum = require("@continuum/node")({ secret: process.env.CONTINUUM_SECRET });\napp.use(continuum);   // /continuum/identity, /continuum/link, /continuum/events\n\n// block a sensitive action while the user looks suspicious\napp.post("/transfer", continuum.protect, handler);')]),
        step(3, "Let your users use the browser extension", "Optional: protection on every website, with the same enrolled profile.", [
          el("p", C.t("Set the sign-in page to {url} on the {tab}.", { url: el("span.mono", (nonExt(t.origins)[0] || "https://your-app") + "/continuum/link"), tab: el("a", { href: "#/organisations/" + t.siteKey + "/extension" }, "Extension tab") }))]),
        step(4, "Verify verdicts anywhere", "Every verdict is a signed token; any language can check it with the public keys.", [
          el("div.kv", [el("div.k", "JWKS"), el("div.v", C.copyField(P + "/.well-known/jwks.json")), el("div.k", "Discovery"), el("div.v", C.copyField(P + "/.well-known/continuum-configuration"))])]),
      ]);
    }).catch(function (e) { C.clear(body).appendChild(failed(e)); });
  }

  // ================= router =================
  var shellBuilt = false;
  function route() {
    if (!token) { shellBuilt = false; renderAuth(); return; }
    if (!shellBuilt) { renderShell(); shellBuilt = true; }
    var parts = location.hash.replace(/^#\/?/, "").split("/");
    if (parts[0] === "organisations" && parts[1] === "new") return renderWizard();
    if (parts[0] === "organisations" && parts[1]) return renderOrg(parts[1], parts[2]);
    if (parts[0] === "activity") return renderActivity();
    if (parts[0] === "quickstart") return renderQuickstart(parts[1]);
    if (location.hash !== "#/organisations") { history.replaceState(null, "", "#/organisations"); }
    renderList();
  }
  window.addEventListener("hashchange", route);
  C.onLang(function () { shellBuilt = false; navLinks = {}; route(); });   // the language button: everything is redrawn
  C.api("/v1/console/config").then(function (c) { cfg = c; }).catch(function () {}).then(route);
})();
