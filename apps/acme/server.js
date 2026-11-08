// Acme — a completely independent application. It knows NOTHING about Continuum's
// internals: no shared session, no shared database, no enrollment pages. Its only
// Continuum dependencies are:
//   • the client SDK (guard.js), loaded from Continuum's gateway origin, and
//   • the @continuum/node middleware to ENFORCE the signed risk verdict.
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { createGuard } = require("./lib/continuumNode");

const app = express();
app.use(express.json());
// The page loads the SDK from Continuum's gateway: http://localhost:8080 as written in it, or the address in
// CONTINUUM_GATEWAY_URL (a deployment whose gateway answers elsewhere).
const GATEWAY_URL = (process.env.CONTINUUM_GATEWAY_URL || "").replace(/\/+$/, "");
if (GATEWAY_URL) {
  const fs = require("fs");
  const page = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8").replaceAll("http://localhost:8080", GATEWAY_URL);
  app.get(["/", "/index.html"], (req, res) => res.type("html").send(page));
}
app.use(express.static(path.join(__dirname, "public")));

// The secret is shared with Continuum (the tenant secret). Acme uses it BOTH to
// verify verdicts AND to vouch for its logged-in user's identity — no calls to Continuum.
const SECRET = process.env.CONTINUUM_SECRET || "dev-continuum-risk-secret";
const guard = createGuard({ secret: SECRET });

// Framework-agnostic IDENTITY minting: sign {sub,exp} with the tenant secret.
// In a real app `sub` comes from YOUR session (req.user.id); here it's a query
// param for the demo. This is ~5 lines in any language (Python/PHP/Go/.NET…).
app.get("/continuum-identity", (req, res) => {
  const sub = String(req.query.user || "guest");
  console.log(sub, "subsubsub");
  const p = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 300 }),
  ).toString("base64url");
  res.json({
    token:
      p + "." + crypto.createHmac("sha256", SECRET).update(p).digest("hex"),
  });
});

// Acme's OWN sensitive action, protected purely by Continuum's signed verdict —
// no Continuum session involved. Suspicious => 403 (step-up), not yet judged (warm-up) => 403 verdict_pending,
// tampered/absent => 401. requireVerified, not requireTrusted: a sensitive action waits for a real verdict (2026-11-08).
app.post("/save-note", guard.requireVerified, (req, res) => {
  res.json({
    ok: true,
    saved: true,
    message: "Saved by Acme — Continuum verdict was genuine.",
    verdict: {
      risk: req.continuum.risk,
      modality: req.continuum.modality,
      continuumUserId: req.continuum.userId,
    },
  });
});

const PORT = process.env.PORT || 4200;
const server = app.listen(PORT, () => console.log(`Acme app on http://localhost:${PORT}`));
// node as PID 1 ignores SIGTERM unless it is handled: without this, every stop waited out the timeout.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
