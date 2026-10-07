// Standalone FIDO2/WebAuthn passkey microservice.
//
// Stateless w.r.t. the calling app: every endpoint takes an explicit userId
// (and, for registration, a username) rather than reading a session. The caller
// (the app / BFF) is responsible for authenticating the user and deciding WHEN
// to register or step-up; this service only performs the WebAuthn crypto and
// owns the credential + challenge store. It knows nothing about behavioral CA.
require("./log")("passkey-service");   // LOG_FORMAT=json: one JSON object per log line
const express = require("express");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const { isoBase64URL } = require("@simplewebauthn/server/helpers");
const db = require("./db");

const PORT = Number(process.env.PORT || 4000);
const RP_NAME = process.env.RP_NAME || "Continuum";
const DEFAULT_RP_ID = process.env.RP_ID || "localhost";
const DEFAULT_ORIGIN = process.env.ORIGIN || "http://localhost:3000";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Optional shared secret between the app and this service. If PASSKEY_API_KEY is
// set, callers must send it as X-Api-Key. Left unset (dev) the check is a no-op.
const API_KEY = process.env.PASSKEY_API_KEY || "";
// Where the passkey (private key) is stored, chosen at registration:
//   ""         → unconstrained: the browser lets the user pick, so on Chrome signed into a
//                Google account they can save to Google Password Manager, which SYNCS the
//                passkey to every device on that account (needed for cross-device step-up).
//   "platform" → pin to THIS device's built-in authenticator (Windows Hello / Touch ID):
//                works offline and while signed OUT of Google, but is device-bound (no sync).
// Default is unconstrained so the step-up passkey can sync across the user's devices. The
// logged-out deadlock this used to cause is handled separately by the extension's content
// script never locking the sign-in origin.
const AUTHENTICATOR_ATTACHMENT = process.env.AUTHENTICATOR_ATTACHMENT || "";

const app = express();
app.use(express.json({ limit: "1mb" }));

