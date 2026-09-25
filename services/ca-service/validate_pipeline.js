/**
 * Validation of the training-pipeline fixes, against the LIVE code and the live database.
 *
 * Each check asserts a property that one of the fixes was supposed to establish. They exercise
 * the real exported functions rather than reimplementing the logic, so a regression in the
 * shipped code fails the check.
 *
 *   2. the alias rule does not exclude legitimate impostors
 *   4. no user's own samples reach their own negative pool, by alias OR by duplicate text
 *  4b. every profile was trained on the Aalto negatives only (T3.3)
 *   5. the calibrated threshold is not, and cannot become, the live cutoff
 *
 * Run inside the ca-service container:
 *   node /app/validate_pipeline.js
 */
const fs = require("fs");
const Database = require("better-sqlite3");
const ks = require("/app/lib/keystrokeSecurity.js");

const DB_PATH = "/app/ca.db";
const db = new Database(DB_PATH, { readonly: true });

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// Compares HASHES, not text: alias and duplicate detection only ever needed equality, so
// the check is identical while the plaintext stays unread.
const longTexts = (u) =>
  db
    .prepare(
      "SELECT DISTINCT text_hash t FROM keystroke_texts WHERE user_id = ? AND text_hash IS NOT NULL AND char_count > 40",
    )
    .all(u)
    .map((r) => r.t);

const trainingUsers = db
  .prepare("SELECT DISTINCT user_id u FROM keystroke_texts WHERE is_training = 1 AND is_suspicious = 0")
  .all()
  .map((r) => r.u);

// ---------------------------------------------------------------- check 2
// The alias rule keys on text overlap. The risk is a FALSE POSITIVE: excluding a real impostor
// because everyone types the same fixed enrolment prompts. Measure the overlap ratio for every
// ordered pair and confirm the known alias is separated from everyone else by a wide margin.
console.log("\nCHECK 2 — alias rule must not exclude legitimate impostors");
const ratios = [];
for (const target of trainingUsers) {
  const own = new Set(longTexts(target));
  if (own.size === 0) continue;
  for (const cand of trainingUsers) {
    if (cand === target) continue;
    const texts = longTexts(cand);
    if (texts.length < 4) continue;
    const shared = texts.filter((t) => own.has(t)).length;
    ratios.push({ target, cand, ratio: shared / texts.length, shared, n: texts.length });
  }
}
const fired = ratios.filter((r) => r.ratio > 0.5);
const notFired = ratios.filter((r) => r.ratio <= 0.5);
const maxLegit = notFired.length ? Math.max(...notFired.map((r) => r.ratio)) : 0;
const minAlias = fired.length ? Math.min(...fired.map((r) => r.ratio)) : 1;
console.log(`    ${ratios.length} ordered pairs; rule fires on ${fired.length}`);
for (const r of fired) {
  console.log(`      fires: user ${r.cand} -> target ${r.target}  ${r.shared}/${r.n} = ${(100 * r.ratio).toFixed(0)}%`);
}
console.log(`    highest overlap among pairs the rule KEEPS: ${(100 * maxLegit).toFixed(1)}%`);
console.log(`    lowest overlap among pairs the rule DROPS:  ${(100 * minAlias).toFixed(1)}%`);
check(
  "decision margin is wide (kept < 50% < dropped, gap > 20 points)",
  minAlias - maxLegit > 0.2,
  `gap ${(100 * (minAlias - maxLegit)).toFixed(0)} points`,
);
check(
  "shared enrolment prompts alone never trigger the rule",
  maxLegit <= 0.5,
  `worst legitimate pair ${(100 * maxLegit).toFixed(1)}%`,
);

// ---------------------------------------------------------------- check 4
// No user's own material may reach their own negative pool. The criterion is PERSON-level,
// not text-level. An earlier version failed a negative merely for sharing a text with the
// target, but the KeyRecs corpus has shared passages: participant 21 shares 1 of participant
// 28's 30 texts because both typed the same passage. That is a different human and the
// strongest possible negative — identical content, different rhythm, so the model cannot win
// on vocabulary. What must never appear is a negative from the SAME person under another id,
// which is exactly the majority-overlap condition the alias rule tests.
console.log("\nCHECK 4 — no genuine user's samples in their own negative pool");
const profiled = db.prepare("SELECT DISTINCT user_id u FROM user_typing_profiles").all().map((r) => r.u);
console.log(`    ${profiled.length} users with a trained profile`);
let contaminated = 0;
let sharedPassages = 0;
for (const u of profiled) {
  const own = new Set(longTexts(u));
  if (own.size === 0) continue;
  const negRows = ks.negativeSampleRows(u, db);
  const byUser = new Map();
  for (const row of negRows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row.text_hash);
  }
  for (const [negUser, hashes] of byUser) {
    const texts = longTexts(negUser);
    if (texts.length < 4) continue;
    const shared = texts.filter((t) => own.has(t)).length;
    if (shared / texts.length > 0.5) {
      contaminated++;
      console.log(`      user ${u}: negatives include user ${negUser}, sharing ${shared}/${texts.length} texts — SAME PERSON`);
    } else if (shared > 0) {
      sharedPassages++;
    }
  }
}
console.log(`    ${sharedPassages} negative-user pairs share a passage without being the same person (expected: shared corpus)`);
check("no profiled user has a same-person alias in their negative pool", contaminated === 0,
  `${contaminated} contaminated`);

