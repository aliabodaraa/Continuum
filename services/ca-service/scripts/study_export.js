// User-study export (LOGGING_SPEC.md §4, T4.3): one JSON Lines file per participant, holding the
// profile records (§1), the scored windows (§2) and the decisions and prompts (§3).
//
//   docker exec -w /app continuum-ca-service-1 node scripts/study_export.js --out /tmp/study_export
//   docker cp continuum-ca-service-1:/tmp/study_export <encrypted storage>
//
// Study data never goes into git: the output directory must lie outside /app (the repository's
// bind mount). Every line is built from an explicit field list, and the finished files are
// scanned before the script reports success (the privacy test, LOGGING_SPEC.md §5).
//
// Windows: overlapping checks score the same window again. A window is written once per
// (session, channel, window key, model), where the model is the profile in force at the check;
// re-scores by the same model must agree (|diff| <= 1e-6), and the largest difference is reported.
// Each decision line keeps its own scores, exactly as scored, for scripts/study_replay.js.
const fs = require("fs");
const path = require("path");
const db = require("../db");

const args = process.argv.slice(2);
const outArg = args[args.indexOf("--out") + 1];
if (!args.includes("--out") || !outArg) {
  console.error("usage: node scripts/study_export.js --out <directory outside /app>");
  process.exit(2);
}
const OUT = path.resolve(outArg);
if (OUT === "/app" || OUT.startsWith("/app/")) {
  console.error(`Refusing ${OUT}: /app is the repository's bind mount, and study data never goes into git.`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const RESCORE_TOLERANCE = 1e-6;
const toIso = (t) => (t ? new Date(t.replace(" ", "T") + "Z").toISOString() : null);

// The allowlist: the only keys a line of each type may carry (checked again by the scan below).
const FIELDS = {
  participant: ["type", "participant", "exportedAt", "counts"],
  profile: ["type", "profileId", "channel", "ruleVersion", "threshold", "thresholdSource", "modelSha256", "windowCount", "thresholdScores", "trainedAt"],
  window: ["type", "channel", "sessionId", "windowKey", "profileId", "score", "condition", "daySinceEnrolment", "firstDecisionId", "timesScored"],
  decision: ["type", "decisionId", "channel", "sessionId", "condition", "clientTs", "checkedAt", "profileId", "ruleVersion", "threshold", "windowCount", "lowWindows", "verdict", "promptRequired", "details", "windowKeys", "scores"],
  prompt: ["type", "sessionId", "channel", "decisionId", "event", "clientTs", "loggedAt"],
};
const line = (type, obj) => {
  const o = { type };
  for (const k of FIELDS[type]) if (k !== "type" && obj[k] !== undefined) o[k] = obj[k];
  return JSON.stringify(o);
};

const participants = db.prepare("SELECT user_id, pseudonym FROM study_participants ORDER BY pseudonym").all();
let maxRescoreDiff = 0;
let rescoreConflicts = 0;
const summary = [];

for (const p of participants) {
  const out = [];
  const profiles = db.prepare("SELECT * FROM study_profiles WHERE user_id = ? ORDER BY id").all(p.user_id);
  // The profile in force at a check: the latest one of that channel trained at or before it.
  const profileAt = (channel, checkedAt) => {
    let id = null;
    for (const pr of profiles) if (pr.channel === channel && pr.trained_at <= checkedAt) id = pr.id;
    return id;
  };
  for (const pr of profiles) {
    out.push(line("profile", {
      profileId: pr.id, channel: pr.channel, ruleVersion: pr.rule_version, threshold: pr.threshold,
      thresholdSource: pr.threshold_source, modelSha256: pr.model_sha256, windowCount: pr.window_count,
      thresholdScores: JSON.parse(pr.threshold_scores || "[]"), trainedAt: toIso(pr.trained_at),
    }));
  }

  const decisions = db.prepare("SELECT * FROM study_decisions WHERE user_id = ? ORDER BY id").all(p.user_id);
  const winStmt = db.prepare("SELECT window_key, score, condition, day_since_enrolment FROM study_windows WHERE decision_id = ? ORDER BY id");
  const windows = new Map();   // session|channel|key|profile -> window record
  const decisionLines = [];
  for (const d of decisions) {
    const rows = winStmt.all(d.id);
    const profileId = profileAt(d.channel, d.checked_at);
    for (const r of rows) {
      const k = `${d.session_id}|${d.channel}|${r.window_key}|${profileId}`;
      const w = windows.get(k);
      if (!w) {
        windows.set(k, { channel: d.channel, sessionId: d.session_id, windowKey: r.window_key, profileId, score: r.score,
          condition: r.condition, daySinceEnrolment: r.day_since_enrolment, firstDecisionId: d.id, timesScored: 1 });
      } else {
        w.timesScored += 1;
        const diff = Math.abs(w.score - r.score);
        maxRescoreDiff = Math.max(maxRescoreDiff, diff);
        if (diff > RESCORE_TOLERANCE) rescoreConflicts += 1;
      }
    }
    decisionLines.push(line("decision", {
      decisionId: d.id, channel: d.channel, sessionId: d.session_id, condition: d.condition, clientTs: d.client_ts,
      checkedAt: toIso(d.checked_at), profileId, ruleVersion: d.rule_version, threshold: d.threshold,
      windowCount: d.window_count, lowWindows: d.low_windows, verdict: d.verdict, promptRequired: !!d.prompt_required,
      details: d.details ? JSON.parse(d.details) : null, windowKeys: rows.map((r) => r.window_key), scores: rows.map((r) => r.score),
    }));
  }
  for (const w of windows.values()) out.push(line("window", w));
  out.push(...decisionLines);

  const prompts = db.prepare("SELECT * FROM study_prompts WHERE user_id = ? ORDER BY id").all(p.user_id);
  for (const q of prompts) {
    out.push(line("prompt", { sessionId: q.session_id, channel: q.channel, decisionId: q.decision_id, event: q.event,
      clientTs: q.client_ts, loggedAt: toIso(q.logged_at) }));
  }

  const counts = { profiles: profiles.length, windows: windows.size, decisions: decisions.length, prompts: prompts.length };
  out.unshift(line("participant", { participant: p.pseudonym, exportedAt: new Date().toISOString(), counts }));
  fs.writeFileSync(path.join(OUT, `${p.pseudonym}.jsonl`), out.join("\n") + "\n");
  summary.push(`${p.pseudonym}: ${counts.profiles} profiles, ${counts.windows} windows, ${counts.decisions} decisions, ${counts.prompts} prompts`);
}

// ---- privacy test (LOGGING_SPEC.md §5): only allowlisted keys, and nothing that looks like text,
// a URL or a page title in any string value.
const SAFE_STRING = /^[A-Za-z0-9_.:;,=+\- ]{0,64}$/;
const URLISH = /(https?:|www\.|\.com\b|\.org\b|\.html?\b|\/\/)/i;
let violations = 0;
function scanValue(v, where) {
  if (typeof v === "string") {
    if (!SAFE_STRING.test(v) || URLISH.test(v)) { violations += 1; console.error(`PRIVACY: suspicious string at ${where}: ${JSON.stringify(v).slice(0, 80)}`); }
  } else if (Array.isArray(v)) v.forEach((x, i) => scanValue(x, `${where}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) scanValue(x, `${where}.${k}`);
}
for (const f of fs.readdirSync(OUT).filter((n) => n.endsWith(".jsonl"))) {
  fs.readFileSync(path.join(OUT, f), "utf8").split("\n").filter(Boolean).forEach((l, i) => {
    const o = JSON.parse(l);
    const allowed = FIELDS[o.type];
    if (!allowed) { violations += 1; console.error(`PRIVACY: unknown line type in ${f}:${i + 1}`); return; }
    for (const k of Object.keys(o)) if (!allowed.includes(k)) { violations += 1; console.error(`PRIVACY: key ${k} not allowed in ${f}:${i + 1}`); }
    scanValue(o, `${f}:${i + 1}`);
  });
}

console.log(summary.join("\n") || "no study participants");
console.log(`re-scored windows: max |diff| ${maxRescoreDiff.toExponential(2)}, ${rescoreConflicts} above ${RESCORE_TOLERANCE}`);
console.log(`privacy scan: ${violations} violation(s)`);
console.log(`wrote ${participants.length} file(s) to ${OUT}`);
process.exitCode = violations || rescoreConflicts ? 1 : 0;
