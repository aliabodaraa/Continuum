const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const path = require("path");
const db = require("./db/init");
const authRoute = require("./routes/auth/auth");
const textRoute = require("./routes/auth/text");
const mouseRoute = require("./routes/auth/mouse");
const guestRoute = require("./routes/guest");
const webauthnRoute = require("./routes/webauthn");
const passkey = require("./services/passkeyClient");
const ca = require("./services/caClient");
const { attachContinuumId } = require("./services/continuumId");

const app = express();

// Middleware
app.use(bodyParser.json({ limit: "5mb" }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "continuum-secret-key-change-in-production",
    resave: false,
    saveUninitialized: true,
    // secure cookies when served over HTTPS (set COOKIE_SECURE=1 behind TLS).
    cookie: { secure: process.env.COOKIE_SECURE === "1", maxAge: 24 * 60 * 60 * 1000 },
  }),
);

// THE ENTIRE consumer-side identity integration — one line. The SDK auto-fetches
// GET /continuum/identity (same-origin, so the session cookie flows); this hands
// back a signed identity for whoever is logged in. No hand-rolled endpoint, no crypto.
const continuum = require("./lib/continuumNode")({
  secret: process.env.CONTINUUM_SECRET || "dev-continuum-risk-secret",
  // No `user:` mapping needed — the middleware auto-detects the logged-in user
  // from common conventions (req.user, req.session.userId, …).
});
// One line. This serves /continuum/identity (so the SDK can identify the logged-in
// user), receives pushed risk-change events at /continuum/events (CAEP), and tags
// each request with the user's current pushed risk — so continuum.protect blocks a
// server-pushed "suspicious" verdict with no further code (see routes/guest.js).
// It also serves /continuum/link, where the demo's users sign in to the Continuum Guard
// extension (the demo tenant's "sign-in page for the extension"; the gateway's public
// address comes from CONTINUUM_GATEWAY_URL). Mounted before the passkey gate below, so a
// signed-in user without a passkey can still link and set one up in the extension.
app.use(continuum);

// Resolve the logged-in user's Continuum id (via the gateway) into req.caUid, so
// this app's OWN routes key the CA on the SAME identity the SDK/gateway uses.
// Cached per session; falls back to the raw id if the gateway is unreachable.
app.use(attachContinuumId);

