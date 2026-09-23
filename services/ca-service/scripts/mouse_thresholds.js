// Admin view of every user's mouse profile: samples on file, the personal threshold the live rule
// uses, the percentile tables it can be taken from (leave-one-sample-out, which the live rule uses,
// and the in-sample enrolment table), and what the live decision log says about that user so far
// (checks, how many asked for a passkey, median window score).
//
//   docker exec -w /app continuum-ca-service-1 node scripts/mouse_thresholds.js
//
// Server-side on purpose: a threshold shown in the browser, next to the per-window scores, would
// tell whoever is at the keyboard how far their movement is from passing.
const db = require("../db");
const mouse = require("../lib/mouse");

const profiles = db
  .prepare("SELECT user_id, threshold, enrol_percentiles, loso_percentiles, decision_version, sample_windows, feature_version, trained_at FROM mouse_profiles ORDER BY user_id")
  .all();
const samples = db.prepare("SELECT COALESCE(SUM(window_count), 0) AS n FROM mouse_samples WHERE user_id = ?");
const decisions = db.prepare(
  "SELECT COUNT(*) AS checks, COALESCE(SUM(suspicious), 0) AS prompts, SUM(warmup) AS warmup FROM mouse_decisions WHERE user_id = ?",
);
const scoreRows = db.prepare("SELECT scores FROM mouse_decisions WHERE user_id = ? AND warmup = 0 ORDER BY id DESC LIMIT 200");

console.log(`live rule (${mouse.MOUSE_DECISION_VERSION}): ${mouse.THRESHOLD_PERCENTILE}th percentile of own ${mouse.THRESHOLD_SOURCE} ` +
  `scores, ${mouse.VOTE_K} of the last ${mouse.VOTE_N} windows below it; samples of ${mouse.SAMPLE_WINDOWS} windows, ` +
  `${mouse.SAMPLES_REQUIRED} required\n`);
if (!profiles.length) console.log("no mouse profiles yet");
for (const p of profiles) {
  const total = samples.get(p.user_id).n;
  const table = JSON.parse(p.enrol_percentiles || "{}");
  const losoTable = JSON.parse(p.loso_percentiles || "{}");
  const d = decisions.get(p.user_id);
  const all = scoreRows.all(p.user_id).flatMap((r) => JSON.parse(r.scores || "[]")).sort((a, b) => a - b);
  const median = all.length ? all[Math.floor(all.length / 2)] : null;
  console.log(`user ${p.user_id}`);
  console.log(`  samples on file   ${Math.floor(total / mouse.SAMPLE_WINDOWS)} (${total} windows; model trained on ${p.sample_windows}) · ${p.feature_version} · trained ${p.trained_at}`);
  console.log(`  threshold         ${Number(p.threshold).toFixed(3)}`);
  console.log(`  decision rule     ${p.decision_version || "(none: trained before S1; rebuilt on next use)"}`);
  console.log(`  out-of-sample     ${Object.entries(losoTable).map(([q, v]) => `p${q} ${Number(v).toFixed(3)}`).join("  ") || "(none: retrain to store it)"}`);
  console.log(`  in-sample         ${Object.entries(table).map(([q, v]) => `p${q} ${Number(v).toFixed(3)}`).join("  ") || "(none: retrain to store it)"}`);
  console.log(`  live decisions    ${d.checks} checks, ${d.prompts} asked for a passkey, ${d.warmup || 0} warm-up` +
    (median !== null ? ` · median window score ${median.toFixed(3)} over the last ${all.length} windows` : ""));
}
