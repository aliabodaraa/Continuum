// Continuum CA service — the behavioral continuous-authentication engine as a
// standalone microservice. Owns keystroke + mouse models/data and scores via the
// model-api. Stateless w.r.t. the caller: every endpoint takes an explicit
// userId. It returns VERDICTS; the demo/BFF applies session + passkey policy.
const express = require("express");
const crypto = require("crypto");
const db = require("./db");
const ks = require("./lib/keystrokeSecurity");
const mouse = require("./lib/mouse");
const lock = require("./lib/lock");

const PORT = Number(process.env.PORT || 4100);
const API_KEY = process.env.CA_API_KEY || "";

// ---- signed risk verdicts (the PDP's attestation) ----
// Every verdict is signed as a short-lived HS256 JWT so a relying party (the
// host app's backend, via the @continuum/node middleware) can ENFORCE the
// decision without trusting the browser. Dependency-free (Node crypto).
const RISK_SECRET = process.env.CA_SIGNING_SECRET || "dev-continuum-risk-secret";
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
const adaptiveRetrainsInFlight = new Set();
const PASTE_POLICY_MAX_CHARS = 80;
// Debounce keystroke CHALLENGES (not scoring): challenge when >= KS_SUSPICIOUS_MIN of the
// last KS_SUSPICIOUS_WINDOW checks are suspicious (a SLIDING window, not strictly
// consecutive). This catches sustained/intermittent abnormal typing (e.g. high-speed
// mashing that's suspicious on many packets but rarely two in a row) while still tolerating
// a single isolated dip on natural text. Strong signals (paste, un-modelable input,
// overwhelming-impostor) bypass the debounce and challenge immediately.
const KS_SUSPICIOUS_WINDOW = 3;
const KS_SUSPICIOUS_MIN = 2;
const suspiciousHistory = new Map(); // userId -> recent booleans (last KS_SUSPICIOUS_WINDOW)
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
function maybeRetrainAdaptively(userId) {
  if (adaptiveRetrainsInFlight.has(userId)) return;
  const profile = ks.getUserTypingProfile(userId, db);
  if (!profile || !profile.trainedAt) return;
  if (countTrainingSamplesSince(userId, profile.trainedAt) < ADAPTIVE_RETRAIN_EVERY) return;
  adaptiveRetrainsInFlight.add(userId);
  setImmediate(async () => {
    try {
      await ks.trainUserTypingProfile(userId, db);
    } catch (err) {
      console.error(`[adaptive] retrain failed for ${userId}:`, err.message);
    } finally {
      adaptiveRetrainsInFlight.delete(userId);
    }
  });
}

// Salted so the hashes are not a rainbow-table of common phrases. The salt is per
// deployment and stable, which is all equality comparison needs.
const TEXT_HASH_SALT = process.env.TEXT_HASH_SALT || "continuum-text-hash-salt";
function textHash(t) {
  return require("crypto").createHmac("sha256", TEXT_HASH_SALT).update(String(t || "")).digest("hex");
}

