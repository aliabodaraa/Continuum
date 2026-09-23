const express = require("express");
const bcryptjs = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const db = require("../../db/init");
const passkey = require("../../services/passkeyClient");
const ca = require("../../services/caClient");
const { resolveContinuumId } = require("../../services/continuumId");

const router = express.Router();
const profileUploadDir = path.join(__dirname, "../../public/uploads/profiles");

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  return next();
}

function publicUser(user) {
  return {
    userId: user.id,
    username: user.username,
    email: user.email,
    profilePhoto: user.profile_photo,
    createdAt: user.created_at,
  };
}

router.post("/register", async (req, res) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }

    // Check if user exists
    const existing = db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username);
    if (existing) {
      return res.status(409).json({ error: "User already exists" });
    }

    // Hash password
    const passwordHash = await bcryptjs.hash(password, 10);

    // Insert user
    const stmt = db.prepare(
      "INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)",
    );
    const result = stmt.run(username, passwordHash, email || null);
    req.session.userId = result.lastInsertRowid;
    req.session.username = username;
    req.session.passkeySetupRequired = true;

    return res.json({
      ok: true,
      message: "Registration successful. Passkey setup required.",
      userId: result.lastInsertRowid,
      passkeySetupRequired: true,
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }

    const user = db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username);
    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const validPassword = await bcryptjs.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    // Ask the passkey service directly here — the session was just established,
    // so the gate middleware hasn't populated the cache yet. Seed it now.
    const hasPasskey = await passkey.hasPasskey(user.id);
    req.session.hasPasskey = hasPasskey;
    req.session.passkeySetupRequired = !hasPasskey;

    // Warm the session's cached Continuum id for later requests (attachContinuumId
    // reads/writes req.session.continuumUserId, but ran before session.userId existed
    // on THIS request). caClient's own functions resolve identity internally from the
    // RAW app user id — passing an already-resolved id back in double-resolves it into
    // a different, empty principal, which is exactly the bug this comment used to cause.
    await resolveContinuumId(req);
    ca.maybeRetrainImpostors(user.id);

    return res.json({
      ok: true,
      message: req.session.passkeySetupRequired
        ? "Login allowed only for passkey setup"
        : "Login successful",
      userId: user.id,
      username: user.username,
      passkeySetupRequired: req.session.passkeySetupRequired,
      typingStatus: (await ca.keystrokeStatus(user.id)).data,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/login/passkey-complete", (req, res) => {
  try {
    const { userId } = req.body;
    const pendingUserId = Number(req.session.pendingPasskeyLoginUserId);
    const verifiedUserId = Number(req.session.passkeyVerifiedUserId);
    const requestedUserId = Number(userId);

    if (
      !pendingUserId ||
      !verifiedUserId ||
      pendingUserId !== requestedUserId ||
      verifiedUserId !== requestedUserId
    ) {
      return res.status(401).json({ error: "Passkey login was not verified" });
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(requestedUserId);
    if (!user) {
      return res.status(401).json({ error: "Invalid user" });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.hasPasskey = true; // they just authenticated with a passkey
    delete req.session.pendingPasskeyLoginUserId;
    delete req.session.passkeyVerifiedUserId;
    delete req.session.passkeySetupRequired;

    // Fire-and-forget (this handler isn't async): warm the session's cached Continuum id,
    // and separately retrain on the RAW id — caClient resolves identity internally, so an
    // already-resolved id fed back in double-resolves into a different, empty principal.
    resolveContinuumId(req).catch(() => {});
    ca.maybeRetrainImpostors(user.id);

    return res.json({
      ok: true,
      message: "Login successful",
      userId: user.id,
      username: user.username,
    });
  } catch (err) {
    console.error("Passkey login complete error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/login/passkey-unavailable", async (req, res) => {
  try {
    const pendingUserId = Number(req.session.pendingPasskeyLoginUserId);
    if (!pendingUserId) {
      return res.status(401).json({ error: "No pending passkey login" });
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(pendingUserId);
    if (!user) {
      return res.status(401).json({ error: "Invalid user" });
    }

    // Clear stale credentials in the passkey service (source of truth).
    await passkey.reset(pendingUserId);

    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.hasPasskey = false;
    req.session.passkeySetupRequired = true;
    delete req.session.pendingPasskeyLoginUserId;
    delete req.session.passkeyVerifiedUserId;

    return res.json({
      ok: true,
      message: "Stale passkeys cleared. Register a new passkey to unlock the account.",
      passkeySetupRequired: true,
    });
  } catch (err) {
    console.error("Passkey unavailable recovery error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, message: "Logged out" });
  });
});

router.get("/profile", requireAuth, (req, res) => {
  const user = db
    .prepare("SELECT id, username, email, profile_photo, created_at FROM users WHERE id = ?")
    .get(req.session.userId);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  return res.json({
    ok: true,
    profile: publicUser(user),
    passkeysRegistered: !!req.session.hasPasskey,
  });
});

router.put("/profile", requireAuth, async (req, res) => {
  try {
    const { username, email, currentPassword, newPassword } = req.body;
    const cleanUsername = String(username || "").trim();
    const cleanEmail = email ? String(email).trim() : null;

    if (!cleanUsername) {
      return res.status(400).json({ error: "Username is required" });
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const usernameOwner = db
      .prepare("SELECT id FROM users WHERE username = ? AND id <> ?")
      .get(cleanUsername, req.session.userId);
    if (usernameOwner) {
      return res.status(409).json({ error: "Username is already used" });
    }

    let passwordHash = user.password_hash;
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: "Current password is required" });
      }
      const validPassword = await bcryptjs.compare(currentPassword, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }
      passwordHash = await bcryptjs.hash(newPassword, 10);
    }

    db.prepare(
      "UPDATE users SET username = ?, email = ?, password_hash = ? WHERE id = ?",
    ).run(cleanUsername, cleanEmail, passwordHash, req.session.userId);

    req.session.username = cleanUsername;
    const updated = db
      .prepare("SELECT id, username, email, profile_photo, created_at FROM users WHERE id = ?")
      .get(req.session.userId);

    return res.json({
      ok: true,
      message: "Profile updated",
      profile: publicUser(updated),
    });
  } catch (err) {
    console.error("Profile update error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/profile/photo", requireAuth, (req, res) => {
  try {
    const { imageData } = req.body;
    const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
      imageData || "",
    );
    if (!match) {
      return res.status(400).json({ error: "Upload a PNG, JPG, or WebP image" });
    }

    const ext = match[1] === "jpeg" ? "jpg" : match[1];
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: "Image must be 2 MB or smaller" });
    }

    fs.mkdirSync(profileUploadDir, { recursive: true });
    const filename = `user-${req.session.userId}-${Date.now()}.${ext}`;
    const absolutePath = path.join(profileUploadDir, filename);
    fs.writeFileSync(absolutePath, buffer);

    const photoPath = `/uploads/profiles/${filename}`;
    db.prepare("UPDATE users SET profile_photo = ? WHERE id = ?").run(
      photoPath,
      req.session.userId,
    );

    return res.json({
      ok: true,
      message: "Profile photo updated",
      profilePhoto: photoPath,
    });
  } catch (err) {
    console.error("Profile photo error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/me", async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const hasPasskey = !!req.session.hasPasskey;
  const user = db
    .prepare("SELECT profile_photo FROM users WHERE id = ?")
    .get(req.session.userId);
  if (!hasPasskey) {
    req.session.passkeySetupRequired = true;
  }
  const typingStatus = await ca
    .keystrokeStatus(req.session.userId)
    .then((r) => r.data)
    .catch((e) => { console.error("[auth/me] keystrokeStatus failed for user", req.session.userId, ":", e.message); return { trained: false }; });
  res.json({
    userId: req.session.userId,
    username: req.session.username,
    profilePhoto: user ? user.profile_photo : null,
    passkeySetupRequired: !!req.session.passkeySetupRequired || !hasPasskey,
    passkeysRegistered: hasPasskey,
    continuousAuthLocked: !!req.session.continuousAuthLocked,
    typingStatus,
  });
});

module.exports = router;
