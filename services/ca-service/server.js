// Continuum CA service — the behavioral continuous-authentication engine as a
// standalone microservice. Owns keystroke + mouse models/data and scores via the
// model-api. Stateless w.r.t. the caller: every endpoint takes an explicit
// userId. It returns VERDICTS; the demo/BFF applies session + passkey policy.
require("./lib/log")("ca-service");   // LOG_FORMAT=json: one JSON object per log line
const express = require("express");
const crypto = require("crypto");
const db = require("./db");
const { waitFor } = require("./lib/boot");
const ks = require("./lib/keystrokeSecurity");
const mouse = require("./lib/mouse");
const mouseUse = require("./lib/mouseUse");
const mouseActions = require("./lib/mouseActions");
const lock = require("./lib/lock");
const decisionState = require("./lib/decisionState");
const trainingQueue = require("./lib/trainingQueue");
const studyLog = require("./lib/studyLog");
const appSettings = require("./lib/appSettings");
const runtimeSettings = require("./lib/runtimeSettings");
const adaptive = require("./lib/adaptive");
const { ModelUnavailableError } = require("./lib/modelClient");

const PORT = Number(process.env.PORT || 4100);
const API_KEY = process.env.CA_API_KEY || "";

// ---- signed risk verdicts (the PDP's attestation) ----
// Every verdict is signed as a short-lived HS256 JWT so a relying party (the
// host app's backend, via the @continuum/node middleware) can ENFORCE the
// decision without trusting the browser. Dependency-free (Node crypto).
const RISK_SECRET = process.env.CA_SIGNING_SECRET || "dev-continuum-risk-secret";
// The production image (NODE_ENV=production) refuses to start without its secrets, or with a development
// default. Development keeps running with the defaults.
if (process.env.NODE_ENV === "production") {
  const missing = [];
  if (RISK_SECRET === "dev-continuum-risk-secret") missing.push("CA_SIGNING_SECRET");
  if (!process.env.MODEL_API_KEY) missing.push("MODEL_API_KEY");
  if (missing.length) {
    console.error(`[ca] refusing to start in production without: ${missing.join(", ")} (openssl rand -hex 32 each)`);
    process.exit(1);
  }
}
const RISK_TTL_SEC = Number(process.env.CA_RISK_TTL_SEC || 90);
function b64url(s) { return Buffer.from(s).toString("base64url"); }
function signRisk(userId, risk, modality) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: "continuum-ca", sub: String(userId), risk, modality,
    iat: now, exp: now + RISK_TTL_SEC,
  }));
  const data = header + "." + payload;
  const sig = crypto.createHmac("sha256", RISK_SECRET).update(data).digest("base64url");
  return data + "." + sig;
}
function riskLevel(isWarmup, isSuspicious) {
  return isWarmup ? "warmup" : isSuspicious ? "suspicious" : "genuine";
}
// A locked account (a step-up asked for and not yet passed) gets no new verdict: every check answers 423 "locked",
// signed suspicious, and asks for the passkey again, whichever tab or client sends it. Until 2026-11-08 the lock was
// read only at page load (lock/status), so another tab already open kept receiving genuine and warm-up tokens.
// A locked account adds nothing to its profile until the passkey is verified (2026-11-10): no enrolment, no sample, no
// real-use sample. Otherwise the person the lock is about could enrol their own typing or mouse into a channel the owner
// had not enrolled yet, and be accepted on it afterwards while the owner was refused.
async function refuseIfLocked(res, userId) {
  if (!(await lock.isLocked(userId))) return false;
  res.status(423).json({ ok: false, locked: true, error: "account_locked", requiresPasskeyChallenge: true,
    message: "This account is locked until the passkey is verified." });
  return true;
}
async function lockedAnswer(res, userId, modality) {
  if (!(await lock.isLocked(userId))) return false;
  res.status(423).json({
    ok: false, checked: true, locked: true, warmup: false, isSuspicious: true, requiresPasskeyChallenge: true,
    riskToken: signRisk(userId, "suspicious", modality),
    message: "This account is locked until the passkey is verified.",
  });
  return true;
}

// ---- adaptive-learning + paste policy (ported from the old demo route) ----
const ADAPTIVE_CONFIDENCE_MIN = 0.8;
// A high MEAN can hide one weak window; every window in a contributed packet must
// clear this floor too, or a borderline moment could quietly enter the training set.
const ADAPTIVE_WINDOW_FLOOR = 0.8;
// Adaptive retraining runs in cycles (lib/adaptive.js, the owner's design of 2026-10-04): three clean,
// non-overlapping samples are collected (pending, used by nothing), the user retrains with a passkey,
// then the feature pauses for the organisation's gap (default 3 hours, lib/appSettings.js). It replaced
// "at most one sample per calendar day, automatic retrain after three". Experiment AR measured that
// earlier rule; its samples were already non-overlapping and retrained after three, so the cycle
// changes the pace and adds the passkey, not which samples pass.
// The paste rule counts ACTUAL captured paste events per field against the organisation's allowance
// (ks.pastePolicyViolation), not a keystroke-coverage ratio. The ratio (keydownCount / textLength)
// false-positived whenever the event buffer no longer spanned the full field text, which happens legitimately
// after a step-up (the tracker resets but the textarea keeps its prior text) and for long entries; those cases
// read as "paste" -> win=0 -> warm-up -> a free pass for the impostor. A genuine paste fires a DOM paste event.
function pastePolicyEvaluation(quality, metrics) {
  return {
    modelConfidence: 0,
    isSuspicious: true,
    reason: "More pastes into one field than this organisation allows. Pasted text is not judged as typing, so passkey verification is required.",
    modelAvailable: true,
    modelType: "paste-policy",
    metrics: metrics || {},
    typingQuality: quality,
  };
}
// A typing top-up (the enrolment route below): samples the user adds to a trained model after the passkey, three of them
// in one sitting, as the adaptive cycle's three by default. They wait as the adaptive popup's pending samples do (not
// training samples, so no retrain of any kind uses them) until the passkey is verified again after the third
// (/v1/keystroke/topup/confirm, 2026-11-26, as the adaptive popup's retrain); then they become training samples and
// the model is rebuilt. Samples that have waited longer than the sitting, or since before the present model, are
// deleted: an unfinished or unconfirmed top-up never reaches a model.
const KS_TOPUP_SAMPLES = 3, TOPUP_PURPOSE = "top-up", TOPUP_WAITING = "top-up-pending";
const TOPUP_SITTING_MS = 16 * 60000;   // a little over the life of the gateway's grant (15 minutes)
const timeText = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");   // as the database writes submitted_at
async function topUpWaitingIds(userId, trainedAt) {
  const stale = await db.all("SELECT id FROM keystroke_texts WHERE user_id = ? AND sample_purpose = ? AND (submitted_at < ? OR submitted_at <= ?)",
    userId, TOPUP_WAITING, timeText(Date.now() - TOPUP_SITTING_MS), trainedAt || "");
  for (const r of stale) {   // keystroke_events has no cascading key
    await db.run("DELETE FROM keystroke_events WHERE keystroke_text_id = ?", r.id);
    await db.run("DELETE FROM keystroke_texts WHERE id = ?", r.id);
  }
  return (await db.all("SELECT id FROM keystroke_texts WHERE user_id = ? AND sample_purpose = ? ORDER BY id", userId, TOPUP_WAITING)).map((r) => r.id);
}
async function countTrainingSamplesSince(userId, trainedAt) {
  return (await db.get(
      `SELECT COUNT(*) as count FROM keystroke_texts
       WHERE user_id = ? AND is_training = 1 AND is_suspicious = 0 AND submitted_at > ?`,
      userId, trainedAt || "1970-01-01")).count;
}
// A repeated phrase teaches the model nothing new and lets one piece of content
// silently dominate the positive class. text_hash is already computed and stored on
// every sample (storeTextSample); this just checks it before accepting a new one.
async function hasDuplicateTrainingText(userId, hash) {
  return (
    (await db.get(
        `SELECT 1 FROM keystroke_texts WHERE user_id = ? AND (is_training = 1 OR sample_purpose = 'adaptive-pending')
           AND text_hash = ? LIMIT 1`,
        userId, hash)) != null
  );
}
// Every already-enrolled sample's raw events, for the rhythm-consistency check — the
// comparison needs raw digraph timing, not the derived windows or the model's opinion.
async function getTrainingEventsForUser(userId) {
  const textIds = (await db.all(`SELECT id FROM keystroke_texts WHERE user_id = ? AND is_training = 1 ORDER BY id`, userId))
    .map((r) => r.id);
  const out = [];
  for (const id of textIds) {
    // equal timestamps in stored order, as in getSampleEvents (lib/keystrokeSecurity.js)
    out.push(await db.all(
        `SELECT key_code as keyCode, event_type as eventType, timestamp_relative as timestampRelative,
                field_name as fieldName, field_type as fieldType
         FROM keystroke_events WHERE keystroke_text_id = ? ORDER BY timestamp_relative ASC, id ASC`,
        id));
  }
  return out;
}
// The pause after a retrain: no sample before this time (null = now).
async function nextContributionAt(userId, settings) {
  const wait = appSettings.contributionWaitMs(await adaptive.lastRetrainAt(userId), Date.now(), settings.adaptiveGapHours);
  return wait > 0 ? new Date(Date.now() + wait).toISOString() : null;
}
// Events typed in a field type the organisation excludes never reach scoring or storage. Not applied to
// enrolment: its samples are typed in Continuum's own wizard, not in the organisation's fields.
const excludeFields = (req, res, next) => {
  if (req.body && Array.isArray(req.body.keystrokeEvents)) {
    req.body.keystrokeEvents = appSettings.withoutExcludedFields(req.body.keystrokeEvents, appSettings.forRequest(req).excludeFieldTypes);
  }
  next();
};
// A channel the organisation turned off is refused outright, so a modified client cannot keep
// sending that data (the SDK and the extension stop asking once the settings say "off").
const channelOn = (channel) => (req, res, next) =>
  appSettings.forRequest(req)[channel] === "off"
    ? res.status(409).json({ ok: false, checked: false, error: `${channel}_disabled`, note: `${channel} protection is turned off for this organisation` })
    : next();
