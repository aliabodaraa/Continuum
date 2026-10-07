// Continuum CA service — the behavioral continuous-authentication engine as a
// standalone microservice. Owns keystroke + mouse models/data and scores via the
// model-api. Stateless w.r.t. the caller: every endpoint takes an explicit
// userId. It returns VERDICTS; the demo/BFF applies session + passkey policy.
require("./lib/log")("ca-service");   // LOG_FORMAT=json: one JSON object per log line
const express = require("express");
const crypto = require("crypto");
const db = require("./db");
const ks = require("./lib/keystrokeSecurity");
const mouse = require("./lib/mouse");
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

// ---- adaptive-learning + paste policy (ported from the old demo route) ----
const ADAPTIVE_CONFIDENCE_MIN = 0.8;
const ADAPTIVE_RETRAIN_EVERY = 3;
// A high MEAN can hide one weak window; every window in a contributed packet must
// clear this floor too, or a borderline moment could quietly enter the training set.
const ADAPTIVE_WINDOW_FLOOR = 0.8;
// Adaptive retraining runs in cycles (lib/adaptive.js, the owner's design of 2026-10-04): three clean,
// non-overlapping samples are collected (pending, used by nothing), the user retrains with a passkey,
// then the feature pauses for the organisation's gap (default 3 hours, lib/appSettings.js). It replaced
// "at most one sample per calendar day, automatic retrain after three". Experiment AR measured that
// earlier rule; its samples were already non-overlapping and retrained after three, so the cycle
// changes the pace and adds the passkey, not which samples pass.
const PASTE_POLICY_MAX_CHARS = 80;
// Debounce keystroke CHALLENGES (not scoring): challenge when >= KS_SUSPICIOUS_MIN of the
// last KS_SUSPICIOUS_WINDOW checks are suspicious (a SLIDING window, not strictly
// consecutive). This catches sustained/intermittent abnormal typing (e.g. high-speed
// mashing that's suspicious on many packets but rarely two in a row) while still tolerating
// a single isolated dip on natural text. Strong signals (paste, un-modelable input,
// overwhelming-impostor) bypass the debounce and challenge immediately.
const KS_SUSPICIOUS_WINDOW = 3;
const KS_SUSPICIOUS_MIN = 2;
// The history itself is PERSISTED (lib/decisionState.js). It was a Map here, which made
// every restart an amnesty: an impostor one suspicious check short of a step-up resumed at
// zero after any deploy, crash or OOM kill. A debounce whose evidence cannot survive a
// restart is a debounce with a reset button.
const PASTE_POLICY_MIN_TYPED_COVERAGE = 0.6;

