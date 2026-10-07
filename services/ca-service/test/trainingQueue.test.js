// Unit tests for the durable training queue: owed work is never lost, never doubled, never retried forever.
// A throwaway database: never the real ca.db.
const os = require("os");
const path = require("path");
const fs = require("fs");
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ca-queue-")), "test.db");
process.env.TRAINING_MAX_ATTEMPTS = "2";

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const q = require("../lib/trainingQueue");

const state = (id) => db.prepare("SELECT state, attempts, last_error FROM training_jobs WHERE id = ?").get(id);

test("enqueue is idempotent while a job is queued or running", () => {
  const a = q.enqueue(1, "keystroke", "enrol");
  const b = q.enqueue(1, "keystroke", "adaptive");
  assert.equal(b.deduped, true);
  assert.equal(b.id, a.id);
  const other = q.enqueue(1, "mouse", "enrol");   // another modality is separate work
  assert.notEqual(other.id, a.id);
});

test("a job runs once and is done; status shows nothing pending", async () => {
  const seen = [];
  q.registerHandler("keystroke", async (userId) => { seen.push(userId); });
  q.registerHandler("mouse", async () => {});
  await q.tick();
  assert.deepEqual(seen, [1]);
  assert.equal(q.statusFor(1, "keystroke").pending, null);
  assert.equal(q.statusFor(1).jobs.every((j) => j.state === "done"), true);
});

test("a failing job is retried, then failed with its error, never forever", async () => {
  q.registerHandler("keystroke", async () => { throw new Error("model-api down"); });
  const job = q.enqueue(2, "keystroke", "enrol");
  await q.tick();   // attempt 1 fails and requeues; the loop picks it up again: attempt 2 fails for good
  const s = state(job.id);
  assert.equal(s.state, "failed");
  assert.equal(s.attempts, 2);
  assert.match(s.last_error, /model-api down/);
});

test("after a crash, running jobs go back to the queue, or fail once out of attempts", () => {
  const a = q.enqueue(3, "keystroke", "enrol");
  const b = q.enqueue(4, "keystroke", "enrol");
  db.prepare("UPDATE training_jobs SET state = 'running', attempts = 1 WHERE id = ?").run(a.id);
  db.prepare("UPDATE training_jobs SET state = 'running', attempts = 2 WHERE id = ?").run(b.id);
  assert.equal(q.recoverOrphans(), 2);
  assert.equal(state(a.id).state, "queued");
  assert.equal(state(b.id).state, "failed");
});
