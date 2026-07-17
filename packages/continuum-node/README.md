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
- **401** `continuum_risk_invalid` — missing / bad signature / expired token
- **403** `step_up_required` (`requiresStepUp: true`) — verdict was `suspicious`
- otherwise `next()` with `req.continuum` populated

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

## Why signed tokens
An attacker can simply not run the client SDK. Enforcement must therefore live
on the server and rest on a signature the client cannot forge. The token is
short-lived (~90 s) so a captured "genuine" verdict can't be replayed later.
