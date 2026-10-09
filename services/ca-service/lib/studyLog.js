/**
 * User-study logging (docs/recovery/user_study/LOGGING_SPEC.md, recovery plan T4.3).
 *
 * Off unless STUDY_LOGGING=1, and even then a request is logged only when it carries a valid
 * study context `{ participant, sessionId, condition, clientTs }`. The study client (the
 * extension's study mode) sets `condition`; it is never inferred here. Scores are kept at full
 * precision, and every threshold-source score of every (re)training is kept, so EER and AUC can
 * be computed offline without any threshold.
 *
 * Nothing here can change a verdict: every function swallows its own errors.
 */
const db = require("../db");

// The switch is STUDY_LOGGING in the environment, overridable at run time from the operator page
// (lib/runtimeSettings.js), so it is read on every call rather than once at start.
const enabled = () => require("./runtimeSettings").get("studyLogging");
// The model's fingerprint (model_sha256) comes from the model service with each training (the trainer
// returns modelSha256, model_store.py): this service never reads model files.

const PSEUDONYM = /^[A-Za-z0-9_-]{1,32}$/;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
// LOGGING_SPEC.md §2: the participant's own browser, or the lab machine of an impostor session.
const CLIENTS = new Set(["extension-study", "lab"]);

/** The validated study context of a request body, or null (not a study request). */
function parseContext(raw) {
  if (!enabled() || !raw || typeof raw !== "object") return null;
  const participant = String(raw.participant || "");
  const sessionId = String(raw.sessionId || "");
  const condition = String(raw.condition || "");
  if (!PSEUDONYM.test(participant) || !SESSION.test(sessionId)) return null;
  const impostorOf = condition.startsWith("impostor:") ? condition.slice(9) : null;
  const conditionOk = condition === "genuine" ||
    (impostorOf !== null && PSEUDONYM.test(impostorOf) && impostorOf !== participant);
  if (!conditionOk) return null;
  // Like the condition, the client is declared by the study client, never inferred: a value outside
  // the list voids the context rather than being stored as something it is not.
  const client = raw.client == null ? null : String(raw.client);
  if (client !== null && !CLIENTS.has(client)) return null;
  const clientTs = Number(raw.clientTs);
  return { participant, sessionId, condition, client, clientTs: Number.isFinite(clientTs) ? clientTs : null };
}

/** A context naming only the participant (study setup, before any session exists), or null. */
function participantContext(participant) {
  if (!enabled() || !PSEUDONYM.test(String(participant || ""))) return null;
  return { participant: String(participant) };
}

/**
 * Bind the Continuum user to the pseudonym of the account being used. In an impostor session the
 * account is still the participant's own (someone else is at the keyboard), so `participant` is the
 * account owner and `condition` names who is typing. A pseudonym belongs to one user only.
 */
async function register(userId, ctx) {
  if (!ctx) return false;
  try {
    const row = await db.get("SELECT user_id FROM study_participants WHERE pseudonym = ?", ctx.participant);
    if (row && row.user_id !== userId) {
      console.error(`[study] pseudonym ${ctx.participant} already belongs to another user; not logged`);
      return false;
    }
    const mine = await db.get("SELECT pseudonym FROM study_participants WHERE user_id = ?", userId);
    if (mine && mine.pseudonym !== ctx.participant) {
      console.error(`[study] user ${userId} is ${mine.pseudonym}, request says ${ctx.participant}; not logged`);
      return false;
    }
    if (!mine) await db.run("INSERT INTO study_participants (user_id, pseudonym) VALUES (?, ?)", userId, ctx.participant);
    return true;
  } catch (e) {
    console.error("[study] register failed:", e.message);
    return false;
  }
}

async function isParticipant(userId) {
  if (!enabled()) return false;
  try {
    return !!(await db.get("SELECT 1 FROM study_participants WHERE user_id = ?", userId));
  } catch (e) {
    return false;
  }
}