// Records that a retrain is owed and returns immediately. Previously a fire-and-forget
// `setImmediate` guarded by an in-memory Set — a restart lost the run AND the guard, and
// nothing anywhere recorded that the work had been owed, so the user's model quietly
// stopped keeping up with them. The queue row is that record; see lib/trainingQueue.js.

// Salted so the hashes are not a rainbow-table of common phrases. The salt is per
// deployment and stable, which is all equality comparison needs.
const TEXT_HASH_SALT = process.env.TEXT_HASH_SALT || "continuum-text-hash-salt";
function textHash(t) {
  return require("crypto").createHmac("sha256", TEXT_HASH_SALT).update(String(t || "")).digest("hex");
}

// One transaction per sample: the sample and its key events are written together or not at all, and
// committed once. Each event used to be its own commit; on the Docker bind mount every commit is a
// slow sync, so a ~280-event sample took about 8 s to store (measured 2026-10-06).
// Events are inserted one by one, in the order they were typed: their ids are the order equal
// timestamps are read back in (getSampleEvents).
function storeTextSample(args) { return db.tx(() => storeTextSampleRows(args)); }
async function storeTextSampleRows({ userId, textContent, keystrokeEvents, metrics, evaluation, samplePurpose, sourcePath, isTraining, hash, charCount }) {
  const textId = await db.insert(
      `INSERT INTO keystroke_texts
        (user_id, text_hash, char_count, keystroke_timings, model_confidence, is_suspicious, sample_purpose, source_path, is_training)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      hash || textHash(textContent),
      charCount != null ? charCount : String(textContent || "").length,
      JSON.stringify(metrics || {}),
      evaluation ? evaluation.modelConfidence : null,
      evaluation && evaluation.isSuspicious ? 1 : 0,
      samplePurpose || "activity",
      sourcePath || null,
      isTraining ? 1 : 0,
    );
  if (Array.isArray(keystrokeEvents)) {
    for (const evt of keystrokeEvents) {
      await db.run(
        `INSERT INTO keystroke_events
          (keystroke_text_id, key_code, event_type, timestamp_relative, field_name, field_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        textId,
        evt.keyCode,
        evt.eventType === "paste" ? "paste" : evt.eventType,
        evt.timestampRelative,
        evt.fieldName || null,
        evt.fieldType || null,
      );
    }
  }
  return textId;
}

/**
 * One error responder for every route that touches the model.
 *
 * The important case is ModelUnavailableError. When the model cannot answer, a
 * continuous-auth layer has three options and two of them are wrong:
 *   fail-open   — call it genuine. Anyone who can stall the model gets a free pass, which
 *                 defeats the system.
 *   fail-closed — call it suspicious. A model outage then steps up every legitimate user at
 *                 once: a self-inflicted denial of service.
 *   no verdict  — refuse to answer. This is what we do.
 *
 * 503 issues no verdict, mints no risk token, sets no lock and records no clean run. The
 * caller's last known state stands, so nothing is granted and nothing is revoked. The SDK
 * already ignores non-200 responses, so this needed no client change. It is logged at
 * SECURITY level precisely because it is the quiet option: a rise in these is either an
 * outage or someone arranging one, and either way it must be visible.
 */
function sendError(res, where, err, extra = {}) {
  if (err instanceof ModelUnavailableError) {
    console.error(`[${where}][SECURITY] no verdict issued — ${err.message}`);
    return res.status(503).json({ ...extra, ok: false, error: "model_unavailable", retryable: true });
  }
  console.error(`${where}:`, err);
  // The message is deliberately generic. These handlers used to return raw `err.message`,
  // which leaks SQL fragments, file paths and model internals to whoever provoked the error.
  return res.status(500).json({ ...extra, ok: false, error: "internal_error" });
}

const app = express();
// Every handler is async (the database is). Express 4 does not catch a rejected promise: without this
// wrapper one failed query would be an unhandled rejection, which stops the whole process.
const aw = (fn) => (req, res, next) => { Promise.resolve().then(() => fn(req, res, next)).catch(next); };
app.use(express.json({ limit: "5mb" }));
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/ready") return next();
  if (API_KEY && req.get("X-Api-Key") !== API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
});

// IDENTITY COMES ONLY FROM THE VERIFIED GATEWAY ASSERTION.
//
// This used to be `Number(req.body.userId || req.params.userId)` — the caller named whoever
// it liked, across any tenant, on 19 of 23 endpoints. It also let the first-party app write
// raw sequential ids, defeating the per-tenant namespacing that stops two customers' "user
// 42" colliding.
//
// requireIdentity() verifies an RS256 assertion signed by the gateway (the only identity
// authority) and sets req.identity. uid() reads THAT and nothing else; a request without a
// valid assertion never reaches a handler.
const { requireIdentity, verifyIdentityAssertion } = require("./lib/identityAssertion");
const uid = (req) => {
  if (!req.identity) throw new Error("uid() called without a verified identity assertion");
  return Number(req.identity.principalId);
};
const tenantOf = (req) => {
  if (!req.identity) throw new Error("tenantOf() called without a verified identity assertion");
  return req.identity.tenantId;
};

app.get("/health", (req, res) => res.json({ ok: true, service: "ca" }));
// Readiness: its own database answers. Not the model service: with the model down this service still
// answers ("model unavailable", never a made-up verdict), so taking it out of rotation would only turn
// those answers into connection errors.
app.get("/ready", async (req, res) => {
  try { await db.ready(); res.json({ ready: true, service: "ca" }); }
  catch (e) { res.status(503).json({ ready: false, service: "ca", error: e.message }); }
});

