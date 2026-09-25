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
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("../db");

const ENABLED = process.env.STUDY_LOGGING === "1";
// model-api's paths as it reports them, and where ca-service sees the same store (read-only mount).
const MODEL_STORE_REMOTE = process.env.MODEL_STORE_REMOTE || "/app/artifacts/users";
const MODEL_STORE_DIR = process.env.MODEL_STORE_DIR || "/model-store";

const PSEUDONYM = /^[A-Za-z0-9_-]{1,32}$/;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;

/** The validated study context of a request body, or null (not a study request). */
function parseContext(raw) {
  if (!ENABLED || !raw || typeof raw !== "object") return null;
  const participant = String(raw.participant || "");
  const sessionId = String(raw.sessionId || "");
  const condition = String(raw.condition || "");
  if (!PSEUDONYM.test(participant) || !SESSION.test(sessionId)) return null;
  const impostorOf = condition.startsWith("impostor:") ? condition.slice(9) : null;
  const conditionOk = condition === "genuine" ||
    (impostorOf !== null && PSEUDONYM.test(impostorOf) && impostorOf !== participant);
  if (!conditionOk) return null;
  const clientTs = Number(raw.clientTs);
  return { participant, sessionId, condition, clientTs: Number.isFinite(clientTs) ? clientTs : null };
}

/**
 * Bind the Continuum user to the pseudonym of the account being used. In an impostor session the
 * account is still the participant's own (someone else is at the keyboard), so `participant` is the
 * account owner and `condition` names who is typing. A pseudonym belongs to one user only.
 */
function register(userId, ctx) {
  if (!ctx) return false;
  try {
    const row = db.prepare("SELECT user_id FROM study_participants WHERE pseudonym = ?").get(ctx.participant);
    if (row && row.user_id !== userId) {
      console.error(`[study] pseudonym ${ctx.participant} already belongs to another user; not logged`);
      return false;
    }
    const mine = db.prepare("SELECT pseudonym FROM study_participants WHERE user_id = ?").get(userId);
    if (mine && mine.pseudonym !== ctx.participant) {
      console.error(`[study] user ${userId} is ${mine.pseudonym}, request says ${ctx.participant}; not logged`);
      return false;
    }
    if (!mine) db.prepare("INSERT INTO study_participants (user_id, pseudonym) VALUES (?, ?)").run(userId, ctx.participant);
    return true;
  } catch (e) {
    console.error("[study] register failed:", e.message);
    return false;
  }
}

function isParticipant(userId) {
  if (!ENABLED) return false;
  try {
    return !!db.prepare("SELECT 1 FROM study_participants WHERE user_id = ?").get(userId);
  } catch (e) {
    return false;
  }
}

function daySinceEnrolment(userId, channel) {
  const first = db
    .prepare("SELECT MIN(trained_at) AS t FROM study_profiles WHERE user_id = ? AND channel = ?")
    .get(userId, channel);
  if (!first || !first.t) return null;
  const t0 = Date.parse(first.t.replace(" ", "T") + "Z");
  return Number.isFinite(t0) ? Math.floor((Date.now() - t0) / 86400000) : null;
}

/**
 * One scored check: the decision row and one row per scored window. `scores` and `keys` are
 * aligned (keys identify windows across overlapping checks); `details` holds the verdict's other
 * inputs, so scripts/study_replay.js can re-derive it. Returns the decision id or null.
 */
function recordCheck(userId, ctx, d) {
  if (!ctx || !register(userId, ctx)) return null;
  try {
    const scores = (d.scores || []).map(Number);
    const keys = Array.isArray(d.keys) && d.keys.length === scores.length ? d.keys.map(String) : null;
    const day = daySinceEnrolment(userId, d.channel);
    let decisionId = null;
    db.transaction(() => {
      decisionId = db.prepare(
        `INSERT INTO study_decisions (user_id, session_id, channel, condition, client_ts, rule_version,
           threshold, window_count, low_windows, verdict, prompt_required, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(userId, ctx.sessionId, d.channel, ctx.condition, ctx.clientTs, d.ruleVersion, d.threshold,
            scores.length, d.lowWindows, d.verdict, d.promptRequired ? 1 : 0,
            d.details ? JSON.stringify(d.details) : null).lastInsertRowid;
      const ins = db.prepare(
        `INSERT INTO study_windows (decision_id, user_id, session_id, channel, condition, window_key, score,
           day_since_enrolment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      scores.forEach((s, i) => ins.run(decisionId, userId, ctx.sessionId, d.channel, ctx.condition,
        keys ? keys[i] : `unkeyed:${decisionId}:${i}`, s, day));
    })();
    if (!keys && scores.length) console.error(`[study] decision ${decisionId}: window keys missing or misaligned`);
    return Number(decisionId);
  } catch (e) {
    console.error("[study] recordCheck failed:", e.message);
    return null;
  }
}

/** sha256 over a model directory (sorted relative paths and bytes), read through the mount. */
function modelSha256(modelPath) {
  try {
    if (!modelPath || !String(modelPath).startsWith(MODEL_STORE_REMOTE)) return null;
    const local = path.join(MODEL_STORE_DIR, String(modelPath).slice(MODEL_STORE_REMOTE.length));
    if (!fs.existsSync(local)) return null;
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p);
      }
    })(fs.statSync(local).isDirectory() ? local : path.dirname(local));
    const h = crypto.createHash("sha256");
    for (const f of files.sort()) {
      h.update(path.relative(local, f).split(path.sep).join("/") + "\0");
      h.update(fs.readFileSync(f));
    }
    return h.digest("hex");
  } catch (e) {
    console.error("[study] model hash failed:", e.message);
    return null;
  }
}

/** A (re)training of a study participant's profile, with all its threshold-source scores. */
function recordProfile(userId, p) {
  if (!isParticipant(userId)) return;
  try {
    db.prepare(
      `INSERT INTO study_profiles (user_id, channel, rule_version, threshold, threshold_source, model_path,
         model_sha256, window_count, threshold_scores) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, p.channel, p.ruleVersion, p.threshold, p.thresholdSource, p.modelPath || null,
          modelSha256(p.modelPath), p.windowCount, JSON.stringify((p.thresholdScores || []).map(Number)));
  } catch (e) {
    console.error("[study] recordProfile failed:", e.message);
  }
}

const PROMPT_EVENTS = new Set(["shown", "passed", "failed", "dismissed"]);

/** A passkey prompt event reported by the study client. Returns true when stored. */
function recordPrompt(userId, ctx, p) {
  if (!ctx || !PROMPT_EVENTS.has(String(p.event)) || !register(userId, ctx)) return false;
  try {
    const decisionId = Number(p.decisionId);
    db.prepare(
      `INSERT INTO study_prompts (user_id, session_id, channel, decision_id, event, client_ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(userId, ctx.sessionId, p.channel === "mouse" || p.channel === "keystroke" ? p.channel : null,
          Number.isInteger(decisionId) ? decisionId : null, String(p.event), ctx.clientTs);
    return true;
  } catch (e) {
    console.error("[study] recordPrompt failed:", e.message);
    return false;
  }
}

module.exports = { ENABLED, parseContext, register, isParticipant, recordCheck, recordProfile, recordPrompt, modelSha256 };
