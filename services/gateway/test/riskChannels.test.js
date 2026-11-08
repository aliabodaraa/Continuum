// The per-channel risk state (riskChannels.js, server.js settleChannel; 2026-11-08): the user is suspicious while any
// channel is, a warm-up leaves a channel as it was, and storage reads a channel's state back. node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { combine } = require("../riskChannels");
const { openStorage } = require("../storage");
const { BASE, freshDatabase, emptyTables } = require("./pg");

test("a genuine mouse verdict does not clear a suspicious typing verdict", () => {
  const r = combine("mouse", "genuine", { keystroke: "suspicious" });
  assert.equal(r.user, "suspicious");
  assert.equal(r.token, "suspicious");
});

test("the user is genuine once no channel is suspicious", () => {
  assert.deepEqual(combine("keystroke", "genuine", { mouse: "genuine" }), { user: "genuine", token: "genuine" });
  assert.deepEqual(combine("keystroke", "genuine", { keystroke: "suspicious", mouse: "genuine" }), { user: "genuine", token: "genuine" });
});

test("a suspicious verdict on either channel makes the token suspicious", () => {
  assert.deepEqual(combine("keystroke", "suspicious", { mouse: "genuine" }), { user: "suspicious", token: "suspicious" });
});

test("a warm-up keeps the channel's state and is signed as warm-up unless another channel is suspicious", () => {
  assert.deepEqual(combine("keystroke", "warmup", { keystroke: "genuine" }), { user: "genuine", token: "warmup" });
  assert.deepEqual(combine("keystroke", "warmup", {}), { user: undefined, token: "warmup" });
  assert.deepEqual(combine("keystroke", "warmup", { keystroke: "suspicious" }), { user: "suspicious", token: "suspicious" });
});

let PG = "";
test.before(async () => { if (BASE) PG = await freshDatabase("riskchannels"); });
const backends = [{ name: "json", open: () => openStorage({ kind: "json", dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "gw-risk-")), log: () => {} }) }];
if (BASE) backends.push({ name: "postgres", open: async () => { await emptyTables(PG); return openStorage({ kind: "postgres", databaseUrl: PG, log: () => {} }); } });

for (const b of backends) {
  test(`${b.name}: a channel's state is stored by riskTransition and read back by riskGet`, async () => {
    const s = await b.open();
    try {
      assert.equal(await s.riskGet("7|keystroke"), undefined);
      await s.riskTransition("7|keystroke", "suspicious", () => null);
      assert.equal(await s.riskGet("7|keystroke"), "suspicious");
      assert.equal(await s.riskGet("7|mouse"), undefined);
      await s.deleteRiskState("7|keystroke");
      assert.equal(await s.riskGet("7|keystroke"), undefined);
    } finally { await s.close(); }
  });
}
