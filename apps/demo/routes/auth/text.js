// Keystroke routes — now a thin PROXY to the CA service. The behavioral engine,
// storage, adaptive learning and paste policy all live in ca-service; this file
// keeps only what belongs to the app: session, the onboarding/lock gates, and
// applying the passkey step-up policy to the CA verdicts. Paths + responses are
// unchanged, so the frontend is untouched.
const express = require("express");
const db = require("../../db/init");
const ca = require("../../services/caClient");
const { requireFreshPasskey } = require("../../middleware/requireFreshPasskey");

const router = express.Router();

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  next();
};

const requireUnlockedSession = (req, res, next) => {
  if (req.session.passkeySetupRequired || !req.session.hasPasskey) {
    req.session.passkeySetupRequired = true;
    return res.status(423).json({
      error: "Passkey registration required before using this feature",
      passkeySetupRequired: true,
    });
  }
  next();
};

const requireTrainedRhythm = async (req, res, next) => {
  try {
    const { data: status } = await ca.keystrokeStatus(req.session.userId);
    if (!status.trained) {
      return res.status(423).json({
        error: "Typing rhythm enrollment required before using this feature",
        rhythmEnrollmentRequired: true,
        typingStatus: status,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};

// Pass a CA response straight through (status + body).
const passthrough = (res, r) => res.status(r.status).json(r.data);

router.get("/config", requireAuth, async (req, res, next) => {
  try { passthrough(res, await ca.config(req.session.userId)); } catch (e) { next(e); }
});

router.get("/typing-status", requireAuth, async (req, res, next) => {
  try { passthrough(res, await ca.keystrokeStatus(req.session.userId)); } catch (e) { next(e); }
});

// Adaptive retraining: the user retrains with the samples collected so far. The passkey must have been
// verified moments ago (requireFreshPasskey), so samples added at an unlocked session never reach a model.
router.post("/adaptive-retrain", requireAuth, requireFreshPasskey, async (req, res, next) => {
  try { passthrough(res, await ca.keystrokeAdaptiveConfirm(req.session.userId)); } catch (e) { next(e); }
});

// Destructive: drops the trained typing profile and unmarks its training texts. Now also
// requires a passkey verified in the last couple of minutes — deleting an enrolled profile is
// precisely what an impostor at an unlocked machine would do, since it lets them re-enroll as
// themselves. requireUnlockedSession alone only checked that a passkey EXISTS.
router.post("/typing-reset", requireAuth, requireUnlockedSession, requireFreshPasskey, async (req, res, next) => {
  try { passthrough(res, await ca.keystrokeReset(req.session.userId)); } catch (e) { next(e); }
});

router.post("/typing-retrain", requireAuth, async (req, res, next) => {
  try { passthrough(res, await ca.keystrokeRetrain(req.session.userId)); } catch (e) { next(e); }
});

router.post("/enroll", requireAuth, requireUnlockedSession, async (req, res, next) => {
  try { passthrough(res, await ca.keystrokeEnroll(req.session.userId, req.body)); } catch (e) { next(e); }
});

router.post("/check", requireAuth, requireUnlockedSession, requireTrainedRhythm, async (req, res, next) => {
  try {
    const r = await ca.keystrokeCheck(req.session.userId, {
      textContent: req.body.textContent,
      textLength: req.body.textLength,       // the SDK sends the length only, never the text
      keystrokeTimings: req.body.keystrokeTimings,
      keystrokeEvents: req.body.keystrokeEvents,
      hasPasskey: !!req.session.hasPasskey,
    });
    if (r.data && r.data.requiresPasskeyChallenge) req.session.continuousAuthLocked = true;
    res.status(r.status).json(r.data);
  } catch (e) { next(e); }
});

router.post("/contribute", requireAuth, requireUnlockedSession, requireTrainedRhythm, async (req, res, next) => {
  try { passthrough(res, await ca.keystrokeContribute(req.session.userId, req.body)); } catch (e) { next(e); }
});

router.get("/history", requireAuth, async (req, res, next) => {
  try { passthrough(res, await ca.keystrokeHistory(req.session.userId)); } catch (e) { next(e); }
});

router.get("/stats", requireAuth, async (req, res, next) => {
  try {
    const r = await ca.keystrokeStats(req.session.userId);
    const hasPasskeys = !!req.session.hasPasskey;
    res.status(r.status).json({ ...r.data, passkeysRegistered: hasPasskeys, passkey_count: hasPasskeys ? 1 : 0 });
  } catch (e) { next(e); }
});

router.get("/decisions", requireAuth, async (req, res, next) => {
  try { passthrough(res, await ca.keystrokeDecisions(req.session.userId)); } catch (e) { next(e); }
});

// CSV export — the CA service holds decisions by user_id; usernames (needed for
// the All-Users export) are joined here from the app's users table.
router.get("/decisions/export", requireAuth, async (req, res, next) => {
  try {
    const all = req.query.all === "1";
    let rows;
    if (all) {
      const { data } = await ca.keystrokeDecisionsAll(req.session.userId);
      const names = {};
      for (const u of db.prepare("SELECT id, username FROM users").all()) names[u.id] = u.username;
      rows = (data.rows || []).map((r) => ({ ...r, username: names[r.user_id] || `user-${r.user_id}` }));
    } else {
      const { data } = await ca.keystrokeDecisions(req.session.userId);
      rows = data.decisions || [];
    }
    const header = all
      ? "id,username,checked_at,source,window_count,mean_score,threshold,verdict,passkey_triggered,passkey_outcome"
      : "id,checked_at,source,window_count,mean_score,threshold,verdict,passkey_triggered,passkey_outcome";
    const csvRows = rows.map((r) => {
      const fields = all
        ? [r.id, r.username, r.checked_at, r.source, r.window_count, r.mean_score, r.threshold, r.verdict, r.passkey_triggered, r.passkey_outcome || ""]
        : [r.id, r.checked_at, r.source, r.window_count, r.mean_score, r.threshold, r.verdict, r.passkey_triggered, r.passkey_outcome || ""];
      return fields.join(",");
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="auth_decisions.csv"`);
    res.send([header, ...csvRows].join("\n"));
  } catch (e) { next(e); }
});

// Research metrics — CA service returns per-user_id aggregates + profiles; the
// username mapping + summary are assembled here.
router.get("/metrics", requireAuth, async (req, res, next) => {
  try {
    const { data } = await ca.keystrokeMetrics(req.session.userId);
    const names = {};
    for (const u of db.prepare("SELECT id, username FROM users").all()) names[u.id] = u.username;
    const profileMap = data.profileMap || {};
    const users = (data.rows || []).map((r) => {
      const profile = profileMap[r.user_id] || {};
      const frr = r.total > 0 ? r.suspicious_count / r.total : null;
      const tar = r.total > 0 ? r.genuine_count / r.total : null;
      return {
        username: names[r.user_id] || `user-${r.user_id}`,
        totalDecisions: r.total,
        genuineVerdicts: r.genuine_count,
        suspiciousVerdicts: r.suspicious_count,
        tar: tar != null ? +tar.toFixed(4) : null,
        frr: frr != null ? +frr.toFixed(4) : null,
        avgScore: r.avg_score != null ? +Number(r.avg_score).toFixed(4) : null,
        eerThreshold: profile.threshold != null ? +Number(profile.threshold).toFixed(4) : null,
        thresholdSource: profile.thresholdSource || "unknown",
        trainingAccuracy: profile.trainingAccuracy != null ? +Number(profile.trainingAccuracy).toFixed(4) : null,
        sampleCount: profile.sampleCount || null,
        trainedAt: profile.trainedAt || null,
        firstCheck: r.first_check,
        lastCheck: r.last_check,
      };
    });
    const totalDecisions = users.reduce((s, u) => s + u.totalDecisions, 0);
    const totalSuspicious = users.reduce((s, u) => s + u.suspiciousVerdicts, 0);
    const scores = users.filter((u) => u.avgScore != null).map((u) => u.avgScore);
    const avgScore = scores.length ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4) : null;
    res.json({
      users,
      summary: {
        totalUsers: users.length,
        totalDecisions,
        overallFRR: totalDecisions > 0 ? +(totalSuspicious / totalDecisions).toFixed(4) : null,
        overallTAR: totalDecisions > 0 ? +((totalDecisions - totalSuspicious) / totalDecisions).toFixed(4) : null,
        avgScore,
      },
      note: "FRR computed from each user's own genuine sessions. FAR requires explicit cross-user impostor testing — export All Users CSV then analyse per impostor-account pairs.",
    });
  } catch (e) { next(e); }
});

module.exports = router;
