// The data layer's contract (db.js), the same on both backends: db.test.js runs these on SQLite,
// db.pg.test.js on PostgreSQL. What the service relies on: values read back exactly as SQLite stored them,
// transactions that hold everything inside them and nothing from outside, and read-modify-writes that do
// not lose an update when requests overlap.
module.exports = function dbCases({ test, assert, db, lock, decisionState }) {
  test("timestamps are SQLite's UTC text; a 2^52-range user id comes back exactly", async () => {
    const id = await db.insert("INSERT INTO auth_decisions (user_id, source) VALUES (?, ?)", 4491128458193823, "t");
    const r = await db.get("SELECT user_id, checked_at FROM auth_decisions WHERE id = ?", id);
    assert.equal(r.user_id, 4491128458193823);
    assert.match(r.checked_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    const t = await db.get("SELECT CURRENT_TIMESTAMP AS t1, datetime('now') AS t2");
    assert.match(t.t1, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.match(t.t2, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.ok(Math.abs(Date.parse(t.t1.replace(" ", "T") + "Z") - Date.now()) < 60000, "UTC, now");
  });

  test("insert returns the new id, and ids increase", async () => {
    const a = await db.insert("INSERT INTO mouse_samples (user_id, windows, window_count) VALUES (?, ?, ?)", 11, "[]", 3);
    const b = await db.insert("INSERT INTO mouse_samples (user_id, windows, window_count) VALUES (?, ?, ?)", 11, "[]", 4);
    assert.equal(typeof a, "number");
    assert.ok(b > a);
  });

  test("result names keep their case; counts, sums and averages are numbers; floats are exact", async () => {
    const r = await db.get("SELECT COUNT(*) AS totalRows, COALESCE(SUM(window_count), 0) AS sumWindows FROM mouse_samples WHERE user_id = ?", 11);
    assert.deepEqual(r, { totalRows: 2, sumWindows: 7 });
    await db.run("INSERT INTO auth_decisions (user_id, source, mean_score) VALUES (?, ?, ?)", 12, "f", 0.123456789012345);
    await db.run("INSERT INTO auth_decisions (user_id, source, mean_score) VALUES (?, ?, ?)", 12, "f", 0.1);
    const f = await db.all("SELECT mean_score FROM auth_decisions WHERE user_id = ? ORDER BY id", 12);
    assert.deepEqual(f.map((x) => x.mean_score), [0.123456789012345, 0.1]);
    const avg = await db.get("SELECT AVG(mean_score) AS avg_score FROM auth_decisions WHERE user_id = ?", 12);
    assert.equal(typeof avg.avg_score, "number");
  });

  test("a ? inside a quoted string is text, not a placeholder", async () => {
    await db.run("INSERT INTO tenants (tenant_id, name) VALUES (?, 'what?')", "t-q");
    const r = await db.get("SELECT name FROM tenants WHERE name = 'what?' AND tenant_id = ?", "t-q");
    assert.equal(r.name, "what?");
  });

  test("a transaction writes everything or nothing", async () => {
    await assert.rejects(db.tx(async () => {
      await db.run("INSERT INTO session_locks (user_id, locked_at) VALUES (?, ?)", 401, "x");
      throw new Error("boom");
    }), /boom/);
    assert.equal(await db.get("SELECT 1 AS one FROM session_locks WHERE user_id = ?", 401), undefined);
  });

  test("inside a transaction a module's own query runs in it (sees the uncommitted row)", async () => {
    await assert.rejects(db.tx(async () => {
      await lock.setLocked(402);
      assert.equal(await lock.isLocked(402), true);
      throw new Error("undo");
    }), /undo/);
    assert.equal(await lock.isLocked(402), false);
  });

  test("a call from another request never runs inside an open transaction", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const tx = db.tx(async () => {
      await db.run("INSERT INTO session_locks (user_id, locked_at) VALUES (?, ?)", 501, "in-tx");
      await gate;   // the transaction stays open while the other request runs
      throw new Error("rolled back");
    });
    await new Promise((r) => setTimeout(r, 20));
    const outside = db.run("INSERT INTO session_locks (user_id, locked_at) VALUES (?, ?)", 502, "outside");
    await new Promise((r) => setTimeout(r, 50));
    release();
    await assert.rejects(tx, /rolled back/);
    await outside;
    assert.equal(await db.get("SELECT 1 AS one FROM session_locks WHERE user_id = ?", 501), undefined);
    assert.ok(await db.get("SELECT 1 AS one FROM session_locks WHERE user_id = ?", 502), "the other request's write survives the rollback");
  });

  test("overlapping read-modify-writes of the decision counters lose no update", async () => {
    // 25 suspicious packets of one user handled at once (two copies of the service, say): every one counts
    await Promise.all(Array.from({ length: 25 }, () => decisionState.updateMouseStreak(77, { isSuspicious: true, warmup: false })));
    assert.equal(await decisionState.getMouseStreak(77), 25);
    assert.equal(await decisionState.updateMouseStreak(77, { isSuspicious: true, warmup: false }), 26);
  });

  test("the schema holds every table the service uses", async () => {
    for (const [name] of db.TABLES) {
      const r = await db.get(`SELECT COUNT(*) AS n FROM ${name}`);
      assert.equal(typeof r.n, "number", name);
    }
  });
};