function pastePolicyViolation(quality) {
  if (!quality) return false;
  // Rely on ACTUAL captured paste events, not a keystroke-coverage ratio. The
  // ratio (keydownCount / textLength) false-positives whenever the event buffer
  // no longer spans the full field text — which happens legitimately after a
  // step-up (the tracker resets but the textarea keeps its prior text) and for
  // long entries (events are capped at the last ~700). Those cases wrongly read
  // as "paste" → win=0 → warmup → the impostor gets a free pass. A genuine paste
  // fires a DOM paste event, which the tracker records as pastedLength.
  return quality.pastedLength > PASTE_POLICY_MAX_CHARS;
}
function pastePolicyEvaluation(quality, metrics) {
  return {
    modelConfidence: 0,
    isSuspicious: true,
    reason: "Pasted content bypasses typing-rhythm monitoring. Passkey verification is required for pasted text.",
    modelAvailable: true,
    modelType: "paste-policy",
    metrics: metrics || {},
    typingQuality: quality,
  };
}
function countTrainingSamplesSince(userId, trainedAt) {
  return db
    .prepare(
      `SELECT COUNT(*) as count FROM keystroke_texts
       WHERE user_id = ? AND is_training = 1 AND is_suspicious = 0 AND submitted_at > ?`,
    )
    .get(userId, trainedAt || "1970-01-01").count;
}
// A repeated phrase teaches the model nothing new and lets one piece of content
// silently dominate the positive class. text_hash is already computed and stored on
// every sample (storeTextSample); this just checks it before accepting a new one.
function hasDuplicateTrainingText(userId, hash) {
  return (
    db
      .prepare(
        `SELECT 1 FROM keystroke_texts WHERE user_id = ? AND (is_training = 1 OR sample_purpose = 'adaptive-pending')
           AND text_hash = ? LIMIT 1`,
      )
      .get(userId, hash) != null
  );
}
// Every already-enrolled sample's raw events, for the rhythm-consistency check — the
// comparison needs raw digraph timing, not the derived windows or the model's opinion.
function getTrainingEventsForUser(userId) {
  const textIds = db
    .prepare(`SELECT id FROM keystroke_texts WHERE user_id = ? AND is_training = 1`)
    .all(userId)
    .map((r) => r.id);
  return textIds.map((id) =>
    db
      .prepare(
        `SELECT key_code as keyCode, event_type as eventType, timestamp_relative as timestampRelative,
                field_name as fieldName, field_type as fieldType
         FROM keystroke_events WHERE keystroke_text_id = ? ORDER BY timestamp_relative ASC`,
      )
      .all(id),
  );
}
// The pause after a retrain: no sample before this time (null = now).
function nextContributionAt(userId, settings) {
  const wait = appSettings.contributionWaitMs(adaptive.lastRetrainAt(userId), Date.now(), settings.adaptiveGapHours);
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
function storeTextSample(args) { return storeTextSampleTx(args); }
const storeTextSampleTx = db.transaction(storeTextSampleRows);
function storeTextSampleRows({ userId, textContent, keystrokeEvents, metrics, evaluation, samplePurpose, sourcePath, isTraining, hash, charCount }) {
  const result = db
    .prepare(
      `INSERT INTO keystroke_texts
        (user_id, text_hash, char_count, keystroke_timings, model_confidence, is_suspicious, sample_purpose, source_path, is_training)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    const eventStmt = db.prepare(
      `INSERT INTO keystroke_events
        (keystroke_text_id, key_code, event_type, timestamp_relative, field_name, field_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const evt of keystrokeEvents) {
      eventStmt.run(
        result.lastInsertRowid,
        evt.keyCode,
        evt.eventType === "paste" ? "paste" : evt.eventType,
        evt.timestampRelative,
        evt.fieldName || null,
        evt.fieldType || null,
      );
    }
  }
  return result.lastInsertRowid;
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
app.get("/ready", (req, res) => {
  try { db.prepare("SELECT 1").get(); res.json({ ready: true, service: "ca" }); }
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
    // The organisation's packet (6, 10 or 20 windows; 20 by default): the first verdict comes once
    // there are more windows than this.
    recentWindowCount: ks.decisionWindows(st.keystrokeDecisionWindows),
    rollingWindowCount: ks.ROLLING_WINDOW_COUNT,
    contributeWindowCount: ks.CONTRIBUTE_WINDOW_COUNT,
    packetVoteFraction: ks.PACKET_VOTE_FRACTION,
    decisionThreshold: ks.WINDOW_DECISION_THRESHOLD,
    checkMinTextChars: ks.CHECK_MIN_TEXT_CHARS,
    adaptiveConfidenceMin: ADAPTIVE_CONFIDENCE_MIN,
    adaptiveRetrainEvery: ADAPTIVE_RETRAIN_EVERY,
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
    keystroke: st.keystroke,
    mouse: st.mouse,
    adaptiveEnabled: st.adaptive === "on",
    adaptiveMinGapHours: st.adaptiveGapHours,
    managed: st.managed,
  });
});

// ---- operator settings (called by the gateway's operator page; the API key protects every route) ----
const SECRET_ENV = new Set(["CA_SIGNING_SECRET", "GATEWAY_SESSION_SECRET", "CA_API_KEY", "MODEL_API_KEY", "TEXT_HASH_SALT"]);
const SERVICE_ENV = ["PORT", "DB_PATH", "MODEL_API_URL", "MODEL_STORE_REMOTE", "MODEL_STORE_DIR", "MODEL_TRAIN_TIMEOUT_MS",
  "MODEL_INFER_TIMEOUT_MS", "TRAINING_POLL_MS", "TRAINING_MAX_ATTEMPTS", "KEYSTROKE_NEGATIVES_PATH", "GATEWAY_JWKS_URI",
  "IDENTITY_MAX_AGE_SEC", "CA_RISK_TTL_SEC", "STUDY_LOGGING", "ONBOARDING_MODE", "MONITOR_EXCLUDE_TYPES", "CONTINUUM_PANEL",
  "CONTINUUM_KEYSTROKE", "CONTINUUM_MOUSE", "ADAPTIVE_RETRAINING", "ADAPTIVE_MIN_GAP_HOURS", "KEYSTROKE_DECISION_WINDOWS", ...SECRET_ENV];