// ---- config + onboarding status (used by the demo gate) ----
app.get("/v1/keystroke/config", async (req, res) => {
  // With an identity assertion (the gateway's relay, or the demo backend for a signed-in user) the
  // caller's organisation settings apply; without one, the deployment defaults.
  if (req.get("X-Continuum-Identity")) {
    try { req.identity = await verifyIdentityAssertion(req.get("X-Continuum-Identity")); } catch (e) { req.identity = null; }
  }
  const st = appSettings.forRequest(req);
  res.json({
    windowSize: ks.WINDOW_SIZE,
    windowStride: ks.WINDOW_STRIDE,
    // The organisation's packet (2, 4, 6, 10 or 20 windows; 20 by default): the first verdict comes once
    // there are more windows than this.
    recentWindowCount: ks.decisionWindows(st.keystrokeDecisionWindows),
    // An adaptive sample is this many windows; the last few must each clear the window floor.
    sampleWindowCount: ks.SAMPLE_WINDOW_COUNT,
    sampleFloorWindows: ks.SAMPLE_FLOOR_WINDOWS,
    packetVoteFraction: ks.PACKET_VOTE_FRACTION,
    decisionThreshold: ks.WINDOW_DECISION_THRESHOLD,
    checkMinTextChars: ks.minTextChars(st.keystrokeDecisionWindows),   // 70 for the 2-window packet, else 80
    adaptiveConfidenceMin: ADAPTIVE_CONFIDENCE_MIN,
    // Accepted samples before a retrain (1, 2 or 3; the organisation's setting).
    adaptiveRetrainEvery: st.adaptiveRetrainEvery,
    // Deployment-level onboarding strategy (docker env):
    //   eager — popup enrolls everything missing at load (default)
    //   lazy  — passkey only at load; keystroke/mouse enroll when the user
    //           enables that toggle (keystroke-only deployments never ask for mouse)
    onboardingMode: st.onboarding,
    // Field types the SDK must NOT monitor. Everything else — including password (value
    // masked, timing kept) — is monitored.
    excludeFieldTypes: st.excludeFieldTypes,
    // The organisation's choices (or the operator's defaults). `managed` lists the ones set
    // explicitly in the console or on the operator page: those override the page's own
    // data-* attributes; the rest are defaults a page may still override.
    panel: st.panel,
    // the panel's language and colours (auto | en | ar, auto | light | dark), for the SDK and the extension
    panelLanguage: st.panelLanguage,
    panelTheme: st.panelTheme,
    keystroke: st.keystroke,
    mouse: st.mouse,
    adaptiveEnabled: st.adaptive === "on",
    adaptiveMinGapHours: st.adaptiveGapHours,
    managed: st.managed,
  });
});

// ---- operator settings (called by the gateway's operator page; the API key protects every route) ----
// DATABASE_URL carries the database password, so it is listed as set or not, never shown.
const SECRET_ENV = new Set(["CA_SIGNING_SECRET", "GATEWAY_SESSION_SECRET", "CA_API_KEY", "MODEL_API_KEY", "TEXT_HASH_SALT", "DATABASE_URL"]);
const SERVICE_ENV = ["PORT", "STORAGE", "DB_PATH", "MODEL_API_URL", "MODEL_INFER_URL", "MODEL_TRAIN_URL", "MODEL_TRAIN_TIMEOUT_MS",
  "MODEL_INFER_TIMEOUT_MS", "TRAINING_POLL_MS", "TRAINING_MAX_ATTEMPTS", "KEYSTROKE_NEGATIVES_PATH", "GATEWAY_JWKS_URI",
  "IDENTITY_MAX_AGE_SEC", "CA_RISK_TTL_SEC", "STUDY_LOGGING", "ONBOARDING_MODE", "MONITOR_EXCLUDE_TYPES", "CONTINUUM_PANEL",
  "CONTINUUM_KEYSTROKE", "CONTINUUM_MOUSE", "ADAPTIVE_RETRAINING", "ADAPTIVE_MIN_GAP_HOURS", "ADAPTIVE_RETRAIN_EVERY", "ADAPTIVE_SAMPLE_FROM",
  "KEYSTROKE_DECISION_WINDOWS", ...SECRET_ENV];
app.get("/v1/admin/settings", (req, res) => {
  res.json({
    settings: runtimeSettings.describe(),
    environment: SERVICE_ENV.map((name) => ({
      name, set: process.env[name] != null && process.env[name] !== "",
      value: SECRET_ENV.has(name) ? null : (process.env[name] ?? null), secret: SECRET_ENV.has(name),
    })),
  });
});
app.put("/v1/admin/settings", aw(async (req, res) => {
  let settings;
  try { settings = await runtimeSettings.update(req.body || {}); }
  catch (e) { if (e.code !== "unknown_setting") throw e; return res.status(400).json({ error: e.code, note: e.message }); }
  res.json({ settings });
}));

// Typing enrolment trains from the queue (since 2026-10-06), as /status reports it: `training` while
// the job is queued or running, `trainingError` when the last job failed and left no model although
// the samples were enough (one more enrolment sample queues a new job).
async function keystrokeTraining(userId, status) {
  if (status.trained) return { training: false, trainingError: null };
  const { pending, jobs } = await trainingQueue.statusFor(userId, "keystroke");
  const enough = status.remainingSamples === 0 && status.remainingPositiveWindows === 0;
  const failed = enough && !pending && jobs.length && jobs[0].state === "failed" ? jobs[0].last_error || "training failed" : null;
  return { training: !!pending, trainingError: failed };
}

app.get("/v1/keystroke/status/:userId", requireIdentity, aw(async (req, res) => {
  const status = { ...(await ks.getUserTypingStatus(uid(req), db)) };
  Object.assign(status, await keystrokeTraining(uid(req), status));
  const adaptiveSamplesSinceRetrain = status.trainedAt ? await countTrainingSamplesSince(uid(req), status.trainedAt) : 0;
  const st = appSettings.forRequest(req);
  const adaptivePending = await adaptive.pendingCount(uid(req));
  res.json({ ...status, adaptiveSamplesSinceRetrain, adaptiveRetrainEvery: st.adaptiveRetrainEvery,
    topUpSamples: KS_TOPUP_SAMPLES, topUpAdded: status.trained ? (await topUpWaitingIds(uid(req), status.trainedAt)).length : 0,
    adaptiveEnabled: st.adaptive === "on", adaptiveMinGapHours: st.adaptiveGapHours,
    adaptivePending, adaptiveReady: adaptivePending >= st.adaptiveRetrainEvery,
    nextContributionAt: st.adaptive === "on" ? await nextContributionAt(uid(req), st) : null });
}));

app.get("/v1/users/:userId/onboarding", requireIdentity, aw(async (req, res) => {
  const status = await ks.getUserTypingStatus(uid(req), db);
  // keystrokeTraining: the model is being built; clients treat typing enrolment as done meanwhile.
  res.json({ trained: !!status.trained, keystrokeTraining: (await keystrokeTraining(uid(req), status)).training, mouseEnrolled: await mouse.mouseEnrolled(uid(req)) });
}));

