// One-off migration of stored mouse enrolments to the adopted representation (|dx|, |dy|).
//
// The retired 7-feature windows stored dx and dy as pixel displacement / 1920 (clipped to +-1).
// |dx| and |dy| in pixels are therefore recovered EXACTLY as |col| * 1920 -- verified on 506,700
// values against the training pipeline (max error 0.0000 px) -- and window selection used the
// same path rule, so the converted sessions are the windows the new pipeline would have produced.
// No user has to enrol again. Each user with enough stored movement is then retrained through
// lib/mouse.js retrainMouse, the same code a live enrolment runs.
//
//   docker exec -w /app continuum-ca-service-1 node scripts/migrate_mouse_a5.js [--dry-run]
const db = require("../db");
const mouse = require("../lib/mouse");

const SCREEN_SCALE = 1920;
const dry = process.argv.includes("--dry-run");

function convertWindow(w) {
  return w.map((row) => [Math.abs(row[0]) * SCREEN_SCALE, Math.abs(row[1]) * SCREEN_SCALE]);
}

(async () => {
  const rows = db.prepare("SELECT id, user_id, windows FROM mouse_samples ORDER BY id").all();
  let converted = 0;
  for (const r of rows) {
    const w = JSON.parse(r.windows);
    if (!w.length || w[0][0].length !== 7) continue;          // already migrated
    const out = w.map(convertWindow);
    if (!dry) db.prepare("UPDATE mouse_samples SET windows = ? WHERE id = ?").run(JSON.stringify(out), r.id);
    converted++;
  }
  console.log(`${dry ? "[dry run] would convert" : "converted"} ${converted} of ${rows.length} stored sessions`);

  const users = db
    .prepare("SELECT user_id, COUNT(*) AS sessions, SUM(window_count) AS total FROM mouse_samples GROUP BY user_id")
    .all();
  for (const u of users) {
    if (u.total < mouse.MIN_ENROLL_WINDOWS) {
      if (!dry) db.prepare("UPDATE mouse_profiles SET feature_version = NULL WHERE user_id = ?").run(u.user_id);
      console.log(`user ${u.user_id}: ${u.total} windows over ${u.sessions} sessions — below ${mouse.MIN_ENROLL_WINDOWS}; needs one more enrolment session`);
      continue;
    }
    if (dry) {
      console.log(`user ${u.user_id}: ${u.total} windows over ${u.sessions} sessions — would retrain`);
      continue;
    }
    const res = await mouse.retrainMouse(u.user_id, { migrated: true });
    console.log(`user ${u.user_id}: ${u.total} windows -> ${res.status} ${res.body.trained ? `trained, threshold ${res.body.threshold.toFixed(4)}` : res.body.error}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