// Since T3.3 no app user's samples are sent as negatives at all: every profile must have been
// trained on the Aalto file alone (NEGATIVES_SOURCE), which makes check 4 hold by construction.
console.log(`\nCHECK 4b — every keystroke profile trained on ${ks.NEGATIVES_SOURCE} negatives only`);
const stale = db.prepare("SELECT user_id u, model_json j FROM user_typing_profiles").all()
  .map((r) => ({ u: r.u, p: JSON.parse(r.j) }))
  .filter(({ p }) => p.negatives !== ks.NEGATIVES_SOURCE || p.negativeSource !== "dataset");
for (const { u, p } of stale) {
  console.log(`      user ${u}: negatives=${p.negatives || "-"} source=${p.negativeSource || "-"}`);
}
check(`all ${profiled.length} profiles use ${ks.NEGATIVES_SOURCE}, dataset source only`, stale.length === 0,
  `${stale.length} stale`);

// ---------------------------------------------------------------- check 5
// The calibrated per-user threshold must be reporting-only. Prove it by MUTATING it to an
// absurd value on a scratch copy and confirming the verdict does not move.
console.log("\nCHECK 5 — calibrated threshold is separated from the live 0.50 cutoff");
console.log(`    WINDOW_DECISION_THRESHOLD (live) = ${ks.WINDOW_DECISION_THRESHOLD}`);
// the profile is stored as JSON in model_json, not as a column
const prof = JSON.parse(db.prepare("SELECT model_json FROM user_typing_profiles WHERE user_id = 1").get().model_json);
console.log(`    user 1 calibrated threshold      = ${prof.threshold} (source: ${prof.thresholdSource})`);
check("live cutoff is the fixed 0.50", ks.WINDOW_DECISION_THRESHOLD === 0.5);
check("calibrated threshold is a distinct value (would change verdicts if used)",
  Math.abs(prof.threshold - 0.5) > 0.01, `${prof.threshold}`);

(async () => {
  const scratch = "/tmp/ca_threshold_test.db";
  fs.copyFileSync(DB_PATH, scratch);
  const wdb = new Database(scratch);
  const sampleId = db
    .prepare("SELECT id FROM keystroke_texts WHERE user_id=1 AND is_training=0 AND sample_purpose='activity' ORDER BY id DESC LIMIT 1")
    .get().id;
  const events = db
    .prepare("SELECT key_code,event_type,timestamp_relative,field_name FROM keystroke_events WHERE keystroke_text_id=? ORDER BY id")
    .all(sampleId)
    .map((e) => ({
      keyCode: e.key_code,
      eventType: e.event_type,
      timestampRelative: e.timestamp_relative,
      fieldName: e.field_name,
    }));

  const at = async (t) => {
    const row = JSON.parse(wdb.prepare("SELECT model_json FROM user_typing_profiles WHERE user_id=1").get().model_json);
    row.threshold = t;
    wdb.prepare("UPDATE user_typing_profiles SET model_json=? WHERE user_id=1").run(JSON.stringify(row));
    const r = await ks.evaluateKeystrokes({ events, userId: 1, db: wdb });
    return { suspicious: r.isSuspicious, conf: r.modelConfidence, windows: r.windowCount };
  };
  const lo = await at(0.01);
  const hi = await at(0.99);
  console.log(`    threshold 0.01 -> suspicious=${lo.suspicious} conf=${lo.conf}`);
  console.log(`    threshold 0.99 -> suspicious=${hi.suspicious} conf=${hi.conf}`);
  check(
    "verdict is INVARIANT to the calibrated threshold (proves it is not the cutoff)",
    lo.suspicious === hi.suspicious && lo.conf === hi.conf,
  );
  wdb.close();
  fs.unlinkSync(scratch);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
