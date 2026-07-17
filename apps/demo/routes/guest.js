// Demonstration of a HOST APP backend enforcing Continuum's signed verdict.
//
// The "Acme Notes" guest page (guest-demo.html) is a stand-in for any customer
// app. Its "Save note" is a sensitive action: the browser attaches the latest
// signed risk token (X-Continuum-Risk, provided by guard.js) and this route —
// guarded by the @continuum/node middleware — allows it only when the live
// behavioral verdict is genuine. A suspicious verdict returns 403 step_up.
const express = require("express");
const { createGuard } = require("../lib/continuumNode");

const router = express.Router();

// Same secret the CA service signs with (CA_SIGNING_SECRET). Defaults match so
// local dev needs no configuration.
const guard = createGuard({
  secret: process.env.CONTINUUM_SECRET || "dev-continuum-risk-secret",
});

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  next();
};

// Enforced by the SIGNED verdict, not the session — this is the pattern an
// external host would use (it need not share Continuum's session at all).
router.post("/save-note", requireAuth, guard.requireTrusted, (req, res) => {
  res.json({
    ok: true,
    saved: true,
    message: "Note saved — behavioral verdict was genuine.",
    verdict: { risk: req.continuum.risk, modality: req.continuum.modality, userId: req.continuum.userId },
  });
});

module.exports = router;
