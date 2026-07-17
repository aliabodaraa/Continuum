// Mouse-dynamics routes — now a thin PROXY to the CA service. Enrollment,
// scoring and the packet vote live in ca-service; this file keeps the session
// concerns: the consecutive-strike DEBOUNCE (per browser session) and the
// passkey step-up policy. Paths + responses match the old shape so mouse-ca.js
// (the live guard) is untouched.
const express = require("express");
const ca = require("../../services/caClient");

const router = express.Router();

// Consecutive suspicious packets before a passkey step-up (debounce). Session-
// scoped, so it belongs here, not in the stateless CA service.
const STRIKES_TO_LOCK = 3;

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  next();
};

router.post("/enroll", requireAuth, async (req, res, next) => {
  try {
    const r = await ca.mouseEnroll(req.caUid, req.body.windows);
    res.status(r.status).json(r.data);
  } catch (e) { next(e); }
});

router.post("/check", requireAuth, async (req, res, next) => {
  try {
    const r = await ca.mouseCheck(req.caUid, req.body.windows);
    const d = r.data || {};
    // Non-scored responses (warm-up, no movement, not enrolled) pass straight
    // through — mouse-ca.js keys off `checked` / `enrolled`.
    if (!d.checked) return res.status(r.status).json(d);

    // Strike debounce: a single suspicious packet never locks; require several
    // in a row. Any clean packet resets the streak.
    if (d.isSuspicious) {
      req.session.mouseSuspiciousStreak = (req.session.mouseSuspiciousStreak || 0) + 1;
    } else if (!d.warmup) {
      req.session.mouseSuspiciousStreak = 0;
    }
    const streak = req.session.mouseSuspiciousStreak || 0;
    const lockNow = streak >= STRIKES_TO_LOCK;
    const passkeyTriggered = lockNow && !!req.session.hasPasskey;
    if (passkeyTriggered) {
      req.session.continuousAuthLocked = true;
      ca.lockSet(req.caUid).catch(() => {});
      req.session.mouseSuspiciousStreak = 0; // consumed — restart clean after unlock
    }

    res.json({
      ...d,
      ok: !passkeyTriggered,
      suspiciousStreak: streak,
      strikesToLock: STRIKES_TO_LOCK,
      requiresPasskeyChallenge: passkeyTriggered,
      reason: passkeyTriggered
        ? `${streak} suspicious packets in a row (packet vote)`
        : d.isSuspicious
          ? `${d.lowWindows}/${(d.recentWindowScores || []).length} mouse windows < 50% — strike ${streak}/${STRIKES_TO_LOCK}`
          : d.reason,
    });
  } catch (e) { next(e); }
});

router.get("/status", requireAuth, async (req, res, next) => {
  try {
    const r = await ca.mouseStatus(req.caUid);
    res.status(r.status).json(r.data);
  } catch (e) { next(e); }
});

module.exports = router;
