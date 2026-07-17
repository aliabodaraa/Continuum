// ============================================================================
//  A COMPLETE consumer app that adopts Continuum.
//  Everything Continuum-related is marked ★ — there are only THREE such lines.
//  Everything else is just "your app" (you already have it).
//
//  Run:  CONTINUUM_SECRET=<your tenant secret> node express-consumer.js
// ============================================================================
const express = require("express");
const session = require("express-session");

// ★ 1) Initialize Continuum — ONE call. No createGuard, no crypto, no endpoint.
//      You only tell it your secret + how to read YOUR logged-in user.
const continuum = require("@continuum/node")({
  secret: process.env.CONTINUUM_SECRET,      // your tenant secret (from registration)
  user: (req) => req.session.userId,         // how to read YOUR logged-in user
});

const app = express();
app.use(express.json());
app.use(session({ secret: "your-own-session-secret", resave: false, saveUninitialized: true }));

// ★ 2) Turn it on — serves /continuum/identity so the SDK can learn who's logged in.
app.use(continuum);

// ---- your app's own code (nothing to do with Continuum) --------------------
app.post("/login", (req, res) => {           // YOUR login sets YOUR session
  req.session.userId = req.body.userId;
  res.json({ ok: true });
});

app.get("/", (req, res) =>                    // YOUR page — plus one script tag
  res.type("html").send(`
    <h1>My App</h1>
    <textarea placeholder="type here…" style="width:400px;height:120px"></textarea>
    <button onclick="save()">Transfer</button>
    <script>
      async function save() {
        const r = await fetch("/transfer", { method: "POST",
          headers: { "Content-Type": "application/json", ...(window.Continuum ? Continuum.riskHeader() : {}) } });
        alert(r.status === 200 ? "done" : "blocked (" + r.status + ")");
      }
    </script>
    <!-- ★ 3) the SDK: onboarding + guard + step-up, all injected -->
    <script src="https://<your-gateway>/guard.js"
            data-site-key="pk_live_xxx"
            data-identity-url="/continuum/identity"></script>
  `));

// ★ (the 3rd line) Protect a sensitive action — genuine passes, suspicious → 403.
app.post("/transfer", continuum.protect, (req, res) => {
  res.json({ ok: true, verifiedUser: req.continuum.userId });
});

app.listen(3000, () => console.log("consumer app on http://localhost:3000"));
