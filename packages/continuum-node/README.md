# @continuum/node

Server-side enforcement SDK for **Continuum**. The behavioral CA service (the
Policy Decision Point) signs every verdict as a short-lived HS256 **risk token**.
This library lets a host application's backend (the Policy Enforcement Point)
**verify** that token and **block** sensitive actions when the user's live
behavior looks suspicious — without ever trusting the browser.

This is the enforcement half of the drop-in: pair it with the client
`guard.js`, which captures behavior and carries the risk token.

## Install

Dependency-free (Node's built-in `crypto`). In this monorepo it's referenced by
path; published it would be `npm i @continuum/node`.

## Use

```js
const { createGuard } = require("@continuum/node");
const guard = createGuard({ secret: process.env.CONTINUUM_SECRET }); // == CA_SIGNING_SECRET

// Gate a sensitive route. The client sends the latest risk token as the
// `X-Continuum-Risk` header (or `riskToken` in the JSON body).
app.post("/money/transfer", guard.requireTrusted, (req, res) => {
  // req.continuum = { userId, risk:"genuine", modality, issuedAt, expiresAt }
  res.json({ ok: true });
});
```

Responses from `requireTrusted`:
- **401** `continuum_risk_invalid` — missing / bad signature / expired token, or not a verdict at all
  (`not_a_verdict`: an identity assertion or a pushed event; `no_expiry`: a token without `exp`)
- **403** `step_up_required` (`requiresStepUp: true`) — verdict was `suspicious`
- otherwise `next()` with `req.continuum` populated

`requireVerified` does the same but also refuses a `warmup` verdict (the typing or movement has not been judged
yet) with **403** `verdict_pending` (`requiresStepUp: false`: keep typing or moving, no passkey needed). Use it on
actions that must never run before a real verdict, such as moving money or changing the e-mail address.

### Options
| Option | Default | Meaning |
|---|---|---|
| `secret` | `process.env.CONTINUUM_SECRET` | HMAC secret, must equal the CA service's `CA_SIGNING_SECRET` |
| `clockSkewSec` | `5` | Allowed expiry skew |
| `blockWarmup` | `false` | Also reject `warmup` verdicts (insufficient evidence) |

### Low-level
```js
const v = guard.verify(token); // { ok, userId, risk, modality, issuedAt, expiresAt }
```

### Sign-in for the Continuum Guard browser extension

The one-line form (`app.use(require("@continuum/node")({ secret }))`) also serves
`GET /continuum/link`. It lets your users sign in to the Continuum Guard
extension with their account on **your** site, so the extension uses the same
Continuum user (and the same enrolled samples) as your app:

1. In the Continuum console (`<gateway>/console.html`), allow the extension for
   your organisation and give `https://your-app.com/continuum/link` as its sign-in
   page.
2. Set `CONTINUUM_GATEWAY_URL` (or the `gatewayUrl` option) to the gateway's
   public address.

A user who is not signed in is sent to your login page first (`loginUrl`,
default `/login.html`, with `?next=/continuum/link?...`: return there after
login). A signed-in user is sent back to the gateway with an identity token
bound to that one sign-in and valid for 2 minutes. The extension never sees
the password or your secret. Options: `gatewayUrl`, `loginUrl`, `userName`
(`req => display name`; default: `req.user.email`/`name`, `req.session.username`).

## Why signed tokens
An attacker can simply not run the client SDK. Enforcement must therefore live
on the server and rest on a signature the client cannot forge. The token is
short-lived (~90 s) so a captured "genuine" verdict can't be replayed later.
