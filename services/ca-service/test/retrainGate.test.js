// The same-recipe regression gate of a typing retrain (lib/keystrokeSecurity.js, trainUserTypingProfile), with a stub
// model service and a throwaway SQLite database, synthetic typing only. A retrain holds its newest training sample out
// of the new fit (2026-11-08: the gate read activity samples, which nothing writes any more, so it never ran), and
// both models score it. A new fit that scores it clearly lower than the model in use is rolled back, unless the
// retrain changes the recipe: the first retrain on a new base (2026-10-25, ws50-gru to ws50-gru-v2) is kept, and the
// profile records its base, so the next retrain on that base is gated again. Also: a fit from scratch, a new fit that
// cannot score, and a reset during the training are never saved. node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ca-gate-"));
process.env.DB_PATH = path.join(DIR, "test.db");
process.env.STORAGE = "sqlite";
const db = require("../db");
let ks;

// What the stubbed model service is told to do on the next calls.
const stubOpts = { newScore: 0.6, scratch: false, failNew: false, failPrev: false, resetDuringTrain: null, resetDuringPredict: null };
const calls = { train: 0, rollback: [], trainBodies: [], predict: [] };
const SCORE = { prev: 0.95 };   // a model scores each window at SCORE[its path]; a new fit at stubOpts.newScore when not listed
// What POST /v1/keystroke/reset does (server.js): the samples first, then the profile.
async function reset(userId) {
  await db.run("UPDATE keystroke_texts SET is_training = 0 WHERE user_id = ?", userId);
  await db.run("DELETE FROM user_typing_profiles WHERE user_id = ?", userId);
}
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; }).on("end", async () => {
    res.setHeader("content-type", "application/json");
    const b = body ? JSON.parse(body) : {};
    if (req.url === "/api/user/train") {
      calls.train += 1;
      calls.trainBodies.push(b);
      if (stubOpts.resetDuringTrain === b.userId) await reset(b.userId);
      return res.end(JSON.stringify({ ok: true, modelPath: `new-${calls.train}`, versioned: true, negativeSource: "dataset",
        trainedFrom: stubOpts.scratch ? "scratch" : "base-model-fine-tune", baseModel: stubOpts.scratch ? null : "ws50-gru-v2",
        positiveWindowCount: b.positiveWindows.length, negativeWindowCount: 60,
        threshold: 0.5, accuracy: 0.9, balancedAccuracy: 0.9, validationGenuineScores: [] }));
    }
    if (req.url === "/api/user/predict") {
      calls.predict.push({ modelPath: b.modelPath, windows: b.windows.length });
      const isNew = String(b.modelPath).startsWith("new-");
      if ((isNew && stubOpts.failNew) || (!isNew && stubOpts.failPrev)) { res.statusCode = 500; return res.end(JSON.stringify({ error: "model file missing" })); }
      if (!isNew && stubOpts.resetDuringPredict === b.userId) await reset(b.userId);
      const p = SCORE[b.modelPath] ?? (isNew ? stubOpts.newScore : 0.6);
      return res.end(JSON.stringify({ model_loaded: true, prediction: b.windows.map(() => [1 - p, p]) }));
    }
    if (req.url === "/api/user/rollback") {
      calls.rollback.push(b.modelPath);
      return res.end("{}");
    }
    res.statusCode = 404;
    res.end("{}");
  });
});

// ---- plain typing, as in contribute.test.js: `keys` keystrokes make keys - 1 steps (100 keys give 5 windows, 250 give 20)
function typing(keys, seed) {
  let t = 0, s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const events = [];
  for (let i = 0; i < keys; i++) {
    const keyCode = 65 + Math.floor(rnd() * 26), dwell = 70 + rnd() * 60;
    events.push({ keyCode, eventType: "keydown", timestampRelative: Math.round(t), fieldName: "f1", fieldType: "textarea" });
    events.push({ keyCode, eventType: "keyup", timestampRelative: Math.round(t + dwell), fieldName: "f1", fieldType: "textarea" });
    t += dwell + 60 + rnd() * 140;
  }
  return events;
}

async function addSample(userId, keys, seed, purpose) {
  const r = await db.get(
    `INSERT INTO keystroke_texts (user_id, char_count, is_suspicious, sample_purpose, is_training) VALUES (?, ?, 0, ?, 1) RETURNING id`,
    userId, keys, purpose);
  for (const e of typing(keys, seed)) {
    await db.run(
      `INSERT INTO keystroke_events (keystroke_text_id, key_code, event_type, timestamp_relative, field_name, field_type)
       VALUES (?, ?, ?, ?, ?, ?)`, r.id, e.keyCode, e.eventType, e.timestampRelative, e.fieldName, e.fieldType);
  }
  return r.id;
}

// Five enrolment samples (25 windows) and, stored last, one popup sample (20 windows, the one held out). With a
// profile (`extra` set): a served profile on the Aalto negatives whose model is "prev".
async function userWithSamples(userId, extra) {
  let newest = null;
  await db.tx(async () => {   // one commit, not one per key event
    for (let i = 0; i < 5; i++) await addSample(userId, 100, userId + i, "enrollment");
    newest = await addSample(userId, 250, userId + 50, "adaptive");
  });
  if (extra) {
    await db.run("INSERT INTO user_typing_profiles (user_id, model_json, sample_count) VALUES (?, ?, 5)", userId,
      JSON.stringify({ version: 3, type: "per-user-cnn-lstm", modelPath: "prev", threshold: 0.5, negatives: ks.NEGATIVES_SOURCE, ...extra }));
  }
  return newest;
}
const onV2 = { baseModel: "ws50-gru-v2" };
const lastTrain = () => calls.trainBodies[calls.trainBodies.length - 1];
const predictsSince = (n) => calls.predict.slice(n);
const profileOf = (userId) => ks.getUserTypingProfile(userId, db);

