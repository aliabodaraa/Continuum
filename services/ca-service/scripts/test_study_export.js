// User-study export and replay test (T4.3): populate study rows on a COPY of the database, export,
// replay, then tamper with a verdict and inject a URL and check that the replay and the privacy scan
// catch them. Never run it on the live database.
//   docker exec continuum-ca-service-1 node -e "require('better-sqlite3')('/app/ca.db',{readonly:true}).backup('/tmp/study_test.db')"
//   docker exec -e DB_PATH=/tmp/study_test.db -e STUDY_LOGGING=1 -w /app continuum-ca-service-1 node scripts/test_study_export.js
if (!process.env.DB_PATH || process.env.DB_PATH.endsWith("/app/ca.db")) { console.error("Refusing: set DB_PATH to a copy of ca.db"); process.exit(2); }
const { execFileSync } = require("child_process");
const fs = require("fs");
const db = require("../db");
const ks = require("../lib/keystrokeSecurity");
const mouse = require("../lib/mouse");
const studyLog = require("../lib/studyLog");
const ok = (c, n, d = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) process.exitCode = 1; };
const run = (script, flag, dir) => { try { return { code: 0, out: execFileSync("node", [script, flag, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; } };

(async () => {
  // a participant with a mouse profile: three overlapping checks, genuine then impostor
  const mu = db.prepare("SELECT user_id FROM mouse_profiles WHERE decision_version = 's1-loso-p20-33of60' LIMIT 1").get().user_id;
  studyLog.register(mu, studyLog.parseContext({ participant: "ZZTEST1", sessionId: "sess-zz-0001", condition: "genuine" }));
  studyLog.recordProfile(mu, { channel: "mouse", ruleVersion: "s1-loso-p20-33of60", threshold: 0.95, thresholdSource: "loso-p20",
    modelPath: "/app/artifacts/users/user-1/mouse_model", windowCount: 440, thresholdScores: Array.from({ length: 440 }, (_, i) => i / 440) });
  const own = db.prepare("SELECT windows FROM mouse_samples WHERE user_id = ? ORDER BY id DESC LIMIT 3").all(mu).flatMap((r) => JSON.parse(r.windows));
  const other = db.prepare("SELECT windows FROM mouse_samples WHERE user_id <> ? ORDER BY id DESC LIMIT 3").all(mu).flatMap((r) => JSON.parse(r.windows));
  for (const [start, cond, src, sess] of [[0, "genuine", own, "sess-zz-0001"], [10, "genuine", own, "sess-zz-0001"], [0, "impostor:ZZTEST2", other, "sess-zz-0002"]]) {
    const w = src.slice(start, start + 60);
    await mouse.checkMouse(mu, w, { participant: "ZZTEST1", sessionId: sess, condition: cond, clientTs: start, windowKeys: w.map((_, i) => String(start + i)) });
  }
  // a keystroke decision with the route's inputs (the route itself is exercised end to end in part 4)
  const scores = Array.from({ length: 20 }, (_, i) => (i < 12 ? 0.2 : 0.9));
  studyLog.recordCheck(mu, studyLog.parseContext({ participant: "ZZTEST1", sessionId: "sess-zz-0001", condition: "genuine" }), {
    channel: "keystroke", ruleVersion: ks.RULE_VERSION, threshold: 0.5, scores, keys: scores.map((_, i) => `${i * 10}-${i * 10 + 500}`),
    lowWindows: 12, verdict: "suspicious", promptRequired: false,
    details: { packetSuspicious: true, windowTotal: 40, overwhelmingImpostor: false, unverifiable: false, pastePolicy: false, degenerateInput: false,
      recentSuspicious: 1, hasPasskey: true, modelAvailable: true, suspiciousWindow: 3, suspiciousMin: 2 } });
  studyLog.recordPrompt(mu, studyLog.parseContext({ participant: "ZZTEST1", sessionId: "sess-zz-0002", condition: "impostor:ZZTEST2", clientTs: 99 }),
    { channel: "mouse", decisionId: 1, event: "shown" });

  fs.rmSync("/tmp/zz_export", { recursive: true, force: true });
  const ex = run("scripts/study_export.js", "--out", "/tmp/zz_export");
  ok(ex.code === 0, "export runs; privacy scan clean", ex.out.trim().split("\n").join(" | "));
  const lines = fs.readFileSync("/tmp/zz_export/ZZTEST1.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  const wins = lines.filter((l) => l.type === "window" && l.channel === "mouse");
  ok(wins.length === 60 + 10 + 60, "overlapping mouse checks deduped to distinct windows", `${wins.length} windows, max timesScored ${Math.max(...wins.map((w) => w.timesScored))}`);
  ok(lines.some((l) => l.type === "profile" && l.thresholdScores.length === 440), "profile line carries all 440 threshold-source scores");
  ok(!JSON.stringify(lines).includes("/app/artifacts") && !JSON.stringify(lines).includes(`"userId"`), "no model path or user id in the export");
  const rp = run("scripts/study_replay.js", "--in", "/tmp/zz_export");
  ok(rp.code === 0 && /REPRODUCES EVERY/.test(rp.out), "replay reproduces every logged verdict", rp.out.trim().split("\n").slice(-2).join(" | "));

  // tamper: flip one verdict -> replay must fail
  const f = "/tmp/zz_export/ZZTEST1.jsonl";
  const tampered = lines.map((l) => (l.type === "decision" && l.channel === "keystroke" ? { ...l, verdict: "ok" } : l));
  fs.writeFileSync(f, tampered.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const rp2 = run("scripts/study_replay.js", "--in", "/tmp/zz_export");
  ok(rp2.code === 1 && /MISMATCH/.test(rp2.out), "replay catches a tampered verdict");
  // privacy: a URL in the database must fail the export's scan
  db.prepare("UPDATE study_decisions SET condition = 'genuine https://example.com' WHERE id = (SELECT MAX(id) FROM study_decisions)").run();
  const ex2 = run("scripts/study_export.js", "--out", "/tmp/zz_export2");
  ok(ex2.code === 1 && /PRIVACY/.test(ex2.out), "privacy scan catches a URL");
  const ex3 = run("scripts/study_export.js", "--out", "/app/study_out");
  ok(ex3.code === 2, "export refuses an output directory inside the repository mount");
  console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nALL EXPORT/REPLAY CHECKS PASSED");
})().catch((e) => { console.error(e); process.exitCode = 1; });