// Only the gateway and the demo call this service, both server-side and both with the key. It used
// to be published to the host with the WebAuthn ceremony (/v1/register/*, /v1/auth/*) left open,
// because the browser extension's /ext/* step-up pages, served from here, called it directly. Those
// pages are gone (the extension now uses the gateway's own pages) and the port is no longer
// published, so every route but /health needs the key: open, the ceremony let anyone who could
// reach the service name a userId and add their own passkey to it.
const OPEN_PREFIXES = ["/health", "/ready"];
app.use((req, res, next) => {
  if (OPEN_PREFIXES.some((p) => req.path === p || req.path.startsWith(p))) return next();
  if (API_KEY && req.get("X-Api-Key") !== API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
});

// Per-request RP/origin so one service can serve multiple tenants/domains.
const rpOf = (req) => String(req.body.rpId || req.query.rpId || DEFAULT_RP_ID);
const originOf = (req) => String(req.body.origin || req.query.origin || DEFAULT_ORIGIN);

// ---- credential-id encoding helpers (ported verbatim from the app) ----
function isHexCredentialId(value) {
  return typeof value === "string" && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}
function storedCredentialIdToBrowserId(value) {
  if (!isHexCredentialId(value)) return value;
  return isoBase64URL.fromBuffer(Buffer.from(value, "hex"));
}
function storedCredentialIdToBuffer(value) {
  return isoBase64URL.toBuffer(storedCredentialIdToBrowserId(value));
}
function browserCredentialIdToLegacyHex(value) {
  return Buffer.from(isoBase64URL.toBuffer(value)).toString("hex");
}
function parseTransports(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function getUserCredentials(userId) {
  return db.prepare("SELECT * FROM passkey_credentials WHERE user_id = ?").all(userId);
}

function saveChallenge(userId, challenge, type) {
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  const result = db
    .prepare(
      "INSERT INTO webauthn_challenges (user_id, challenge, challenge_type, expires_at) VALUES (?, ?, ?, ?)",
    )
    .run(userId, challenge, type, expiresAt);
  return result.lastInsertRowid;
}

// ---- health ----
app.get("/health", (req, res) => res.json({ ok: true, service: "passkey" }));
// Readiness: the credential store answers.
app.get("/ready", (req, res) => {
  try { db.prepare("SELECT 1").get(); res.json({ ready: true, service: "passkey" }); }
  catch (e) { res.status(503).json({ ready: false, service: "passkey", error: e.message }); }
});

// ---- lightweight lookups the app uses on hot paths ----
app.get("/v1/users/:userId/passkeys", (req, res) => {
  const userId = Number(req.params.userId);
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id = ?")
    .get(userId).n;
  res.json({ userId, count, hasPasskey: count > 0 });
});

app.post("/v1/users/:userId/reset", (req, res) => {
  const userId = Number(req.params.userId);
  db.prepare("DELETE FROM passkey_credentials WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM webauthn_challenges WHERE user_id = ?").run(userId);
  res.json({ ok: true, message: "Stored passkeys cleared" });
});

// ---- registration ----
app.post("/v1/register/options", async (req, res) => {
  try {
    const userId = Number(req.body.userId);
    const username = String(req.body.username || `user-${userId}`);
    if (!userId) return res.status(400).json({ error: "userId required" });

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpOf(req),
      userID: String(userId),
      userName: username,
      userDisplayName: username,
      timeout: 300000,
      attestationType: "none",
      authenticatorSelection: {
        // Only constrain attachment when explicitly configured (see AUTHENTICATOR_ATTACHMENT
        // above). Unconstrained (default) lets Chrome offer Google Password Manager, whose
        // passkeys SYNC across the account's devices; "platform" would pin it to this
        // device's Windows Hello / Touch ID (local, no sync).
        ...(AUTHENTICATOR_ATTACHMENT ? { authenticatorAttachment: AUTHENTICATOR_ATTACHMENT } : {}),
        residentKey: "required",
        requireResidentKey: true,
        // "required" forces user verification (Windows Hello / Touch ID / device unlock),
        // so a biometric/PIN prompt appears every time regardless of where the key lives.
        userVerification: "required",
      },
    });
    // Challenge lives in this service's store (not a session), so the service
    // stays stateless and horizontally scalable.
    saveChallenge(userId, options.challenge, "registration");
    res.json(options);
  } catch (err) {
    console.error("register/options:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/v1/register/complete", async (req, res) => {
  try {
    const userId = Number(req.body.userId);
    const credential = req.body.credential;
    if (!userId || !credential) {
      return res.status(400).json({ error: "userId and credential required" });
    }

    const chal = db
      .prepare(
        `SELECT * FROM webauthn_challenges
         WHERE user_id = ? AND challenge_type = 'registration' AND used = 0
         ORDER BY id DESC LIMIT 1`,
      )
      .get(userId);
    if (!chal) return res.status(400).json({ error: "No pending registration challenge" });

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: chal.challenge,
      expectedOrigin: originOf(req),
      expectedRPID: rpOf(req),
      requireUserVerification: true,
    });
    if (!verification.verified) {
      return res.status(400).json({ error: "Registration verification failed" });
    }

    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
    db.prepare(
      "INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)",
    ).run(
      userId,
      isoBase64URL.fromBuffer(credentialID),
      isoBase64URL.fromBuffer(credentialPublicKey),
      counter,
      credential.response && credential.response.transports
        ? JSON.stringify(credential.response.transports)
        : null,
    );
    db.prepare("UPDATE webauthn_challenges SET used = 1 WHERE id = ?").run(chal.id);
    res.json({ ok: true, message: "Passkey registered successfully" });
  } catch (err) {
    console.error("register/complete:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---- authentication / step-up ----
app.post("/v1/auth/options", async (req, res) => {
  try {
    const userId = Number(req.body.userId);
    if (!userId) return res.status(400).json({ error: "userId required" });

    const credentials = getUserCredentials(userId);
    if (credentials.length === 0) {
      return res.status(400).json({ error: "No passkeys registered for this user" });
    }

    const options = await generateAuthenticationOptions({
      rpID: rpOf(req),
      timeout: 300000,
      // Force the Windows Hello / biometric prompt on every step-up verification.
      userVerification: "required",
      allowCredentials: credentials.map((c) => ({
        id: storedCredentialIdToBuffer(c.credential_id),
        type: "public-key",
        transports: parseTransports(c.transports),
      })),
    });
    const challengeId = saveChallenge(userId, options.challenge, "authentication");
    res.json({ ...options, challengeId });
  } catch (err) {
    console.error("auth/options:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/v1/auth/complete", async (req, res) => {
  try {
    const userId = Number(req.body.userId);
    const { challengeId, assertion } = req.body;
    if (!userId || !challengeId || !assertion) {
      return res.status(400).json({ error: "userId, challengeId, and assertion required" });
    }

    const challenge = db
      .prepare("SELECT * FROM webauthn_challenges WHERE id = ? AND user_id = ? AND used = 0")
      .get(challengeId, userId);
    if (!challenge) return res.status(400).json({ error: "Invalid or expired challenge" });

    if (new Date(challenge.expires_at) < new Date()) {
      db.prepare("UPDATE webauthn_challenges SET used = 1 WHERE id = ?").run(challengeId);
      return res.status(400).json({ error: "Challenge expired" });
    }

    const credentialId = assertion.id;
    const legacyCredentialId = browserCredentialIdToLegacyHex(credentialId);
    const credential = db
      .prepare(
        "SELECT * FROM passkey_credentials WHERE user_id = ? AND credential_id IN (?, ?)",
      )
      .get(userId, credentialId, legacyCredentialId);
    if (!credential) return res.status(400).json({ error: "Credential not found" });

    const verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: challenge.challenge,
      expectedOrigin: originOf(req),
      expectedRPID: rpOf(req),
      requireUserVerification: true,
      authenticator: {
        credentialID: storedCredentialIdToBuffer(credential.credential_id),
        credentialPublicKey: isoBase64URL.toBuffer(credential.public_key),
        counter: credential.counter,
        transports: parseTransports(credential.transports),
      },
    });

    if (!verification.verified) {
      db.prepare("UPDATE webauthn_challenges SET used = 1 WHERE id = ?").run(challengeId);
      return res.status(400).json({ error: "Authentication verification failed" });
    }

    db.prepare("UPDATE passkey_credentials SET counter = ? WHERE id = ?").run(
      verification.authenticationInfo.newCounter,
      credential.id,
    );
    db.prepare("UPDATE webauthn_challenges SET used = 1 WHERE id = ?").run(challengeId);
    res.json({ ok: true, verified: true, message: "Passkey authentication successful" });
  } catch (err) {
    console.error("auth/complete:", err);
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Passkey service on http://localhost:${PORT} (rpID=${DEFAULT_RP_ID})`);
});
// A stop request (docker stop, a Kubernetes rollout): finish the requests in flight, close the database.
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[passkey] ${sig}: stopping`);
    server.close(() => { try { db.close(); } catch (_) {} process.exit(0); });
    setTimeout(() => process.exit(0), 10000).unref();
  });
}
