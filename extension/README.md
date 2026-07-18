# Continuum Guard — browser extension

Browser-wide continuous authentication (see `../docs/EXTENSION.md` for the full design).
Cross-browser via the standard WebExtensions API (`browser`/`chrome`). This folder is the
**P0 skeleton**: it proves on-device capture works across every site.

## What P0 does
- Injects a content script on **every page** that captures keystroke **timing** and builds
  digraph feature windows `[id1, id2, dwell1, dwell2, dd, ud]` **on-device**, in the exact
  format the Continuum model scores (`src/features.js` mirrors the server).
- Forwards only finished **windows** (timing numbers) to the background worker — the typed
  **characters never leave the page**. Password fields are key-masked; hidden fields ignored.
- A **popup** shows live status, a windows-captured counter, an **on/off** toggle, and a
  per-site **exclude** control (all persisted).

Nothing is sent to any server yet — this phase is pure local capture.

## Load it (unpacked)
**Chrome / Edge / Brave:**
1. Go to `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Open any site, type a few sentences, click the toolbar icon → watch **Windows captured** climb.

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**.
2. Select `extension/manifest.json`.
3. Same test.

Verify: typing raises the counter; toggling **off** stops it; **Exclude this site** stops
capture on that origin only.

## Layout
```
manifest.json            # MV3, <all_urls>, cross-browser (browser_specific_settings for Firefox)
src/features.js          # on-device digraph windowing (mirrors ca-service/lib/keystrokeSecurity.js)
src/content.js           # capture on every page; mask passwords; exclusions; emit windows only
src/background.js        # aggregate windows, hold config, serve the popup (scoring plugs in at P2)
src/popup/               # status + on/off + per-site exclusion
```

## Roadmap (from docs/EXTENSION.md)
- **P0 (this):** skeleton + on-device capture. ✅
- **P1:** per-profile identity + onboarding (collect samples → train the user's model server-side).
- **P2 (on-device scoring): built.** The background worker loads the TF.js runtime
  (`vendor/tf.min.js`) + the graph model (`model/ws50-gru/`), scores each window, and applies
  the Lu et al. packet vote (`src/scoring.js`) → live verdict in the popup. Verified: model
  runs via `executeAsync` (GRU has a dynamic loop op), valid softmax, ~80 ms/window on the CPU
  backend; decision logic unit-tested. **Next (P1):** swap the base model for the user's
  personalised one after enrollment — same loop, just a different `ContinuumScoring.load()`.
- **P3:** step-up — Windows Hello / Touch ID via a fixed Continuum relying-party page (Option B).
- **P4:** consent screen, richer exclusions, store-listing polish.

## Privacy
The model authenticates by **how** you type (timing), never **what** you type. Scoring is
**on-device** (P2), so keystrokes/verdicts don't stream to a server; only enrollment (once) and
the step-up passkey handshake use the network. See `../docs/EXTENSION.md` §6.
