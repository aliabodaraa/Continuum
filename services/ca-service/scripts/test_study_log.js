// User-study logging test (T4.3, lib/studyLog.js). Run it against a COPY of the database, never
// the live one: it writes study rows, a mouse decision and a streak update.
//   docker exec continuum-ca-service-1 node -e "require('better-sqlite3')('/app/ca.db',{readonly:true}).backup('/tmp/study_test.db')"
//   docker exec -e DB_PATH=/tmp/study_test.db -e STUDY_LOGGING=1 -w /app continuum-ca-service-1 node scripts/test_study_log.js
// On PostgreSQL: a copy made with CREATE DATABASE ca_test TEMPLATE ca, and STORAGE=postgres DATABASE_URL=.../ca_test.
// It calls model-api for predictions (read-only) and trains nothing.
const assert = (ok, name, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); if (!ok) process.exitCode = 1; };
const pgCopy = process.env.STORAGE === "postgres" && /\/[A-Za-z0-9_]+$/.test(process.env.DATABASE_URL || "") && !/\/ca$/.test(process.env.DATABASE_URL);
if (!pgCopy && (process.env.STORAGE === "postgres" || !process.env.DB_PATH || process.env.DB_PATH.endsWith("/app/ca.db"))) {
  console.error("Refusing: set DB_PATH to a copy of ca.db (or STORAGE=postgres with DATABASE_URL naming a copy, not the database ca)"); process.exit(2);
}
const db = require("../db");
const ks = require("../lib/keystrokeSecurity");
const mouse = require("../lib/mouse");
const studyLog = require("../lib/studyLog");

