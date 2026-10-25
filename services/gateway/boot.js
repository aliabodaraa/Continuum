// Waiting for the database at start. In Kubernetes (and after a Docker restart) a service often starts
// before PostgreSQL answers: its name does not resolve yet (EAI_AGAIN), the port refuses, or the server is
// "starting up". Exiting at once is correct but slow to recover from: the orchestrator restarts the
// process with a growing back-off (up to five minutes), so the service comes back long after the database
// did, and every restart counts as a crash. Instead, a transient failure is retried for a bounded time
// (BOOT_WAIT_MS, default two minutes); a setting error (no code of its own) fails at once, as before.
const TRANSIENT_CODES = new Set([
  "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "EPIPE",
  "57P03",   // the database system is starting up
  "53300",   // too many connections (the other copies are starting too)
  "08000", "08001", "08003", "08006",   // connection exceptions
  "3D000",   // the database does not exist yet (the operator creates it after the cluster is up)
  "28000", "28P01",   // the login does not exist yet / its password is not applied yet (managed roles)
]);
const transient = (e) => e && (TRANSIENT_CODES.has(e.code) || TRANSIENT_CODES.has(e.cause && e.cause.code)
  || /starting up|shutting down|terminating connection|Connection terminated/i.test(e.message || ""));

async function waitFor(what, open, { log = console.error, waitMs = Number(process.env.BOOT_WAIT_MS || 120000), stepMs = 2000 } = {}) {
  const until = Date.now() + waitMs;
  for (let attempt = 1; ; attempt++) {
    try { return await open(); }
    catch (e) {
      const left = until - Date.now();
      if (!transient(e) || left <= 0) throw e;
      if (attempt === 1 || attempt % 5 === 0) log(`[boot] ${what} not ready (${e.code || ""} ${e.message}); retrying for another ${Math.ceil(left / 1000)} s`);
      await new Promise((r) => setTimeout(r, Math.min(stepMs, left)));
    }
  }
}

module.exports = { waitFor, transient };
