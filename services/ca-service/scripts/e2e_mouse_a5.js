// End-to-end check of the adopted mouse pipeline through ca-service's own code and the live
// model-api: gates, accumulation, training, per-user threshold, verdicts, stale-client refusal.
// Reads real SapiMouse windows (|dx|, |dy|) as JSON on stdin:
//   { enrolA: [...], enrolB: [...], genuine: [...], impostor: [...] }
//   docker exec -i -w /app continuum-ca-service-1 node scripts/e2e_mouse_a5.js < payload.json
const mouse = require("../lib/mouse");
const db = require("../db");

const TEST_USER = 990000001;   // throwaway id, removed at the end
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", async () => {
  const d = JSON.parse(raw);
  mouse.resetMouseProfile(TEST_USER);
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
    check("first real session (200 windows) is stored but NOT trained (below 330)", r.status === 202 && r.body.trained === false && r.body.totalWindows === d.enrolA.length, `${r.status} ${r.body.message}`);
    const st0 = mouse.mouseStatus(TEST_USER);
    check("status reports enrolment in samples (3 of 6 after 200 windows)", st0.samplesOnFile === 3 && st0.samplesRequired === 6 && st0.sampleWindows === 55 && !st0.enrolled, JSON.stringify({ on: st0.samplesOnFile, req: st0.samplesRequired }));

    r = await mouse.enrollMouse(TEST_USER, d.enrolB);
    const thr = r.body.threshold;
    check("second session crosses 330 and trains the FCN profile", r.status === 200 && r.body.trained === true && r.body.trainedFrom === "base-feature-extractor", `${r.status} total ${r.body.totalWindows} trainedFrom ${r.body.trainedFrom}`);
    check("a per-user threshold (1st percentile of enrolment scores) is stored with the percentile table", Number.isFinite(thr) && thr > 0 && thr < 1
      && JSON.parse(db.prepare("SELECT enrol_percentiles FROM mouse_profiles WHERE user_id = ?").get(TEST_USER).enrol_percentiles)["1"] === thr, `threshold ${thr}`);
    const st = mouse.mouseStatus(TEST_USER);
    check("status reports enrolled on the current feature version", st.enrolled && st.profile.feature_version === mouse.MOUSE_FEATURE_VERSION, JSON.stringify({ enrolled: st.enrolled, v: st.profile.feature_version }));

    r = await mouse.checkMouse(TEST_USER, d.genuine);
    check("genuine check returns a verdict with the 30-of-60 rule", r.status === 200 && r.body.checked && !r.body.warmup && r.body.bufferMax === 60 && r.body.lockAt === 30, `low ${r.body.lowWindows}/60, suspicious ${r.body.isSuspicious}`);
    check("every scored check is written to the decision log", db.prepare("SELECT COUNT(*) AS n FROM mouse_decisions WHERE user_id = ?").get(TEST_USER).n === 1);
    const gLow = r.body.lowWindows;
    r = await mouse.checkMouse(TEST_USER, d.impostor);
    const iLow = r.body.lowWindows;
    console.log(`    observed: genuine ${gLow}/60 low (suspicious=${gLow >= 30}), impostor ${iLow}/60 low (suspicious=${iLow >= 30})`);
    check("impostor windows score lower than the genuine user's", iLow > gLow, `${iLow} vs ${gLow}`);

    r = await mouse.checkMouse(TEST_USER, seven.slice(0, 20));
    check("live check refuses 7-column windows", r.status === 400, `${r.status}`);
  } finally {
    const gone = mouse.resetMouseProfile(TEST_USER);
    db.prepare("DELETE FROM mouse_profiles WHERE user_id = ?").run(TEST_USER);
    db.prepare("DELETE FROM mouse_decisions WHERE user_id = ?").run(TEST_USER);
    console.log(`  cleanup: removed ${gone.removedSessions} test sessions and the test profile`);
  }
  console.log(`\n${failures === 0 ? "ALL MOUSE CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
});