function storeTextSample({ userId, textContent, keystrokeEvents, metrics, evaluation, samplePurpose, sourcePath, isTraining }) {
  const result = db
    .prepare(
      `INSERT INTO keystroke_texts
        (user_id, text_hash, char_count, keystroke_timings, model_confidence, is_suspicious, sample_purpose, source_path, is_training)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      textHash(textContent),
      String(textContent || "").length,
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

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (API_KEY && req.get("X-Api-Key") !== API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
});

const uid = (req) => Number(req.body.userId || req.params.userId);

app.get("/health", (req, res) => res.json({ ok: true, service: "ca" }));

// ---- config + onboarding status (used by the demo gate) ----
app.get("/v1/keystroke/config", (req, res) => {
  res.json({
    windowSize: ks.WINDOW_SIZE,
    windowStride: ks.WINDOW_STRIDE,
    recentWindowCount: ks.RECENT_WINDOW_COUNT,
    rollingWindowCount: ks.ROLLING_WINDOW_COUNT,
    packetVoteFraction: ks.PACKET_VOTE_FRACTION,
    decisionThreshold: ks.WINDOW_DECISION_THRESHOLD,
    checkMinTextChars: ks.CHECK_MIN_TEXT_CHARS,
    adaptiveConfidenceMin: ADAPTIVE_CONFIDENCE_MIN,
    adaptiveRetrainEvery: ADAPTIVE_RETRAIN_EVERY,
    // Deployment-level onboarding strategy (docker env):
    //   eager — popup enrolls everything missing at load (default)
    //   lazy  — passkey only at load; keystroke/mouse enroll when the user
    //           enables that toggle (keystroke-only deployments never ask for mouse)
    onboardingMode: process.env.ONBOARDING_MODE === "lazy" ? "lazy" : "eager",
    // Field types the SDK must NOT monitor (deployment config). Everything else —
    // including password (value masked, timing kept) — is monitored.
    excludeFieldTypes: (process.env.MONITOR_EXCLUDE_TYPES || "hidden")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  });
});

app.get("/v1/keystroke/status/:userId", (req, res) => {
  const status = ks.getUserTypingStatus(uid(req), db);
  const adaptiveSamplesSinceRetrain = status.trainedAt ? countTrainingSamplesSince(uid(req), status.trainedAt) : 0;
  res.json({ ...status, adaptiveSamplesSinceRetrain, adaptiveRetrainEvery: ADAPTIVE_RETRAIN_EVERY });
});

app.get("/v1/users/:userId/onboarding", (req, res) => {
  const status = ks.getUserTypingStatus(uid(req), db);
  res.json({ trained: !!status.trained, mouseEnrolled: mouse.mouseEnrolled(uid(req)) });
});

// ---- keystroke: enroll / check / submit / contribute / reset / retrain ----
app.post("/v1/keystroke/enroll", async (req, res) => {
  try {
    const userId = uid(req);
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
    let profile = null, trainingError = null;
    try { profile = await ks.trainUserTypingProfile(userId, db); }
    catch (err) { trainingError = err.message; console.error("training error:", err); }
    const typingStatus = ks.getUserTypingStatus(userId, db);
    res.json({
      ok: true,
      message: trainingError ? `Enrollment sample saved, but training failed: ${trainingError}`
        : typingStatus.trained ? "CNN/LSTM typing rhythm model trained" : "Enrollment sample saved",
      textId, trained: !!profile, trainingError, typingStatus, typingQuality: quality,
    });
  } catch (err) { console.error("enroll:", err); res.status(500).json({ error: err.message }); }
});

app.post("/v1/keystroke/check", async (req, res) => {
  try {
    const userId = uid(req);
    const { textContent, keystrokeTimings, keystrokeEvents, hasPasskey } = req.body;
    if (!textContent || String(textContent).trim().length < ks.CHECK_MIN_TEXT_CHARS) {
      return res.json({ ok: true, checked: false, message: "More typed text is required before rhythm verification" });
    }
    const checkQuality = ks.typingQuality(textContent, keystrokeEvents);
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
      : await ks.evaluateKeystrokes({ events: keystrokeEvents, timings: keystrokeTimings, userId, db });

    const warmupScores = Array.isArray(evaluation.recentWindowScores) ? evaluation.recentWindowScores.map(Number) : [];
    const warmupLows = warmupScores.filter((s) => s < ks.WINDOW_DECISION_THRESHOLD).length;
    const overwhelmingImpostor = warmupScores.length >= 4 && warmupLows >= Math.ceil(warmupScores.length * 0.75);
    // Un-modelable typing (no window despite abundant keystrokes) and a paste
    // violation are BOTH definite verdicts, not warmup — they must be challenged,
    // otherwise they're a free pass around the whole model. (A paste evaluation
    // carries no windowCount, so without this it would default to warmup.)
    const unverifiable = evaluation.unverifiable === true;
    const isPastePolicy = evaluation.modelType === "paste-policy";
    const isWarmup = Number(evaluation.windowCount || 0) <= ks.RECENT_WINDOW_COUNT &&
      !overwhelmingImpostor && !unverifiable && !isPastePolicy && !degenerateInput;
    // Debounce the CHALLENGE (not the scoring): normal packet-vote suspicion must persist
    // across KS_SUSPICIOUS_MIN of the last KS_SUSPICIOUS_WINDOW checks (sliding window);
    // strong signals fire immediately. A genuine run flushes the history. Probation (post
    // step-up, client-side) is unaffected. Degenerate input is unverifiable even when the
    // model scores it genuine, so it forces suspicion AND counts as a strong signal.
    const effectiveSuspicious = (!isWarmup && evaluation.isSuspicious) || degenerateInput;
    const strongSignal = overwhelmingImpostor || unverifiable || isPastePolicy || degenerateInput;
    let hist = suspiciousHistory.get(userId) || [];
    hist.push(effectiveSuspicious);
    if (hist.length > KS_SUSPICIOUS_WINDOW) hist = hist.slice(-KS_SUSPICIOUS_WINDOW);
    suspiciousHistory.set(userId, hist);
    const recentSuspicious = hist.filter(Boolean).length;
    const passkeyTriggered = !!hasPasskey && effectiveSuspicious && (strongSignal || recentSuspicious >= KS_SUSPICIOUS_MIN);
    if (passkeyTriggered) { suspiciousHistory.set(userId, []); lock.setLocked(userId); }

    ks.logAuthDecision(userId, db, { source: "check", evaluation, passkeyTriggered });

    res.json({
      ok: !passkeyTriggered, checked: true, warmup: isWarmup,
      requiresPasskeyChallenge: passkeyTriggered,
      // How many windows the model ACTUALLY scored this check. 0 = the warmup
      // "placeholder" verdict (no scorable window yet) — used by the SDK to tell a
      // real suspicious verdict apart from the not-enough-data placeholder, so
      // post-step-up probation re-challenges a scored impostor but never loops on
      // a genuine user who is merely rebuilding their first window.
      scoredWindowCount: warmupScores.length,
      modelConfidence: evaluation.modelConfidence, isSuspicious: evaluation.isSuspicious,
      typingEvaluation: evaluation,
      riskToken: signRisk(userId, riskLevel(isWarmup, evaluation.isSuspicious), "keystroke"),
      message: passkeyTriggered
        ? (degenerateInput ? "Repeated or erratic keystrokes can't verify identity. Passkey verification required."
          : "Typing rhythm does not match. Passkey verification required.")
        : isWarmup ? "Warming up — building the first evaluation packet." : "Typing rhythm verified.",
    });
  } catch (err) { console.error("check:", err); res.status(500).json({ error: err.message }); }
});

app.post("/v1/keystroke/submit", async (req, res) => {
  try {
    const userId = uid(req);
    const { textContent, keystrokeTimings, keystrokeEvents, passkeyVerified, hasPasskey } = req.body;
    if (!textContent) return res.status(400).json({ error: "textContent required" });

    const submitQuality = ks.typingQuality(textContent, keystrokeEvents);
    const evaluation = passkeyVerified
      ? { modelConfidence: null, isSuspicious: false, reason: "Passkey verified this protected writing action",
          modelAvailable: true, modelType: "passkey-step-up", metrics: keystrokeTimings || {} }
      : pastePolicyViolation(submitQuality)
        ? pastePolicyEvaluation(submitQuality, keystrokeTimings)
        : await ks.evaluateKeystrokes({ events: keystrokeEvents, timings: keystrokeTimings, userId, db });

    const adaptiveTrainingSample = !passkeyVerified && !evaluation.isSuspicious &&
      Number(evaluation.modelConfidence) >= ADAPTIVE_CONFIDENCE_MIN && submitQuality.acceptableForEnrollment;

    const textId = storeTextSample({
      userId, textContent, keystrokeEvents,
      metrics: evaluation.metrics || keystrokeTimings || {}, evaluation,
      samplePurpose: adaptiveTrainingSample ? "adaptive" : "activity",
      sourcePath: req.body.sourcePath || null, isTraining: adaptiveTrainingSample,
    });
    if (adaptiveTrainingSample) maybeRetrainAdaptively(userId);

    const passkeyTriggered = !passkeyVerified && evaluation.isSuspicious && !!hasPasskey;
    if (passkeyVerified) lock.clearLocked(userId);
    else if (passkeyTriggered) lock.setLocked(userId);
    ks.logAuthDecision(userId, db, {
      source: "submit", evaluation, passkeyTriggered, passkeyOutcome: passkeyVerified ? "success" : null,
    });

    const profile = ks.getUserTypingProfile(userId, db);
    const adaptiveSamplesSinceRetrain = profile ? countTrainingSamplesSince(userId, profile.trainedAt) : 0;
    let adaptiveSkipReason = null;
    if (!adaptiveTrainingSample && !passkeyVerified && !evaluation.isSuspicious) {
      if (!submitQuality.acceptableForEnrollment) {
        adaptiveSkipReason = submitQuality.pasteCount > 0 ? "pasted text detected — type naturally for adaptive learning" : "not enough typed keystrokes captured";
      } else if (Number(evaluation.modelConfidence) < ADAPTIVE_CONFIDENCE_MIN) {
        adaptiveSkipReason = `confidence ${(Number(evaluation.modelConfidence) * 100).toFixed(0)}% is below the 90% minimum for adaptive learning`;
      }
    }
    res.json({
      ok: true, message: "Text and keystroke data submitted", textId,
      modelConfidence: evaluation.modelConfidence, isSuspicious: evaluation.isSuspicious,
      typingEvaluation: evaluation, adaptiveTrainingSample, adaptiveSamplesSinceRetrain,
      adaptiveRetrainEvery: ADAPTIVE_RETRAIN_EVERY, adaptiveSkipReason,
      requiresPasskeyChallenge: passkeyTriggered,
      riskToken: signRisk(userId, riskLevel(false, evaluation.isSuspicious), "keystroke"),
    });
  } catch (err) { console.error("submit:", err); res.status(500).json({ error: err.message }); }
});

app.post("/v1/keystroke/contribute", async (req, res) => {
  try {
    const userId = uid(req);
    const { textContent, keystrokeEvents } = req.body;
    const quality = ks.typingQuality(textContent, keystrokeEvents);
    if (!quality.acceptableForEnrollment) {
      return res.status(422).json({
        ok: false,
        error: quality.pasteCount > 0 ? "Pasted text cannot train your model. Type naturally." : "Not enough typed keystrokes in this sample to contribute.",
      });
    }
    const evaluation = await ks.evaluateKeystrokes({ events: keystrokeEvents, timings: null, userId, db });
    const rolling = Number(evaluation.rollingMean != null ? evaluation.rollingMean : evaluation.modelConfidence);
    const windowsSeen = evaluation.rollingWindowCount || 0;
    const minContributeWindows = ks.RECENT_WINDOW_COUNT;
    if (!evaluation.modelAvailable || rolling < ADAPTIVE_CONFIDENCE_MIN || windowsSeen < minContributeWindows) {
      return res.status(422).json({
        ok: false,
        error: windowsSeen < minContributeWindows
          ? `Keep typing — need ${minContributeWindows} clean windows, have ${windowsSeen}.`
          : `Sample not clean enough to contribute (${Math.round(rolling * 100)}% < ${Math.round(ADAPTIVE_CONFIDENCE_MIN * 100)}%).`,
        rollingMean: rolling,
      });
    }
    storeTextSample({
      userId, textContent: textContent || "[adaptive-contribution]", keystrokeEvents,
      metrics: evaluation.metrics, evaluation, samplePurpose: "adaptive",
      sourcePath: "/opinion.html#contribute", isTraining: true,
    });
    maybeRetrainAdaptively(userId);
    const profile = ks.getUserTypingProfile(userId, db);
    const done = profile ? countTrainingSamplesSince(userId, profile.trainedAt) : 0;
    res.json({ ok: true, message: "Clean sample added to your model's training set.", rollingMean: rolling, adaptiveSamplesSinceRetrain: done, adaptiveRetrainEvery: ADAPTIVE_RETRAIN_EVERY });
  } catch (err) { console.error("contribute:", err); res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/v1/keystroke/reset", (req, res) => {
  const userId = uid(req);
  ks.resetUserTypingProfile(userId, db);
  db.prepare("UPDATE keystroke_texts SET is_training = 0 WHERE user_id = ?").run(userId);
  res.json({ ok: true, message: "Typing rhythm enrollment was reset", typingStatus: ks.getUserTypingStatus(userId, db) });
});

app.post("/v1/keystroke/retrain", async (req, res) => {
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
  } catch (err) { console.error("retrain:", err); res.status(500).json({ ok: false, error: err.message }); }
});

// ---- login-triggered background retrain when new impostors appeared ----
app.post("/v1/keystroke/maybe-retrain-impostors", (req, res) => {
  ks.maybeRetrainForNewImpostors(uid(req), db);
  res.json({ ok: true });
});

// ---- read models for the demo/dashboard (username joins happen in the demo) ----
app.get("/v1/keystroke/history/:userId", (req, res) => {
  const texts = db.prepare(
    "SELECT id, char_count, model_confidence, is_suspicious, sample_purpose, is_training, submitted_at FROM keystroke_texts WHERE user_id = ? ORDER BY submitted_at DESC",
  ).all(uid(req));
  res.json({ texts });
});

app.get("/v1/keystroke/stats/:userId", (req, res) => {
  const stats = db.prepare(
    `SELECT COUNT(*) as total_submissions,
            COUNT(CASE WHEN is_suspicious = 1 THEN 1 END) as suspicious_count,
            AVG(model_confidence) as avg_confidence,
            SUM(char_count) as total_chars
     FROM keystroke_texts WHERE user_id = ?`,
  ).get(uid(req));
  res.json({ ...stats, typingStatus: ks.getUserTypingStatus(uid(req), db) });
});

app.get("/v1/keystroke/decisions/:userId", (req, res) => {
  const decisions = db.prepare(
    `SELECT id, checked_at, source, window_count, mean_score, threshold, verdict, passkey_triggered, passkey_outcome, per_window_scores
     FROM auth_decisions WHERE user_id = ? ORDER BY checked_at DESC LIMIT 500`,
  ).all(uid(req));
  res.json({ decisions });
});

// Raw decisions for CSV export + research metrics (per user_id; the demo maps usernames).
app.get("/v1/keystroke/decisions-all", (req, res) => {
  const rows = db.prepare(
    `SELECT id, user_id, checked_at, source, window_count, mean_score, threshold, verdict, passkey_triggered, passkey_outcome, per_window_scores
     FROM auth_decisions ORDER BY checked_at DESC`,
  ).all();
  res.json({ rows });
});

app.get("/v1/keystroke/metrics", (req, res) => {
  const rows = db.prepare(
    `SELECT user_id,
            COUNT(*) as total,
            SUM(CASE WHEN verdict = 'genuine' THEN 1 ELSE 0 END) as genuine_count,
            SUM(CASE WHEN verdict IN ('suspicious','paste') THEN 1 ELSE 0 END) as suspicious_count,
            AVG(CASE WHEN mean_score IS NOT NULL THEN mean_score END) as avg_score,
            AVG(threshold) as avg_threshold,
            MIN(checked_at) as first_check, MAX(checked_at) as last_check
     FROM auth_decisions WHERE verdict IN ('genuine','suspicious','paste') GROUP BY user_id`,
  ).all();
  const profiles = db.prepare("SELECT user_id, model_json FROM user_typing_profiles").all();
  const profileMap = {};
  for (const p of profiles) { try { profileMap[p.user_id] = JSON.parse(p.model_json); } catch {} }
  res.json({ rows, profileMap });
});

// ---- mouse ----
app.post("/v1/mouse/enroll", async (req, res) => {
  try { const r = await mouse.enrollMouse(uid(req), req.body.windows); res.status(r.status).json(r.body); }
  catch (err) { console.error("mouse enroll:", err); res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/v1/mouse/check", async (req, res) => {
  try {
    const r = await mouse.checkMouse(uid(req), req.body.windows);
    if (r.body && r.body.checked) {
      r.body.riskToken = signRisk(uid(req), riskLevel(r.body.warmup, r.body.isSuspicious), "mouse");
    }
    res.status(r.status).json(r.body);
  } catch (err) { console.error("mouse check:", err); res.status(500).json({ ok: false, error: err.message }); }
});
app.get("/v1/mouse/status/:userId", (req, res) => res.json(mouse.mouseStatus(uid(req))));
// Destructive: drops the trained mouse profile and every stored session. The CALLER is
// responsible for having verified a passkey first — this service is stateless about auth and
// trusts its caller (same contract as /v1/keystroke/reset).
app.post("/v1/mouse/reset", (req, res) => {
  try {
    const userId = uid(req);
    const r = mouse.resetMouseProfile(userId);
    res.json({ ok: true, message: "Mouse enrollment was reset", removedSessions: r.removedSessions, mouseStatus: mouse.mouseStatus(userId) });
  } catch (err) { console.error("mouse reset:", err); res.status(500).json({ ok: false, error: err.message }); }
});

// Shared step-up lock (see lib/lock.js). Mouse callers (apps/demo, the
// gateway) each run their own consecutive-strike debounce, so they set/clear
// this explicitly; keystroke sets it directly above since ca-service already
// decides passkeyTriggered for it.
app.post("/v1/lock/set", (req, res) => { lock.setLocked(uid(req)); res.json({ ok: true }); });
app.post("/v1/lock/clear", (req, res) => { lock.clearLocked(uid(req)); res.json({ ok: true }); });
app.get("/v1/lock/status/:userId", (req, res) => res.json({ locked: lock.isLocked(uid(req)) }));

app.listen(PORT, () => console.log(`CA service on http://localhost:${PORT}`));
