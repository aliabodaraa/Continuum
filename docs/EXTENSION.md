# Continuum Browser Extension — Design

A Chrome (MV3) extension that applies Continuum's continuous authentication to the
**whole browser**, not a single web app. It binds identity to the **browser profile**,
enrolls the user's typing/mouse rhythm once, monitors every page, and on a suspicious
change performs a **step-up bound to Continuum itself** (a platform passkey via a fixed
Continuum relying party — "Option B"), since a website's own passkey can't be reused
browser-wide.

> Status: design. Nothing here is built yet; this is the spec + build plan.

## 1. Why the backend doesn't change
Continuum already separates **capture/transport** (thin, per-surface) from
**intelligence** (server-side models + verdicts + protocol). The extension is a new
capture surface: it re-implements only the browser-side layer and feeds the **same
event schema** to the **same** `gateway → ca-service → model-api`. No model or
verdict-pipeline changes.

| Piece | Reused as-is | New for the extension |
|---|---|---|
| Keystroke/mouse models + per-user training (`model-api`) | ✅ | |
| Verdict pipeline — warmup, probation, paste policy (`ca-service`) | ✅ | |
| Verdict signing RS256/JWKS, tenant/identity protocol (`gateway`) | ✅ | |
| Capture (keystroke/mouse) | logic reused | re-packaged as a bundled content script |
| Identity | protocol reused | sourced from the **browser profile**, not a web-app session |
| Step-up | `requireStepUp(modality)` reused | new **platform-passkey** modality bound to a fixed Continuum RP |

## 2. Components (MV3)
```
extension/
├── manifest.json          # MV3, host_permissions: <all_urls>, minimal perms
├── background.js          # service worker: session state, talks to the gateway, verdict loop
├── content.js             # injected on every page: keystroke/mouse capture (timing only)
├── popup/                 # setup + status UI (enroll, on/off, exclusions)
└── stepup.html            # a page under a FIXED Continuum origin used as the WebAuthn RP
```
- **content script** (`<all_urls>`): captures keydown/keyup + mouse events, extracts
  **timing features only**, posts them to the background worker. Never sends typed text.
- **background service worker**: holds the rolling session, batches events to the
  gateway's `/v1/sdk/*` endpoints, applies verdicts, triggers step-up.
- **popup**: first-run onboarding (collect enrollment samples), and an on/off + per-site
  exclusion list + status ("verified / analyzing / locked").

## 3. Identity = the browser profile
- `chrome.identity.getProfileUserInfo({ accountStatus: "ANY" })` → the signed-in Chrome
  profile's email/id. If not signed in, fall back to a per-profile random id persisted in
  `chrome.storage.local`.
- The extension sends this as its **externalId** (or a backend-verified token) to the
  gateway, which maps it to the same deterministic `continuumUserId`. So the identity is
  **stable across every site** — exactly the point of a browser-wide guard.
- The extension is its own **tenant** (a dedicated site key + secret), whose registered
  origin is the fixed Continuum step-up origin (see §5). The site key/secret live in the
  extension's packaged config / `chrome.storage`, provisioned once at install.

## 4. Onboarding (once, at setup)
1. On install, the popup runs the same enrollment flow as the SDK wizard: collect typing
   samples (a passage) + mouse samples (move + ≥10 clicks).
2. Samples → `ca-service` per-user training → the profile model. Identity = the browser
   profile, so the model belongs to "this profile".
3. Also registers the **step-up passkey** (§5) so a challenge can be answered later.

## 5. Step-up — Option B: a passkey bound to Continuum (not the visited site)
A website's passkey is bound to **that site as the Relying Party**, so it can't verify the
user on `bank.com` while they're on `mail.com`. Solution: make **Continuum the RP**.
- The extension opens a small window/tab to a **fixed Continuum origin**
  (e.g. `https://auth.continuum.app/stepup.html`) which runs `navigator.credentials.get()`
  with `rpId = auth.continuum.app`. The platform authenticator (Windows Hello / Touch ID)
  prompts. The passkey is bound to **Continuum**, works from any page.
- Flow on a suspicious verdict:
  1. background worker gets `requiresPasskeyChallenge` from the gateway.
  2. it opens the Continuum step-up window; the user completes Windows Hello / Touch ID.
  3. the assertion is verified by `passkey-service` (RP = the fixed Continuum origin);
     on success the gateway clears the lock (`/v1/lock/clear`) and monitoring resumes.
- **Fallback (Option A):** if no platform authenticator is available, prompt for a
  password set at install, verified **server-side** (hashed in `ca-service`). Weaker, but
  always works. The `requireStepUp(modality)` abstraction already supports multiple modes.

## 6. Browser-wide monitoring & privacy (the critical part)
Capturing input on **every** site (banking, email, other passwords) is sensitive. Design
guarantees:
- **Timing only, never content.** The model uses digraph *timings*
  (`[id1,id2,dwell1,dwell2,dd,ud]`), not the typed text. The content script extracts
  features and discards characters; password fields are masked (already in the SDK).
- **Explicit consent** at install; a clear on/off toggle.
- **Per-site exclusion list** (e.g. never run on a bank's domain) + a global pause.
- No raw keystroke text ever leaves the browser → a strong, defensible privacy story:
  *"Continuum observes how you type, never what you type."*

## 7. MV3 constraints
- **No remote code:** bundle the capture libs (`keystroke-tracker.js`, mouse features)
  into the extension package — can't `loadScript` from the gateway like the web SDK does.
- **Service worker** (not a persistent background page): keep session state in
  `chrome.storage`/memory with re-hydration on wake.
- **Permissions:** `host_permissions: ["<all_urls>"]`, `identity`, `storage`, `scripting`.
  Justify `<all_urls>` in the store listing (continuous auth needs cross-site capture).

## 8. Data flow (per session)
```
content.js (every tab) ──timing features──▶ background.js
background.js ──batch──▶ gateway /v1/sdk/keystroke|mouse/check  (identity = browser profile)
gateway ──▶ ca-service ──▶ model-api  → verdict (RS256)
verdict suspicious ──▶ background opens Continuum step-up (Windows Hello) ──▶ passkey-service verifies
                    └─ genuine ──▶ keep monitoring
```

## 9. Build plan (phases)
1. **P0 — skeleton:** manifest, background worker, content script that captures timing and
   logs it. Prove capture works on arbitrary pages.
2. **P1 — identity + enrollment:** `chrome.identity` → gateway session; onboarding popup
   collects samples → trains the profile model.
3. **P2 — monitoring loop:** batch → gateway checks → surface "verified/analyzing" in the popup.
4. **P3 — step-up (Option B):** fixed-RP passkey page + Windows Hello; lock/clear wired to
   the existing shared lock. Password fallback (Option A).
5. **P4 — privacy controls:** exclusion list, consent screen, pause; store-listing polish.

## 10. Open questions / risks
- WebAuthn from an extension-opened window on a fixed RP domain — confirm the platform
  authenticator UX across Chrome/Edge (should work; the RP is a normal https origin).
- Hosting the fixed step-up origin (`auth.continuum.app`) — for the thesis demo this can be
  the gateway itself on a stable dev origin.
- Performance of `<all_urls>` capture on heavy pages — throttle/batch in the content script.
- Store review for `<all_urls>` + `identity` — needs a clear privacy justification.