app.get("/v1/admin/settings", (req, res) => {
  res.json({
    settings: runtimeSettings.describe(),
    environment: SERVICE_ENV.map((name) => ({
      name, set: process.env[name] != null && process.env[name] !== "",
      value: SECRET_ENV.has(name) ? null : (process.env[name] ?? null), secret: SECRET_ENV.has(name),
    })),
  });
});
app.put("/v1/admin/settings", (req, res) => {
  try { res.json({ settings: runtimeSettings.update(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.code || "bad_setting", note: e.message }); }
});

// Typing enrolment trains from the queue (since 2026-10-06), as /status reports it: `training` while
// the job is queued or running, `trainingError` when the last job failed and left no model although
// the samples were enough (one more enrolment sample queues a new job).
function keystrokeTraining(userId, status) {
  if (status.trained) return { training: false, trainingError: null };
  const { pending, jobs } = trainingQueue.statusFor(userId, "keystroke");
  const enough = status.remainingSamples === 0 && status.remainingPositiveWindows === 0;
  const failed = enough && !pending && jobs.length && jobs[0].state === "failed" ? jobs[0].last_error || "training failed" : null;
  return { training: !!pending, trainingError: failed };
}

app.get("/v1/keystroke/status/:userId", requireIdentity, (req, res) => {
  const status = { ...ks.getUserTypingStatus(uid(req), db) };
  Object.assign(status, keystrokeTraining(uid(req), status));
  const adaptiveSamplesSinceRetrain = status.trainedAt ? countTrainingSamplesSince(uid(req), status.trainedAt) : 0;
  const st = appSettings.forRequest(req);
  res.json({ ...status, adaptiveSamplesSinceRetrain, adaptiveRetrainEvery: ADAPTIVE_RETRAIN_EVERY,
    adaptiveEnabled: st.adaptive === "on", adaptiveMinGapHours: st.adaptiveGapHours,
    adaptivePending: adaptive.pendingCount(uid(req)), adaptiveReady: adaptive.pendingCount(uid(req)) >= ADAPTIVE_RETRAIN_EVERY,
    nextContributionAt: st.adaptive === "on" ? nextContributionAt(uid(req), st) : null });
});

app.get("/v1/users/:userId/onboarding", requireIdentity, (req, res) => {
  const status = ks.getUserTypingStatus(uid(req), db);
  // keystrokeTraining: the model is being built; clients treat typing enrolment as done meanwhile.
  res.json({ trained: !!status.trained, keystrokeTraining: keystrokeTraining(uid(req), status).training, mouseEnrolled: mouse.mouseEnrolled(uid(req)) });
});

// ---- keystroke: enroll / check / submit / contribute / reset / retrain ----
app.post("/v1/keystroke/enroll", requireIdentity, channelOn("keystroke"), async (req, res) => {
  try {
    const userId = uid(req);
    // Once the typing model exists it learns more ONLY through the adaptive popup, whose retrain needs
    // the passkey. Until 2026-10-05 this route took more samples at any time and retrained at once with
    // no passkey, so anyone at an unlocked session could train the model on their own typing. Enrolling
    // again needs a profile reset first, and the reset asks for the passkey.
    if (ks.getUserTypingStatus(userId, db).trained) {
      return res.status(409).json({ ok: false, error: "already_enrolled",
        note: "The typing model is trained; it learns more only through the adaptive popup. Reset the profile (passkey) to enrol again." });
    }
    studyLog.register(userId, studyLog.parseContext(req.body.study));   // so its training is logged
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
    const textId = storeTextSample({
      userId, textContent, keystrokeEvents, metrics,
      evaluation: { modelConfidence: null, isSuspicious: false },
      samplePurpose: "enrollment", sourcePath: sourcePath || "/enroll.html", isTraining: true,
    });
    // Training runs from the queue (since 2026-10-06), like mouse enrolment: the user is not held for the
    // ~45 s it takes (up to ~2 min; it used to run inside this request), and a page reload or a restart
    // loses nothing. Clients read `training` / `trainingError` from /status until `trained`.
    const before = ks.getUserTypingStatus(userId, db);
    const enough = before.remainingSamples === 0 && before.remainingPositiveWindows === 0;
    if (enough) trainingQueue.enqueue(userId, "keystroke", "enrol");
    const typingStatus = { ...before };
    Object.assign(typingStatus, keystrokeTraining(userId, typingStatus));
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
    const { textContent, textLength, keystrokeTimings, keystrokeEvents, hasPasskey } = req.body;
    // The organisation's packet: the vote runs on its last this-many windows, and until there are
    // more windows than this the check is warm-up.
    const packetWindows = ks.decisionWindows(appSettings.forRequest(req).keystrokeDecisionWindows);
    // A client may send the trimmed text's LENGTH instead of the text (the study extension does).
    const typedLength = textContent != null ? String(textContent).trim().length : Number(textLength);
    if (!Number.isFinite(typedLength) || typedLength < ks.CHECK_MIN_TEXT_CHARS) {
      return res.json({ ok: true, checked: false, message: "More typed text is required before rhythm verification" });
    }
    const checkQuality = ks.typingQuality(textContent, keystrokeEvents, typedLength);
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
    const evaluation = pastePolicyViolation(checkQuality)
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
    const unverifiable = evaluation.unverifiable === true;
    const isPastePolicy = evaluation.modelType === "paste-policy";
    const isWarmup = Number(evaluation.windowCount || 0) <= packetWindows &&
      !overwhelmingImpostor && !unverifiable && !isPastePolicy && !degenerateInput;
    // Debounce the CHALLENGE (not the scoring): normal packet-vote suspicion must persist
    // across KS_SUSPICIOUS_MIN of the last KS_SUSPICIOUS_WINDOW checks (sliding window);
    // strong signals fire immediately. A genuine run flushes the history. Probation (post
    // step-up, client-side) is unaffected. Degenerate input is unverifiable even when the
    // model scores it genuine, so it forces suspicion AND counts as a strong signal.
    const effectiveSuspicious = (!isWarmup && evaluation.isSuspicious) || degenerateInput;
    const strongSignal = overwhelmingImpostor || unverifiable || isPastePolicy || degenerateInput;
    // Persisted, so the evidence accumulated so far outlives a restart.
    const { suspiciousCount: recentSuspicious } =
      decisionState.pushKeystrokeVerdict(userId, effectiveSuspicious, KS_SUSPICIOUS_WINDOW);
    const passkeyTriggered = !!hasPasskey && effectiveSuspicious && (strongSignal || recentSuspicious >= KS_SUSPICIOUS_MIN);
    if (passkeyTriggered) { decisionState.resetKeystrokeHistory(userId); lock.setLocked(userId); }

    ks.logAuthDecision(userId, db, { source: "check", evaluation, passkeyTriggered });
    // User study (lib/studyLog.js; a no-op outside it): the packet's full-precision scores and keys.
    const studyCtx = studyLog.parseContext(req.body.study);
    const studyDecisionId = studyCtx ? studyLog.recordCheck(userId, studyCtx, {
      channel: "keystroke", ruleVersion: ks.ruleVersion(packetWindows), threshold: ks.WINDOW_DECISION_THRESHOLD,
      scores: warmupScores, keys: evaluation.recentWindowKeys,
      lowWindows: warmupLows,
      verdict: passkeyTriggered ? "challenge" : isWarmup ? "warmup" : effectiveSuspicious ? "suspicious" : "ok",
      promptRequired: passkeyTriggered,
      details: {
        packetSuspicious: evaluation.isSuspicious === true, windowTotal: Number(evaluation.windowCount || 0),
        overwhelmingImpostor, unverifiable, pastePolicy: isPastePolicy, degenerateInput,
        recentSuspicious, hasPasskey: !!hasPasskey, modelAvailable: evaluation.modelAvailable !== false,
        suspiciousWindow: KS_SUSPICIOUS_WINDOW, suspiciousMin: KS_SUSPICIOUS_MIN, packetWindows,
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
      modelConfidence: evaluation.modelConfidence, isSuspicious: evaluation.isSuspicious,
      typingEvaluation: evaluation,
      riskToken: signRisk(userId, riskLevel(isWarmup, evaluation.isSuspicious), "keystroke"),
      message: passkeyTriggered
        ? (degenerateInput ? "Repeated or erratic keystrokes can't verify identity. Passkey verification required."
          : "Typing rhythm does not match. Passkey verification required.")
        : isWarmup ? "Warming up — building the first evaluation packet." : "Typing rhythm verified.",
    });
  } catch (err) { return sendError(res, "check", err, { checked: false }); }
});

// /v1/keystroke/submit (score and store the text at a form's submit) was removed on 2026-10-05:
// Continuum checks typing and movement while they happen, never at a submit, and nothing but the
// adaptive popup adds typing samples.

app.post("/v1/keystroke/contribute", requireIdentity, channelOn("keystroke"), excludeFields, async (req, res) => {
  try {
    const userId = uid(req);
    const st = appSettings.forRequest(req);
    if (st.adaptive === "off") {
      return res.status(409).json({ ok: false, error: "adaptive_disabled", note: "Adaptive retraining is turned off for this organisation." });
    }
    const next = nextContributionAt(userId, st);
    if (next) {
      const mins = Math.ceil((Date.parse(next) - Date.now()) / 60000);
      return res.status(429).json({
        ok: false, error: "adaptive_paused", nextContributionAt: next, pauseHours: st.adaptiveGapHours,
        message: `Your model was just retrained. New samples can be added again in ${mins >= 60 ? Math.ceil(mins / 60) + " h" : mins + " min"}.`,
      });
    }
    const pending = adaptive.pendingCount(userId);
    if (pending >= ADAPTIVE_RETRAIN_EVERY) {
      return res.status(409).json({ ok: false, error: "ready_to_retrain", pending, retrainEvery: ADAPTIVE_RETRAIN_EVERY,
        message: `${pending} samples are ready. Retrain your model (with your passkey) before adding more.` });
    }
    // A sample is the typing since the previous one (the SDK sends only that, and its length, not the
    // field's whole text); a client that still sends the text is measured on the text.
    const { textContent, keystrokeEvents } = req.body;
    const quality = ks.typingQuality(textContent != null ? textContent : null, keystrokeEvents, req.body.textLength);
    if (!quality.acceptableForEnrollment) {
      return res.status(422).json({
        ok: false,
        error: quality.pasteCount > 0 ? "Pasted text cannot train your model. Type naturally." : "Not enough typed keystrokes in this sample to contribute.",
      });
    }
    if (adaptive.overlapShare(userId, keystrokeEvents) > adaptive.OVERLAP_LIMIT) {
      return res.status(422).json({ ok: false, error: "sample_overlaps",
        message: "This stretch repeats typing from your previous sample. Keep typing, then add the next one." });
    }
    const evaluation = await ks.evaluateKeystrokes({ events: keystrokeEvents, timings: null, userId, db });
    const rolling = Number(evaluation.rollingMean != null ? evaluation.rollingMean : evaluation.modelConfidence);
    const windowsSeen = evaluation.rollingWindowCount || 0;
    const minContributeWindows = ks.CONTRIBUTE_WINDOW_COUNT;
    if (!evaluation.modelAvailable || rolling < ADAPTIVE_CONFIDENCE_MIN || windowsSeen < minContributeWindows) {
      return res.status(422).json({
        ok: false,
        error: windowsSeen < minContributeWindows
          ? `Keep typing — need ${minContributeWindows} clean windows, have ${windowsSeen}.`
          : `Sample not clean enough to contribute (${Math.round(rolling * 100)}% < ${Math.round(ADAPTIVE_CONFIDENCE_MIN * 100)}%).`,
        rollingMean: rolling,
      });
    }
    // A high MEAN can hide one weak window inside an otherwise-clean packet — require
    // every recent window to clear the floor too.
    const recentScores = Array.isArray(evaluation.recentWindowScores)
      ? evaluation.recentWindowScores.slice(-ks.CONTRIBUTE_WINDOW_COUNT) : [];
    const worstWindow = recentScores.length ? Math.min(...recentScores) : rolling;
    if (worstWindow < ADAPTIVE_WINDOW_FLOOR) {
      return res.status(422).json({
        ok: false,
        error: `One window in this sample scored ${Math.round(worstWindow * 100)}%, below the ${Math.round(ADAPTIVE_WINDOW_FLOOR * 100)}% floor — a good average can hide one weak moment. Try again with a fully consistent stretch of typing.`,
        rollingMean: rolling,
      });
    }
    // Model-independent check: does this sample's own timing match this user's ALREADY
    // enrolled history, regardless of what the (possibly still-young) model thinks of it?
    const consistency = ks.checkRhythmConsistency(keystrokeEvents, getTrainingEventsForUser(userId));
    if (!consistency.consistent) {
      return res.status(422).json({
        ok: false,
        error: `This sample's ${consistency.worstFeature} timing is unusually different from your `
          + `enrolled rhythm (z=${consistency.worstZ.toFixed(2)}) — try again with your normal typing pace.`,
        rollingMean: rolling,
      });
    }
    // "New text": the same phrase typed again (the same key sequence) teaches the model nothing new.
    const hash = textContent != null ? textHash(textContent) : textHash("keys:" + adaptive.keySequence(keystrokeEvents));
    if (hasDuplicateTrainingText(userId, hash)) {
      return res.status(422).json({
        ok: false,
        error: "This text has already been contributed — a repeated sample teaches the model nothing new.",
      });
    }
    storeTextSample({
      userId, textContent: textContent || "[adaptive-contribution]", keystrokeEvents,
      metrics: evaluation.metrics, evaluation, samplePurpose: adaptive.PENDING,
      sourcePath: "contribute", isTraining: false, hash, charCount: quality.textLength,
    });
    const now = adaptive.pendingCount(userId);
    res.json({ ok: true, pending: now, retrainEvery: ADAPTIVE_RETRAIN_EVERY, ready: now >= ADAPTIVE_RETRAIN_EVERY, rollingMean: rolling,
      message: now >= ADAPTIVE_RETRAIN_EVERY ? "Sample added. Your model is ready to retrain." : `Sample added: ${now} of ${ADAPTIVE_RETRAIN_EVERY}.` });
  } catch (err) { return sendError(res, "contribute", err); }
});

// The user retrains with the pending samples. Callers MUST have verified the user's passkey in the
// same request (gateway /v1/sdk/keystroke/adaptive/retrain, demo /api/text/adaptive-retrain): that is
// what keeps samples added at an unlocked session from ever reaching a model.
app.post("/v1/keystroke/adaptive/confirm", requireIdentity, channelOn("keystroke"), (req, res) => {
  try {
    const userId = uid(req);
    const st = appSettings.forRequest(req);
    if (st.adaptive === "off") return res.status(409).json({ ok: false, error: "adaptive_disabled" });
    const pending = adaptive.pendingCount(userId);
    if (pending < ADAPTIVE_RETRAIN_EVERY) {
      return res.status(409).json({ ok: false, error: "not_ready", pending, retrainEvery: ADAPTIVE_RETRAIN_EVERY });
    }
    const n = adaptive.confirm(userId);
    trainingQueue.enqueue(userId, "keystroke", "adaptive");
    res.json({ ok: true, retraining: true, samples: n, nextContributionAt: nextContributionAt(userId, st), pauseHours: st.adaptiveGapHours });
  } catch (err) { return sendError(res, "adaptive-confirm", err); }
});

app.post("/v1/keystroke/reset", requireIdentity, (req, res) => {
  const userId = uid(req);
  ks.resetUserTypingProfile(userId, db);
  adaptive.forget(userId);
  db.prepare("UPDATE keystroke_texts SET is_training = 0 WHERE user_id = ?").run(userId);
  // The debounce history is evidence against a model that no longer exists. Carrying it
  // into re-enrollment could step the user up on their first scored check afterwards.
  decisionState.resetKeystrokeHistory(userId);
  res.json({ ok: true, message: "Typing rhythm enrollment was reset", typingStatus: ks.getUserTypingStatus(userId, db) });
});

// ---- training jobs (durable queue) ----
// Retraining is owed work recorded in a table, not a detached promise. This endpoint is how
// a dashboard or an operator sees that a retrain is pending, running, or has failed —
// previously the entire lifecycle was invisible and a lost job was indistinguishable from
// one that had never been scheduled.
app.get("/v1/training/jobs", requireIdentity, (req, res) => {
  res.json(trainingQueue.statusFor(uid(req), req.query.modality || null));
});

app.post("/v1/keystroke/retrain", requireIdentity, async (req, res) => {
  try {
    const userId = uid(req);
    const profile = await ks.trainUserTypingProfile(userId, db);
    if (!profile) {
      return res.status(422).json({ ok: false, error: "Not enough training samples to rebuild model", typingStatus: ks.getUserTypingStatus(userId, db) });
    }
    res.json({
      ok: true, message: "Rhythm model rebuilt from stored samples",
      typingStatus: ks.getUserTypingStatus(userId, db),
      profile: { threshold: profile.threshold, sampleCount: profile.sampleCount, trainedAt: profile.trainedAt, trainedFrom: profile.trainedFrom },
    });
  } catch (err) { return sendError(res, "retrain", err); }
});

// ---- user study: bind this user to a participant pseudonym at setup, BEFORE enrolment, so the
// enrolment trainings are recorded with their threshold-source scores (lib/studyLog.js) ----
app.post("/v1/study/register", requireIdentity, (req, res) => {
  const ctx = studyLog.participantContext(req.body.participant);
  if (!ctx) return res.status(400).json({ ok: false, error: "invalid participant (or STUDY_LOGGING is off)" });
  const ok = studyLog.register(uid(req), ctx);
  res.status(ok ? 200 : 409).json({ ok, userId: uid(req) });
});

// ---- user study: passkey prompt events as the study client saw them (lib/studyLog.js) ----
app.post("/v1/study/prompt", requireIdentity, (req, res) => {
  const ctx = studyLog.parseContext(req.body.study);
  if (!ctx) return res.status(400).json({ ok: false, error: "no valid study context (or STUDY_LOGGING is off)" });
  const stored = studyLog.recordPrompt(uid(req), ctx, {
    channel: req.body.channel, decisionId: req.body.decisionId, event: req.body.event,
  });
  res.status(stored ? 200 : 400).json({ ok: stored });
});

// ---- login-triggered background retrain when new impostors appeared ----
app.post("/v1/keystroke/maybe-retrain-impostors", requireIdentity, (req, res) => {
  ks.maybeRetrainForNewImpostors(uid(req), db);
  res.json({ ok: true });
});

// ---- read models for the demo/dashboard (username joins happen in the demo) ----
app.get("/v1/keystroke/history/:userId", requireIdentity, (req, res) => {
  const texts = db.prepare(
    "SELECT id, char_count, model_confidence, is_suspicious, sample_purpose, is_training, submitted_at FROM keystroke_texts WHERE user_id = ? ORDER BY submitted_at DESC",
  ).all(uid(req));
  res.json({ texts });
});

app.get("/v1/keystroke/stats/:userId", requireIdentity, (req, res) => {
  const stats = db.prepare(
    `SELECT COUNT(*) as total_submissions,
            COUNT(CASE WHEN is_suspicious = 1 THEN 1 END) as suspicious_count,
            AVG(model_confidence) as avg_confidence,
            SUM(char_count) as total_chars
     FROM keystroke_texts WHERE user_id = ?`,
  ).get(uid(req));
  res.json({ ...stats, typingStatus: ks.getUserTypingStatus(uid(req), db) });
});

app.get("/v1/keystroke/decisions/:userId", requireIdentity, (req, res) => {
  const decisions = db.prepare(
    `SELECT id, checked_at, source, window_count, mean_score, threshold, verdict, passkey_triggered, passkey_outcome, per_window_scores
     FROM auth_decisions WHERE user_id = ? ORDER BY checked_at DESC LIMIT 500`,
  ).all(uid(req));
  res.json({ decisions });
});

// Raw decisions for CSV export + research metrics (per user_id; the demo maps usernames).
// TENANT-SCOPED. This returned every tenant's decisions unconditionally. There is still no
// tenant_id column on auth_decisions, so the scope is enforced by joining the identity
// registry: only ids belonging to the caller's tenant are visible. Retired and unregistered
// ids belong to no tenant and are therefore excluded, which is the correct outcome.
app.get("/v1/keystroke/decisions-all", requireIdentity, (req, res) => {
  const rows = db.prepare(
    `SELECT id, user_id, checked_at, source, window_count, mean_score, threshold, verdict, passkey_triggered, passkey_outcome, per_window_scores
     FROM auth_decisions
     WHERE user_id IN (SELECT legacy_user_id FROM principal_aliases WHERE tenant_id = ?)
     ORDER BY checked_at DESC`,
  ).all(tenantOf(req));
  res.json({ rows });
});

app.get("/v1/keystroke/metrics", requireIdentity, (req, res) => {
  const rows = db.prepare(
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
     GROUP BY user_id`,
  ).all(tenantOf(req));
  const profiles = db.prepare("SELECT user_id, model_json FROM user_typing_profiles WHERE user_id IN (SELECT legacy_user_id FROM principal_aliases WHERE tenant_id = ?)").all(tenantOf(req));
  const profileMap = {};
  for (const p of profiles) { try { profileMap[p.user_id] = JSON.parse(p.model_json); } catch {} }
  res.json({ rows, profileMap });
});

// ---- mouse ----
// Action-based mouse — the published path (Antal & Egyed-Zsigmond 2019).
// The window endpoints below are retained as the comparison arm.
app.post("/v1/mouse/actions/enroll", requireIdentity, channelOn("mouse"), async (req, res) => {
  try { const r = await mouseActions.enrollMouseActions(uid(req), req.body.actions); res.status(r.status).json(r.body); }
  catch (err) { return sendError(res, "mouse-action-enroll", err); }
});
app.post("/v1/mouse/actions/check", requireIdentity, channelOn("mouse"), async (req, res) => {
  try {
    const r = await mouseActions.checkMouseActions(uid(req), req.body.actions);
    if (r.body && r.body.checked) {
      r.body.riskToken = signRisk(uid(req), riskLevel(r.body.warmup, r.body.isSuspicious), "mouse");
    }
    res.status(r.status).json(r.body);
  } catch (err) { return sendError(res, "mouse-action-check", err, { checked: false }); }
});
app.get("/v1/mouse/actions/status", requireIdentity, (req, res) => {
  res.json(mouseActions.mouseActionsStatus(uid(req)));
});
app.post("/v1/mouse/actions/reset", requireIdentity, (req, res) => {
  const r = mouseActions.resetMouseActionProfile(uid(req));
  res.status(r.status).json(r.body);
});

app.post("/v1/mouse/enroll", requireIdentity, channelOn("mouse"), async (req, res) => {
  try {
    studyLog.register(uid(req), studyLog.parseContext(req.body.study));   // so its training is logged
    const r = await mouse.enrollMouse(uid(req), req.body.windows); res.status(r.status).json(r.body);
  }
  catch (err) { return sendError(res, "mouse-enroll", err); }
});
app.post("/v1/mouse/check", requireIdentity, channelOn("mouse"), async (req, res) => {
  try {
    const r = await mouse.checkMouse(uid(req), req.body.windows, req.body.study);
    if (r.body && r.body.checked) {
      r.body.riskToken = signRisk(uid(req), riskLevel(r.body.warmup, r.body.isSuspicious), "mouse");
    }
    res.status(r.status).json(r.body);
  } catch (err) { return sendError(res, "mouse-check", err, { checked: false }); }
});
app.get("/v1/mouse/status/:userId", requireIdentity, (req, res) => res.json(mouse.mouseStatus(uid(req))));
// Destructive: drops the trained mouse profile and every stored session. The CALLER is
// responsible for having verified a passkey first — this service is stateless about auth and
// trusts its caller (same contract as /v1/keystroke/reset).
app.post("/v1/mouse/reset", requireIdentity, (req, res) => {
  try {
    const userId = uid(req);
    const r = mouse.resetMouseProfile(userId);
    res.json({ ok: true, message: "Mouse enrollment was reset", removedSessions: r.removedSessions, mouseStatus: mouse.mouseStatus(userId) });
  } catch (err) { return sendError(res, "mouse-reset", err); }
});

// Shared step-up lock (see lib/lock.js). Mouse callers (apps/demo, the
// gateway) each run their own consecutive-strike debounce, so they set/clear
// this explicitly; keystroke sets it directly above since ca-service already
// decides passkeyTriggered for it.
// Callers that own their own step-up threshold (gateway 3 strikes, demo 1) tell us when
// they have SPENT the evidence, so the next session starts clean. The count lives here;
// only the decision to consume it lives with them.
app.post("/v1/mouse/streak/reset", requireIdentity, (req, res) => {
  decisionState.resetMouseStreak(uid(req));
  res.json({ ok: true });
});

app.post("/v1/lock/set", requireIdentity, (req, res) => { lock.setLocked(uid(req)); res.json({ ok: true }); });
app.post("/v1/lock/clear", requireIdentity, (req, res) => { lock.clearLocked(uid(req)); res.json({ ok: true }); });
app.get("/v1/lock/status/:userId", requireIdentity, (req, res) => res.json({ locked: lock.isLocked(uid(req)) }));

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

const server = app.listen(PORT, () => {
  console.log(`CA service on http://localhost:${PORT}`);
  // Started after listen so a boot-time backlog cannot delay readiness — and, more to the
  // point, so a job interrupted by the last shutdown is picked back up on this one.
  trainingQueue.start();
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
    server.close(() => { try { db.close(); } catch (_) {} process.exit(0); });
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
