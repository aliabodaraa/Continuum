/**
 * Durable training queue.
 *
 * WHAT IT REPLACES
 * ----------------
 * Background retraining was `setImmediate(async () => { await train(...) })`, deduplicated
 * by an in-memory `Set` (`adaptiveRetrainsInFlight` in server.js, `loginRetrainsInFlight`
 * in keystrokeSecurity.js). Two ways that lost work silently:
 *
 *   • A restart during a run abandoned it. Nothing recorded that training had been owed, so
 *     it was never picked up again — the user's model simply stopped keeping up with them,
 *     with no error anywhere.
 *   • The dedupe guard died with the process, so the same work could also be started twice.
 *
 * A row in `training_jobs` is the durable record of owed work: enqueue is a write, and the
 * work is only forgotten once a row says `done`. On boot, `recoverOrphans()` returns
 * anything still marked `running` to `queued` — a process that no longer exists cannot be
 * running anything, so such rows are always crash debris.
 *
 * WHY NOT A BROKER
 * ----------------
 * Redis + Bull (or NATS) is the reflex here, and it is the wrong size. This is one producer,
 * one consumer, one machine, and at most a handful of jobs a day. A table plus a loop gives
 * the same durability, crash recovery and dedupe with no new stateful service to deploy,
 * back up or fail — and it inherits ca.db's existing volume and export scripts for free.
 * The pattern (a durable delayed-job queue) is worth borrowing; the infrastructure is not.
 *
 * CONCURRENCY
 * -----------
 * One job at a time, deliberately. Training is CPU-bound TensorFlow work sharing a host
 * with live inference; running two at once lengthens both and starves the authentication
 * path, which is the one thing that must stay fast. Claiming is a single UPDATE guarded by
 * `state = 'queued'`, so even if that assumption is relaxed later, two workers can never
 * claim one row (better-sqlite3 serialises writes).
 */
const db = require("../db");

const POLL_MS = Number(process.env.TRAINING_POLL_MS || 5000);
const MAX_ATTEMPTS = Number(process.env.TRAINING_MAX_ATTEMPTS || 3);

// modality -> async (userId) => any. Registered by server.js so this module stays free of
// any dependency on the training implementations (and stays testable with a fake handler).
const handlers = new Map();

function registerHandler(modality, fn) {
  handlers.set(modality, fn);
}

/**
 * Record that `userId` is owed a retrain.
 *
 * Idempotent by design: if a job for this (user, modality) is already queued or running,
 * this is a no-op returning the existing row. That is the durable replacement for the
 * in-memory `Set`, and it means callers can enqueue on every eligible submission without
 * having to reason about whether one is already pending.
 */
function enqueue(userId, modality = "keystroke", reason = null) {
  const existing = db
    .prepare(
      `SELECT id, state FROM training_jobs
       WHERE user_id = ? AND modality = ? AND state IN ('queued','running')
       ORDER BY id LIMIT 1`,
    )
    .get(userId, modality);
  if (existing) return { ...existing, deduped: true };

  const r = db
    .prepare("INSERT INTO training_jobs (user_id, modality, reason) VALUES (?, ?, ?)")
    .run(userId, modality, reason);
  console.log(`[training] queued job ${r.lastInsertRowid} user=${userId} modality=${modality} reason=${reason || "-"}`);
  return { id: r.lastInsertRowid, state: "queued", deduped: false };
}

/** Claim the oldest queued job, or null. The UPDATE's WHERE clause is the lock. */
function claimNext() {
  const row = db.prepare("SELECT * FROM training_jobs WHERE state = 'queued' ORDER BY id LIMIT 1").get();
  if (!row) return null;
  const claimed = db
    .prepare(
      `UPDATE training_jobs
       SET state = 'running', attempts = attempts + 1, started_at = CURRENT_TIMESTAMP
       WHERE id = ? AND state = 'queued'`,
    )
    .run(row.id);
  if (claimed.changes === 0) return null; // someone else took it
  return { ...row, attempts: row.attempts + 1 };
}

function finish(id, state, lastError = null) {
  db.prepare(
    "UPDATE training_jobs SET state = ?, last_error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(state, lastError, id);
}

/**
 * Rows left `running` by a process that is gone. Requeue them if they have attempts left,
 * fail them if they do not — a job that has already crashed the service MAX_ATTEMPTS times
 * is more likely to be poison than unlucky, and retrying it forever would crash-loop the
 * worker on every boot.
 */
function recoverOrphans() {
  const orphans = db.prepare("SELECT id, user_id, attempts FROM training_jobs WHERE state = 'running'").all();
  if (!orphans.length) return 0;
  for (const j of orphans) {
    if (j.attempts >= MAX_ATTEMPTS) {
      finish(j.id, "failed", `abandoned after ${j.attempts} attempts (service restarted mid-run)`);
      console.warn(`[training] job ${j.id} (user=${j.user_id}) failed — exhausted attempts across restarts`);
    } else {
      db.prepare("UPDATE training_jobs SET state = 'queued', started_at = NULL WHERE id = ?").run(j.id);
      console.log(`[training] job ${j.id} (user=${j.user_id}) requeued after restart`);
    }
  }
  return orphans.length;
}

async function runOne() {
  const job = claimNext();
  if (!job) return false;

  const handler = handlers.get(job.modality);
  if (!handler) {
    finish(job.id, "failed", `no handler registered for modality "${job.modality}"`);
    console.error(`[training] job ${job.id}: no handler for modality ${job.modality}`);
    return true;
  }

  const started = Date.now();
  try {
    await handler(job.user_id, job);
    finish(job.id, "done");
    console.log(`[training] job ${job.id} done user=${job.user_id} in ${Date.now() - started}ms`);
  } catch (err) {
    const terminal = job.attempts >= MAX_ATTEMPTS;
    finish(job.id, terminal ? "failed" : "queued", err.message);
    console.error(
      `[training] job ${job.id} ${terminal ? "FAILED permanently" : "will retry"} ` +
        `(attempt ${job.attempts}/${MAX_ATTEMPTS}) user=${job.user_id}: ${err.message}`,
    );
  }
  return true;
}

let timer = null;
let draining = false;

/** Drain the queue, then wait POLL_MS. Never overlaps itself. */
async function tick() {
  if (draining) return;
  draining = true;
  try {
    // Loop so a backlog clears in one pass instead of one job per poll interval.
    while (await runOne()) { /* keep going until the queue is empty */ }
  } catch (err) {
    console.error("[training] worker loop error:", err.message);
  } finally {
    draining = false;
  }
}

function start() {
  const recovered = recoverOrphans();
  if (recovered) console.log(`[training] recovered ${recovered} interrupted job(s) from the previous run`);
  timer = setInterval(tick, POLL_MS);
  if (timer.unref) timer.unref(); // never hold the process open just to poll
  setImmediate(tick);             // don't wait a full interval for a backlog
  console.log(`[training] worker started (poll=${POLL_MS}ms, maxAttempts=${MAX_ATTEMPTS})`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function statusFor(userId, modality = null) {
  const rows = modality
    ? db.prepare("SELECT * FROM training_jobs WHERE user_id = ? AND modality = ? ORDER BY id DESC LIMIT 20").all(userId, modality)
    : db.prepare("SELECT * FROM training_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 20").all(userId);
  const pending = rows.find((r) => r.state === "queued" || r.state === "running") || null;
  return { pending, jobs: rows };
}

module.exports = { registerHandler, enqueue, start, stop, statusFor, recoverOrphans, tick, MAX_ATTEMPTS };
