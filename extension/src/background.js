// background.js — MV3 service worker. Aggregates the feature windows arriving from every
// tab, holds the on/off + per-site exclusion config (persisted), and serves the popup.
// P0: it counts windows and tracks activity. On-device SCORING (load the user's model,
// run the packet vote + probation) plugs in here at P2 — the windows already arrive in
// the exact server format, so nothing about capture changes.
var api = globalThis.browser || globalThis.chrome;

var config = { enabled: true, exclusions: [] };
var state = { totalWindows: 0, lastWindowAt: 0 };

api.storage.local.get(["cg_enabled", "cg_exclusions"], function (d) {
  d = d || {};
  config.enabled = d.cg_enabled !== false;
  config.exclusions = d.cg_exclusions || [];
});

function broadcastConfig() {
  if (!api.tabs) return;
  api.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (t) {
      try { api.tabs.sendMessage(t.id, { type: "cg:config", enabled: config.enabled, exclusions: config.exclusions }); } catch (e) {}
    });
  });
}

api.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg) return;
  switch (msg.type) {
    case "cg:hello":
      reply({ enabled: config.enabled, excluded: config.exclusions.indexOf(msg.origin) >= 0 });
      return true;
    case "cg:windows":
      if (config.enabled) { state.totalWindows += 1; state.lastWindowAt = Date.now(); }
      return;
    case "cg:status":
      reply({ enabled: config.enabled, totalWindows: state.totalWindows, lastWindowAt: state.lastWindowAt, exclusions: config.exclusions });
      return true;
    case "cg:setEnabled":
      config.enabled = !!msg.value;
      api.storage.local.set({ cg_enabled: config.enabled });
      broadcastConfig();
      reply({ ok: true });
      return true;
    case "cg:toggleExclude": {
      var i = config.exclusions.indexOf(msg.origin);
      if (i >= 0) config.exclusions.splice(i, 1);
      else if (msg.origin) config.exclusions.push(msg.origin);
      api.storage.local.set({ cg_exclusions: config.exclusions });
      broadcastConfig();
      reply({ exclusions: config.exclusions });
      return true;
    }
  }
});
