# Continuum Client SDK

The **customer-facing** browser SDK. Every consumer app loads `guard.js` from the
Continuum **gateway** (which serves this folder) — it is *not* part of any single
app. This is the single source of truth for the client bundle.

```
sdk/
├── guard.js                              # the SDK (drop-in)
├── js/keystroke-tracker.js               # keystroke capture (window.continuumKeystrokes)
├── js/mouse-features.js                  # mouse feature windows (window.mouseFeatures)
└── vendor/simplewebauthn/index.umd.min.js # WebAuthn browser lib
```

## Use (consumer app, any backend)
```html
<script src="https://<gateway>/guard.js"
        data-api-base="https://<gateway>"
        data-site-key="pk_live_…"
        data-defer="1"></script>
<script>
  // after your own login, hand the SDK a backend-signed identity token
  Continuum.identify(tokenMintedByYourBackend);
</script>
```
`guard.js` self-loads the two capture modules + the WebAuthn lib from the same
origin, injects the onboarding wizard + guard + step-up (Shadow DOM), and talks
only to the gateway. See the gateway + `@continuum/node` for the server side.

## Served by
- **Gateway** (`services/gateway`) → mounts this folder at `/app/sdk-public`; this
  is the URL customers load.
- **Demo app** (`apps/demo`) also mounts it (`/app/sdk-assets`) so its own pages
  use the same libs — no duplication.
