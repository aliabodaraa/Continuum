continuum — Complete Implementation Summary

# What's Been Built

1. ✅ SimpleWebAuthn Passkey Integration
   - Full registration flow (attestation)
   - Full authentication flow (assertion)
   - Challenge-response protocol
   - Signature verification
   - Replay attack prevention (counter checking)

2. ✅ Extended Database Schema
   - passkey_credentials: stores user's passkey public keys
   - webauthn_challenges: manages temporary challenges (5-min expiry)
   - keystroke_texts: now tracks model_confidence & is_suspicious
   - keystroke_events: unchanged, stores individual key timings

3. ✅ Conditional Passkey Trigger
   - Keystroke text submission → model prediction
   - If confidence < 50%: mark as suspicious
   - Trigger passkey challenge on suspicious detection
   - Passkey verification required to continue session
   - Live statistics & history with confidence metrics

# Tech Stack Updates

Dependencies Added:

- @simplewebauthn/server@8.3.5 (attestation/assertion verification)
- @simplewebauthn/browser@8.3.5 (browser WebAuthn API wrapper)
- uuid@9.0.1 (for credential IDs)

Removed:

- fido2-lib (replaced with SimpleWebAuthn)

# Database Tables

1. users
   - id, username, password_hash, email, created_at

2. passkey_credentials
   - id, user_id, credential_id, public_key, counter, transports, created_at
   - Stores user's registered passkey credentials

3. keystroke_texts
   - id, user_id, text_content, keystroke_timings, model_confidence, is_suspicious
   - Tracks each submission + model decision

4. keystroke_events
   - id, keystroke_text_id, key_code, event_type, timestamp_relative
   - Individual keystroke timing data

5. webauthn_challenges
   - id, user_id, challenge, challenge_type, created_at, expires_at, used
   - Temporary challenges for passkey verification (expires in 5 mins)

# API Endpoints

Authentication

- POST /api/auth/register — Register with password
- POST /api/auth/login — Login with password
- POST /api/auth/logout — Logout
- GET /api/auth/me — Get current user

Text & Keystroke Submission

- POST /api/text/submit — Submit text + keystroke events (triggers model prediction + passkey check)
- GET /api/text/history — Get user's submissions with confidence scores
- GET /api/text/stats — Get aggregated stats (submissions, suspicious count, avg confidence)

Passkey Registration

- POST /api/webauthn/register/options — Get registration options
- POST /api/webauthn/register/complete — Verify & store passkey credential

Passkey Authentication (triggered on suspicious behavior)

- POST /api/webauthn/auth/options — Get challenge for passkey verification
- POST /api/webauthn/auth/complete — Verify passkey assertion

# Frontend Features

Dashboard (dashboard.html)

- Keystroke sample submission textarea
- Live keystroke event capture (keydown/keyup)
- Model confidence display
- Suspicious behavior warning
- Passkey registration button
- Passkey challenge modal (triggered on suspicious detection)
- Statistics dashboard (submissions, suspicious count, avg confidence, total chars)
- Submission history with confidence badges

# Passkey Flow

Registration:

1. User clicks "Register Passkey" button
2. Server generates registration options (challenge, RP ID, etc.)
3. Browser prompts for authenticator (fingerprint, face, PIN, etc.)
4. User completes registration on device
5. Server verifies attestation & stores credential

Authentication (triggered when keystroke model detects anomaly):

1. Model outputs confidence < 50% during keystroke submission
2. Dashboard detects is_suspicious=true
3. Modal opens: "Passkey Verification Required"
4. User clicks "Verify with Passkey"
5. Server generates authentication challenge
6. Browser prompts for passkey verification
7. Server verifies assertion & updates credential counter
8. Session secured, user continues

# Keystroke → Passkey Logic

