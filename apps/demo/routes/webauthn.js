// WebAuthn routes — now a thin PROXY to the standalone passkey microservice.
// All FIDO2 crypto and credential storage live in that service; this router
// keeps only what belongs to the app: session, authorization ("may THIS session
// act for this user?"), and the app-side risk flags (continuousAuthLocked,
// passkeyVerifiedUserId). The paths + responses are unchanged, so the frontend
// is untouched.
const express = require("express");
const db = require("../db/init");
const passkey = require("../services/passkeyClient");
const ca = require("../services/caClient");

const router = express.Router();

function getUser(userId) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

// ---- registration ----
router.post("/register/options", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
    const user = getUser(req.session.userId);
    const options = await passkey.registerOptions(user.id, user.username);
    res.json(options);
  } catch (err) {
    console.error("Register options error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/register/complete", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: "No credential provided" });

    await passkey.registerComplete(req.session.userId, credential);
    // Update the app-side cache + gate flags now that a passkey exists.
    req.session.hasPasskey = true;
    delete req.session.passkeySetupRequired;
    res.json({ ok: true, message: "Passkey registered successfully" });
  } catch (err) {
    console.error("Register complete error:", err);
    res.status(err.status === 400 ? 400 : 500).json({ error: err.message });
  }
});

router.post("/register/reset", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
    await passkey.reset(req.session.userId);
    req.session.hasPasskey = false;
    delete req.session.passkeyVerifiedUserId;
    delete req.session.continuousAuthLocked;
    ca.lockClear(req.session.userId).catch(() => {});
    req.session.passkeySetupRequired = true;
    res.json({ ok: true, message: "Stored passkeys cleared" });
  } catch (err) {
    console.error("Reset passkeys error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---- authentication / step-up ----
router.post("/auth/options", async (req, res) => {
  try {
    const userId = Number(req.body.userId);
    if (!userId) return res.status(400).json({ error: "userId required" });

    // Authorization stays in the app: a session may only step-up for its own
    // user (or a pending login for that user).
    const sessionUserId = Number(req.session.userId);
    const pendingLoginUserId = Number(req.session.pendingPasskeyLoginUserId);
    if (sessionUserId && sessionUserId !== userId) {
      return res.status(403).json({ error: "Cannot verify a passkey for another user" });
    }
    if (!sessionUserId && pendingLoginUserId && pendingLoginUserId !== userId) {
      return res.status(403).json({ error: "Cannot verify a passkey for another login attempt" });
    }
    if (!sessionUserId && !pendingLoginUserId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const options = await passkey.authOptions(userId);
    res.json(options); // includes challengeId from the service
  } catch (err) {
    console.error("Auth options error:", err);
    res.status(err.status === 400 ? 400 : 500).json({ error: err.message });
  }
});

router.post("/auth/complete", async (req, res) => {
  try {
    const { userId, challengeId, assertion } = req.body;
    if (!userId || !challengeId || !assertion) {
      return res.status(400).json({ error: "userId, challengeId, and assertion required" });
    }

    await passkey.authComplete(userId, challengeId, assertion);

    // App-side outcome: record the verification + lift the risk lock for a
    // matching in-session user (both keystroke and mouse guards read this).
    req.session.passkeyVerifiedUserId = Number(userId);
    // WHEN it happened, not just that it did. Destructive actions (profile reset) require a
    // verification from moments ago, not one left over from an unlock earlier in the session
    // — otherwise a single step-up would authorise deletion for as long as the session lives.
    req.session.passkeyVerifiedAt = Date.now();
    if (req.session.userId && Number(req.session.userId) === Number(userId)) {
      delete req.session.continuousAuthLocked;
      ca.lockClear(req.session.userId).catch(() => {});
    }
    res.json({ ok: true, message: "Passkey authentication successful" });
  } catch (err) {
    console.error("Auth complete error:", err);
    res.status(err.status === 400 ? 400 : 500).json({ error: err.message });
  }
});

module.exports = router;
