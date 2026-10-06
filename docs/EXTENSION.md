# Continuum Browser Extension — Design

A **cross-browser** (WebExtensions / MV3) extension that applies Continuum's continuous
authentication to the **whole browser**, not a single web app. It binds identity to the
**browser profile**, enrolls the user's typing/mouse rhythm once, monitors every page, and
on a suspicious change performs a **step-up bound to Continuum itself** (a platform passkey
via a fixed Continuum relying party — "Option B"), since a website's own passkey can't be
reused browser-wide.

**Browser support:** one codebase targets Chromium (Chrome, Edge, Brave, Opera) **and**
Firefox by using the standard `browser.*` WebExtensions API with the `webextension-polyfill`.
Safari supports Web Extensions too but requires an Xcode app wrapper — a later target. We
therefore avoid Chrome-only APIs (e.g. `chrome.identity`'s Google profile) — see §3.

> Status (2026-09-29): this was the original design. What was built differs: the extension is now a
> client of the Continuum server only (no on-device scoring, no browser-profile identity). People sign
> in with a personal Continuum account or their organisation's account (OAuth code flow with PKCE via
> the gateway), and the step-up runs on the gateway's own pages. The current design is in
> [`extension/README.md`](../extension/README.md); the on-device version is git tag `extension-on-device-v1`.

## 1. What the backend reuses (and the one addition)
Continuum already separates **capture/transport** (thin, per-surface) from
**intelligence** (server-side models + verdicts + protocol). The extension is a new
capture surface: it re-implements only the browser-side layer and feeds the **same
event schema** to the **same** `gateway → ca-service → model-api`. The verdict pipeline,
signing, and identity protocol are **unchanged**; the only backend addition is a
**timing-only model variant** for privacy (§6).

| Piece | Reused as-is | New for the extension |
|---|---|---|
| Verdict pipeline — warmup, probation, paste policy (`ca-service`) | ✅ | |
| Verdict signing RS256/JWKS, tenant/identity protocol (`gateway`) | ✅ | |
| Per-user training + serving (`model-api`) | ✅ mechanism | + a **timing-only model** variant (no key codes) |
| Capture (keystroke/mouse) | logic reused | re-packaged as a bundled content script |
| Identity | protocol reused | a **per-profile key**, not a web-app session (§3) |
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

## 3. Identity = the browser profile (portable across browsers)
- On first run the extension generates a **per-profile key** and stores it in
  `browser.storage.local` — a stable identifier for *this* browser profile. Works
  identically on every browser (no Chrome-only `chrome.identity` / Google account).
- Optionally the user signs into a **Continuum account** in the popup, so the identity (and
  trained model) follows them across devices/browsers; otherwise it stays per-profile local.
- The extension sends this as its **externalId** (or a backend-verified token) to the
  gateway, which maps it to the same deterministic `continuumUserId`. So the identity is
  **stable across every site** — exactly the point of a browser-wide guard.
- The extension is its own **tenant** (a dedicated site key + secret), whose registered
  origin is the fixed Continuum step-up origin (see §5). The site key/secret live in the
  extension's packaged config / `browser.storage`, provisioned once at install.

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
Capturing input on **every** site (banking, email, other passwords) is sensitive, so the
extension's privacy stance must be **stronger than the web SDK's**. The goal: authenticate
by *rhythm* (how you type) and never by *content* (what you type).

- **What "timing features" means:** instead of the letters, the extension keeps
  measurements — key hold time (dwell) and the gaps between keys (flight). These numbers
  describe your rhythm, like recognizing someone by their gait.
- **Password masking:** on password fields the characters are never captured at all.
- **Per-site exclusions:** the user can exclude sites (e.g. their bank) — nothing is
  captured there — plus a global pause.
- **Explicit consent:** the user knowingly opts in at install; monitoring is never silent.

### Honest caveat + the fix (timing-only model)
Today's feature vector is `[id1, id2, dwell1, dwell2, dd, ud]` where `id1/id2` are **key
codes** (which keys). So the raw feature stream *could* reconstruct text — acceptable for the
web SDK (the host app already sees its own textarea) but **not** for a browser-wide monitor
watching other sites. To make *"never what you type"* literally true here, the extension
should use a **timing-only model** (drop the key ids → only dwell/flight timings), so content
is unrecoverable by construction. Cost: a retrained timing-only variant and a possible small
accuracy trade-off (key identity carries some signal). This is the privacy-correct default
for the extension; the key-code model stays for the web SDK where content isn't newly exposed.

## 7. MV3 & cross-browser constraints
- **One codebase:** write against the standard `browser.*` API + `webextension-polyfill`;
  it runs on Chromium and Firefox MV3. Safari via the Xcode Web Extension converter (later).
- **No remote code:** bundle the capture libs (`keystroke-tracker.js`, mouse features)
  into the extension package — can't `loadScript` from the gateway like the web SDK does.
- **Service worker** (not a persistent background page): keep session state in
  `browser.storage`/memory with re-hydration on wake.
- **Permissions:** `host_permissions: ["<all_urls>"]`, `storage`, `scripting`. (No `identity`
  permission — identity is a local per-profile key, §3.) Justify `<all_urls>` in each store
  listing (continuous auth needs cross-site capture; only timing is collected).

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
2. **P1 — identity + enrollment:** per-profile key (`browser.storage.local`) → gateway
   session; onboarding popup collects samples → trains the (timing-only) profile model.
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
