// Gate for DESTRUCTIVE actions: require a passkey verification that happened moments ago.
//
// Why a server-side gate at all: the SDK runs the passkey ceremony before calling these
// endpoints, but that is a client-side decision and anyone can POST directly. Deleting a
// user's enrolled biometric profile is exactly the action an impostor sitting at an unlocked
// machine would want — it would let them re-enroll the profile as themselves — so the check
// has to live where the client cannot skip it.
//
// Why FRESH rather than "has ever verified": routes/webauthn.js already records
// passkeyVerifiedUserId when a step-up succeeds, but that flag survives for the life of the
// session. Reusing it would mean one unlock at login silently authorises deletion an hour
// later. The timestamp (passkeyVerifiedAt, set alongside it) bounds that to a short window.
const FRESH_MS = 2 * 60 * 1000; // 2 minutes: long enough to click through, short enough to matter

function requireFreshPasskey(req, res, next) {
  const sessionUser = Number(req.session && req.session.userId);
  const verifiedUser = Number(req.session && req.session.passkeyVerifiedUserId);
  const at = Number(req.session && req.session.passkeyVerifiedAt);

  if (!sessionUser || !verifiedUser || verifiedUser !== sessionUser || !at) {
    return res.status(401).json({
      error: "Verify with your passkey to continue",
      passkeyRequired: true,
    });
  }
  if (Date.now() - at > FRESH_MS) {
    return res.status(401).json({
      error: "That verification has expired — verify with your passkey again",
      passkeyRequired: true,
    });
  }
  // One verification authorises ONE destructive action. Consuming it prevents a single
  // step-up from clearing both profiles, or being replayed by a second request.
  delete req.session.passkeyVerifiedAt;
  next();
}

module.exports = { requireFreshPasskey, FRESH_MS };
