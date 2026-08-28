// Mouse-dynamics routes — now a thin PROXY to the CA service. Enrollment,
// scoring and the packet vote live in ca-service; this file keeps the session
// concerns: the consecutive-strike DEBOUNCE (per browser session) and the
// passkey step-up policy. Paths + responses match the old shape so mouse-ca.js
// (the live guard) is untouched.
const express = require("express");
const ca = require("../../services/caClient");
const { requireFreshPasskey } = require("../../middleware/requireFreshPasskey");

const router = express.Router();

// Consecutive suspicious verdicts before a passkey step-up. Session-scoped, so it belongs
// here rather than in the stateless CA service.
//
// 1, i.e. no extra debounce. This layer was added when the CA service decided mouse on a
// 6-window packet vote, where a single suspicious verdict was thin evidence and needed
// corroboration. The service now uses a SUSTAINED vote — 15 of the last 20 windows must be
// low — which already is the debounce: at the measured genuine rate (~22% of windows low)
// that fires with probability ~1e-7, so a suspicious verdict is no longer a coin flip worth
// second-guessing. Stacking 3 strikes on top of it only delayed a real impostor by three
// more full buffers while adding nothing against false positives, and it made the SDK behave
// differently from the extension, which steps up as soon as the sustained vote trips.
const STRIKES_TO_LOCK = 1;

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

// Destructive: deletes the trained mouse profile and every stored session. Gated on a passkey
// verification from the last couple of minutes — see middleware/requireFreshPasskey. The SDK
// runs the ceremony first, but the gate is enforced here because the client cannot be trusted
// to have done so.
router.post("/reset", requireAuth, requireFreshPasskey, async (req, res, next) => {
  try {
    const r = await ca.mouseReset(req.caUid);
    // Any in-flight strike history refers to a model that no longer exists.
    req.session.mouseSuspiciousStreak = 0;
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
        ? `${d.lowWindows}/${(d.recentWindowScores || []).length} mouse windows < 50% (sustained vote)`
        : d.isSuspicious
          ? `${d.lowWindows}/${(d.recentWindowScores || []).length} mouse windows < 50%`
              + (STRIKES_TO_LOCK > 1 ? ` — strike ${streak}/${STRIKES_TO_LOCK}` : " — no passkey registered")
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