// ---- keystroke: enroll / check / submit / contribute / reset / retrain ----
app.post("/v1/keystroke/enroll", requireIdentity, channelOn("keystroke"), async (req, res) => {
  try {
    const userId = uid(req);
    if (await refuseIfLocked(res, userId)) return;
    // Once the typing model exists it takes more samples in two ways only, both behind the passkey: the adaptive
    // popup, whose retrain needs it, and since 2026-11-25 a top-up the user asks for (the owner's decision: the first
    // enrolment stays in one session, and the user may add samples later). The caller (the gateway) sets topUp for a
    // request that carries its grant from a passkey verified moments before, and for no other. Until 2026-10-05 this
    // route took more samples at any time and retrained at once with no passkey, so anyone at an unlocked session
    // could train the model on their own typing. Enrolling from nothing needs a reset, which asks for the passkey.
    const { trained: trainedNow, trainedAt } = await ks.getUserTypingStatus(userId, db);
    const topUp = trainedNow && req.body.topUp === true;
    if (trainedNow && !topUp) {
      return res.status(409).json({ ok: false, error: "already_enrolled",
        note: "The typing model is trained. It takes more samples only after the user's passkey (a top-up) or through the adaptive popup; a reset (passkey) starts again." });
    }
    // A top-up that has its samples takes no more: they wait for the passkey (the confirm route below).
    if (topUp && (await topUpWaitingIds(userId, trainedAt)).length >= KS_TOPUP_SAMPLES) {
      return res.status(409).json({ ok: false, error: "topup_full", topUp: { added: KS_TOPUP_SAMPLES, needed: KS_TOPUP_SAMPLES },
        note: "This top-up has its samples. They are added to the typing model once the passkey confirms them." });
    }
    await studyLog.register(userId, studyLog.parseContext(req.body.study));   // so its training is logged
    const { textContent, keystrokeTimings, keystrokeEvents, sourcePath } = req.body;
    if (!textContent || String(textContent).trim().length < 120) {
      return res.status(400).json({ error: "Enrollment sample must be at least 120 characters" });
    }
    const quality = ks.typingQuality(textContent, keystrokeEvents);
    if (!quality.acceptableForEnrollment) {
      return res.status(400).json({
        error: quality.pasteCount > 0
          ? "Pasted text cannot be used for rhythm training. Type the displayed text naturally."
          : "Not enough typed key events were captured for this enrollment sample.",
        typingQuality: quality,
      });
    }
    const metrics = { ...(await ks.evaluateKeystrokes({ events: keystrokeEvents, timings: keystrokeTimings, userId, db })).metrics };
    const textId = await storeTextSample({
      userId, textContent, keystrokeEvents, metrics,
      evaluation: { modelConfidence: null, isSuspicious: false },
      samplePurpose: topUp ? TOPUP_WAITING : "enrollment", sourcePath: sourcePath || "/enroll.html", isTraining: !topUp,
    });
    if (topUp) {
      // It waits, the last one too: the confirm route (/v1/keystroke/topup/confirm) makes them training samples.
      const waiting = await topUpWaitingIds(userId, trainedAt);
      return res.json({ ok: true, textId, trained: true, training: false, topUp: { added: Math.min(waiting.length, KS_TOPUP_SAMPLES), needed: KS_TOPUP_SAMPLES },
        typingQuality: quality, message: waiting.length < KS_TOPUP_SAMPLES ? `Sample saved: ${waiting.length} of ${KS_TOPUP_SAMPLES}`
          : "Sample saved. They are added to your typing model once your passkey confirms them." });
    }
    // Training runs from the queue (since 2026-10-06), like mouse enrolment: the user is not held for the
    // ~45 s it takes (up to ~2 min; it used to run inside this request), and a page reload or a restart
    // loses nothing. Clients read `training` / `trainingError` from /status until `trained`.
    const before = await ks.getUserTypingStatus(userId, db);
    const enough = before.remainingSamples === 0 && before.remainingPositiveWindows === 0;
    if (enough) await trainingQueue.enqueue(userId, "keystroke", "enrol");
    const typingStatus = { ...before };
    Object.assign(typingStatus, await keystrokeTraining(userId, typingStatus));
    res.json({
      ok: true,
      message: enough ? "Enrollment sample saved; your typing model is being built" : "Enrollment sample saved",
      textId, trained: false, training: typingStatus.training, typingStatus, typingQuality: quality,
    });
  } catch (err) { return sendError(res, "enroll", err); }
});

