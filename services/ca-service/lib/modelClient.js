/**
 * The ONE way ca-service talks to model-api.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three modules (keystrokeSecurity.js, mouse.js, mouseActions.js) each carried their own
 * identical `postModelApi()` — a bare `fetch` with no credential and no deadline. That had
 * two consequences, both of which this module closes.
 *
 * 1. THE HOP WAS UNAUTHENTICATED.
 *    model-api has no notion of a caller. It was protected only by topology (`expose:`
 *    rather than `ports:`), and compose declared no networks at all, so every container on
 *    the default bridge — including the demo app and acme — could reach it directly and
 *    POST /api/user/train, /api/user/predict or /api/user/rollback for ANY userId. That is
 *    a biometric scoring oracle: score arbitrary windows against a victim's model and you
 *    can hill-climb an accepted forgery, no login required. `confine_path()` on the model
 *    side stops filesystem escape; it does nothing about naming another person's model,
 *    because the path is DERIVED from the caller's own userId field.
 *
 *    Now every request carries X-Api-Key, and model-api rejects anything without it. This
 *    is deliberately a SERVICE credential, not a user identity: the question it answers is
 *    "is this ca-service?", and the question "may this request act for this person?" is
 *    already answered one hop earlier by the gateway's RS256 assertion (lib/identityAssertion.js).
 *    ca-service is the only component that holds a verified identity AND the model key, so
 *    the two checks compose into: only a caller the gateway vouched for can reach a model.
 *
 * 2. THE HOP WAS UNBOUNDED.
 *    `await fetch(...)` with no AbortSignal means a wedged TensorFlow process hangs the
 *    keystroke check forever — and the keystroke check is the authentication path. The
 *    failure mode of the whole security layer under a dependency stall was undefined.
 *
 *    Now every call has a deadline, sized to the operation: inference is interactive and
 *    gets seconds, training is a batch job and gets minutes.
 *
 * FAILURE POLICY (deliberate, and the reasoning belongs in the open)
 * -----------------------------------------------------------------
 * When the model cannot answer, a continuous-auth layer has three bad options:
 *   fail-open   — treat "no score" as genuine. An attacker who can stall the model gets a
 *                 free pass, which defeats the entire system.
 *   fail-closed — treat "no score" as suspicious. A model outage then locks out every
 *                 legitimate user simultaneously: a self-inflicted denial of service.
 *   no verdict  — refuse to answer at all.
 *
 * We take the third. A `ModelUnavailableError` propagates to the route, which returns 503
 * `model_unavailable`. No verdict is issued, no risk token is minted, no lock is set, and
 * no clean run is recorded. The caller's last known state simply stands. This grants
 * nothing and revokes nothing, and — unlike fail-open — it is loud: every occurrence is
 * logged as a security event, because a spike in them is either an outage or someone
 * trying to arrange one.
 *
 * RETRIES
 * -------
 * One retry, on connection-level failure only, and only for inference. Never on a timeout
 * (the deadline already expressed how long we were willing to wait — retrying doubles the
 * latency we just declared unacceptable), never on a 4xx/5xx from the model (a re-send
 * cannot change a rejected payload), and never for training (expensive and not idempotent —
 * the durable job queue in trainingQueue.js is what makes training survivable, not retries).
 */

const MODEL_API_URL = process.env.MODEL_API_URL || "http://localhost:5000";
// Service credential. When unset the header is simply omitted — model-api's own check is
// likewise inactive when ITS key is unset, so local development without a key still works
// while any deployment that sets one is enforced end to end.
const MODEL_API_KEY = process.env.MODEL_API_KEY || "";

// Interactive scoring. Sits directly in the authentication path, so the bound is a latency
// budget, not a generosity: past this the user is waiting on a verdict that isn't coming.
const INFER_TIMEOUT_MS = Number(process.env.MODEL_INFER_TIMEOUT_MS || 5000);
// Per-user fine-tuning. Minutes, not seconds — a real training run on CPU. Reached
// synchronously only on first enrollment; adaptive retrains go through the job queue.
const TRAIN_TIMEOUT_MS = Number(process.env.MODEL_TRAIN_TIMEOUT_MS || 600000);

const TRAINING_PATHS = new Set(["/api/user/train"]);

class ModelUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ModelUnavailableError";
    this.code = "model_unavailable";
    this.cause = cause;
  }
}

/** A connection-level failure — the model never saw the request, so a resend is safe. */
function isConnectionError(err) {
  if (!err) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return false; // deadline, not connectivity
  // undici surfaces connection problems as TypeError("fetch failed") with a cause.
  return err.name === "TypeError" || ["ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND"].includes(err.cause?.code);
}

async function attempt(path, body, timeoutMs) {
  const headers = { "Content-Type": "application/json" };
  if (MODEL_API_KEY) headers["X-Api-Key"] = MODEL_API_KEY;
  const r = await fetch(`${MODEL_API_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 401 means our own credential is wrong. That is a deployment fault, not a model fault,
  // and it must not be mistaken for "the model is down" — say so plainly in the log.
  if (r.status === 401) {
    console.error("[model] 401 from model-api — MODEL_API_KEY does not match the model service's key");
    throw new ModelUnavailableError("model-api rejected the service credential");
  }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `model-api ${path} failed`);
  return data;
}

/**
 * POST to model-api with a deadline and a service credential.
 * Throws ModelUnavailableError when the model could not be reached or did not answer in
 * time; throws a plain Error when the model answered and rejected the request.
 */
async function postModelApi(path, body) {
  const isTraining = TRAINING_PATHS.has(path);
  const timeoutMs = isTraining ? TRAIN_TIMEOUT_MS : INFER_TIMEOUT_MS;
  const started = Date.now();
  try {
    return await attempt(path, body, timeoutMs);
  } catch (err) {
    if (err instanceof ModelUnavailableError) throw err;

    const timedOut = err.name === "AbortError" || err.name === "TimeoutError";
    if (timedOut) {
      console.error(`[model][SECURITY] ${path} exceeded ${timeoutMs}ms — no verdict issued`);
      throw new ModelUnavailableError(`model-api ${path} timed out after ${timeoutMs}ms`, err);
    }

    if (isConnectionError(err) && !isTraining) {
      console.warn(`[model] ${path} connection failed (${err.message}) — retrying once`);
      try {
        return await attempt(path, body, timeoutMs);
      } catch (retryErr) {
        console.error(`[model][SECURITY] ${path} unreachable after retry (${Date.now() - started}ms)`);
        throw new ModelUnavailableError(`model-api ${path} unreachable`, retryErr);
      }
    }
    if (isConnectionError(err)) {
      console.error(`[model][SECURITY] ${path} unreachable`);
      throw new ModelUnavailableError(`model-api ${path} unreachable`, err);
    }
    throw err; // the model answered and said no — a real application error, propagate it
  }
}

module.exports = { postModelApi, ModelUnavailableError, MODEL_API_URL };
