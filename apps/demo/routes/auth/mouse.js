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

// More samples for a trained profile (2026-11-25). A trained profile takes no enrolment sample, or anyone at an open
// session could teach it their own movement; its user may add samples after a passkey verified moments ago
// (requireFreshPasskey). Continuum exchanges that verification's step-up token for a grant, which stays in this
// session, never on the page, and goes with each sample while it lasts (routes/auth/text.js does the same for typing).
router.post("/topup", requireAuth, requireFreshPasskey, async (req, res, next) => {
  const stepUpToken = req.session.stepUpToken;
  delete req.session.stepUpToken;
  try {
    const r = await ca.mouseTopUp(req.session.userId, stepUpToken);
    if (r.status !== 200 || !r.data || !r.data.topUpToken) return res.status(r.status === 200 ? 502 : r.status).json(r.data || {});
    req.session.topUp = { ...(req.session.topUp || {}), mouse: { token: r.data.topUpToken, until: Date.now() + Number(r.data.expiresInMs || 0) } };
    res.json({ ok: true, expiresInMs: r.data.expiresInMs });
  } catch (e) { next(e); }
});

// The end of a top-up (2026-11-26): its samples wait at Continuum and reach the model only after a second passkey,
// verified once they were made (requireFreshPasskey again: the first verification was spent on the grant). A top-up left
// open on the screen cannot be finished by someone else.
router.post("/topup/confirm", requireAuth, requireFreshPasskey, async (req, res, next) => {
  const stepUpToken = req.session.stepUpToken;
  delete req.session.stepUpToken;
  try {
    const r = await ca.mouseTopUpConfirm(req.session.userId, stepUpToken);
    if (r.status >= 200 && r.status < 300 && req.session.topUp) delete req.session.topUp.mouse;   // the top-up is over, and its grant with it
    res.status(r.status).json(r.data);
  } catch (e) { next(e); }
});

router.post("/enroll", requireAuth, async (req, res, next) => {
  try {
    const grant = req.session.topUp && req.session.topUp.mouse;
    const r = await ca.mouseEnroll(req.session.userId, req.body.windows, grant && grant.until > Date.now() ? grant.token : undefined);
    res.status(r.status).json(r.data);
  } catch (e) { next(e); }
});

// A real-use sample, recorded by the SDK right after a passkey verification and the user's yes (learning from real use,
// stage 1). Continuum keeps it only after a passkey it verified moments ago; a locked session never gets here (app.js).
router.post("/use-sample", requireAuth, async (req, res, next) => {
  try {
    const r = await ca.mouseUseSample(req.session.userId, req.body.windows);
    res.status(r.status).json(r.data);
  } catch (e) { next(e); }
});

// Destructive: deletes the trained mouse profile and every stored session. Gated on a passkey
// verification from the last couple of minutes — see middleware/requireFreshPasskey. The SDK
// runs the ceremony first, but the gate is enforced here because the client cannot be trusted
// to have done so.
router.post("/reset", requireAuth, requireFreshPasskey, async (req, res, next) => {
  // Continuum checks the same thing on its side: the step-up token from that verification, used once.
  const stepUpToken = req.session.stepUpToken;
  delete req.session.stepUpToken;
  try {
    // ca-service clears the persisted streak as part of the reset — any in-flight strike
    // history refers to a model that no longer exists (see lib/mouse.js resetMouseProfile).
    const r = await ca.mouseReset(req.session.userId, stepUpToken);
    res.status(r.status).json(r.data);
  } catch (e) { next(e); }
});

router.post("/check", requireAuth, async (req, res, next) => {
  try {
    const r = await ca.mouseCheck(req.session.userId, req.body.windows);
    const d = r.data || {};
    // Continuum says the account is locked (a step-up asked for in another tab or by another client, not passed yet):
    // its answer goes to the page as it is and this session locks with it, as the typing route does (2026-11-25). It
    // was read as a scored packet with no strike and answered 200, so that page asked for no passkey.
    if (d.locked) { req.session.continuousAuthLocked = true; return res.status(r.status).json(d); }
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
