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
 * One job at a time per copy of the service, deliberately. Training is CPU-bound TensorFlow work
 * sharing a host with live inference; running two at once lengthens both and starves the
 * authentication path, which is the one thing that must stay fast. Claiming is one statement
 * (with postgres, SKIP LOCKED), so two copies can never claim one row.
 *
 * SEVERAL COPIES
 * --------------
 * A claimed job carries a LEASE (locked_by, lease_until) that its worker renews every
 * HEARTBEAT_MS while the training runs. A copy recovers a "running" job only once its lease has
 * run out: the copy that held it is gone (a crash, an OOM kill). It used to requeue every running
 * job at start, which with two copies would have taken the other copy's live work. A worker that
 * finishes after losing its lease records nothing (the job is someone else's now).
 */
const crypto = require("crypto");
const db = require("../db");

const POLL_MS = Number(process.env.TRAINING_POLL_MS || 5000);
const MAX_ATTEMPTS = Number(process.env.TRAINING_MAX_ATTEMPTS || 3);
const LEASE_MS = Number(process.env.TRAINING_LEASE_MS || 120000);
const HEARTBEAT_MS = Math.max(1000, Math.floor(LEASE_MS / 4));
const INSTANCE = crypto.randomBytes(6).toString("hex");
// Timestamps in the store's text format ("YYYY-MM-DD HH:MM:SS", UTC), so they compare as text.
const at = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

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
const pendingOf = (userId, modality) => db.get(
  `SELECT id, state FROM training_jobs
   WHERE user_id = ? AND modality = ? AND state IN ('queued','running')
   ORDER BY id LIMIT 1`, userId, modality);

async function enqueue(userId, modality = "keystroke", reason = null) {
  const existing = await pendingOf(userId, modality);
  if (existing) return { ...existing, deduped: true };
  // The unique index on pending jobs (db.js) settles two copies enqueueing the same work at once.
  const r = await db.get("INSERT INTO training_jobs (user_id, modality, reason) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING id",
    userId, modality, reason);
  if (!r) return { ...(await pendingOf(userId, modality)), deduped: true };
  console.log(`[training] queued job ${r.id} user=${userId} modality=${modality} reason=${reason || "-"}`);
  return { id: r.id, state: "queued", deduped: false };
}

/** Claim the oldest queued job for this copy, with a lease, or null. One statement: one claimer. */
async function claimNext() {
  const pick = `SELECT id FROM training_jobs WHERE state = 'queued' ORDER BY id LIMIT 1${db.kind === "postgres" ? " FOR UPDATE SKIP LOCKED" : ""}`;
  const row = await db.get(
    `UPDATE training_jobs
     SET state = 'running', attempts = attempts + 1, started_at = CURRENT_TIMESTAMP, locked_by = ?, lease_until = ?
     WHERE id = (${pick}) AND state = 'queued'
     RETURNING *`, INSTANCE, at(Date.now() + LEASE_MS));
  return row || null;
}

// Records the outcome only while this copy still holds the job (its lease may have run out and the job
// been taken over); returns whether it did.
async function finish(id, state, lastError = null) {
  const r = await db.run(
    `UPDATE training_jobs SET state = ?, last_error = ?, finished_at = CURRENT_TIMESTAMP, locked_by = NULL, lease_until = NULL
     WHERE id = ? AND locked_by = ?`, state, lastError, id, INSTANCE);
  if (!r.changes) console.warn(`[training] job ${id}: lease lost or job cancelled before it finished; its outcome (${state}) is not recorded`);
  return r.changes > 0;
}

/**
 * A reset makes the owed work moot (2026-11-08). Queued jobs are cancelled. A running one is marked cancelled and
 * released too, so that a new enrolment can queue its own job at once: enqueue dedupes against queued AND running
 * jobs, and a moot running job would otherwise swallow it, leaving the user with no model. Its worker cannot be stopped
 * mid-fit: the handler sees that its samples are gone and saves nothing (lib/keystrokeSecurity.js), and finish() records
 * nothing for a job this copy no longer holds.
 */
async function cancel(userId, modality, why = null) {
  const r = await db.run(
    `UPDATE training_jobs SET state = 'cancelled', last_error = ?, finished_at = CURRENT_TIMESTAMP, locked_by = NULL, lease_until = NULL
     WHERE user_id = ? AND modality = ? AND state IN ('queued', 'running')`, why, userId, modality);
  if (r.changes) console.log(`[training] cancelled ${r.changes} job(s) user=${userId} modality=${modality}: ${why || "-"}`);
  return r.changes;
}

/**
 * Rows left `running` by a process that is gone. Requeue them if they have attempts left,
 * fail them if they do not — a job that has already crashed the service MAX_ATTEMPTS times
 * is more likely to be poison than unlucky, and retrying it forever would crash-loop the
 * worker on every boot.
 */
// Jobs left `running` whose lease ran out (no lease at all: from before leases). Each is taken in one
// statement guarded by its state and lease, so two copies recovering at once do it once.
async function recoverOrphans() {
  const now = at(Date.now());
  const orphans = await db.all(
    "SELECT id, user_id, attempts FROM training_jobs WHERE state = 'running' AND (lease_until IS NULL OR lease_until < ?)", now);
  let n = 0;
  for (const j of orphans) {
    const terminal = j.attempts >= MAX_ATTEMPTS;
    const r = await db.run(
      `UPDATE training_jobs SET state = ?, started_at = CASE WHEN ? = 'queued' THEN NULL ELSE started_at END,
         finished_at = CASE WHEN ? = 'failed' THEN CURRENT_TIMESTAMP ELSE finished_at END,
         last_error = CASE WHEN ? = 'failed' THEN ? ELSE last_error END, locked_by = NULL, lease_until = NULL
       WHERE id = ? AND state = 'running' AND (lease_until IS NULL OR lease_until < ?)`,
      terminal ? "failed" : "queued", terminal ? "failed" : "queued", terminal ? "failed" : "queued", terminal ? "failed" : "queued",
      `abandoned after ${j.attempts} attempts (service restarted mid-run)`, j.id, now);
    if (!r.changes) continue;
    n += 1;
    if (terminal) console.warn(`[training] job ${j.id} (user=${j.user_id}) failed — exhausted attempts across restarts`);
    else console.log(`[training] job ${j.id} (user=${j.user_id}) requeued after its worker was lost`);
  }
  return n;
}

async function runOne() {
  const job = await claimNext();
  if (!job) return false;

  const handler = handlers.get(job.modality);
  if (!handler) {
    await finish(job.id, "failed", `no handler registered for modality "${job.modality}"`);
    console.error(`[training] job ${job.id}: no handler for modality ${job.modality}`);
    return true;
  }

  // Keep the lease while the training runs (it can take minutes).
  const beat = setInterval(() => {
    db.run("UPDATE training_jobs SET lease_until = ? WHERE id = ? AND locked_by = ?", at(Date.now() + LEASE_MS), job.id, INSTANCE)
      .catch((e) => console.error(`[training] job ${job.id}: lease not renewed: ${e.message}`));
  }, HEARTBEAT_MS);
  beat.unref();
  const started = Date.now();
  try {
    await handler(job.user_id, job);
    clearInterval(beat);
    if (await finish(job.id, "done")) console.log(`[training] job ${job.id} done user=${job.user_id} in ${Date.now() - started}ms`);
  } catch (err) {
    clearInterval(beat);
    const terminal = job.attempts >= MAX_ATTEMPTS;
    await finish(job.id, terminal ? "failed" : "queued", err.message);
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
    await recoverOrphans();   // a job whose copy died is picked up by whichever copy polls next
    // Loop so a backlog clears in one pass instead of one job per poll interval.
    while (await runOne()) { /* keep going until the queue is empty */ }
  } catch (err) {
    console.error("[training] worker loop error:", err.message);
  } finally {
    draining = false;
  }
}

function start() {
  timer = setInterval(tick, POLL_MS);
  if (timer.unref) timer.unref(); // never hold the process open just to poll
  setImmediate(tick);             // don't wait a full interval for a backlog (tick recovers orphans first)
  console.log(`[training] worker ${INSTANCE} started (poll=${POLL_MS}ms, maxAttempts=${MAX_ATTEMPTS}, lease=${LEASE_MS}ms)`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function statusFor(userId, modality = null) {
  const rows = modality
    ? await db.all("SELECT * FROM training_jobs WHERE user_id = ? AND modality = ? ORDER BY id DESC LIMIT 20", userId, modality)
    : await db.all("SELECT * FROM training_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 20", userId);
  const pending = rows.find((r) => r.state === "queued" || r.state === "running") || null;
  return { pending, jobs: rows };
}

module.exports = { registerHandler, enqueue, cancel, start, stop, statusFor, recoverOrphans, tick, MAX_ATTEMPTS, INSTANCE, LEASE_MS };
