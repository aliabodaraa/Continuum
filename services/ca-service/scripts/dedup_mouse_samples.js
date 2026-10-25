// One-off cleanup of mouse samples that repeat another sample of the same user (the owner's step 0, 2026-10-24).
// On 2026-09-19 the SDK recorded the same movement twice (two sample flows at once) and stored both copies; a copy
// inside a profile finds its twin in training, so the leave-one-sample-out threshold comes out too high. Since
// 2026-10-24 enrolment refuses such a sample (lib/mouse.js REPEAT_LIMIT); this removes the ones stored before.
// Newest first, a sample is removed when more than REPEAT_LIMIT of its 20-step runs occur in a sample already kept
// (lib/mouse.js repeatedSamples). Then the user's profile is rebuilt by retrainMouse, the queue's own code.
//
//   kubectl -n continuum exec deploy/ca-service -- node scripts/dedup_mouse_samples.js            (report only)
//   kubectl -n continuum exec deploy/ca-service -- node scripts/dedup_mouse_samples.js --apply    (remove, rebuild)
const db = require("../db");
const mouse = require("../lib/mouse");
const trainingQueue = require("../lib/trainingQueue");

const apply = process.argv.includes("--apply");

(async () => {
  await db.open();
  const users = (await db.all("SELECT DISTINCT user_id FROM mouse_samples ORDER BY user_id")).map((r) => r.user_id);
  let removedAll = 0;
  for (const userId of users) {
    const rows = await db.all("SELECT id, windows, window_count FROM mouse_samples WHERE user_id = ? ORDER BY id", userId);
    const repeated = mouse.repeatedSamples(rows.map((r) => ({ id: r.id, windows: JSON.parse(r.windows) })));
    if (!repeated.length) { console.log(`user ${userId}: ${rows.length} samples, none repeats another`); continue; }
    for (const r of repeated) console.log(`user ${userId}: sample ${r.id} repeats sample ${r.repeats} (${(100 * r.share).toFixed(1)}% of its 20-step runs)`);
    if (!apply) { console.log(`user ${userId}: would remove ${repeated.map((r) => r.id).join(", ")} and rebuild the profile`); continue; }
    const ids = repeated.map((r) => r.id);
    const gone = await db.run(`DELETE FROM mouse_samples WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`, userId, ...ids);
    removedAll += gone.changes;
    const left = rows.length - gone.changes;
    const total = rows.filter((r) => !ids.includes(r.id)).reduce((a, r) => a + r.window_count, 0);
    console.log(`user ${userId}: removed ${gone.changes} (${ids.join(", ")}), ${left} samples and ${total} windows left`);
    if (total < mouse.MIN_ENROLL_WINDOWS) {
      // Too few left for a profile: the old one goes, so it is never scored on samples that no longer exist.
      await db.run("DELETE FROM mouse_profiles WHERE user_id = ?", userId);
      console.log(`user ${userId}: below ${mouse.MIN_ENROLL_WINDOWS} windows, profile removed; enrol again`);
      continue;
    }
    const before = await db.get("SELECT threshold FROM mouse_profiles WHERE user_id = ?", userId);
    const res = await mouse.retrainMouse(userId, { retrained: "repeated samples removed" });
    console.log(`user ${userId}: rebuilt -> ${res.status} ${res.body.trained
      ? `threshold ${before && before.threshold != null ? before.threshold : "none"} -> ${res.body.threshold}`
      : res.body.error}`);
    if (res.status !== 200) {
      // The old profile still counts as current, so nothing else would rebuild it: leave the job to the queue.
      const job = await trainingQueue.enqueue(userId, "mouse", "repeated-samples-removed");
      console.log(`user ${userId}: rebuild queued as job ${job.id}`);
    }
  }
  console.log(apply ? `done: ${removedAll} samples removed` : "report only; run with --apply to remove and rebuild");
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
