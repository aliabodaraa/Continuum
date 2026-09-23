// Retrain every stored mouse profile through lib/mouse.js retrainMouse -- the same code a live
// enrolment runs. Used when the training recipe or the operating point changes, so existing users
// get the current recipe (single contiguous validation tail) and a threshold at the current
// percentile, with the full percentile table stored alongside it.
//
//   docker exec -w /app continuum-ca-service-1 node scripts/retrain_mouse_profiles.js [--dry-run]
const db = require("../db");
const mouse = require("../lib/mouse");

const dry = process.argv.includes("--dry-run");

(async () => {
  const users = db
    .prepare("SELECT user_id, COUNT(*) AS sessions, SUM(window_count) AS total FROM mouse_samples GROUP BY user_id")
    .all();
  for (const u of users) {
    if (u.total < mouse.MIN_ENROLL_WINDOWS) {
      console.log(`user ${u.user_id}: ${u.total} windows (${Math.floor(u.total / mouse.SAMPLE_WINDOWS)} of ${mouse.SAMPLES_REQUIRED} samples) — not enough for a model yet`);
      continue;
    }
    if (dry) { console.log(`user ${u.user_id}: ${u.total} windows over ${u.sessions} sessions — would retrain`); continue; }
    const before = db.prepare("SELECT threshold FROM mouse_profiles WHERE user_id = ?").get(u.user_id);
    const res = await mouse.retrainMouse(u.user_id, { retrained: "recipe/operating-point update" });
    console.log(`user ${u.user_id}: ${u.total} windows -> ${res.status} ${res.body.trained
      ? `trained, threshold ${before ? before.threshold.toFixed(4) : "none"} -> ${res.body.threshold.toFixed(4)} (p${mouse.THRESHOLD_PERCENTILE})`
      : res.body.error}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
