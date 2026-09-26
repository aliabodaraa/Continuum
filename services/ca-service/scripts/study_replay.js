// Integrity check for the user-study export (LOGGING_SPEC.md §5, T4.3): re-derive every logged
// verdict from the exported scores and the live decision rules, and report any disagreement.
//
//   docker exec -w /app continuum-ca-service-1 node scripts/study_replay.js --in /tmp/study_export
//
// Mouse: low = score < the profile threshold; warm-up below VOTE_N windows; suspicious at >= VOTE_K
// low (lib/mouse.js). Keystroke (server.js /v1/keystroke/check): low = score < 0.50; the packet vote,
// the overwhelming-impostor fast path, warm-up, and the 2-of-3 debounce with the passkey condition.
// The debounce history is also simulated across each participant's decisions in order; a mismatch
// there means checks outside the study log (or a reset) touched it, and is reported separately.
const fs = require("fs");
const path = require("path");
const ks = require("../lib/keystrokeSecurity");

const args = process.argv.slice(2);
const IN = args.includes("--in") ? path.resolve(args[args.indexOf("--in") + 1]) : null;
if (!IN || !fs.existsSync(IN)) {
  console.error("usage: node scripts/study_replay.js --in <export directory>");
  process.exit(2);
}

const T = ks.WINDOW_DECISION_THRESHOLD;
let checked = 0, mismatches = 0, historyNotes = 0;
const fail = (f, d, what) => { mismatches += 1; console.error(`MISMATCH ${f} decision ${d.decisionId} (${d.channel}): ${what}`); };

for (const f of fs.readdirSync(IN).filter((n) => n.endsWith(".jsonl")).sort()) {
  const decisions = fs.readFileSync(path.join(IN, f), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).filter((o) => o.type === "decision");
  let history = [];   // simulated keystroke debounce history of this participant
  for (const d of decisions) {
    checked += 1;
    const s = d.scores || [];
    if (s.length !== d.windowCount) fail(f, d, `${s.length} scores for windowCount ${d.windowCount}`);
    if (d.channel === "mouse") {
      const n = d.details ? d.details.voteN : 60;
      const k = d.details ? d.details.voteK : 33;
      const low = s.filter((x) => x < d.threshold).length;
      const verdict = s.length < n ? "warmup" : low >= k ? "suspicious" : "ok";
      if (low !== d.lowWindows) fail(f, d, `low ${low} vs logged ${d.lowWindows}`);
      if (verdict !== d.verdict) fail(f, d, `verdict ${verdict} vs logged ${d.verdict}`);
      continue;
    }
    // keystroke
    const x = d.details || {};
    const low = s.filter((v) => v < T).length;
    if (low !== d.lowWindows) fail(f, d, `low ${low} vs logged ${d.lowWindows}`);
    if (x.modelAvailable !== false && s.length > 0 && !x.pastePolicy) {
      const packet = low / s.length >= ks.PACKET_VOTE_FRACTION;
      if (packet !== x.packetSuspicious) fail(f, d, `packet vote ${packet} vs logged ${x.packetSuspicious}`);
    }
    const overwhelming = s.length >= ks.WARMUP_FAST_MIN_WINDOWS && low >= Math.ceil(s.length * ks.WARMUP_FAST_FRACTION);
    if (overwhelming !== !!x.overwhelmingImpostor) fail(f, d, `overwhelming ${overwhelming} vs logged ${x.overwhelmingImpostor}`);
    const warmup = x.windowTotal <= ks.RECENT_WINDOW_COUNT && !overwhelming && !x.unverifiable && !x.pastePolicy && !x.degenerateInput;
    const effective = (!warmup && !!x.packetSuspicious) || !!x.degenerateInput;
    const strong = overwhelming || !!x.unverifiable || !!x.pastePolicy || !!x.degenerateInput;
    const challenge = !!x.hasPasskey && effective && (strong || x.recentSuspicious >= x.suspiciousMin);
    const verdict = challenge ? "challenge" : warmup ? "warmup" : effective ? "suspicious" : "ok";
    if (verdict !== d.verdict) fail(f, d, `verdict ${verdict} vs logged ${d.verdict}`);
    if (challenge !== d.promptRequired) fail(f, d, `prompt ${challenge} vs logged ${d.promptRequired}`);
    // the debounce history, simulated from this participant's own decisions
    history = history.concat([effective]).slice(-(x.suspiciousWindow || 3));
    const count = history.filter(Boolean).length;
    if (count !== x.recentSuspicious) {
      historyNotes += 1;
      console.warn(`note ${f} decision ${d.decisionId}: simulated history count ${count}, logged ${x.recentSuspicious} (checks outside the log, or a reset)`);
      history = [];   // resynchronise with a conservative assumption; the logged value decided
      for (let i = 0; i < x.recentSuspicious; i += 1) history.push(true);
    }
    if (challenge) history = [];
  }
}
console.log(`replayed ${checked} decision(s): ${mismatches} mismatch(es), ${historyNotes} history note(s)`);
console.log(mismatches ? "REPLAY FAILED" : "REPLAY REPRODUCES EVERY LOGGED VERDICT");
process.exitCode = mismatches ? 1 : 0;