async function passkeySetupGate(req, res, next) {
  if (!req.session.userId) {
    const publicPages = new Set(["/login.html", "/register.html", "/index.html"]);
    if (req.path.endsWith(".html") && !publicPages.has(req.path)) {
      return res.redirect("/login.html");
    }
    return next();
  }

  // Session-cached (populated here on first hit, updated on register/reset) so
  // this per-request gate stays fast and never hits the passkey service inline.
  const hasPasskey = await passkey.ensureHasPasskey(req);
  if (hasPasskey) {
    delete req.session.passkeySetupRequired;
  }

  const allowedApiPaths = new Set([
    "/api/auth/me",
    "/api/auth/logout",
    "/api/webauthn/register/options",
    "/api/webauthn/register/complete",
    "/api/webauthn/register/reset",
    "/api/webauthn/auth/options",
    "/api/webauthn/auth/complete",
    "/api/text/typing-status",
    "/api/text/stats",
    "/api/text/typing-reset",
    "/api/text/enroll",
    // Read-only history/metrics/config — safe to view while onboarding or locked
    // (the dashboard loads these on every refresh; blocking them caused 423s).
    "/api/text/config",
    "/api/text/decisions",
    "/api/text/decisions/export",
    "/api/text/history",
    "/api/text/metrics",
    // Mouse onboarding must work while the user is still gated on it.
    "/api/mouse/enroll",
    "/api/mouse/status",
    "/api/mouse/check",
    // Host-app sensitive action — enforced by the SIGNED risk token middleware,
    // not the session gate, so it demonstrates token-based enforcement.
    "/api/guest/save-note",
  ]);

  if (hasPasskey && req.session.continuousAuthLocked) {
    if (req.path.startsWith("/api/")) {
      if (allowedApiPaths.has(req.path)) {
        return next();
      }
      return res.status(423).json({
        error: "Passkey verification required before continuing",
        continuousAuthLocked: true,
      });
    }

    // Reloading (or navigating to) any other page while a step-up challenge is
    // pending must not silently resume the session with no popup — the
    // in-memory client-side lock (guard.js `locked`, lab.html `passkeyRequired`)
    // resets on every page load, so only the server can enforce this. Log out
    // rather than bounce to the dashboard, so a dismissed challenge can't be
    // waited out by reloading. Dashboard keeps its own in-place resolve UI
    // (banner + "Verify with Passkey" button) and is exempted above.
    if (req.path.endsWith(".html") && req.path !== "/dashboard.html") {
      return req.session.destroy(() => res.redirect("/login.html"));
    }

    return next();
  }

  if (hasPasskey) {
    // Onboarding status comes from the CA service (single call). Fail OPEN on a
    // hiccup so a transient ca-service issue never locks the whole app behind an
    // unreachable enrollment gate.
    // LAZY strategy (ONBOARDING_MODE=lazy): enrollment is per-toggle in the SDK —
    // the app must not gate on it, so unenrolled users browse freely.
    const onboarding = process.env.ONBOARDING_MODE === "lazy"
      ? { trained: true, mouseEnrolled: true }
      : await ca
          .onboarding(req.session.userId)
          .then((r) => r.data)
          .catch(() => ({ trained: true, mouseEnrolled: true }));

    // While the typing model is being built (about a minute, from ca-service's queue) the user moves
    // freely: enrolment is done, and typing checks start by themselves once the model exists.
    if (!onboarding.trained && !onboarding.keystrokeTraining) {
      if (req.path.startsWith("/api/")) {
        if (allowedApiPaths.has(req.path)) {
          return next();
        }
        return res.status(423).json({
          error: "Typing rhythm enrollment required before using this action",
          rhythmEnrollmentRequired: true,
          typingStatus: { trained: false },
        });
      }

      // Enrollment now happens via the SDK onboarding popup on the dashboard —
      // send unenrolled users there instead of a dedicated enroll page.
      if (req.path.endsWith(".html") && req.path !== "/dashboard.html") {
        return res.redirect("/dashboard.html");
      }

      return next();
    }

    // Second modality gate: after keystroke enrollment, a new user must also
    // enroll their mouse dynamics before using the system (mandatory, like the
    // 5-sample keystroke minimum). Onboarding order: passkey → keystroke → mouse.
    if (!onboarding.mouseEnrolled) {
      if (req.path.startsWith("/api/")) {
        if (allowedApiPaths.has(req.path)) {
          return next();
        }
        return res.status(423).json({
          error: "Mouse-dynamics enrollment required before using this action",
          mouseEnrollmentRequired: true,
        });
      }

      // Mouse enrollment also happens via the SDK popup on the dashboard.
      if (req.path.endsWith(".html") && req.path !== "/dashboard.html") {
        return res.redirect("/dashboard.html");
      }

      return next();
    }

    return next();
  }

  req.session.passkeySetupRequired = true;

  if (req.path.startsWith("/api/")) {
    if (allowedApiPaths.has(req.path)) {
      return next();
    }
    return res.status(423).json({
      error: "Passkey registration required before using this action",
      passkeySetupRequired: true,
    });
  }

  const pageRequest =
    req.path === "/" ||
    req.path.endsWith(".html");

  if (pageRequest && req.path !== "/dashboard.html") {
    return res.redirect("/dashboard.html");
  }

  return next();
}

// Express 4 doesn't await middleware promises — bridge rejections to next(err).
app.use((req, res, next) => passkeySetupGate(req, res, next).catch(next));

// Static files
app.use(express.static(path.join(__dirname, "public")));
// The shared client SDK (guard.js + capture libs + webauthn) lives in the
// top-level sdk/ package, mounted here — same source the gateway serves customers.
app.use(express.static(path.join(__dirname, "sdk-assets")));
app.use(
  "/vendor/simplewebauthn",
  express.static(path.join(__dirname, "node_modules/@simplewebauthn/browser/dist/bundle")),
);

// Routes
app.use("/api/auth", authRoute);
app.use("/api/text", textRoute);
app.use("/api/mouse", mouseRoute);
app.use("/api/guest", guestRoute);
app.use("/api/webauthn", webauthnRoute);

// Home redirect
app.get("/", (req, res) => {
  if (req.session.userId) {
    res.redirect("/dashboard.html");
  } else {
    res.redirect("/login.html");
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Continuum server listening on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});
// node as PID 1 ignores SIGTERM unless it is handled: without this, every stop waited out the timeout.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