app.post("/v1/keystroke/check", requireIdentity, channelOn("keystroke"), excludeFields, async (req, res) => {
  try {
    const userId = uid(req);
    if (await lockedAnswer(res, userId, "keystroke")) return;
    const { textContent, textLength, keystrokeTimings, keystrokeEvents, hasPasskey } = req.body;
    // The organisation's packet: the vote runs on its last this-many windows, and until there are
    // more windows than this the check is warm-up.
    const appCfg = appSettings.forRequest(req);
    const packetWindows = ks.decisionWindows(appCfg.keystrokeDecisionWindows);
    // A client may send the trimmed text's LENGTH instead of the text (the study extension does).
    const typedLength = textContent != null ? String(textContent).trim().length : Number(textLength);
    // More pastes into one field than the organisation allows: judged whatever was typed, because the clients
    // send a check at every paste and a paste that no typing follows must still be caught.
    const pasteViolation = ks.pastePolicyViolation(keystrokeEvents, appCfg.pasteAllowance);
    // The minimum counts what was typed, not only what is still in the field (2026-11-08): a chat box emptied at every
    // send never held 70 characters, so its typing was never checked. The printable keys sent count as well.
    const gateLength = Math.max(Number.isFinite(typedLength) ? typedLength : 0, ks.printableKeyCount(keystrokeEvents));
    if (!pasteViolation && gateLength < ks.minTextChars(packetWindows)) {
      return res.json({ ok: true, checked: false, message: "More typed text is required before rhythm verification" });
    }
    const checkQuality = ks.typingQuality(textContent, keystrokeEvents, Number.isFinite(typedLength) ? typedLength : 0);
    if (keystrokeTimings) {
      const trueKeys = Number(keystrokeTimings.keyCount);
      const truePasted = Number(keystrokeTimings.pastedLength || 0);
      if (trueKeys > checkQuality.keydownCount && checkQuality.textLength > 0) checkQuality.typedCoverage = trueKeys / checkQuality.textLength;
      if (truePasted > checkQuality.pastedLength) checkQuality.pastedLength = truePasted;
    }
    // Degenerate / unverifiable input the identity model can't judge (it's still your hands,
    // so it may score genuine, yet it isn't real rhythm). Two patterns, either one => challenge:
    //  (a) low key DIVERSITY  — hammering one key or a tiny set;
    //  (b) chaotic TIMING     — keydowns landing implausibly close together (< 40ms apart is
    //      > 25 keys/s, i.e. key rollover / slapping, not sustainable deliberate typing).
    const degKeydowns = (Array.isArray(keystrokeEvents) ? keystrokeEvents : [])
      .filter((e) => e && e.eventType === "keydown" && Number(e.keyCode) > 0);
    const lowDiversity = degKeydowns.length >= 30 && new Set(degKeydowns.map((e) => Number(e.keyCode))).size <= 4;
    const degDowns = degKeydowns.map((e) => Number(e.timestampRelative)).filter(Number.isFinite).sort((a, b) => a - b);
    let degTooFast = 0, degGaps = 0;
    for (let i = 1; i < degDowns.length; i++) { const dd = degDowns[i] - degDowns[i - 1]; if (dd >= 0) { degGaps += 1; if (dd < 40) degTooFast += 1; } }
    const chaoticInput = degGaps >= 20 && degTooFast / degGaps >= 0.4;
    const degenerateInput = lowDiversity || chaoticInput;
    const evaluation = pasteViolation
      ? pastePolicyEvaluation(checkQuality, keystrokeTimings)
      : await ks.evaluateKeystrokes({ events: keystrokeEvents, timings: keystrokeTimings, userId, db, packetWindows });

    const warmupScores = Array.isArray(evaluation.recentWindowScores) ? evaluation.recentWindowScores.map(Number) : [];
    const warmupLows = warmupScores.filter((s) => s < ks.WINDOW_DECISION_THRESHOLD).length;
    // Minimum 8 windows since 2026-09-26 (was 4); see WARMUP_FAST_MIN_WINDOWS in lib/keystrokeSecurity.js.
    const overwhelmingImpostor = warmupScores.length >= ks.WARMUP_FAST_MIN_WINDOWS &&
      warmupLows >= Math.ceil(warmupScores.length * ks.WARMUP_FAST_FRACTION);
    // Un-modelable typing (no window despite abundant keystrokes) and a paste
    // violation are BOTH definite verdicts, not warmup — they must be challenged,
    // otherwise they're a free pass around the whole model. (A paste evaluation
    // carries no windowCount, so without this it would default to warmup.)
    const isPastePolicy = evaluation.modelType === "paste-policy";
    // Typing that never fills a packet (2026-11-08): a pause over a second drops its digraph, so typing about one key a
    // second keeps every check in warm-up, a free pass. Twice the keys a packet needs with the packet still not full is
    // unverifiable, as typing that yields no window at all is.
    const keysSent = Number(((evaluation.metrics || {}).keyCount) || 0);
    const sparseTyping = !isPastePolicy && evaluation.modelAvailable !== false &&
      keysSent >= 2 * ks.minTextChars(packetWindows) && keysSent >= 2 * (ks.WINDOW_SIZE + ks.WINDOW_STRIDE * packetWindows) &&
      Number(evaluation.windowCount || 0) <= packetWindows;
    const unverifiable = evaluation.unverifiable === true || sparseTyping;
    // No typing profile yet (or one from an older feature scheme): nothing to judge, so no verdict and no token,
    // unless the input itself asks for the passkey (pastes beyond the allowance, degenerate typing). It used to be
    // signed "genuine" once the text was long enough.
    if (evaluation.modelAvailable === false && !isPastePolicy && !degenerateInput) {
      // What the server did with the typing is still reported (windows built, the organisation's packet, whether it
      // is full), without a verdict or a token.
      const windowCount = Number(evaluation.windowCount || 0);
      return res.json({
        ok: true, checked: false, rhythmEnrollmentRequired: true, packetWindows, warmup: windowCount <= packetWindows,
        typingEvaluation: { windowCount, modelAvailable: false }, message: "No typing profile yet: no verdict.",
      });
    }
    const isWarmup = Number(evaluation.windowCount || 0) <= packetWindows &&
      !overwhelmingImpostor && !unverifiable && !isPastePolicy && !degenerateInput;
    // The decision is the packet vote itself (Lu et al., 2020, here over the organisation's packet, twenty
    // windows by default): a check whose last windows are at least half below 0.50 asks for the passkey at
    // once. Nothing is carried from one check to the next. Degenerate input is unverifiable even when the
    // model scores it genuine, so it forces suspicion.
    const effectiveSuspicious = (!isWarmup && evaluation.isSuspicious) || degenerateInput || sparseTyping;
    // What the answer and its signed token say: the model's packet vote, and degenerate input too (the decision above
    // asks for the passkey on it, but until 2026-11-08 the token was signed from the vote alone, so "genuine").
    // Warm-up keeps the vote's own value, which the SDK's post-step-up probation reads.
    const verdictSuspicious = evaluation.isSuspicious === true || degenerateInput || sparseTyping;
    const passkeyTriggered = !!hasPasskey && effectiveSuspicious;
    if (passkeyTriggered) await lock.setLocked(userId);

    await ks.logAuthDecision(userId, db, { source: "check", evaluation, passkeyTriggered });
    // User study (lib/studyLog.js; a no-op outside it): the packet's full-precision scores and keys.
    const studyCtx = studyLog.parseContext(req.body.study);
    const studyDecisionId = studyCtx ? await studyLog.recordCheck(userId, studyCtx, {
      channel: "keystroke", ruleVersion: ks.ruleVersion(packetWindows), threshold: ks.WINDOW_DECISION_THRESHOLD,
      scores: warmupScores, keys: evaluation.recentWindowKeys,
      lowWindows: warmupLows,
      verdict: passkeyTriggered ? "challenge" : isWarmup ? "warmup" : effectiveSuspicious ? "suspicious" : "ok",
      promptRequired: passkeyTriggered,
      details: {
        packetSuspicious: evaluation.isSuspicious === true, windowTotal: Number(evaluation.windowCount || 0),
        overwhelmingImpostor, unverifiable, pastePolicy: isPastePolicy, degenerateInput,
        hasPasskey: !!hasPasskey, modelAvailable: evaluation.modelAvailable !== false, packetWindows,
      },
    }) : null;

    res.json({
      ok: !passkeyTriggered, checked: true, warmup: isWarmup,
      requiresPasskeyChallenge: passkeyTriggered,
      ...(studyDecisionId ? { studyDecisionId } : {}),
      // How many windows the model ACTUALLY scored this check. 0 = the warmup
      // "placeholder" verdict (no scorable window yet) — used by the SDK to tell a
      // real suspicious verdict apart from the not-enough-data placeholder, so
      // post-step-up probation re-challenges a scored impostor but never loops on
      // a genuine user who is merely rebuilding their first window.
      scoredWindowCount: warmupScores.length,
      packetWindows,
      modelConfidence: evaluation.modelConfidence, isSuspicious: verdictSuspicious,
      typingEvaluation: evaluation,
      riskToken: signRisk(userId, riskLevel(isWarmup, verdictSuspicious), "keystroke"),
      message: passkeyTriggered
        ? (isPastePolicy ? "More pastes into one field than allowed. Passkey verification required."
          : degenerateInput ? "Repeated or erratic keystrokes can't verify identity. Passkey verification required."
          : sparseTyping ? "Typing this slow never fills a packet and can't verify identity. Passkey verification required."
          : "Typing rhythm does not match. Passkey verification required.")
        : isWarmup ? "Warming up — building the first evaluation packet." : "Typing rhythm verified.",
    });
  } catch (err) { return sendError(res, "check", err, { checked: false }); }
});

// /v1/keystroke/submit (score and store the text at a form's submit) was removed on 2026-10-05:
// Continuum checks typing and movement while they happen, never at a submit, and nothing but the
// adaptive popup adds typing samples.

