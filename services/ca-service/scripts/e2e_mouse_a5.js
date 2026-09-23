// End-to-end check of the adopted mouse pipeline (S1) through ca-service's own code, its training
// queue and the live model-api: gates, accumulation to 8 samples, queued leave-one-sample-out
// training, the per-user threshold, verdicts with 33 of 60, the rebuild of a profile trained under
// an earlier decision rule, stale-client refusal.
// Reads real SapiMouse windows (|dx|, |dy|) as JSON on stdin:
//   { enrolA: [...], enrolB: [...], enrolC: [...], genuine: [...], impostor: [...] }
//   docker exec -i -w /app continuum-ca-service-1 node scripts/e2e_mouse_a5.js < payload.json
// Training is done by the RUNNING ca-service (its queue worker), exactly as for a live enrolment:
// this script only records the job and polls the status clients poll, so the service must be up
// on the current code.
const mouse = require("../lib/mouse");
const db = require("../db");

const TEST_USER = 990000001;   // throwaway id, removed at the end
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Poll /status until the queued job has finished (or failed, or timed out).
async function waitTrained(timeoutMs = 600000) {
  const t0 = Date.now();
  for (;;) {
    const st = mouse.mouseStatus(TEST_USER);
    const secs = Math.round((Date.now() - t0) / 1000);
    if (st.enrolled || st.trainingError || !st.training) return { st, secs };
    if (Date.now() - t0 > timeoutMs) return { st, secs, timedOut: true };
    await sleep(2000);
  }
}

