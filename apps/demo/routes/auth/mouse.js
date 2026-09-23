// Mouse-dynamics routes — now a thin PROXY to the CA service. Enrollment,
// scoring and the packet vote live in ca-service; this file keeps the session
// concerns: the consecutive-strike DEBOUNCE (per browser session) and the
// passkey step-up policy. Paths + responses match the old shape so mouse-ca.js
// (the live guard) is untouched.
const express = require("express");
const ca = require("../../services/caClient");
const { requireFreshPasskey } = require("../../middleware/requireFreshPasskey");

// IDENTITY CONTRACT. Pass `req.session.userId` — the demo's OWN raw user id — into every
// `ca.*` call, never `req.caUid`. caClient mints an identity token from what it is given and
// asks the gateway to resolve it; `req.caUid` is ALREADY the resolved canonical principal, so
// handing it back resolves a second time and lands on a different, empty principal. That
// failure is silent: the response is a well-formed "no data" object, not an error.
// `req.caUid` remains correct for anything that only reads or displays the canonical id.

const router = express.Router();

// Consecutive suspicious verdicts before a passkey step-up.
//
// The THRESHOLD is a host-app policy and stays here. The COUNT does not: it used to live in
// `req.session.mouseSuspiciousStreak`, a third copy of a fact the gateway also kept in a Map
// and ca-service could have derived. Three owners meant three answers — and because the
// demo's session store is in-memory, a restart cleared the count for a user mid-escalation.
// ca-service now persists it (lib/decisionState.js) and returns it as `suspiciousStreak`.
//
// 1, i.e. no extra debounce. This layer was added when the CA service decided mouse on a
// 6-window packet vote, where a single suspicious verdict was thin evidence and needed
// corroboration. The service now uses a SUSTAINED vote — 12 of the last 20 windows below the
// user's own threshold — which already is the debounce, and it is the rule whose false-lock
// and capture rates were measured (Experiment F: 5.7% median false lock, 95.6% capture).
// Stacking strikes on top of it would move the system away from that measured operating
// point, and delay a real impostor by further full buffers.
const STRIKES_TO_LOCK = 1;

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  next();
};

router.post("/enroll", requireAuth, async (req, res, next) => {
  try {
    const r = await ca.mouseEnroll(req.session.userId, req.body.windows);
    res.status(r.status).json(r.data);
  } catch (e) { next(e); }
});

// Destructive: deletes the trained mouse profile and every stored session. Gated on a passkey
// verification from the last couple of minutes — see middleware/requireFreshPasskey. The SDK
// runs the ceremony first, but the gate is enforced here because the client cannot be trusted
// to have done so.
router.post("/reset", requireAuth, requireFreshPasskey, async (req, res, next) => {
  try {
    // ca-service clears the persisted streak as part of the reset — any in-flight strike
    // history refers to a model that no longer exists (see lib/mouse.js resetMouseProfile).
    const r = await ca.mouseReset(req.session.userId);
    res.status(r.status).json(r.data);
  } catch (e) { next(e); }
});

router.post("/check", requireAuth, async (req, res, next) => {
  try {
    const r = await ca.mouseCheck(req.session.userId, req.body.windows);
    const d = r.data || {};
    // Non-scored responses (warm-up, no movement, not enrolled) pass straight
    // through — mouse-ca.js keys off `checked` / `enrolled`.
    if (!d.checked) return res.status(r.status).json(d);

    // The streak was advanced server-side when the packet was scored; we only read it and
    // apply our threshold. Any clean scored packet clears it; warm-up packets do neither.
    const streak = Number(d.suspiciousStreak || 0);
    const lockNow = streak >= STRIKES_TO_LOCK;
    const passkeyTriggered = lockNow && !!req.session.hasPasskey;
    if (passkeyTriggered) {
      req.session.continuousAuthLocked = true;
      ca.lockSet(req.session.userId).catch(() => {});
      ca.mouseStreakReset(req.session.userId).catch(() => {}); // consumed — restart clean after unlock
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
    const r = await ca.mouseStatus(req.session.userId);
    res.status(r.status).json(r.data);
  } catch (e) { next(e); }
});

module.exports = router;