// The adaptive popup's sample (lib/adaptive.js) is the typing behind the user's last SAMPLE_WINDOW_COUNT
// windows (ks.lastWindowsSample). All of those windows are scored and judged, and only they are stored, so
// nothing is learned that was not judged. `dryRun: true` asks the same question without storing anything: the
// SDK asks it at every new window so that the popup shows only when a click would be accepted. A dry run is
// answered 200 whatever the outcome, with `eligible` and the reason a click would be refused for, so asking
// often does not fill the logs with refusals. It skips the rhythm-consistency check, whose history query is
// the costly part and which, in experiment AR, never refused a sample.
app.post("/v1/keystroke/contribute", requireIdentity, channelOn("keystroke"), excludeFields, async (req, res) => {
  try {
    const userId = uid(req);
    if (await refuseIfLocked(res, userId)) return;
    const dryRun = req.body.dryRun === true;
    const refuse = (status, body) => (dryRun
      ? res.json({ ok: true, dryRun: true, eligible: false, ...body })
      : res.status(status).json({ ok: false, ...body }));
    const st = appSettings.forRequest(req);
    if (st.adaptive === "off") {
      return refuse(409, { error: "adaptive_disabled", note: "Adaptive retraining is turned off for this organisation." });
    }
    const next = await nextContributionAt(userId, st);
    if (next) {
      const mins = Math.ceil((Date.parse(next) - Date.now()) / 60000);
      return refuse(429, {
        error: "adaptive_paused", nextContributionAt: next, pauseHours: st.adaptiveGapHours,
        message: `Your model was just retrained. New samples can be added again in ${mins >= 60 ? Math.ceil(mins / 60) + " h" : mins + " min"}.`,
      });
    }
    const pending = await adaptive.pendingCount(userId);
    if (pending >= st.adaptiveRetrainEvery) {
      return refuse(409, { error: "ready_to_retrain", pending, retrainEvery: st.adaptiveRetrainEvery,
        message: `${pending} samples are ready. Retrain your model (with your passkey) before adding more.` });
    }
    // The SDK sends only the typing since the previous sample, and its length, not the field's whole text;
    // a client that still sends the text is measured on the text.
    const { textContent, keystrokeEvents } = req.body;
    const quality = ks.typingQuality(textContent != null ? textContent : null, keystrokeEvents, req.body.textLength);
    if (!quality.acceptableForEnrollment) {
      return refuse(422, {
        error: quality.pasteCount > 0 ? "Pasted text cannot train your model. Type naturally." : "Not enough typed keystrokes in this sample to contribute.",
      });
    }
    // The sample: the typing behind SAMPLE_WINDOW_COUNT consecutive windows. By default the last ones, what the
    // user typed last. The organisation may choose "any": the newest run that would be accepted, anywhere in the
    // stretch, and the rest of it is ignored. A shorter stretch is not a sample yet.
    const stretch = st.adaptiveSampleFrom === "any"
      ? await ks.newestQualifyingSample({ events: keystrokeEvents, userId, db, meanMin: ADAPTIVE_CONFIDENCE_MIN, floor: ADAPTIVE_WINDOW_FLOOR })
      : ks.lastWindowsSample(keystrokeEvents);
    if (!stretch.events) {
      return refuse(422, stretch.cutFailed
        ? { error: "This stretch could not be cut into a sample. Keep typing and try again.", windows: stretch.windows }
        : { error: `Keep typing — need ${ks.SAMPLE_WINDOW_COUNT} clean windows, have ${stretch.windows}.`, windows: stretch.windows });
    }
    const sample = stretch.events;
    if ((await adaptive.overlapShare(userId, sample)) > adaptive.OVERLAP_LIMIT) {
      return refuse(422, { error: "sample_overlaps",
        message: "This stretch repeats typing from your previous sample. Keep typing, then add the next one." });
    }
    const evaluation = await ks.evaluateKeystrokes({ events: sample, timings: null, userId, db });
    const scores = Array.isArray(evaluation.sampleWindowScores) ? evaluation.sampleWindowScores : [];
    if (!evaluation.modelAvailable || scores.length < ks.SAMPLE_WINDOW_COUNT) {
      return refuse(422, { error: "Your typing model could not score this sample. Try again in a moment." });
    }
    const mean = Number(evaluation.sampleMean);
    if (mean < ADAPTIVE_CONFIDENCE_MIN) {
      return refuse(422, { error: `Sample not clean enough to contribute (${Math.round(mean * 100)}% < ${Math.round(ADAPTIVE_CONFIDENCE_MIN * 100)}%).`, sampleMean: mean });
    }
    // A high MEAN can hide one weak window inside an otherwise-clean sample — require
    // each of the last SAMPLE_FLOOR_WINDOWS windows to clear the floor too.
    const worstWindow = Math.min(...scores.slice(-ks.SAMPLE_FLOOR_WINDOWS));
    if (worstWindow < ADAPTIVE_WINDOW_FLOOR) {
      return refuse(422, {
        error: `One of the last ${ks.SAMPLE_FLOOR_WINDOWS} windows scored ${Math.round(worstWindow * 100)}%, below the ${Math.round(ADAPTIVE_WINDOW_FLOOR * 100)}% floor — a good average can hide one weak moment, and what you typed last has to look like you. Try again with a fully consistent stretch of typing.`,
        sampleMean: mean,
      });
    }
    // Model-independent check: does this sample's own timing match this user's ALREADY
    // enrolled history, regardless of what the (possibly still-young) model thinks of it?
    if (!dryRun) {
      const consistency = ks.checkRhythmConsistency(sample, await getTrainingEventsForUser(userId));
      if (!consistency.consistent) {
        return refuse(422, {
          error: `This sample's ${consistency.worstFeature} timing is unusually different from your `
            + `enrolled rhythm (z=${consistency.worstZ.toFixed(2)}) — try again with your normal typing pace.`,
          sampleMean: mean,
        });
      }
    }
    // "New text": the same phrase typed again (the same key sequence) teaches the model nothing new.
    const hash = textContent != null ? textHash(textContent) : textHash("keys:" + adaptive.keySequence(sample));
    if (await hasDuplicateTrainingText(userId, hash)) {
      return refuse(422, { error: "This text has already been contributed — a repeated sample teaches the model nothing new." });
    }
    if (dryRun) return res.json({ ok: true, dryRun: true, eligible: true, windows: stretch.windows, sampleFrom: st.adaptiveSampleFrom, sampleMean: mean });
    await storeTextSample({
      userId, textContent: textContent || "[adaptive-contribution]", keystrokeEvents: sample,
      metrics: evaluation.metrics, evaluation, samplePurpose: adaptive.PENDING,
      sourcePath: "contribute", isTraining: false, hash,
      charCount: Math.min(quality.textLength, ks.printableKeyCount(sample)) || quality.textLength,
    });
    const now = await adaptive.pendingCount(userId);
    res.json({ ok: true, pending: now, retrainEvery: st.adaptiveRetrainEvery, ready: now >= st.adaptiveRetrainEvery, sampleMean: mean,
      message: now >= st.adaptiveRetrainEvery ? "Sample added. Your model is ready to retrain." : `Sample added: ${now} of ${st.adaptiveRetrainEvery}.` });
  } catch (err) { return sendError(res, "contribute", err); }
});

// The user retrains with the pending samples. Callers MUST have verified the user's passkey in the
// same request (gateway /v1/sdk/keystroke/adaptive/retrain, demo /api/text/adaptive-retrain): that is
// what keeps samples added at an unlocked session from ever reaching a model.
app.post("/v1/keystroke/adaptive/confirm", requireIdentity, channelOn("keystroke"), async (req, res) => {
  try {
    const userId = uid(req);
    const st = appSettings.forRequest(req);
    if (st.adaptive === "off") return res.status(409).json({ ok: false, error: "adaptive_disabled" });
    const pending = await adaptive.pendingCount(userId);
    if (pending < st.adaptiveRetrainEvery) {
      return res.status(409).json({ ok: false, error: "not_ready", pending, retrainEvery: st.adaptiveRetrainEvery });
    }
    const n = await adaptive.confirm(userId);
    await trainingQueue.enqueue(userId, "keystroke", "adaptive");
    res.json({ ok: true, retraining: true, samples: n, nextContributionAt: await nextContributionAt(userId, st), pauseHours: st.adaptiveGapHours });
  } catch (err) { return sendError(res, "adaptive-confirm", err); }
});

// The end of a typing top-up (2026-11-26): the waiting samples become training samples and the model is rebuilt once
// (the trainer holds the newest sample out and keeps the earlier model if the new one does worse on it, as for every
// retrain). The caller must have verified the passkey for this very request, as for the adaptive confirm above:
// verified after the samples were typed, it says that whoever typed them was the user to the end.
app.post("/v1/keystroke/topup/confirm", requireIdentity, channelOn("keystroke"), async (req, res) => {
  try {
    const userId = uid(req);
    if (await refuseIfLocked(res, userId)) return;
    const { trained, trainedAt } = await ks.getUserTypingStatus(userId, db);
    if (!trained) return res.status(409).json({ ok: false, error: "not_enrolled" });
    const waiting = await topUpWaitingIds(userId, trainedAt);
    if (waiting.length < KS_TOPUP_SAMPLES) {
      return res.status(409).json({ ok: false, error: "topup_incomplete", topUp: { added: waiting.length, needed: KS_TOPUP_SAMPLES },
        note: `A top-up is ${KS_TOPUP_SAMPLES} samples typed in one sitting, and ${waiting.length} are waiting. A sample that waited longer than a quarter of an hour was removed.` });
    }
    const ids = waiting.slice(0, KS_TOPUP_SAMPLES);
    await db.run(`UPDATE keystroke_texts SET is_training = 1, sample_purpose = ? WHERE id IN (${ids.map(() => "?").join(",")})`, TOPUP_PURPOSE, ...ids);
    await trainingQueue.enqueue(userId, "keystroke", "top-up");
    res.json({ ok: true, trained: true, training: true, samples: ids.length, message: "Your typing model is being rebuilt" });
  } catch (err) { return sendError(res, "topup-confirm", err); }
});