let newest3002 = null;
test.before(async () => {
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  process.env.MODEL_API_URL = `http://127.0.0.1:${stub.address().port}`;
  ks = require("../lib/keystrokeSecurity");
  await db.open();
  await userWithSamples(3001, {});              // trained before bases were recorded
  newest3002 = await userWithSamples(3002, onV2);   // already on the new base
  for (const u of [3003, 3004, 3005, 3006, 3007, 3008]) await userWithSamples(u, onV2);
  await userWithSamples(3009, null);            // enrolled, never trained
});

test.after(async () => {
  await db.close();
  stub.close();
  fs.rmSync(DIR, { recursive: true, force: true });
});

test("the first retrain on a new base is kept although it scores lower, and the profile records the base", async () => {
  const p = await ks.trainUserTypingProfile(3001, db);
  assert.equal(p.modelPath, "new-1");
  assert.equal(p.baseModel, "ws50-gru-v2");
  assert.deepEqual(calls.rollback, []);
  assert.equal((await profileOf(3001)).baseModel, "ws50-gru-v2");
});

test("a retrain on the same base that scores clearly lower is rolled back, and the model in use stays", async () => {
  const before = calls.predict.length;
  const p = await ks.trainUserTypingProfile(3002, db);
  assert.equal(p.modelPath, "prev");
  assert.deepEqual(calls.rollback, ["new-2"]);
  assert.equal((await profileOf(3002)).modelPath, "prev");
  // the newest sample was held out of the fit, and both models scored its 20 windows
  assert.equal(lastTrain().positiveWindows.length, 25);
  assert.equal(lastTrain().positiveGroups.includes(newest3002), false);
  assert.deepEqual(predictsSince(before), [{ modelPath: "new-2", windows: 20 }, { modelPath: "prev", windows: 20 }]);
});

test("the next retrain of the migrated profile is gated again", async () => {
  SCORE["new-1"] = 0.95;   // the model it now serves scores high, the new fit (new-3) 0.60
  const p = await ks.trainUserTypingProfile(3001, db);
  assert.equal(p.modelPath, "new-1");
  assert.deepEqual(calls.rollback, ["new-2", "new-3"]);
});

test("a retrain that scores as well is accepted; it was fitted without the held-out sample, and says so", async () => {
  stubOpts.newScore = 0.96;
  try {
    const p = await ks.trainUserTypingProfile(3003, db);
    assert.equal(p.modelPath, "new-4");
    assert.equal(p.sampleCount, 5);
    assert.equal((await profileOf(3003)).modelPath, "new-4");
    assert.deepEqual(calls.rollback, ["new-2", "new-3"]);
  } finally { stubOpts.newScore = 0.6; }
});

test("a model trained from scratch is a failed training: it is discarded and the model in use stays", async () => {
  stubOpts.scratch = true;
  try {
    await assert.rejects(ks.trainUserTypingProfile(3004, db), /base model/);
    assert.equal(calls.rollback.at(-1), "new-5");
    assert.equal((await profileOf(3004)).modelPath, "prev");
  } finally { stubOpts.scratch = false; }
});

test("a new fit that cannot score the held-out sample is a failed training, never served unchecked", async () => {
  stubOpts.failNew = true;
  try {
    await assert.rejects(ks.trainUserTypingProfile(3005, db), /scored 0 of 20 held-out windows/);
    assert.equal(calls.rollback.at(-1), "new-6");
    assert.equal((await profileOf(3005)).modelPath, "prev");
  } finally { stubOpts.failNew = false; }
});

test("a model in use that cannot score (its files gone) leaves the new fit, which can", async () => {
  stubOpts.failPrev = true;
  try {
    const p = await ks.trainUserTypingProfile(3006, db);
    assert.equal(p.modelPath, "new-7");
    assert.equal((await profileOf(3006)).modelPath, "new-7");
    assert.notEqual(calls.rollback.at(-1), "new-7");
  } finally { stubOpts.failPrev = false; }
});

test("a reset during the training: nothing is saved, the new model is discarded, the profile stays deleted", async () => {
  stubOpts.resetDuringTrain = 3007;
  try {
    assert.equal(await ks.trainUserTypingProfile(3007, db), null);
    assert.equal(calls.rollback.at(-1), "new-8");
    assert.equal(await profileOf(3007), null);
  } finally { stubOpts.resetDuringTrain = null; }
});

test("a reset after the fit, while it is checked and saved: the saved profile is removed again", async () => {
  stubOpts.resetDuringPredict = 3008;   // lands after the first check, before the save
  stubOpts.newScore = 0.96;             // the gate accepts, so the profile is saved
  try {
    assert.equal(await ks.trainUserTypingProfile(3008, db), null);
    assert.equal(calls.rollback.at(-1), "new-9");
    assert.equal(await profileOf(3008), null);
  } finally { stubOpts.resetDuringPredict = null; stubOpts.newScore = 0.6; }
});

test("the first training (enrolment) uses every sample and has nothing to gate against", async () => {
  const before = calls.predict.length;
  const p = await ks.trainUserTypingProfile(3009, db);
  assert.equal(p.modelPath, "new-10");
  assert.equal(p.sampleCount, 6);
  assert.equal(lastTrain().positiveWindows.length, 45);
  assert.deepEqual(predictsSince(before), []);
});