let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", async () => {
  const d = JSON.parse(raw);
  mouse.resetMouseProfile(TEST_USER);
  db.prepare("DELETE FROM training_jobs WHERE user_id = ? AND modality = 'mouse'").run(TEST_USER);
  try {
    let r = await mouse.enrollMouse(TEST_USER, d.enrolA.slice(0, 40));
    check("session below 55 windows is refused, nothing stored", r.status === 422 && mouse.mouseStatus(TEST_USER).sessions === 0, `${r.status}`);

    const uniform = Array.from({ length: 80 }, () => Array.from({ length: 50 }, () => [6, 6]));
    r = await mouse.enrollMouse(TEST_USER, uniform);
    check("mechanical uniform motion is refused by the step-spread gate", r.status === 422 && r.body.stepSpreadPx === 0, `${r.status} spread ${r.body.stepSpreadPx}`);

    const seven = d.enrolA.slice(0, 60).map((w) => w.map((s) => [s[0], s[1], 0, 0, 0, 0, 0]));
    r = await mouse.enrollMouse(TEST_USER, seven);
    check("a 7-column (retired) client is refused with an update message", r.status === 400 && /retired/.test(r.body.error), `${r.status}`);

    r = await mouse.enrollMouse(TEST_USER, d.enrolA);
    check("first real session (200 windows) is stored, no model yet", r.status === 202 && r.body.trained === false && !r.body.training && r.body.totalWindows === 200, `${r.status} ${r.body.message}`);
    const st0 = mouse.mouseStatus(TEST_USER);
    check("status reports enrolment in samples (3 of 8 after 200 windows)", st0.samplesOnFile === 3 && st0.samplesRequired === 8 && st0.sampleWindows === 55 && !st0.enrolled && !st0.training, JSON.stringify({ on: st0.samplesOnFile, req: st0.samplesRequired }));

    r = await mouse.enrollMouse(TEST_USER, d.enrolB);
    check("330 windows (the old minimum) are stored, still no model", r.status === 202 && !r.body.trained && !r.body.training && r.body.totalWindows === 330, `${r.status} ${r.body.message}`);

    r = await mouse.enrollMouse(TEST_USER, d.enrolC);
    check("the session reaching 440 queues training instead of training in the request", r.status === 202 && r.body.training === true && r.body.trained === false && !!r.body.jobId, `${r.status} ${r.body.message}`);
    const job = db.prepare("SELECT state, reason FROM training_jobs WHERE id = ?").get(r.body.jobId);
    check("the job is recorded durably in training_jobs", !!job && ["queued", "running"].includes(job.state) && job.reason === "enrol", JSON.stringify(job));

    let w = await waitTrained();
    check("the ca-service worker trains the profile (8 fold models + the final model)", w.st.enrolled, `${w.secs} s${w.timedOut ? " (timed out)" : ""}${w.st.trainingError ? " error: " + w.st.trainingError : ""}`);
    const prof = db.prepare("SELECT threshold, sample_windows, loso_percentiles, enrol_percentiles, decision_version, feature_version FROM mouse_profiles WHERE user_id = ?").get(TEST_USER) || {};
    const loso = JSON.parse(prof.loso_percentiles || "{}");
    const insample = JSON.parse(prof.enrol_percentiles || "{}");
    check("threshold = 20th percentile of the leave-one-sample-out scores; both tables stored",
      Number.isFinite(prof.threshold) && prof.threshold === loso["20"] && Object.keys(loso).length === 9 && Object.keys(insample).length === 9,
      `threshold ${Number(prof.threshold).toFixed(4)} (in-sample p1 ${Number(insample["1"]).toFixed(4)}, p20 ${Number(insample["20"]).toFixed(4)})`);
    check("trained on exactly 440 windows, under the current feature version and decision rule",
      prof.sample_windows === 440 && prof.decision_version === mouse.MOUSE_DECISION_VERSION && prof.feature_version === mouse.MOUSE_FEATURE_VERSION,
      JSON.stringify({ windows: prof.sample_windows, rule: prof.decision_version }));

    r = await mouse.checkMouse(TEST_USER, d.genuine);
    check("genuine check returns a verdict with the 33-of-60 rule", r.status === 200 && r.body.checked && !r.body.warmup && r.body.bufferMax === 60 && r.body.lockAt === 33, `low ${r.body.lowWindows}/60, suspicious ${r.body.isSuspicious}`);
    check("every scored check is written to the decision log", db.prepare("SELECT COUNT(*) AS n FROM mouse_decisions WHERE user_id = ? AND vote_k = 33").get(TEST_USER).n === 1);
    const gLow = r.body.lowWindows;
    r = await mouse.checkMouse(TEST_USER, d.impostor);
    const iLow = r.body.lowWindows;
    console.log(`    observed: genuine ${gLow}/60 low (suspicious=${gLow >= mouse.VOTE_K}), impostor ${iLow}/60 low (suspicious=${iLow >= mouse.VOTE_K})`);
    check("impostor windows score lower than the genuine user's", iLow > gLow, `${iLow} vs ${gLow}`);

    // A profile from an earlier decision rule (what every pre-S1 profile is after the upgrade).
    db.prepare("UPDATE mouse_profiles SET decision_version = NULL WHERE user_id = ?").run(TEST_USER);
    r = await mouse.checkMouse(TEST_USER, d.genuine);
    check("a profile from an earlier decision rule is not scored, and its rebuild is queued", r.status === 422 && r.body.retrain === true && r.body.training === true && r.body.enrolled === false, `${r.status} ${r.body.error}`);
    const st1 = mouse.mouseStatus(TEST_USER);
    check("status reports it as rebuilding, not enrolled", !st1.enrolled && st1.training && st1.needsRetrain, JSON.stringify({ enrolled: st1.enrolled, training: st1.training }));
    w = await waitTrained();
    const again = db.prepare("SELECT threshold, decision_version FROM mouse_profiles WHERE user_id = ?").get(TEST_USER) || {};
    check("the rebuild restores a current profile", w.st.enrolled && again.decision_version === mouse.MOUSE_DECISION_VERSION, `${w.secs} s`);
    check("training is deterministic: the rebuild reproduces the same threshold",
      Number.isFinite(again.threshold) && again.threshold === prof.threshold, `${again.threshold} vs ${prof.threshold}`);

    r = await mouse.checkMouse(TEST_USER, seven.slice(0, 20));
    check("live check refuses 7-column windows", r.status === 400, `${r.status}`);
  } finally {
    const gone = mouse.resetMouseProfile(TEST_USER);
    db.prepare("DELETE FROM mouse_profiles WHERE user_id = ?").run(TEST_USER);
    db.prepare("DELETE FROM mouse_decisions WHERE user_id = ?").run(TEST_USER);
    db.prepare("DELETE FROM training_jobs WHERE user_id = ? AND modality = 'mouse' AND state NOT IN ('queued', 'running')").run(TEST_USER);
    console.log(`  cleanup: removed ${gone.removedSessions} test sessions, the test profile and its finished jobs`);
  }
  console.log(`\n${failures === 0 ? "ALL MOUSE CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
});