// The samples first, then the profile (2026-11-08): a training that runs across the reset finds its samples gone and
// saves nothing, and one that saves between the two statements finds them gone just after and removes what it saved
// (lib/keystrokeSecurity.js). The owed training is cancelled, the running job included, so a new enrolment queues its own.
app.post("/v1/keystroke/reset", requireIdentity, aw(async (req, res) => {
  const userId = uid(req);
  await db.run("UPDATE keystroke_texts SET is_training = 0 WHERE user_id = ?", userId);
  await ks.resetUserTypingProfile(userId, db);
  await adaptive.forget(userId);
  await topUpWaitingIds(userId, timeText(Date.now() + 60000));   // a top-up in progress goes with the profile (every waiting sample is older than that time)
  await trainingQueue.cancel(userId, "keystroke", "typing profile reset");
  res.json({ ok: true, message: "Typing rhythm enrollment was reset", typingStatus: await ks.getUserTypingStatus(userId, db) });
}));

// ---- training jobs (durable queue) ----
// Retraining is owed work recorded in a table, not a detached promise. This endpoint is how
// a dashboard or an operator sees that a retrain is pending, running, or has failed —
// previously the entire lifecycle was invisible and a lost job was indistinguishable from
// one that had never been scheduled.
app.get("/v1/training/jobs", requireIdentity, aw(async (req, res) => {
  res.json(await trainingQueue.statusFor(uid(req), req.query.modality || null));
}));

app.post("/v1/keystroke/retrain", requireIdentity, async (req, res) => {
  try {
    const userId = uid(req);
    const profile = await ks.trainUserTypingProfile(userId, db);
    if (!profile) {
      return res.status(422).json({ ok: false, error: "Not enough training samples to rebuild model", typingStatus: await ks.getUserTypingStatus(userId, db) });
    }
    res.json({
      ok: true, message: "Rhythm model rebuilt from stored samples",
      typingStatus: await ks.getUserTypingStatus(userId, db),
      profile: { threshold: profile.threshold, sampleCount: profile.sampleCount, trainedAt: profile.trainedAt, trainedFrom: profile.trainedFrom },
    });
  } catch (err) { return sendError(res, "retrain", err); }
});

// ---- user study: bind this user to a participant pseudonym at setup, BEFORE enrolment, so the
// enrolment trainings are recorded with their threshold-source scores (lib/studyLog.js) ----
app.post("/v1/study/register", requireIdentity, aw(async (req, res) => {
  const ctx = studyLog.participantContext(req.body.participant);
  if (!ctx) return res.status(400).json({ ok: false, error: "invalid participant (or STUDY_LOGGING is off)" });
  const ok = await studyLog.register(uid(req), ctx);
  res.status(ok ? 200 : 409).json({ ok, userId: uid(req) });
}));

// ---- user study: passkey prompt events as the study client saw them (lib/studyLog.js) ----
app.post("/v1/study/prompt", requireIdentity, aw(async (req, res) => {
  const ctx = studyLog.parseContext(req.body.study);
  if (!ctx) return res.status(400).json({ ok: false, error: "no valid study context (or STUDY_LOGGING is off)" });
  const stored = await studyLog.recordPrompt(uid(req), ctx, {
    channel: req.body.channel, decisionId: req.body.decisionId, event: req.body.event,
  });
  res.status(stored ? 200 : 400).json({ ok: stored });
}));

// ---- login-triggered background retrain when new impostors appeared ----
app.post("/v1/keystroke/maybe-retrain-impostors", requireIdentity, aw(async (req, res) => {
  await ks.maybeRetrainForNewImpostors(uid(req), db);
  res.json({ ok: true });
}));

// ---- read models for the demo/dashboard (username joins happen in the demo) ----
// Rows written in the same second come in id order, as SQLite already returned them.
app.get("/v1/keystroke/history/:userId", requireIdentity, aw(async (req, res) => {
  const texts = await db.all(
    "SELECT id, char_count, model_confidence, is_suspicious, sample_purpose, is_training, submitted_at FROM keystroke_texts WHERE user_id = ? ORDER BY submitted_at DESC, id ASC",
    uid(req));
  res.json({ texts });
}));

app.get("/v1/keystroke/stats/:userId", requireIdentity, aw(async (req, res) => {
  const stats = await db.get(
    `SELECT COUNT(*) as total_submissions,
            COUNT(CASE WHEN is_suspicious = 1 THEN 1 END) as suspicious_count,
            AVG(model_confidence) as avg_confidence,
            SUM(char_count) as total_chars
     FROM keystroke_texts WHERE user_id = ?`,
    uid(req));
  res.json({ ...stats, typingStatus: await ks.getUserTypingStatus(uid(req), db) });
}));

app.get("/v1/keystroke/decisions/:userId", requireIdentity, aw(async (req, res) => {
  const decisions = await db.all(
    `SELECT id, checked_at, source, window_count, mean_score, threshold, verdict, passkey_triggered, passkey_outcome, per_window_scores
     FROM auth_decisions WHERE user_id = ? ORDER BY checked_at DESC, id ASC LIMIT 500`,
    uid(req));
  res.json({ decisions });
}));

// Raw decisions for CSV export + research metrics (per user_id; the demo maps usernames).
// TENANT-SCOPED. This returned every tenant's decisions unconditionally. There is still no
// tenant_id column on auth_decisions, so the scope is enforced by joining the identity
// registry: only ids belonging to the caller's tenant are visible. Retired and unregistered
// ids belong to no tenant and are therefore excluded, which is the correct outcome.
app.get("/v1/keystroke/decisions-all", requireIdentity, aw(async (req, res) => {
  const rows = await db.all(
    `SELECT id, user_id, checked_at, source, window_count, mean_score, threshold, verdict, passkey_triggered, passkey_outcome, per_window_scores
     FROM auth_decisions
     WHERE user_id IN (SELECT legacy_user_id FROM principal_aliases WHERE tenant_id = ?)
     ORDER BY checked_at DESC, id ASC`,
    tenantOf(req));
  res.json({ rows });
}));

app.get("/v1/keystroke/metrics", requireIdentity, aw(async (req, res) => {
  const rows = await db.all(
    `SELECT user_id,
            COUNT(*) as total,
            SUM(CASE WHEN verdict = 'genuine' THEN 1 ELSE 0 END) as genuine_count,
            SUM(CASE WHEN verdict IN ('suspicious','paste') THEN 1 ELSE 0 END) as suspicious_count,
            AVG(CASE WHEN mean_score IS NOT NULL THEN mean_score END) as avg_score,
            AVG(threshold) as avg_threshold,
            MIN(checked_at) as first_check, MAX(checked_at) as last_check
     FROM auth_decisions
     WHERE verdict IN ('genuine','suspicious','paste')
       AND user_id IN (SELECT legacy_user_id FROM principal_aliases WHERE tenant_id = ?)
     GROUP BY user_id
     ORDER BY user_id`,
    tenantOf(req));
  const profiles = await db.all("SELECT user_id, model_json FROM user_typing_profiles WHERE user_id IN (SELECT legacy_user_id FROM principal_aliases WHERE tenant_id = ?)", tenantOf(req));
  const profileMap = {};
  for (const p of profiles) { try { profileMap[p.user_id] = JSON.parse(p.model_json); } catch {} }
  res.json({ rows, profileMap });
}));