async function daySinceEnrolment(userId, channel) {
  const first = await db.get("SELECT MIN(trained_at) AS t FROM study_profiles WHERE user_id = ? AND channel = ?", userId, channel);
  if (!first || !first.t) return null;
  const t0 = Date.parse(first.t.replace(" ", "T") + "Z");
  return Number.isFinite(t0) ? Math.floor((Date.now() - t0) / 86400000) : null;
}

/**
 * One scored check: the decision row and one row per scored window. `scores` and `keys` are
 * aligned (keys identify windows across overlapping checks); `details` holds the verdict's other
 * inputs, so scripts/study_replay.js can re-derive it. Returns the decision id or null.
 */
async function recordCheck(userId, ctx, d) {
  if (!ctx || !(await register(userId, ctx))) return null;
  try {
    const scores = (d.scores || []).map(Number);
    const keys = Array.isArray(d.keys) && d.keys.length === scores.length ? d.keys.map(String) : null;
    const day = await daySinceEnrolment(userId, d.channel);
    let decisionId = null;
    await db.tx(async () => {
      decisionId = await db.insert(
        `INSERT INTO study_decisions (user_id, session_id, channel, condition, client, client_ts, rule_version,
           threshold, window_count, low_windows, verdict, prompt_required, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        userId, ctx.sessionId, d.channel, ctx.condition, ctx.client || null, ctx.clientTs, d.ruleVersion, d.threshold,
        scores.length, d.lowWindows, d.verdict, d.promptRequired ? 1 : 0,
        d.details ? JSON.stringify(d.details) : null);
      for (let i = 0; i < scores.length; i++) {
        await db.run(
          `INSERT INTO study_windows (decision_id, user_id, session_id, channel, condition, window_key, score,
             day_since_enrolment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          decisionId, userId, ctx.sessionId, d.channel, ctx.condition, keys ? keys[i] : `unkeyed:${decisionId}:${i}`, scores[i], day);
      }
    });
    if (!keys && scores.length) console.error(`[study] decision ${decisionId}: window keys missing or misaligned`);
    return Number(decisionId);
  } catch (e) {
    console.error("[study] recordCheck failed:", e.message);
    return null;
  }
}

/** A (re)training of a study participant's profile, with all its threshold-source scores. */
async function recordProfile(userId, p) {
  if (!(await isParticipant(userId))) return;
  try {
    await db.run(
      `INSERT INTO study_profiles (user_id, channel, rule_version, threshold, threshold_source, model_path,
         model_sha256, window_count, threshold_scores) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      userId, p.channel, p.ruleVersion, p.threshold, p.thresholdSource, p.modelPath || null,
      p.modelSha256 || null, p.windowCount, JSON.stringify((p.thresholdScores || []).map(Number)));
  } catch (e) {
    console.error("[study] recordProfile failed:", e.message);
  }
}

const PROMPT_EVENTS = new Set(["shown", "passed", "failed", "dismissed"]);

/** A passkey prompt event reported by the study client. Returns true when stored. */
async function recordPrompt(userId, ctx, p) {
  if (!ctx || !PROMPT_EVENTS.has(String(p.event)) || !(await register(userId, ctx))) return false;
  try {
    const decisionId = Number(p.decisionId);
    await db.run(
      `INSERT INTO study_prompts (user_id, session_id, channel, decision_id, event, client_ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
      userId, ctx.sessionId, p.channel === "mouse" || p.channel === "keystroke" ? p.channel : null,
      Number.isInteger(decisionId) ? decisionId : null, String(p.event), ctx.clientTs);
    return true;
  } catch (e) {
    console.error("[study] recordPrompt failed:", e.message);
    return false;
  }
}

module.exports = { parseContext, participantContext, register, isParticipant, recordCheck, recordProfile, recordPrompt };
Object.defineProperty(module.exports, "ENABLED", { enumerable: true, get: enabled });
