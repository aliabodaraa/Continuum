# Continuum Guard — browser extension

Continuous authentication on every website: the extension records how you type and move the mouse,
and your **Continuum server** decides whether it is still you. When the server asks for a step-up,
every tab locks until you verify with your passkey.

The extension is a client of the server, exactly like a website that embeds the SDK (`sdk/guard.js`).
It scores nothing itself. The earlier on-device version (TensorFlow.js models in the browser,
samples tied to the Chrome Google account) is kept as git tag `extension-on-device-v1`; the thesis's
on-device experiments (G, I) were run with it.

## Who uses it, and how they sign in

A **tenant** is an organisation or an app, never a person. People sign in to a tenant:

| | Who | How they sign in |
|---|---|---|
| **Personal** | someone with no organisation | a Continuum account (email + passkey), on the gateway's built-in `pk_personal` tenant |
| **Organisation** | a user of an app or company that runs Continuum (e.g. the demo) | "Sign in with my organisation": the organisation code (its site key), then **its own** sign-in page |
| **Research study** | a study participant | set by the experimenter on the settings page: see [`STUDY_MODE.md`](STUDY_MODE.md) |

Sign-in is OAuth 2.0's authorization-code flow with PKCE, the gateway being the authorization server
(`services/gateway/server.js`, "EXTENSION SIGN-IN"). The extension never sees a password or a tenant
secret: it keeps only a refresh token, revoked at sign-out. An organisation's user who already enrolled
in the organisation's app is the **same** Continuum user in the extension, so their samples are reused.
A passkey, though, belongs to the website it was made on: step-ups run on the gateway's pages, so such a
user adds one passkey there, once, at the first enrolment.

Organisations register themselves in the **developer console** (`<gateway>/console.html`): they get a
site key and a secret, list their websites, may allow the extension (giving the address of their
sign-in page for it: `/continuum/link` with `@continuum/node`), and wait for the operator's approval.
The operator (whoever runs the gateway) approves or revokes them on `<gateway>/operator.html`, which
opens only on the gateway's own machine and signs in with `GATEWAY_ADMIN_KEY`.

## What leaves the browser

- **Typing:** the tail of key events (key codes and timings, up to 1,400) at each new window, and the
  typed length. The text is not sent as text, but the order of key codes is, and it could be rebuilt.
- **Mouse:** numbered windows of movement features, every 1.6 s while the pointer moves.
- **Never:** anything from a password field (no event at all), hidden fields, excluded sites, or
  anything while recording is paused (popup, or Alt+Shift+P).

## Load it (unpacked)

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → this `extension/` folder.
2. The settings page opens. Check the server address (`http://localhost:8080` for the local stack),
   then choose **Personal** or **My organisation**.
3. Enrolment opens by itself (passkey, five typing samples, eight mouse samples) and trains on the server.
4. The popup then shows the live verdict of each channel (it can be hidden in the settings).

The toolbar icon (Chrome allows one badge, so with the live verdict shown the icon itself becomes **two bars**):
**left = typing, right = mouse**. Each fills while the page collects evidence (typing: 20 windows, about 240
keystrokes; mouse: 60 windows, about 17 s of movement), then turns **green** when the server says it is you or
**red** when suspicious; hovering shows both counts. The logo comes back with a badge for **🔒** locked, **II**
paused, **REC** the research study, **•** recording with the live verdict hidden, and on pages that cannot be
recorded (Chrome's own pages, the extension's pages, the gateway).

An unpacked extension's id depends on its folder. The gateway must know it (`CONTINUUM_EXTENSION_ID` in
`continuum/.env`) for the personal and demo tenants to admit the extension; the settings page shows it.

## Layout

```
manifest.json          MV3; storage, tabs, scripting; <all_urls>
src/features.js        keystroke windowing (same windows as ca-service), to know when a new window formed
src/features-mouse.js  mouse windows (same features as the SDK and ca-service)
src/content.js         capture on every page; the lock overlay; relays the gateway pages' results
src/background.js      the session with the gateway, checks, verdicts, lock, sign-in (PKCE), badge
src/options.*          settings: sign in / out, display, research study
src/popup/             account, live verdict, pause, per-site exclusion
scripts/e2e_headless_connect.mjs   sign-in, console and security checks (headless Chrome)
scripts/e2e_headless_study.mjs     the research study end to end (headless Chrome)
```

## Tests

Both run against the local stack in a throwaway headless Chrome profile and clean up after themselves:

```
node extension/scripts/e2e_headless_connect.mjs
# study logging is on in the cluster (STUDY_LOGGING: "1" in deploy/k8s/overlays/local/local-urls.yaml); under Compose:
#   STUDY_LOGGING=1 docker compose up -d --no-deps ca-service
node extension/scripts/e2e_headless_study.mjs
```
