// Continuum Operator — approve, revoke and watch every organisation, and set the server's defaults.
// Routes: #/organisations, #/activity, #/settings.
(function () {
  "use strict";
  var C = window.CUI, el = C.el, icon = C.icon, append = C.append;
  var root = document.getElementById("app");
  var key = null, cfg = { operatorKeyRequired: true };
  try { key = sessionStorage.getItem("continuumOperator"); } catch (e) {}
  var all = null, filter = "all", stats = {};

  function call(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers || {}, { "X-Admin-Key": key || "" });
    return C.api(path, opts).catch(function (e) {
      if (e.code === "invalid_admin_key" || e.code === "too_many_attempts") { key = null; try { sessionStorage.removeItem("continuumOperator"); } catch (x) {} route(); C.toast("bad", C.explain(e)); }
      throw e;
    });
  }

  // ---- sign-in with the admin key ----
  function renderSignIn() {
    var input = el("input.input.mono#opKey", { type: "password", autocomplete: "off", placeholder: cfg.operatorKeyRequired ? "Paste GATEWAY_ADMIN_KEY" : "No key needed on this server" });
    var msg = el("div.field-error#opMsg");
    var btn = el("button.btn.btn-primary.btn-lg.btn-block#opSignIn", { type: "submit" }, [icon("shield"), "Open operator view"]);
    var form = el("form", [el("label.field", [el("span.label", "Admin key"), input, el("p.hint", C.t("The line {line} in {file}.", { line: el("span.mono", "GATEWAY_ADMIN_KEY="), file: el("span.mono", "continuum/.env") }))]), el("div", { style: "margin-top:18px" }, btn), msg]);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault(); msg.textContent = ""; btn.disabled = true;
      var k = input.value.trim();
      C.api("/v1/tenants", { headers: { "X-Admin-Key": k } }).then(function (d) {
        key = k; try { sessionStorage.setItem("continuumOperator", k); } catch (e) {}
        all = d.tenants; route();
      }).catch(function (e) {
        // 2026-11-25: during the pause every try is refused, so the button waits it out
        btn.disabled = e.code === "too_many_attempts";
        if (btn.disabled) setTimeout(function () { btn.disabled = false; }, (e.data.retryAfterSec || 900) * 1000);
        if (e.code === "too_many_attempts") msg.textContent = C.plural(Math.ceil((e.data.retryAfterSec || 900) / 60), "Too many wrong keys. Operator sign-in is paused for about {n} minute.", "Too many wrong keys. Operator sign-in is paused for about {n} minutes.");
        else if (e.code === "invalid_admin_key") msg.textContent = C.t("That key is not right.") + (e.data && e.data.attemptsLeft != null ? " " + C.plural(e.data.attemptsLeft, "{n} try left before a 15-minute pause.", "{n} tries left before a 15-minute pause.") : "");
        else msg.textContent = C.explain(e);
      });
    });
    C.clear(root).appendChild(el("div.center", el("div.solo", [
      el("div.solo-head", { style: "justify-content:space-between" }, [C.brand("Operator"), C.langButton()]),
      el("div.card", el("div.card-body", { style: "padding:28px" }, [
        el("div.big-icon.info", icon("shield")),
        el("h1", "Operator sign-in"),
        el("p.lead", "For the person who runs this Continuum server: approve new organisations, revoke any of them, and see all activity."),
        el("div", { style: "margin-top:22px" }, form),
      ])),
      el("p.foot-note", "This page opens only on the server's own machine. Organisations use the Console."),
    ])));
    input.focus();
  }

  // ---- shell ----
  var main = null, nav = {}, pendingCount = null;
  function renderShell() {
    var item = function (k, href, ic, label) { var a = el("a.nav-item", { href: href }, [icon(ic), label]); nav[k] = a; return a; };
    pendingCount = el("span.count.hidden", "0");
    var orgItem = item("organisations", "#/organisations", "building", "Organisations"); orgItem.appendChild(pendingCount);
    var side = el("aside.sidebar", [C.brand("Operator"), el("nav.nav", [el("div.nav-label", "Manage"), orgItem, item("activity", "#/activity", "history", "Activity"), item("settings", "#/settings", "sliders", "Settings")]),
      el("div.sidebar-foot", [el("div.lang-row", C.langButton()), el("div.account", [el("div.avatar", { style: "background:#0f1222" }, icon("shield", "sm")), el("div.who", [el("b", "Operator"), el("span", { dir: "ltr" }, C.text(location.host))]), el("span.spacer"),
        el("button.btn.btn-ghost.btn-icon#opSignOut", { type: "button", title: "Sign out", "aria-label": "Sign out", onclick: function () { key = null; try { sessionStorage.removeItem("continuumOperator"); } catch (e) {} route(); } }, icon("logout"))])])]);
    main = el("main.main");
    C.clear(root).appendChild(el("div.shell", [side, el("div", [el("div.mobilebar", [el("button.btn.btn-ghost.btn-icon", { type: "button", "aria-label": "Menu", onclick: function () { side.classList.toggle("open"); } }, icon("menu")), C.brand("Operator")]), main])]));
  }
  function setNav(k) { Object.keys(nav).forEach(function (x) { nav[x].classList.toggle("active", x === k); }); }
  function page(kids) { C.clear(main); main.appendChild(el("div.page", kids)); }
  function updatePending() {
    var n = (all || []).filter(function (t) { return t.status === "pending"; }).length;
    pendingCount.textContent = String(n); pendingCount.classList.toggle("hidden", !n);
  }

  // ---- all organisations ----
  function renderOrgs() {
    setNav("organisations");
    var tbody = el("tbody"), search = el("input.input", { type: "search", placeholder: "Search name, owner or site key", "aria-label": "Search" });
    var seg = el("div.seg");
    var FILTERS = [["all", "All"], ["pending", "Waiting"], ["active", "Active"], ["revoked", "Revoked"]];
    var drawSeg = function () { C.clear(seg); FILTERS.forEach(function (f) { seg.appendChild(el("button" + (filter === f[0] ? ".on" : ""), { type: "button", id: "filter-" + f[0], onclick: function () { filter = f[0]; drawSeg(); draw(); } }, f[1])); }); };
    var refresh = el("button.btn.btn-secondary", { type: "button", onclick: function () { load(); } }, [icon("refresh", "sm"), "Refresh"]);
    page([el("div.page-head", [el("div", [el("h1", "All organisations"), el("p.sub", "Approve new sign-ups, revoke any organisation, and see how many people each one protects.")]), el("span.spacer"), refresh]),
      el("div.row.wrap", { style: "margin-bottom:14px" }, [seg, el("div", { style: "flex:1;min-width:220px;max-width:360px;margin-inline-start:auto" }, search)]),
      el("div.card", el("div.table-wrap", el("table.table", [el("thead", el("tr", [el("th", "Organisation"), el("th.hide-sm", "Owner"), el("th", "Status"), el("th.hide-sm", "Users"), el("th.hide-sm", "Created"), el("th", { style: "text-align:end" }, "Actions")])), tbody])))]);
    drawSeg();
    function draw() {
      var q = search.value.trim().toLowerCase();
      C.clear(tbody);
      var list = (all || []).filter(function (t) { return (filter === "all" || t.status === filter) && (!q || (t.name + " " + t.siteKey + " " + (t.owner || "")).toLowerCase().indexOf(q) >= 0); });
      if (!list.length) { tbody.appendChild(el("tr", el("td", { colspan: 6, class: "muted", style: "text-align:center;padding:28px" }, "No organisations here."))); return; }
      list.forEach(function (t) {
        var acts = el("div.row", { style: "justify-content:flex-end" });
        if (!t.builtIn && t.status === "pending") acts.appendChild(el("button.btn.btn-primary.btn-sm", { type: "button", "data-act": "approve", onclick: function (e) { e.stopPropagation(); setStatus(t, "active", e.currentTarget); } }, [icon("check", "sm"), "Approve"]));
        if (!t.builtIn && t.status === "revoked") acts.appendChild(el("button.btn.btn-secondary.btn-sm", { type: "button", "data-act": "reactivate", onclick: function (e) { e.stopPropagation(); setStatus(t, "active", e.currentTarget); } }, "Re-activate"));
        if (!t.builtIn && t.status !== "revoked") acts.appendChild(el("button.btn.btn-danger-outline.btn-sm", { type: "button", "data-act": "revoke", onclick: function (e) { e.stopPropagation(); confirmRevoke(t); } }, "Revoke"));
        if (t.builtIn) acts.appendChild(el("span.muted.small", "Built in"));
        var users = el("span.muted", stats[t.siteKey] ? String(stats[t.siteKey].users) : "…");
        tbody.appendChild(el("tr.click", { "data-key": t.siteKey, onclick: function () { details(t); } }, [
          el("td", [el("div", { style: "font-weight:600" }, C.text(t.name)), el("div.mono.muted", t.siteKey)]),
          el("td.hide-sm", t.owner ? C.text(t.owner) : el("span.muted", t.builtIn ? "built in" : "operator")),
          el("td", C.badge(t.status)), el("td.hide-sm", users),
          el("td.hide-sm.muted.nowrap", { title: C.fullDate(t.createdAt) }, C.when(t.createdAt)), el("td.nowrap", acts)]));
        if (!stats[t.siteKey]) call("/v1/admin/tenants/" + t.siteKey + "/stats").then(function (s) { stats[t.siteKey] = s; users.textContent = String(s.users); }).catch(function () { users.textContent = "—"; });
      });
    }
    search.addEventListener("input", draw);
    function load() { call("/v1/tenants").then(function (d) { all = d.tenants; updatePending(); draw(); }).catch(function () {}); }
    if (all) { updatePending(); draw(); } else load();
  }
  function setStatus(t, status, btn) {
    if (btn) btn.disabled = true;
    return call("/v1/tenants/" + t.siteKey + "/status", { body: { status: status } }).then(function (r) {
      C.toast("ok", C.t(status === "active" ? "{name} is active." : "{name} was revoked.", { name: t.name }));
      all = all.map(function (x) { return x.siteKey === t.siteKey ? r : x; });
      updatePending(); renderOrgs();
    }).catch(function (e) { if (btn) btn.disabled = false; C.toast("bad", C.explain(e)); });
  }
  function confirmRevoke(t) {
    C.modal({ title: C.t("Revoke {name}?", { name: t.name }), text: "Its site key stops working at once, for all its users. You can re-activate it later from this page.",
      actions: [{ label: "Cancel" }, { label: "Revoke", kind: "danger", id: "opRevokeGo", onClick: function (close) { close(); return setStatus(t, "revoked"); } }] });
  }
  function details(t) {
    var s = stats[t.siteKey], sites = (t.origins || []).filter(function (o) { return o.indexOf("chrome-extension://") !== 0; });
    C.modal({ title: C.text(t.name), text: el("span.mono", t.siteKey), body: el("div.kv", [
      el("div.k", "Status"), el("div.v", C.badge(t.status)),
      el("div.k", "Owner"), el("div.v", t.owner ? C.text(t.owner) : (t.builtIn ? "built in" : "operator")),
      el("div.k", "Websites"), el("div.v", sites.length ? sites.join(", ") : el("span.muted", "None")),
      el("div.k", "Extension"), el("div.v", t.allowExtension ? ["Allowed", t.signInUrl ? el("div.mono.muted.small", t.signInUrl) : null] : el("span.muted", "Off")),
      el("div.k", "Alerts"), el("div.v", t.webhookUrl ? el("span.mono", t.webhookUrl) : el("span.muted", "Off")),
      el("div.k", "People"), el("div.v", s ? C.t("{users} users · {passkey} with a passkey · {typing} typing · {mouse} mouse", s) : "…"),
      el("div.k", "Created"), el("div.v", C.fullDate(t.createdAt)),
    ]) });
  }

  // ---- activity ----
  var ACT = {
    "organisation.created": ["Organisation created", "plus", ""], "organisation.updated": ["Settings changed", "sliders", ""],
    "organisation.approved": ["Approved", "check", "ok"], "organisation.reactivated": ["Re-activated", "check", "ok"], "organisation.revoked": ["Revoked", "lock", "bad"],
    "secret.rotated": ["New secret made", "key", "warn"], "webhook.tested": ["Test alert sent", "send", ""], "account.created": ["Account created", "user", "ok"],
    "account.deleted": ["Account deleted", "trash", "bad"], "operator.locked_out": ["Operator sign-in paused after wrong keys", "lock", "bad"],
    "organisation.owner_set": ["Owner set", "user", "ok"], "organisation.owner_cleared": ["Owner removed", "user", ""],
    "organisation.deleted": ["Organisation deleted", "trash", "bad"],
    "organisation.settings_changed": ["Protection settings changed", "shieldCheck", ""], "settings.changed": ["Server settings changed", "sliders", ""],
    "webhook.undeliverable": ["An alert could not be delivered", "send", "bad"],
  };
  function renderActivity() {
    setNav("activity");
    var box = el("div.card.card-pad", [el("span.spinner"), " Loading…"]);
    page([el("div.page-head", el("div", [el("h1", "Activity"), el("p.sub", "Every change on this server: sign-ups, approvals, revocations, new secrets, and paused operator sign-ins.")])), box]);
    call("/v1/admin/activity").then(function (d) {
      C.clear(box);
      if (!d.entries.length) { box.appendChild(el("div.empty", [el("div.art", icon("history")), el("h3", "Nothing yet")])); return; }
      box.appendChild(el("ul.timeline", d.entries.map(function (e) {
        var a = ACT[e.action] || [e.action, "info", ""];
        var who = e.actor && e.actor.type === "operator" ? C.t("operator") : e.actor && e.actor.type === "system" ? "Continuum" : (e.actor && e.actor.email) || C.t("someone");
        var extra = e.detail && e.detail.email ? " (" + e.detail.email + ")" : e.detail && e.detail.changed ? " (" + e.detail.changed.join(", ") + ")"
          : e.detail && e.action === "webhook.undeliverable" ? C.t(" — gave up after {n} tries ({error})", { n: e.detail.attempts, error: e.detail.error }) : "";
        return el("li", [el("span.dot" + (a[2] ? "." + a[2] : ""), icon(a[1], "sm")), el("div", [el("div.what", C.text(C.t(a[0]) + extra + (e.name ? " · " + e.name : ""))), el("div.when", { title: C.fullDate(e.at) }, C.t("by {who} · {when}", { who: who, when: C.when(e.at) }))])]);
      })));
    }).catch(function (e) { C.clear(box).appendChild(el("div.callout.bad", [icon("alert"), el("div", C.explain(e))])); });
  }

  // ---- settings: defaults for every organisation, server switches, the environment ----
  var SWITCH_TEXT = {
    autoApproveTenants: ["Approve new organisations automatically", "Off: every organisation that signs up in the console waits for your approval. Turn it on only for a closed deployment."],
    allowPrivateWebhooks: ["Allow private webhook addresses", "Lets organisations send alerts to localhost, private IPs or internal names. The gateway calls them itself, so keep it off outside local testing."],
    studyLogging: ["Research study logging", "Keeps the study participants' pseudonymous scores for the user study. Off outside a study."],
  };
  function switchCard(title, sub, items, saveKey, id) {
    var rows = items.map(function (it) {
      var cb = el("input", { type: "checkbox", checked: !!it.value, id: "set-" + it.key });
      var cleared = false, badge = el("span.badge.badge-neutral.small"), reset = el("a.small", { href: "#", style: "margin-inline-start:8px" }, "Use the default");
      function sync() {
        var changed = !cleared && cb.checked !== !!it.value;
        badge.textContent = cleared ? C.t("Default: {v} (after saving)", { v: C.tr((it.envValue != null ? it.envValue : it.builtIn) ? "on" : "off") }) : changed ? C.tr("Changed (not saved)") : C.tr(C.SOURCE_TEXT[it.source] || it.source);
        reset.style.display = it.source === "operator" && !cleared ? "" : "none";
      }
      cb.addEventListener("change", function () { cleared = false; sync(); });
      reset.addEventListener("click", function (e) { e.preventDefault(); cleared = true; sync(); });
      sync();
      var txt = SWITCH_TEXT[it.key] || [it.key, ""];
      return { key: it.key, collect: function () { return cleared ? null : (cb.checked !== !!it.value ? cb.checked : undefined); },
        node: el("div.setting-row", [el("div.setting-text", [el("b", txt[0]), el("p.muted.small", txt[1]), el("div", [badge, reset])]), el("div.setting-ctl", el("label.switch", [cb, el("span")]))]) };
    });
    var btn = el("button.btn.btn-primary#" + id, { type: "button" }, "Save");
    btn.addEventListener("click", function () {
      var changes = {};
      rows.forEach(function (r) { var v = r.collect(); if (v !== undefined) changes[r.key] = v; });
      if (!Object.keys(changes).length) { C.toast("info", "Nothing changed."); return; }
      var body = {}; body[saveKey] = changes;
      saveSettings(body, btn);
    });
    return el("div.card", { style: "margin-top:18px" }, [el("div.card-head", el("div", [el("h3", title), el("p.muted.small", sub)])),
      el("div.card-body.settings-list", rows.map(function (r) { return r.node; })), el("div.card-foot", btn)]);
  }
  var settingsBox = null;
  function saveSettings(body, btn) {
    btn.disabled = true;
    return call("/v1/admin/settings", { method: "PUT", body: body })
      .then(function (d) { C.toast("ok", d.changed && d.changed.length ? C.plural(d.changed.length, "Saved: {n} change.", "Saved: {n} changes.") : "Saved."); drawSettings(d); })
      .catch(function (e) { C.toast("bad", C.explain(e)); btn.disabled = false; });
  }
  function renderSettings() {
    setNav("settings");
    settingsBox = el("div", el("div.card.card-pad", [el("span.spinner"), " Loading…"]));
    page([el("div.page-head", el("div", [el("h1", "Settings"), el("p.sub", "Defaults for every organisation, this server's switches, and its whole environment. Each organisation can still choose its own protection settings in its console.")])), settingsBox]);
    call("/v1/admin/settings").then(drawSettings).catch(function (e) { C.clear(settingsBox).appendChild(el("div.callout.bad", [icon("alert"), el("div", C.explain(e))])); });
  }
  function drawSettings(d) {
    if (!settingsBox) return;
    var form = C.settingsForm(d.defaults, { level: "operator" });
    var btn = el("button.btn.btn-primary#opDefaultsSave", { type: "button" }, "Save defaults");
    btn.addEventListener("click", function () {
      var changes = form.collect();
      if (!Object.keys(changes).length) { C.toast("info", "Nothing changed."); return; }
      saveSettings({ defaults: changes }, btn);
    });
    var env = el("table.table", [el("thead", el("tr", [el("th", "Service"), el("th", "Variable"), el("th", "Value"), el("th.hide-sm", "Change it")])),
      el("tbody", d.environment.map(function (e) {
        var val = e.secret ? el("span.badge." + (e.set ? "badge-active" : "badge-neutral"), e.set ? "set (hidden)" : "not set") : e.set ? el("span.mono", e.value) : el("span.muted", "—");
        return el("tr", [el("td.muted", e.service), el("td.mono", e.name), el("td", val), el("td.hide-sm.muted.small", e.setting ? "on this page" : "in .env, then restart")]);
      }))]);
    C.clear(settingsBox);
    append(settingsBox, [
      el("div.card", [el("div.card-head", el("div", [el("h3", "Defaults for every organisation"), el("p.muted.small", "What every organisation gets until it chooses otherwise in its console (Protection tab), and what the personal accounts and the extension's study use.")])),
        el("div.card-body", form.node), el("div.card-foot", btn)]),
      switchCard("Organisations", "How organisations join this server and where they may send alerts.", d.server, "server", "opServerSave"),
      d.study ? switchCard("Research study", "The user study's data collection, on the scoring service.", [Object.assign({ key: "studyLogging" }, d.study.studyLogging)], "study", "opStudySave")
        : el("div.callout.warn", { style: "margin-top:18px" }, [icon("alert"), el("div", "The scoring service did not answer, so its settings are not shown.")]),
      el("div.card", { style: "margin-top:18px" }, [el("div.card-head", el("div", [el("h3", "Environment"), el("p.muted.small", "Everything this server was started with. Secrets show only whether they are set. Where a setting above exists, it overrides the value here.")])),
        el("div", { style: "overflow-x:auto" }, env)]),
    ]);
  }

  var built = false;
  function route() {
    if (cfg.operatorKeyRequired && !key) { built = false; renderSignIn(); return; }
    if (!built) { renderShell(); built = true; }
    if (location.hash.indexOf("#/activity") === 0) return renderActivity();
    if (location.hash.indexOf("#/settings") === 0) return renderSettings();
    renderOrgs();
  }
  window.addEventListener("hashchange", route);
  C.onLang(function () { built = false; nav = {}; route(); });   // the language button: everything is redrawn
  C.api("/v1/console/config").then(function (c) { cfg = c; if (!c.operatorKeyRequired) key = key || ""; }).catch(function () {}).then(route);
})();
