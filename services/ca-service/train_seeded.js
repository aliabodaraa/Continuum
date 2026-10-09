// Train per-user models for the seeded accounts.
//
// Resumable: skips any account that already has a profile, so a restart after an
// interruption costs nothing. The previous run stalled for two hours because model-api
// restarted mid-request and the fetch in postModelApi has no timeout, leaving ca-service
// waiting forever on a socket nobody would answer. Progress is therefore flushed after every
// account and a watchdog bounds each training call.
const fs = require("fs");
const db = require("/app/db.js");
const ks = require("/app/lib/keystrokeSecurity.js");
const map = JSON.parse(fs.readFileSync("/app/idmap.json", "utf8"));

const TIMEOUT_MS = 6 * 60 * 1000;
const withTimeout = (p, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)),
  ]);

(async () => {
  const trained = new Set((await db.all("SELECT user_id FROM user_typing_profiles")).map((r) => r.user_id));
  const todo = Object.entries(map).filter(([, id]) => !trained.has(id));
  console.log(`${trained.size} already trained; ${todo.length} to do`);
  let ok = 0, fail = 0;
  for (const [name, id] of todo) {
    const t0 = Date.now();
    try {
      const p = await withTimeout(ks.trainUserTypingProfile(id, db), name);
      if (p) {
        ok++;
        console.log(`${name} (id ${id}): thr=${p.threshold} posWin=${p.positiveWindowCount} acc=${(p.trainingAccuracy || 0).toFixed(3)} [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
      } else {
        fail++;
        console.log(`${name} (id ${id}): NOT TRAINED (below gate)`);
      }
    } catch (e) {
      fail++;
      console.log(`${name} (id ${id}): ERROR ${e.message}`);
    }
  }
  console.log(`\ntrained ${ok}, failed ${fail}`);
  await db.close();
})();
