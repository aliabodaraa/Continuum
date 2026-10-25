// The same-recipe regression gate of a typing retrain (lib/keystrokeSecurity.js, trainUserTypingProfile), with a stub
// model service and a throwaway SQLite database, synthetic typing only. A new fit that scores the user's held-out
// typing clearly lower than the model in use is rolled back, unless the retrain changes the recipe: the first retrain
// on a new base (2026-10-25, ws50-gru to ws50-gru-v2) is kept, and the profile records its base, so the next retrain
// on that base is gated again. node --test
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

// ---- the model service: a model scores each held-out window at SCORE[its path], 0.60 when not listed
const calls = { train: 0, rollback: [] };
const SCORE = { prev: 0.95 };
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; }).on("end", () => {
    res.setHeader("content-type", "application/json");
    const b = body ? JSON.parse(body) : {};
    if (req.url === "/api/user/train") {
      calls.train += 1;
      return res.end(JSON.stringify({ ok: true, modelPath: `new-${calls.train}`, versioned: true, negativeSource: "dataset",
        trainedFrom: "base-model-fine-tune", baseModel: "ws50-gru-v2", positiveWindowCount: 25, negativeWindowCount: 60,
        threshold: 0.5, accuracy: 0.9, balancedAccuracy: 0.9, validationGenuineScores: [] }));
    }
    if (req.url === "/api/user/predict") {
      const p = SCORE[b.modelPath] ?? 0.6;
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

// ---- plain typing, as in contribute.test.js: `keys` keystrokes make keys - 1 steps (100 keys give 5 windows, 150 give 10)
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

async function addSample(userId, keys, seed, training) {
  const r = await db.get(
    `INSERT INTO keystroke_texts (user_id, char_count, is_suspicious, sample_purpose, is_training) VALUES (?, ?, 0, ?, ?) RETURNING id`,
    userId, keys, training ? "enrollment" : "activity", training ? 1 : 0);
  for (const e of typing(keys, seed)) {
    await db.run(
      `INSERT INTO keystroke_events (keystroke_text_id, key_code, event_type, timestamp_relative, field_name, field_type)
       VALUES (?, ?, ?, ?, ?, ?)`, r.id, e.keyCode, e.eventType, e.timestampRelative, e.fieldName, e.fieldType);
  }
}

// a served profile on the Aalto negatives whose model is "prev": five enrolment samples (25 windows) to train on, and
// three activity samples (30 windows) held out for the gate
async function userWithProfile(userId, extra) {
  await db.tx(async () => {   // one commit, not one per key event
    for (let i = 0; i < 5; i++) await addSample(userId, 100, userId + i, true);
    for (let i = 0; i < 3; i++) await addSample(userId, 150, userId + 50 + i, false);
  });
  await db.run("INSERT INTO user_typing_profiles (user_id, model_json, sample_count) VALUES (?, ?, 5)", userId,
    JSON.stringify({ version: 3, type: "per-user-cnn-lstm", modelPath: "prev", threshold: 0.5, negatives: ks.NEGATIVES_SOURCE, ...extra }));
}

test.before(async () => {
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  process.env.MODEL_API_URL = `http://127.0.0.1:${stub.address().port}`;
  ks = require("../lib/keystrokeSecurity");
  await db.open();
  await userWithProfile(3001, {});                              // trained before bases were recorded
  await userWithProfile(3002, { baseModel: "ws50-gru-v2" });    // already on the new base
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
  assert.equal((await ks.getUserTypingProfile(3001, db)).baseModel, "ws50-gru-v2");
});

test("a retrain on the same base that scores clearly lower is rolled back, and the model in use stays", async () => {
  const p = await ks.trainUserTypingProfile(3002, db);
  assert.equal(p.modelPath, "prev");
  assert.deepEqual(calls.rollback, ["new-2"]);
  assert.equal((await ks.getUserTypingProfile(3002, db)).modelPath, "prev");
});

test("the next retrain of the migrated profile is gated again", async () => {
  SCORE["new-1"] = 0.95;   // the model it now serves scores high, the new fit (new-3) 0.60
  const p = await ks.trainUserTypingProfile(3001, db);
  assert.equal(p.modelPath, "new-1");
  assert.deepEqual(calls.rollback, ["new-2", "new-3"]);
});
