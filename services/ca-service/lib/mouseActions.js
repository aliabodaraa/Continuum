// Action-based mouse decision logic for the CA service.
//
// Replaces the fixed-window path in mouse.js with the published method of
//   M. Antal and E. Egyed-Zsigmond, "Intrusion detection using mouse dynamics",
//   IET Biometrics 8(5):285-294, 2019.
//
// The window path segmented motion into 50-step windows with a stride of 10.
// Those numbers came from the KEYSTROKE method of Lu et al. and have no
// published basis for a pointer; the mouse literature segments by ACTION. The
// browser now sends 39-feature action vectors (sdk/js/mouse-actions.js, proven
// numerically identical to the training extractor by tools/action_parity_check.js)
// and the model service scores each action with a per-user Random Forest.
//
// The decision rule is the paper's, not an invention: the score for a set of k
// actions is the MEAN of the per-action probabilities, and the paper establishes
// that 10-20 actions are needed. We use 20 — its own reporting point, and the
// size at which we measured median EER 11.48% / AUC 0.947 across 20 held-out
// SapiMouse subjects.
const db = require("../db");

// The hop to model-api is authenticated + deadline-bounded — see lib/modelClient.js.
const { postModelApi } = require("./modelClient");
const decisionState = require("./decisionState");

// Antal & Egyed-Zsigmond: 10-20 actions per decision; 20 is their reporting point.
const ACTION_SET_SIZE = 20;
const ACTION_DECISION_THRESHOLD = 0.5;
// Enrollment needs enough actions to fit a forest. The population study enrolled
// targets on as few as 26 actions and still separated them, so 40 is a
// conservative floor rather than a tuned value.
const MIN_ENROLL_ACTIONS = 40;
const MAX_TRAIN_ACTIONS = 2000;
const ACTION_FEATURES = 39;

function validActions(actions) {
  return (
    Array.isArray(actions) &&
    actions.length > 0 &&
    Array.isArray(actions[0]) &&
    actions[0].length === ACTION_FEATURES &&
    actions.every((a) => Array.isArray(a) && a.length === ACTION_FEATURES &&
                         a.every((v) => Number.isFinite(v)))
  );
}

async function enrollMouseActions(userId, actions) {
  if (!validActions(actions)) {
    return { status: 400, body: { ok: false, error: `actions must be (n, ${ACTION_FEATURES}) finite numbers` } };
  }

  await db.run(
    "INSERT INTO mouse_action_samples (user_id, actions, action_count) VALUES (?, ?, ?)",
    userId, JSON.stringify(actions), actions.length);

  // Accumulate across enrollment sessions, newest first, capped.
  const rows = await db.all("SELECT actions FROM mouse_action_samples WHERE user_id = ? ORDER BY id DESC", userId);
  let positives = [];
  for (const row of rows) {
    const a = JSON.parse(row.actions);
    if (positives.length + a.length > MAX_TRAIN_ACTIONS) {
      positives = positives.concat(a.slice(0, MAX_TRAIN_ACTIONS - positives.length));
      break;
    }
    positives = positives.concat(a);
  }

  if (positives.length < MIN_ENROLL_ACTIONS) {
    return {
      status: 200,
      body: {
        ok: true, trained: false, actionCount: positives.length,
        requiredActions: MIN_ENROLL_ACTIONS,
        message: `collected ${positives.length} of ${MIN_ENROLL_ACTIONS} actions`,
      },
    };
  }

  const result = await postModelApi("/api/user/train", {
    userId,
    actions: positives,
    minActions: MIN_ENROLL_ACTIONS,
  });

  await db.run(
    `INSERT INTO mouse_action_profiles (user_id, model_path, sample_actions, trained_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET
       model_path=excluded.model_path, sample_actions=excluded.sample_actions,
       trained_at=CURRENT_TIMESTAMP`,
    userId, result.modelPath, positives.length);

  return {
    status: 200,
    body: {
      ok: true, trained: true, actionCount: positives.length,
      negativeSource: result.negativeSource, setSize: ACTION_SET_SIZE,
      method: result.method,
    },
  };
}

async function checkMouseActions(userId, actions) {
  const profile = await db.get("SELECT model_path FROM mouse_action_profiles WHERE user_id = ?", userId);
  if (!profile) {
    return { status: 200, body: { ok: true, checked: false, enrolled: false } };
  }
  if (!validActions(actions)) {
    return { status: 200, body: { ok: true, checked: false, enrolled: true, reason: "no actions" } };
  }

  // Only the most recent set is scored; older actions have already been judged.
  const recent = actions.slice(-ACTION_SET_SIZE);
  const result = await postModelApi("/api/user/predict", {
    userId,
    actions: recent,
    modelPath: profile.model_path,   // the version this profile was trained as (model versions)
    setSize: ACTION_SET_SIZE,
    threshold: ACTION_DECISION_THRESHOLD,
  });

  // Warm-up is honest, not a silent pass: until a full set of actions exists
  // there is no decision to make, and the caller is told so rather than being
  // handed a verdict computed from three actions.
  const warmup = recent.length < ACTION_SET_SIZE;
  const isSuspicious = !warmup && result.setScore < ACTION_DECISION_THRESHOLD;

  // Same persisted counter as the window path (lib/mouse.js) — one user has one mouse
  // streak regardless of which pipeline scored them, so the two arms of the comparison
  // cannot disagree about how close the session is to a step-up.
  const suspiciousStreak = await decisionState.updateMouseStreak(userId, { isSuspicious, warmup });

  return {
    status: 200,
    body: {
      ok: true, checked: true, enrolled: true,
      warmup,
      isSuspicious,
      suspiciousStreak,
      setScore: result.setScore,
      setSize: ACTION_SET_SIZE,
      actionsScored: recent.length,
      actionScores: result.scores,
      threshold: ACTION_DECISION_THRESHOLD,
    },
  };
}

async function mouseActionsEnrolled(userId) {
  return !!(await db.get("SELECT 1 FROM mouse_action_profiles WHERE user_id = ?", userId));
}

async function mouseActionsStatus(userId) {
  const p = await db.get("SELECT model_path, sample_actions, trained_at FROM mouse_action_profiles WHERE user_id = ?", userId);
  const collected = await db.get("SELECT COALESCE(SUM(action_count), 0) AS n FROM mouse_action_samples WHERE user_id = ?", userId);
  return {
    enrolled: !!p,
    trainedAt: p ? p.trained_at : null,
    sampleActions: p ? p.sample_actions : 0,
    collectedActions: collected ? collected.n : 0,
    requiredActions: MIN_ENROLL_ACTIONS,
    setSize: ACTION_SET_SIZE,
  };
}

async function resetMouseActionProfile(userId) {
  await db.run("DELETE FROM mouse_action_profiles WHERE user_id = ?", userId);
  await db.run("DELETE FROM mouse_action_samples WHERE user_id = ?", userId);
  await decisionState.resetMouseStreak(userId); // strikes against a model that no longer exists
  return { status: 200, body: { ok: true, reset: true } };
}

module.exports = {
  enrollMouseActions,
  checkMouseActions,
  mouseActionsEnrolled,
  mouseActionsStatus,
  resetMouseActionProfile,
  ACTION_SET_SIZE,
  MIN_ENROLL_ACTIONS,
  ACTION_FEATURES,
};
