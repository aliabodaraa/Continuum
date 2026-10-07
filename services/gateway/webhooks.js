// Delivers the risk-change events (CAEP Security Event Tokens) that a risk change wrote to the outbox
// (storage.js, STORAGE=postgres). Every gateway copy runs one of these; the database hands each event to
// one copy at a time (SKIP LOCKED with a lease), so adding copies adds delivery capacity, never
// duplicates by design. Delivery is at least once: a copy that dies mid-delivery leaves the event to the
// next, so receivers drop repeats by the token's `jti`.
//
// A failed delivery (no answer, a timeout, any status but 2xx) is retried with exponential backoff and
// jitter: 5 s, 10 s, 20 s ... capped at an hour. After the last attempt the event is "dead" and the
// tenant's activity log says so. A slow or broken receiver therefore never delays a check: checks only
// write the outbox row.
const DEFAULTS = { intervalMs: 1000, batch: 10, leaseMs: 30000, maxAttempts: 8, timeoutMs: 5000, baseDelayMs: 5000, maxDelayMs: 3600000 };

function createDispatcher({ storage, onDead, log = console.error, fetchImpl = fetch, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  let timer = null, busy = false, again = false;

  const backoff = (attempts) => Math.round(Math.min(o.baseDelayMs * 2 ** (attempts - 1), o.maxDelayMs) * (0.8 + Math.random() * 0.4));

  async function deliver(row) {
    let error = null;
    try {
      const r = await fetchImpl(row.url, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs),
        headers: { "Content-Type": "application/secevent+jwt" }, body: row.body,
      });
      if (r.status >= 200 && r.status < 300) return storage.finishWebhook(row.id, { ok: true });
      error = `HTTP ${r.status}`;
    } catch (e) {
      error = e && e.name === "TimeoutError" ? "timeout" : (e.cause && (e.cause.code || e.cause.message)) || e.message;
    }
    if (row.attempts >= o.maxAttempts) {
      await storage.finishWebhook(row.id, { error, dead: true });
      log(`[caep] event ${row.id} for ${row.siteKey} undeliverable after ${row.attempts} attempts: ${error}`);
      if (onDead) onDead(row, error);
      return;
    }
    await storage.finishWebhook(row.id, { error, retryInMs: backoff(row.attempts) });
  }

  // One pass: claim what is due and deliver it. A pass already running takes the next one over when it
  // ends (a kick during a pass is not lost).
  async function tick() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        const rows = await storage.claimWebhooks(o.batch, o.leaseMs);
        await Promise.all(rows.map((row) => deliver(row).catch((e) => log(`[caep] event ${row.id}: ${e.message}`))));
        if (rows.length === o.batch) again = true;
      } while (again);
    } catch (e) {
      log(`[caep] outbox unavailable: ${e.message}`);
    } finally { busy = false; }
  }

  return {
    start() { if (!timer) { timer = setInterval(tick, o.intervalMs); timer.unref(); } },
    stop() { clearInterval(timer); timer = null; },
    kick() { tick(); },   // right after an event is queued, so it leaves without waiting for the next pass
    tick,
  };
}

module.exports = { createDispatcher, DEFAULTS };
