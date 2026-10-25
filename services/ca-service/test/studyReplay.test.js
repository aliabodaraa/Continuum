// The study replay (scripts/study_replay.js) re-derives every logged typing verdict. Rows logged before 2026-10-19
// carry the parameters of the confirmation that was live then and are replayed under them; rows logged since carry
// none and are judged by the packet vote alone. No database is involved: the replay reads exported files. node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "scripts", "study_replay.js");
let id = 0;
function decision({ low, n = 20, windowTotal = 30, verdict, prompt, extra = {} }) {
  const scores = Array.from({ length: n }, (_, i) => (i < low ? 0.2 : 0.9));
  return { type: "decision", decisionId: ++id, channel: "keystroke", sessionId: "s1", condition: "genuine", ruleVersion: "lu-050-10of20-warm8",
    threshold: 0.5, windowCount: n, lowWindows: low, scores, verdict, promptRequired: prompt,
    details: { packetSuspicious: low / n >= 0.5, windowTotal, overwhelmingImpostor: false, unverifiable: false, pastePolicy: false,
      degenerateInput: false, hasPasskey: true, modelAvailable: true, packetWindows: 20, ...extra } };
}
const earlier = (recent) => ({ recentSuspicious: recent, suspiciousWindow: 3, suspiciousMin: 2 });
function replay(decisions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-replay-"));
  try {
    fs.writeFileSync(path.join(dir, "P1.jsonl"), decisions.map((d) => JSON.stringify(d)).join("\n") + "\n");
    const r = spawnSync(process.execPath, [SCRIPT, "--in", dir], { encoding: "utf8", env: { ...process.env, DB_PATH: path.join(dir, "unused.db") } });
    return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("a check with half of its twenty windows low is replayed as a passkey request", () => {
  const r = replay([decision({ low: 10, verdict: "challenge", prompt: true })]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /REPRODUCES EVERY LOGGED VERDICT/);
});

test("the same check logged as merely suspicious, with no earlier parameters, is a mismatch", () => {
  const r = replay([decision({ low: 10, verdict: "suspicious", prompt: false })]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /MISMATCH/);
});

test("a check below half is ok, and a short packet is warm-up", () => {
  const r = replay([decision({ low: 9, verdict: "ok", prompt: false }), decision({ low: 7, n: 15, windowTotal: 15, verdict: "warmup", prompt: false })]);
  assert.equal(r.code, 0, r.out);
});

test("three quarters of the windows low from eight windows on is still a passkey request in warm-up", () => {
  const r = replay([decision({ low: 12, n: 15, windowTotal: 15, verdict: "challenge", prompt: true, extra: { overwhelmingImpostor: true } })]);
  assert.equal(r.code, 0, r.out);
});

test("rows logged under the earlier confirmation are replayed under their own parameters", () => {
  const r = replay([
    decision({ low: 10, verdict: "suspicious", prompt: false, extra: earlier(1) }),
    decision({ low: 11, verdict: "challenge", prompt: true, extra: earlier(2) }),
  ]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /0 mismatch/);
});

test("an earlier row that asked at once without a second suspicious check is a mismatch", () => {
  const r = replay([decision({ low: 10, verdict: "challenge", prompt: true, extra: earlier(1) })]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /MISMATCH/);
});
