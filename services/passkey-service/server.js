// Standalone FIDO2/WebAuthn passkey microservice.
//
// Stateless w.r.t. the calling app: every endpoint takes an explicit userId
// (and, for registration, a username) rather than reading a session. The caller
// (the app / BFF) is responsible for authenticating the user and deciding WHEN
// to register or step-up; this service only performs the WebAuthn crypto and
// owns the credential + challenge store. It knows nothing about behavioral CA.
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
// Default is unconstrained so the step-up passkey can sync with the account the extension is
// already bound to. The logged-out deadlock this used to cause is handled separately by the
// content script no longer locking the sign-in origin.
const AUTHENTICATOR_ATTACHMENT = process.env.AUTHENTICATOR_ATTACHMENT || "";

const app = express();
app.use(express.json({ limit: "1mb" }));

// This service is published to the host because the extension's step-up pages are
// browser-facing, so the key gate has to distinguish two kinds of endpoint.
//
// OPEN, and safe to be open: the WebAuthn ceremony (/v1/register/*, /v1/auth/*). The
//   /ext/* pages are HTML served to a browser, and their own scripts call these paths —
//   a browser cannot hold a server API key. They are not unprotected: WebAuthn binds every
//   ceremony to a server-issued challenge and to the caller's origin, and completion needs
//   a signature from the real authenticator. An attacker gains nothing from a challenge.
//
// PROTECTED: the management endpoints (/v1/users/*). These are NOT part of the ceremony,
//   are never called by a browser, and are genuinely dangerous when open —
//   GET /v1/users/:id/passkeys leaks whether a user has a passkey, and
//   POST /v1/users/:id/reset DELETES it, removing the step-up factor entirely.
const OPEN_PREFIXES = ["/health", "/ext/", "/v1/register/", "/v1/auth/"];
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

// ---- extension step-up pages (the FIXED Continuum RP) ----
// Site passkeys are origin-bound, so the browser extension cannot use a customer site's
// passkey. Instead its step-up happens HERE, on the Continuum origin: these two pages run
// the WebAuthn ceremony against this service and postMessage the outcome into their own
// window, where the extension's content script relays it (the worker verifies sender.url).
// NOTE: they call the /v1 endpoints directly, so with PASSKEY_API_KEY set these pages need
// a fronting proxy to attach the key — dev runs without one.
const EXT_PAGE_STYLE = `body{font:15px/1.5 system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:96vh;align-items:center;justify-content:center;margin:0}
.card{max-width:420px;background:#1e293b;border-radius:16px;padding:30px 34px;text-align:center}
h1{font-size:19px;margin:0 0 8px}p{color:#94a3b8;margin:0 0 6px}#s{font-weight:700;color:#e2e8f0;margin-top:14px}`;
const EXT_PAGE_HELPERS = `const uid=Number(new URLSearchParams(location.hash.slice(1)).get("uid"));
const b2b=s=>Uint8Array.from(atob(String(s).replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
const b2s=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
const post=async(u,body)=>{const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.assign({rpId:location.hostname,origin:location.origin},body))});const j=await r.json();if(j.error)throw new Error(j.error);return j};
const report=(action,ok,err)=>{window.postMessage({type:"continuum-ext-passkey",action,ok,error:err},"*")};`;

app.get("/ext/register.html", (req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Continuum — set up passkey</title><style>${EXT_PAGE_STYLE}</style>
<div class="card"><h1>🔑 Set up your Continuum passkey</h1>
<p>This passkey protects your browser profile everywhere the guard runs. Approve the prompt (Windows Hello / Touch ID).</p><div id="s">Starting…</div></div>
<script>${EXT_PAGE_HELPERS}
(async()=>{const s=document.getElementById("s");try{
const o=await post("/v1/register/options",{userId:uid,username:"guard-profile-"+uid});
o.challenge=b2b(o.challenge);o.user.id=b2b(o.user.id);(o.excludeCredentials||[]).forEach(c=>c.id=b2b(c.id));
const c=await navigator.credentials.create({publicKey:o});
await post("/v1/register/complete",{userId:uid,credential:{id:c.id,rawId:b2s(c.rawId),type:c.type,response:{clientDataJSON:b2s(c.response.clientDataJSON),attestationObject:b2s(c.response.attestationObject),transports:c.response.getTransports?c.response.getTransports():void 0}}});
s.textContent="✓ Passkey registered — you can close this tab.";report("register",true)}
catch(e){s.textContent="✗ "+e.message;report("register",false,e.message)}})();
</script>`);
});

app.get("/ext/verify.html", (req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Continuum — verify it's you</title><style>${EXT_PAGE_STYLE}</style>
<div class="card"><h1>🔒 Verify it's you</h1>
<p>Continuum Guard detected typing that doesn't match this profile. Confirm with your passkey to unlock.</p><div id="s">Starting…</div></div>
<script>${EXT_PAGE_HELPERS}
(async()=>{const s=document.getElementById("s");try{
const o=await post("/v1/auth/options",{userId:uid});
const cid=o.challengeId;o.challenge=b2b(o.challenge);(o.allowCredentials||[]).forEach(c=>c.id=b2b(c.id));
const a=await navigator.credentials.get({publicKey:o});
await post("/v1/auth/complete",{userId:uid,challengeId:cid,assertion:{id:a.id,rawId:b2s(a.rawId),type:a.type,response:{clientDataJSON:b2s(a.response.clientDataJSON),authenticatorData:b2s(a.response.authenticatorData),signature:b2s(a.response.signature),userHandle:a.response.userHandle?b2s(a.response.userHandle):null}}});
s.textContent="✓ Verified — pages are unlocked. You can close this tab.";report("verify",true)}
catch(e){s.textContent="✗ "+e.message;report("verify",false,e.message)}})();
</script>`);
});

app.listen(PORT, () => {
  console.log(`Passkey service on http://localhost:${PORT} (rpID=${DEFAULT_RP_ID})`);
});
