// Retrain every stored mouse profile through lib/mouse.js retrainMouse -- the same code the training
// queue runs for a live enrolment. Used when the training recipe or the operating point changes, so
// existing users get the current recipe (mouse.MOUSE_DECISION_VERSION; since T3.4 F2: latest 440
// windows, a per-user head on the frozen network, leave-one-sample-out threshold at the 20th
// percentile) with both percentile tables stored alongside it. Runs in this process, one user at a
// time (seconds each under F2; S1 took about 2.5 min); a profile it skips is rebuilt from the queue
// the next time that user's mouse status or check is read.
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
      ? `trained, threshold ${before && before.threshold != null ? before.threshold.toFixed(4) : "none"} -> ${res.body.threshold.toFixed(4)} (p${mouse.THRESHOLD_PERCENTILE}, ${mouse.THRESHOLD_SOURCE})`
      : res.body.error}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
