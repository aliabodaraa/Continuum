// The durable training queue's contract, the same on both backends: trainingQueue.test.js runs these on
// SQLite, trainingQueue.pg.test.js on PostgreSQL. Owed work is never lost, never doubled, never retried
// forever, and a job another copy of the service is running is never taken from it.
module.exports = function queueCases({ test, assert, db, q }) {
  const state = (id) => db.get("SELECT state, attempts, last_error, locked_by, lease_until FROM training_jobs WHERE id = ?", id);
  const at = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

  test("enqueue is idempotent while a job is queued or running", async () => {
    const a = await q.enqueue(1, "keystroke", "enrol");
    const b = await q.enqueue(1, "keystroke", "adaptive");
    assert.equal(b.deduped, true);
    assert.equal(b.id, a.id);
    const other = await q.enqueue(1, "mouse", "enrol");   // another modality is separate work
    assert.notEqual(other.id, a.id);
  });

  test("the database refuses a second pending job for one user and modality", async () => {
    // what two copies enqueueing at the same moment would both attempt
    await assert.rejects(db.run("INSERT INTO training_jobs (user_id, modality) VALUES (?, ?)", 1, "keystroke"), /unique/i);
  });

  test("a job runs once and is done; status shows nothing pending", async () => {
    const seen = [];
    q.registerHandler("keystroke", async (userId) => { seen.push(userId); });
    q.registerHandler("mouse", async () => {});
    await q.tick();
    assert.deepEqual(seen, [1]);
    assert.equal((await q.statusFor(1, "keystroke")).pending, null);
    assert.equal((await q.statusFor(1)).jobs.every((j) => j.state === "done"), true);
  });

  test("a failing job is retried, then failed with its error, never forever", async () => {
    q.registerHandler("keystroke", async () => { throw new Error("model-api down"); });
    const job = await q.enqueue(2, "keystroke", "enrol");
    await q.tick();   // attempt 1 fails and requeues; the loop picks it up again: attempt 2 fails for good
    const s = await state(job.id);
    assert.equal(s.state, "failed");
    assert.equal(s.attempts, 2);
    assert.match(s.last_error, /model-api down/);
    assert.equal(s.locked_by, null);
  });

  test("a running job whose lease ran out goes back to the queue, or fails once out of attempts", async () => {
    const a = await q.enqueue(3, "keystroke", "enrol");
    const b = await q.enqueue(4, "keystroke", "enrol");
    await db.run("UPDATE training_jobs SET state = 'running', attempts = 1, locked_by = 'gone', lease_until = ? WHERE id = ?", at(Date.now() - 1000), a.id);
    await db.run("UPDATE training_jobs SET state = 'running', attempts = 2, locked_by = NULL, lease_until = NULL WHERE id = ?", b.id);   // from before leases
    assert.equal(await q.recoverOrphans(), 2);
    assert.equal((await state(a.id)).state, "queued");
    assert.equal((await state(b.id)).state, "failed");
  });

  test("a job another copy is running (lease still valid) is left alone; its late finish is not recorded", async () => {
    const j = await q.enqueue(5, "keystroke", "enrol");
    await db.run("UPDATE training_jobs SET state = 'running', attempts = 1, locked_by = 'other-copy', lease_until = ? WHERE id = ?", at(Date.now() + 60000), j.id);
    assert.equal(await q.recoverOrphans(), 0);
    const s = await state(j.id);
    assert.equal(s.state, "running");
    assert.equal(s.locked_by, "other-copy");
    // this copy never claimed it, so a stray finish from here changes nothing (the guard on locked_by)
    const r = await db.run("UPDATE training_jobs SET state = 'done' WHERE id = ? AND locked_by = ?", j.id, q.INSTANCE);
    assert.equal(r.changes, 0);
  });

  test("a claimed job carries this copy's lease, renewed while it trains", async () => {
    let seen = null;
    q.registerHandler("keystroke", async () => { seen = await state(job.id); });
    const job = await q.enqueue(6, "keystroke", "enrol");
    await q.tick();
    assert.equal(seen.state, "running");
    assert.equal(seen.locked_by, q.INSTANCE);
    assert.ok(seen.lease_until > at(Date.now()), "the lease is in the future while it runs");
    const done = await state(job.id);
    assert.equal(done.state, "done");
    assert.equal(done.lease_until, null);
  });

  test("a reset cancels the user's owed work, the running job included, so a new enrolment queues its own at once", async () => {
    const queued = await q.enqueue(8, "keystroke", "adaptive");
    assert.equal(await q.cancel(8, "keystroke", "typing profile reset"), 1);
    assert.equal((await state(queued.id)).state, "cancelled");
    assert.equal((await q.statusFor(8, "keystroke")).pending, null);

    let calls = 0, fresh = null;
    q.registerHandler("keystroke", async (userId) => {
      calls += 1;
      if (calls === 1 && userId === 7) {   // the reset lands while the first job trains, and the user enrols again
        assert.equal(await q.cancel(7, "keystroke", "typing profile reset"), 1);
        fresh = await q.enqueue(7, "keystroke", "enrol");
      }
    });
    const first = await q.enqueue(7, "keystroke", "enrol");
    await q.tick();
    assert.equal(fresh.deduped, false, "the new enrolment got its own job, not the moot running one");
    const s = await state(first.id);
    assert.equal(s.state, "cancelled", "the moot job's late finish is not recorded");
    assert.equal(s.locked_by, null);
    assert.equal((await state(fresh.id)).state, "done");
    assert.equal(calls, 2);
  });
};