// ---- mouse ----
// Action-based mouse — the published path (Antal & Egyed-Zsigmond 2019).
// The window endpoints below are retained as the comparison arm.
app.post("/v1/mouse/actions/enroll", requireIdentity, channelOn("mouse"), async (req, res) => {
  try { if (await refuseIfLocked(res, uid(req))) return; const r = await mouseActions.enrollMouseActions(uid(req), req.body.actions); res.status(r.status).json(r.body); }
  catch (err) { return sendError(res, "mouse-action-enroll", err); }
});
app.post("/v1/mouse/actions/check", requireIdentity, channelOn("mouse"), async (req, res) => {
  try {
    if (await lockedAnswer(res, uid(req), "mouse")) return;
    const r = await mouseActions.checkMouseActions(uid(req), req.body.actions);
    if (r.body && r.body.checked) {
      r.body.riskToken = signRisk(uid(req), riskLevel(r.body.warmup, r.body.isSuspicious), "mouse");
    }
    res.status(r.status).json(r.body);
  } catch (err) { return sendError(res, "mouse-action-check", err, { checked: false }); }
});
app.get("/v1/mouse/actions/status", requireIdentity, aw(async (req, res) => {
  res.json(await mouseActions.mouseActionsStatus(uid(req)));
}));
app.post("/v1/mouse/actions/reset", requireIdentity, aw(async (req, res) => {
  const r = await mouseActions.resetMouseActionProfile(uid(req));
  res.status(r.status).json(r.body);
}));

app.post("/v1/mouse/enroll", requireIdentity, channelOn("mouse"), async (req, res) => {
  try {
    if (await refuseIfLocked(res, uid(req))) return;
    await studyLog.register(uid(req), studyLog.parseContext(req.body.study));   // so its training is logged
    // topUp: the gateway's word that this request carries its grant from a passkey verified moments before (lib/mouse.js)
    const r = await mouse.enrollMouse(uid(req), req.body.windows, { topUp: req.body.topUp === true }); res.status(r.status).json(r.body);
  }
  catch (err) { return sendError(res, "mouse-enroll", err); }
});
// The end of a mouse top-up (lib/mouse.js confirmTopUp): the caller must have verified the passkey for this very request.
app.post("/v1/mouse/topup/confirm", requireIdentity, channelOn("mouse"), async (req, res) => {
  try {
    if (await refuseIfLocked(res, uid(req))) return;
    const r = await mouse.confirmTopUp(uid(req)); res.status(r.status).json(r.body);
  } catch (err) { return sendError(res, "mouse-topup-confirm", err); }
});
app.post("/v1/mouse/check", requireIdentity, channelOn("mouse"), async (req, res) => {
  try {
    if (await lockedAnswer(res, uid(req), "mouse")) return;
    const r = await mouse.checkMouse(uid(req), req.body.windows, req.body.study);
    if (r.body && r.body.checked) {
      r.body.riskToken = signRisk(uid(req), riskLevel(r.body.warmup, r.body.isSuspicious), "mouse");
    }
    res.status(r.status).json(r.body);
  } catch (err) { return sendError(res, "mouse-check", err, { checked: false }); }
});
app.get("/v1/mouse/status/:userId", requireIdentity, aw(async (req, res) => res.json({ ...(await mouse.mouseStatus(uid(req))), ...(await mouseUse.useStatus(uid(req))) })));
// Learning from real use, stage 1 (lib/mouseUse.js). The gateway calls use-anchor only after it verified the user's
// passkey in the same request (/v1/sdk/passkey/auth/complete); the tenant API has no route to it. A sample of the
// movement after that passkey is stored for the evaluation and trains nothing.
app.post("/v1/mouse/use-anchor", requireIdentity, channelOn("mouse"), aw(async (req, res) => {
  if (await refuseIfLocked(res, uid(req))) return;
  res.json(await mouseUse.recordUseAnchor(uid(req), { reason: req.body.reason }));
}));
app.post("/v1/mouse/use-sample", requireIdentity, channelOn("mouse"), async (req, res) => {
  try { if (await refuseIfLocked(res, uid(req))) return; const r = await mouseUse.addUseSample(uid(req), req.body.windows, { client: req.body.client }); res.status(r.status).json(r.body); }
  catch (err) { return sendError(res, "mouse-use-sample", err); }
});
// Destructive: drops the trained mouse profile and every stored session. The CALLER is
// responsible for having verified a passkey first — this service is stateless about auth and
// trusts its caller (same contract as /v1/keystroke/reset).
app.post("/v1/mouse/reset", requireIdentity, async (req, res) => {
  try {
    const userId = uid(req);
    const r = await mouse.resetMouseProfile(userId);
    res.json({ ok: true, message: "Mouse enrollment was reset", removedSessions: r.removedSessions, mouseStatus: await mouse.mouseStatus(userId) });
  } catch (err) { return sendError(res, "mouse-reset", err); }
});

// Shared step-up lock (see lib/lock.js). Mouse callers (apps/demo, the
// gateway) each run their own consecutive-strike debounce, so they set/clear
// this explicitly; keystroke sets it directly above since ca-service already
// decides passkeyTriggered for it.
// Callers that own their own step-up threshold (gateway 3 strikes, demo 1) tell us when
// they have SPENT the evidence, so the next session starts clean. The count lives here;
// only the decision to consume it lives with them.
app.post("/v1/mouse/streak/reset", requireIdentity, aw(async (req, res) => {
  await decisionState.resetMouseStreak(uid(req));
  res.json({ ok: true });
}));

app.post("/v1/lock/set", requireIdentity, aw(async (req, res) => { await lock.setLocked(uid(req)); res.json({ ok: true }); }));
app.post("/v1/lock/clear", requireIdentity, aw(async (req, res) => { await lock.clearLocked(uid(req)); res.json({ ok: true }); }));
app.get("/v1/lock/status/:userId", requireIdentity, aw(async (req, res) => res.json({ locked: await lock.isLocked(uid(req)) })));

// The queue module knows nothing about how training is done — server.js supplies the
// implementation. That keeps the durability machinery independent of the model code and
// lets a test drive the worker with a fake handler.
trainingQueue.registerHandler("keystroke", (userId) => ks.trainUserTypingProfile(userId, db));
// Mouse enrolment trains nine models (lib/mouse.js), so it runs here instead of in the request.
// 409 = nothing left to train (samples reset or below the minimum): done, not a failure to retry.
trainingQueue.registerHandler("mouse", async (userId) => {
  const r = await mouse.retrainMouse(userId);
  if (r.status !== 200 && r.status !== 409) throw new Error(r.body.error || `mouse retrain returned ${r.status}`);
  return r.body;
});

// An error a handler did not answer itself (aw above): the same generic answer as sendError. A request
// body that is not JSON keeps Express's own 400.
app.use((err, req, res, next) => {
  if (err && (err.status || err.statusCode) && (err.status || err.statusCode) < 500) return next(err);
  if (res.headersSent) return next(err);
  return sendError(res, `${req.method} ${req.path}`, err);
});

let server = null;
(async () => {
  // The database first (schema, migration of an older file), then the operator's settings: every
  // request reads them from memory.
  // The database may still be starting (a rollout, a restart of the whole machine): wait for it, bounded (lib/boot.js).
  await waitFor("database", () => db.open());
  await runtimeSettings.load();
  server = app.listen(PORT, () => {
    console.log(`CA service on http://localhost:${PORT} (storage: ${db.kind})`);
    // Started after listen so a boot-time backlog cannot delay readiness — and, more to the
    // point, so a job interrupted by the last shutdown is picked back up on this one.
    trainingQueue.start();
  });
})().catch((e) => {
  console.error(`[ca] cannot start: ${e.message}`);
  process.exit(1);
});
// A stop request (docker stop, a Kubernetes rollout): take no new jobs, finish the requests in flight,
// close the database. A training job still running is left "running" and recovered by the next start
// (trainingQueue.recoverOrphans), as after a crash.
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[ca] ${sig}: stopping`);
    trainingQueue.stop();
    runtimeSettings.stop();
    const done = () => db.close().catch(() => {}).then(() => process.exit(0));
    if (server) server.close(done); else done();
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