(async () => {
  assert(studyLog.ENABLED, "study logging is on in this test process");

  // 1. The keyed windows are exactly the live windows, on real stored samples.
  const texts = await db.all("SELECT id FROM keystroke_texts WHERE is_training = 1 ORDER BY id DESC LIMIT 60");
  let same = 0, withWindows = 0, keysUnique = true;
  for (const t of texts) {
    const ev = (await db.all("SELECT key_code, event_type, timestamp_relative, field_name, field_type FROM keystroke_events WHERE keystroke_text_id = ? ORDER BY timestamp_relative, id", t.id))
      .map((r) => ({ keyCode: r.key_code, eventType: r.event_type, timestampRelative: r.timestamp_relative, fieldName: r.field_name, fieldType: r.field_type }));
    const a = ks.eventsToFeatureWindows(ev);
    const b = ks.featureWindowsWithKeys(ev);
    if (JSON.stringify(a) === JSON.stringify(b.windows) && b.keys.length === b.windows.length) same++;
    if (a.length) withWindows++;
    if (new Set(b.keys).size !== b.keys.length) keysUnique = false;
  }
  assert(same === texts.length, "featureWindowsWithKeys builds the same windows as eventsToFeatureWindows", `${same}/${texts.length} samples, ${withWindows} with windows`);
  assert(keysUnique, "window keys are unique within a sample");

  // 2. A study mouse check logs full-precision scores with the client's keys; the verdict is unchanged.
  const mu = await db.get("SELECT user_id FROM mouse_profiles WHERE decision_version = ? ORDER BY user_id LIMIT 1", mouse.MOUSE_DECISION_VERSION);
  const rows = await db.all("SELECT windows FROM mouse_samples WHERE user_id = ? ORDER BY id DESC LIMIT 3", mu.user_id);
  const windows = rows.flatMap((r) => JSON.parse(r.windows)).slice(0, 70);
  const keys = windows.map((_, i) => String(1000 + i));
  const ctx = { participant: "T01", sessionId: "sess-test-0001", condition: "genuine", clientTs: 12345.5, windowKeys: keys };
  const plain = await mouse.checkMouse(mu.user_id, windows);
  const logged = await mouse.checkMouse(mu.user_id, windows, ctx);
  assert(plain.body.isSuspicious === logged.body.isSuspicious && plain.body.lowWindows === logged.body.lowWindows,
    "a study context does not change the mouse verdict", `low ${logged.body.lowWindows}/${logged.body.windowCount}`);
  const dId = logged.body.studyDecisionId;
  assert(Number.isInteger(dId), "the mouse check returns its study decision id", String(dId));
  const w = await db.all("SELECT window_key, score FROM study_windows WHERE decision_id = ? ORDER BY id", dId);
  assert(w.length === 60 && w[0].window_key === "1010" && w[59].window_key === "1069", "60 windows logged with the last 60 client keys", `${w.length}: ${w[0] && w[0].window_key}..${w[59] && w[59].window_key}`);
  const exact = w.every((r, i) => r.score === logged.body.recentWindowScores[i]);
  assert(exact, "logged mouse scores equal the returned scores exactly (full precision)");
  const md = await db.get("SELECT scores FROM mouse_decisions ORDER BY id DESC LIMIT 1");
  assert(JSON.parse(md.scores).every((s, i) => s === logged.body.recentWindowScores[i]), "mouse_decisions now stores full precision too");
  const dec = await db.get("SELECT * FROM study_decisions WHERE id = ?", dId);
  assert(dec.condition === "genuine" && dec.session_id === "sess-test-0001" && dec.rule_version === mouse.MOUSE_DECISION_VERSION && dec.client_ts === 12345.5,
    "decision row carries condition, session, rule and client time", `${dec.verdict}, thr ${dec.threshold}`);

  // 3. Keystroke: the evaluation returns one key per packet score.
  // a different user from the mouse test's, so the pseudonym binding is exercised correctly
  const ku = (await db.all("SELECT t.user_id, t.model_json FROM user_typing_profiles t WHERE t.user_id <> ? AND (SELECT COUNT(*) FROM keystroke_texts k WHERE k.user_id = t.user_id AND k.is_training = 1) >= 6 ORDER BY t.user_id", mu.user_id))
    .find((r) => { try { return JSON.parse(r.model_json).negatives === "aalto-A200"; } catch (e) { return false; } });
  const kt = await db.all("SELECT id FROM keystroke_texts WHERE user_id = ? AND is_training = 1 ORDER BY id DESC LIMIT 6", ku.user_id);
  let events = [];
  let offset = 0;
  for (const t of kt) {
    const ev = await db.all("SELECT key_code, event_type, timestamp_relative, field_name FROM keystroke_events WHERE keystroke_text_id = ? ORDER BY timestamp_relative, id", t.id);
    const last = ev.length ? ev[ev.length - 1].timestamp_relative : 0;
    events = events.concat(ev.map((r) => ({ keyCode: r.key_code, eventType: r.event_type, timestampRelative: r.timestamp_relative + offset, fieldName: "f" })));
    offset += last + 5000;
  }
  const evaln = await ks.evaluateKeystrokes({ events, userId: ku.user_id, db });
  assert(Array.isArray(evaln.recentWindowKeys) && evaln.recentWindowKeys.length === evaln.recentWindowScores.length && evaln.recentWindowScores.length === 20,
    "keystroke evaluation returns 20 scores and 20 aligned window keys", `${evaln.recentWindowScores && evaln.recentWindowScores.length} / ${evaln.recentWindowKeys && evaln.recentWindowKeys.length}`);
  const kctx = studyLog.parseContext({ participant: "T02", sessionId: "sess-test-0002", condition: "impostor:T01", clientTs: 1 });
  const kId = await studyLog.recordCheck(ku.user_id, kctx, { channel: "keystroke", ruleVersion: ks.RULE_VERSION, threshold: 0.5,
    scores: evaln.recentWindowScores, keys: evaln.recentWindowKeys, lowWindows: 0, verdict: "ok", promptRequired: false });
  const kw = await db.all("SELECT window_key, condition FROM study_windows WHERE decision_id = ? ORDER BY id", kId);
  assert(kw.length === 20 && kw.every((r) => r.condition === "impostor:T01") && /^\d+(\.\d+)?-\d+(\.\d+)?$/.test(kw[0].window_key),
    "keystroke windows logged with impostor condition and time keys", `${ks.RULE_VERSION}, key ${kw[0] && kw[0].window_key}`);

  // 4. Context validation and pseudonym binding.
  const bad = [{ participant: "T01", sessionId: "short", condition: "genuine" }, { participant: "T01", sessionId: "sess-test-0003", condition: "impostor:T01" },
    { participant: "T01", sessionId: "sess-test-0003", condition: "maybe" }, { participant: "a b", sessionId: "sess-test-0003", condition: "genuine" }];
  assert(bad.every((b) => studyLog.parseContext(b) === null), "invalid contexts are rejected (session, self-impostor, unknown condition, pseudonym)");
  const lab = studyLog.parseContext({ participant: "T01", sessionId: "sess-test-0005", condition: "genuine", client: "lab" });
  const phone = studyLog.parseContext({ participant: "T01", sessionId: "sess-test-0005", condition: "genuine", client: "phone" });
  assert(lab && lab.client === "lab" && phone === null, "client: 'lab' accepted, an unknown client voids the context");
  // ku is bound to T02 above; claiming T01 (bound to the mouse user) must be refused
  const hijack = await studyLog.recordCheck(ku.user_id, studyLog.parseContext({ participant: "T01", sessionId: "sess-test-0004", condition: "genuine" }),
    { channel: "keystroke", scores: [0.9], keys: ["k"], lowWindows: 0, verdict: "ok" });
  assert(hijack === null, "a pseudonym bound to one user cannot be used by another");

  // 5. Prompt events.
  const okPrompt = await studyLog.recordPrompt(mu.user_id, studyLog.parseContext(ctx), { channel: "mouse", decisionId: dId, event: "shown" });
  const badPrompt = await studyLog.recordPrompt(mu.user_id, studyLog.parseContext(ctx), { channel: "mouse", decisionId: dId, event: "clicked" });
  assert(okPrompt && !badPrompt, "prompt events: 'shown' stored, unknown event refused");

  // 6. Profile records only for participants.
  await studyLog.recordProfile(999999, { channel: "mouse", ruleVersion: "x", thresholdScores: [1] });
  assert(!(await db.get("SELECT 1 FROM study_profiles WHERE user_id = 999999")), "no profile record for a non-participant");
  await studyLog.recordProfile(mu.user_id, { channel: "mouse", ruleVersion: mouse.MOUSE_DECISION_VERSION, threshold: 0.5, thresholdSource: "loso-p20",
    modelPath: "/app/artifacts/users/user-1/mouse_model", windowCount: 440, thresholdScores: [0.123456789012345, 0.9] });
  const pr = await db.get("SELECT threshold_scores, model_sha256 FROM study_profiles WHERE user_id = ? ORDER BY id DESC LIMIT 1", mu.user_id);
  assert(JSON.parse(pr.threshold_scores)[0] === 0.123456789012345, "profile threshold scores stored at full precision",
    `model hash ${pr.model_sha256 ? pr.model_sha256.slice(0, 12) : "null (no /model-store mount here)"}`);
  console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL STUDY-LOG CHECKS PASSED");
  await db.close();
})().catch((e) => { console.error(e); process.exitCode = 1; });