```
User submits text with keystroke events
  ↓
/api/text/submit processes:
  1. Extract keystroke events (keydown/keyup with timestamps)
  2. Call model prediction endpoint (if available)
  3. Get model confidence (0-1)
  4. If confidence < 0.5:
       → is_suspicious = true
       → Check if user has passkeys registered
       → If yes: set requiresPasskeyChallenge = true
  5. Store in database
  ↓
Response includes: modelConfidence, isSuspicious, requiresPasskeyChallenge
  ↓
If requiresPasskeyChallenge:
  → Show warning message
  → Open passkey challenge modal
  → Trigger /api/webauthn/auth/options
  → User completes passkey verification
  → /api/webauthn/auth/complete finalizes session
```

# How to Run

Prerequisites:

- Node.js 14+
- npm
- Python 3.8+ (for model training)

Step 1: Install Dependencies

```bash
cd continuum/server
npm install
```

Step 2: Start Node.js Backend

```bash
npm start
# Opens http://localhost:3000
```

Step 3 (Optional): Start Python Model API

```bash
cd ../
pip install -r requirements.txt
python api.py
# Runs on http://localhost:5000
```

If Python API is not running:

- Keystroke model endpoint will return null confidence
- System assumes genuine user (confidence = 1.0)
- No passkey challenge triggered (unless model is available)

# Browser Access

- http://localhost:3000 → Landing page
- http://localhost:3000/register.html → Sign up
- http://localhost:3000/login.html → Sign in
- http://localhost:3000/dashboard.html → Main dashboard (auth required)

# Testing Passkey Flow

1. Create account at /register.html
2. Login at /login.html
3. On dashboard, click "Register Passkey"
4. Authenticate with your device (biometric, PIN, security key, etc.)
5. Submit keystroke sample text (minimum 100 chars)
6. If model detects suspicious behavior (or model unavailable & confidence < 0.5):
   → Modal opens for passkey verification
   → Complete passkey authentication
   → Session secured
7. Check statistics to see confidence scores and suspicious flags

# Security Features

✅ Password Hashing (bcryptjs)
✅ WebAuthn Attestation Verification (SimpleWebAuthn)
✅ WebAuthn Assertion Verification (SimpleWebAuthn)
✅ Challenge-Response Protocol (replay attack prevention)
✅ Counter Checking (credential cloning prevention)
✅ Challenge Expiration (5 minutes)
✅ Session Management (express-session)
✅ Proper Credential Isolation (per-user)

# Performance Considerations

- Keystroke events captured in real-time (keydown/keyup)
- Model prediction is async (doesn't block UI)
- If model slow/unavailable: system gracefully defaults to genuine (confidence = 1.0)
- Passkey challenge modal non-blocking
- Database queries indexed by user_id

# Known Limitations & TODOs

1. Keystroke Feature Extraction (data_loader.py)
   - Currently: generic array loading
   - TODO: Extract actual dwell/DD/UD features as per Continuum spec

2. Model Input Format
   - Currently: simple event array
   - TODO: Properly reshape to (1, window_size, num_features) format

3. Threshold Configuration
   - Currently: hardcoded 0.5 (50% confidence threshold)
   - TODO: Make configurable per-user

4. Passkey Credential Backup
   - Currently: single credential per user
   - TODO: Support multiple registered authenticators

5. Database: SQLite → MySQL (for production)
   - Schema easily portable
   - SimpleWebAuthn works with any DB

# Next Phase: Keystroke Model Integration

1. Download Continuum HDF dataset
2. Run: python train.py --data-dir data/ --epochs 150
3. Convert model to TFJS or run Flask API
4. Test with /api/predict endpoint
5. Collect user keystroke data via dashboard
6. Retrain model on collected submissions
7. Benchmark model accuracy (accuracy, F1, FAR, FRR, EER)

# References

- SimpleWebAuthn Docs: https://simplewebauthn.dev/docs
- W3C WebAuthn Spec: https://www.w3.org/TR/webauthn-2/
- FIDO Alliance: https://fidoalliance.org/
- corbado/passkey-tutorial: https://github.com/corbado/passkey-tutorial
- Continuum Capstone (Elkoby & Gutchin, 2022)
- Lu et al. (2020): CNN+RNN keystroke authentication
