// Admin view of every user's mouse profile: samples on file, the personal threshold the live rule
// uses, the whole enrolment-percentile table it was taken from, and what the live decision log
// says about that user so far (checks, how many asked for a passkey, median window score).
//
//   docker exec -w /app continuum-ca-service-1 node scripts/mouse_thresholds.js
//
// Server-side on purpose: a threshold shown in the browser, next to the per-window scores, would
// tell whoever is at the keyboard how far their movement is from passing.
const db = require("../db");
const mouse = require("../lib/mouse");

const profiles = db
  .prepare("SELECT user_id, threshold, enrol_percentiles, sample_windows, feature_version, trained_at FROM mouse_profiles ORDER BY user_id")
  .all();
const samples = db.prepare("SELECT COALESCE(SUM(window_count), 0) AS n FROM mouse_samples WHERE user_id = ?");
const decisions = db.prepare(
  "SELECT COUNT(*) AS checks, COALESCE(SUM(suspicious), 0) AS prompts, SUM(warmup) AS warmup FROM mouse_decisions WHERE user_id = ?",
);
const scoreRows = db.prepare("SELECT scores FROM mouse_decisions WHERE user_id = ? AND warmup = 0 ORDER BY id DESC LIMIT 200");

console.log(`live rule: ${mouse.THRESHOLD_PERCENTILE}st percentile of own enrolment scores; ` +
  `samples of ${mouse.SAMPLE_WINDOWS} windows, ${mouse.SAMPLES_REQUIRED} required\n`);
if (!profiles.length) console.log("no mouse profiles yet");
for (const p of profiles) {
  const total = samples.get(p.user_id).n;
  const table = JSON.parse(p.enrol_percentiles || "{}");
  const d = decisions.get(p.user_id);
  const all = scoreRows.all(p.user_id).flatMap((r) => JSON.parse(r.scores || "[]")).sort((a, b) => a - b);
  const median = all.length ? all[Math.floor(all.length / 2)] : null;
  console.log(`user ${p.user_id}`);
  console.log(`  samples on file   ${Math.floor(total / mouse.SAMPLE_WINDOWS)} (${total} windows; model trained on ${p.sample_windows}) · ${p.feature_version} · trained ${p.trained_at}`);
  console.log(`  threshold         ${Number(p.threshold).toFixed(3)}`);
  console.log(`  percentile table  ${Object.entries(table).map(([q, v]) => `p${q} ${Number(v).toFixed(3)}`).join("  ") || "(none: retrain to store it)"}`);
  console.log(`  live decisions    ${d.checks} checks, ${d.prompts} asked for a passkey, ${d.warmup || 0} warm-up` +
    (median !== null ? ` · median window score ${median.toFixed(3)} over the last ${all.length} windows` : ""));
}
