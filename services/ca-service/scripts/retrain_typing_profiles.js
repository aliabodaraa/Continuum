// Retrain every stored typing profile through the training queue, so that each user's model is fine-tuned again
// from the base the model service now loads. Used when the keystroke base or the training recipe changes. On
// 2026-10-25 the live base moved from ws50-gru (two GRU layers of 32 units) to ws50-gru-v2 (16 units), the base
// every typing result in the paper and the thesis was measured with. One job is queued per profile; the worker
// (lib/trainingQueue.js) runs ks.trainUserTypingProfile, the same code a live enrolment runs, and a profile whose
// samples no longer meet the minimum is left as it is. Nothing is trained in this process.
//
//   docker exec -w /app continuum-ca-service-1 node scripts/retrain_typing_profiles.js [--dry-run]
const db = require("../db");
const trainingQueue = require("../lib/trainingQueue");

const dry = process.argv.includes("--dry-run");

(async () => {
  const users = await db.all("SELECT user_id, trained_at FROM user_typing_profiles ORDER BY user_id");
  for (const u of users) {
    if (dry) { console.log(`user ${u.user_id}: trained ${u.trained_at} — would queue a retrain`); continue; }
    const r = await trainingQueue.enqueue(u.user_id, "keystroke", "base-update");
    console.log(`user ${u.user_id}: job ${r.id} ${r.deduped ? "already queued" : "queued"}`);
  }
  console.log(`${dry ? "would queue" : "queued"} ${users.length} typing retrains`);
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
