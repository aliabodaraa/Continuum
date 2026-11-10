continuum — Keystroke Dynamics Continuous Authentication

Based on:

- **Lu et al. (2020)**: _Continuous authentication by free-text keystroke based on CNN and RNN_
- **Continuum (2022)**: Capstone project by Elkoby & Gutchin implementing 1D CNN + 2LSTM architecture

Overview
A two-layer security system:

1. **Keystroke Dynamics Model** (1D CNN, max pooling and two GRU layers of 16 units, Lu et al. 2020): continuous behavioural monitoring with a personal copy of the base model for each user (the base and its leak-free test metrics: `artifacts/ws50-gru-v2/`)
2. **WebAuthn Passkeys**: Second-factor verification when suspicious behavior is detected

Architecture

- **Python**: Model training (Continuum architecture), data processing, Flask inference API
- **Node.js**: User registration/login, keystroke text collection, WebAuthn endpoints, dashboard
- **SQLite**: User data, keystroke submissions, keystroke timings
- **TensorFlow/Keras**: 1D CNN + 2GRU model (Lu et al. 2020)

Model Details

- **Architecture**: 1D Convolution (32 filters, kernel 2, valid padding) → max pooling (2) → GRU (16 units, sequences) → Dropout → GRU (16 units) → Dropout → Dense (softmax), Lu et al.'s (2020) best Buffalo setting; the base served since 2026-10-25 is `artifacts/ws50-gru-v2`
- **Window Size**: Default 50 (the Continuum/Lu et al. optimum)
- **Features per digraph step**: `[id1, id2, dwell1, dwell2, dd, ud]` — key codes /254, hold times of both keys, down-down and up-down flight times in seconds (verified against the `Rand_WS*.h5` files)
- **Preprocessing**: outlier clipping + z-score standardization (fit on train split only, stored in `artifacts/ws50-gru-v2/scaler.json` and reused for all realtime inference)
- **Evaluation**: leak-free group-aware split — the published `Rand_WS*.h5` files contain overlapping sliding windows in shuffled order, so a naive random split leaks near-duplicate windows into the test set and inflates accuracy. Windows sharing timing subsequences are grouped and never cross split boundaries (see `data_loader.py`).
- **Per-user models**: fine-tuned from the pre-trained base model (transfer learning) using the user's enrollment typing as positives and windows of 200 Aalto typists as negatives (since 2026-09-25).

Quick Start

Prerequisites

- Python 3.8+
- Node.js 14+
- pip, npm

Step 1: Setup Python Environment

```bash
cd continuum
python -m venv .venv
source .venv/bin/activate   # or .\.venv\Scripts\activate on Windows
pip install -r requirements.txt
```

Step 2: Download Continuum Dataset

```bash
# See download_instructions.md for manual download
# Or clone and copy:
mkdir -p data
git clone https://github.com/raf545/BioKey---Keystroke-dynamics-for-user-authentication.git temp_continuum
cp -r temp_continuum/Data_HDF_files/* data/
rm -rf temp_continuum
```

Step 3: Train the Model

```bash
# Local Python:
python train.py --data-dir data/ --window-size 50 --epochs 150 --output-dir artifacts/ws50

# Or via Docker (recommended):
docker compose --profile training run --rm trainer
```

Training writes `best_model.h5`, `final_model/`, `scaler.json` and `results.json`
(accuracy, F1, ROC-AUC, FAR/FRR/EER on the leak-free test split) into the output directory.

Step 4: Start Flask Inference API (optional)

```bash
python api.py
# Server runs on http://localhost:5000
```

Step 5: Setup Node.js Backend

```bash
cd server
npm install
npm start
# Server runs on http://localhost:3000
```

Step 6: Open in Browser
Navigate to http://localhost:3000

Workflow

1. **Register**: Create account at /register.html
2. **Login**: Authenticate with password at /login.html
3. **Dashboard**: Access protected dashboard at /dashboard.html
4. **Submit Text**: Type or paste long text (100+ chars) in the textarea
5. **Keystroke Capture**: Frontend captures keystroke events (keydown/keyup) with timestamps
6. **Data Storage**: Text + keystroke timings saved in SQLite database
7. **Model Training**: Use collected submissions to train/fine-tune the keystroke model
8. **Inference**: Model predicts user legitimacy on each keystroke window
9. **Passkey Trigger**: If prediction is "suspicious", trigger WebAuthn passkey verification
10. **Session Protection**: Legitimate user continues; intruder is locked out

File Structure

```
continuum/
├── data/                    # Continuum HDF dataset
├── artifacts/               # Trained models, metrics, TFJS exports
├── data_loader.py          # HDF loading, train/val/test split
├── model.py                # Keras CNN+RNN architecture
├── train.py                # Training script
├── api.py                  # Flask inference server
├── requirements.txt        # Python dependencies
├── server/
│   ├── app.js              # Express app with routes
│   ├── package.json        # Node dependencies
│   ├── model_adapter.js    # TFJS/proxy model loader
│   ├── db/
│   │   └── init.js         # SQLite schema
│   ├── routes/
│   │   ├── auth/
│   │   │   ├── auth.js     # Register, login, logout
│   │   │   └── text.js     # Text + keystroke submission
│   │   ├── predict.js      # Inference endpoint
│   │   └── webauthn.js     # Passkey endpoints
│   └── public/
│       ├── index.html      # Landing page
│       ├── register.html   # Registration form
│       ├── login.html      # Login form
│       └── dashboard.html  # Text submission + keystroke capture
```

API Endpoints

Authentication

- `POST /api/auth/register` — Register new user
- `POST /api/auth/login` — Login user
- `POST /api/auth/logout` — Logout user
- `GET /api/auth/me` — Current user info

Text & Keystroke

- `POST /api/text/submit` — Submit text + keystroke data
- `GET /api/text/history` — View user's submissions

Model Inference

- `POST /api/predict` — Get keystroke prediction (genuine/suspicious)

WebAuthn (Skeleton)

- `POST /api/webauthn/register/options` — Start passkey registration
- `POST /api/webauthn/auth/options` — Start passkey authentication

Data Collection

The dashboard captures:

- **Text content**: Long text typed or pasted by user
- **Keystroke events**: keydown/keyup with relative timestamps
- **Timing analysis**: Average dwell time, flight time, event count
- **Metadata**: Submission time, user ID

Data is stored in SQLite:

- `users`: username, hashed password
- `keystroke_texts`: text content, aggregated timings
- `keystroke_events`: individual key events with timestamps

Next Steps

1. **Data Collection Phase** (Week 1-2):
   - Users register and submit keystroke samples
   - Collect 50-100+ submissions per user
   - Each submission should be 200+ characters

2. **Model Training** (Week 3):
   - Use collected submissions + Continuum HDF data
   - Train CNN+RNN for user identification / authenticity
   - Evaluate FAR, FRR, EER metrics

3. **Integration** (Week 4):
   - Wire trained model to `/api/predict` endpoint
   - Implement continuous monitoring on dashboard
   - Trigger passkey verification for suspicious behavior

4. **Evaluation**:
   - Test model accuracy on validation set
   - Measure passkey trigger frequency
   - Compare with Lu et al. (2020) baseline

Troubleshooting

**Model loading fails**

- Ensure Continuum HDF files are in `continuum/data/`
- Check file paths and HDF structure with `h5py`

**Node server can't reach Python API**

- Ensure Flask is running: `python api.py`
- Check connection: `curl http://localhost:5000/health`

**Database errors**

- Delete `continuum/server/db/continuum.db` and restart to recreate schema
- Ensure proper SQLite permissions

Session Lock & Step-Up Enforcement

A passkey step-up challenge (triggered by suspicious keystroke or mouse behavior)
must not be escapable by simply reloading or navigating away — otherwise an
impostor mid-challenge could just refresh the page and keep going.

- **apps/demo**: its own `passkeySetupGate` middleware (`apps/demo/app.js`) checks
  `continuousAuthLocked` on every request. Reloading (or navigating to) any page
  other than `/dashboard.html` while locked now destroys the session and redirects
  to `/login.html`, instead of the previous behavior of just bouncing to the
  dashboard. Dashboard keeps its own in-place recovery UI (a banner + "Verify with
  Passkey" button).
- **Any other app** (e.g. `apps/acme`, or a real customer integration via SDK +
  middleware only) has no server-side gate of its own — the SDK's in-memory lock
  resets on every page load, so nothing previously caught this case. Fixed with a
  **shared, persisted lock in ca-service** (`services/ca-service/lib/lock.js`,
  `session_locks` table), which is the single source of truth regardless of which
  app or which modality (keystroke/mouse) triggered the challenge:
  - ca-service sets it directly when keystroke's own check/submit decides a
    challenge is required; the gateway and apps/demo set it explicitly for mouse,
    since that modality's consecutive-strike debounce lives in each caller, not in
    ca-service.
  - Cleared on a verified passkey step-up, in both the gateway
    (`/v1/sdk/passkey/auth/complete`) and apps/demo (`webauthn.js`).
  - Endpoints: `POST /v1/lock/set`, `POST /v1/lock/clear`,
    `GET /v1/lock/status/:userId` (ca-service, internal); `GET /v1/sdk/lock/status`
    (gateway, auth-gated, the one any consumer's SDK instance actually calls).
  - `sdk/guard.js`'s gateway-mode bootstrap (`gatewayFlow()`) checks this on every
    page load and logs out immediately if locked, before onboarding or monitoring
    starts.
- **Framework-agnostic by construction**: the SDK talks to the gateway over
  HTTP/JSON, and the gateway is the only thing that talks to ca-service/passkey-
  service — none of this depends on the consumer's backend language. An
  integrating app that wants an `×` on the mandatory windows names its own sign-in
  page with `data-login-url` (and `data-logout-url` if signing out needs a call);
  with none named there is no `×`, and the passkey is the way out. Continuum has no
  session of its own to destroy in gateway mode, only the host app's.
- **One logout path**: cancelling the mandatory step-up modal's `×` and a mandatory
  onboarding wizard step's `×` call the same `doLogout()` in `guard.js` (POST
  `cfg.logoutUrl` if the page names one, then redirect to `cfg.loginUrl` regardless
  of the response). A page that opens on a locked account shows the passkey prompt
  and does not sign the user out: the lock outlives the sign-in.

Mouse Enrollment: Server-Side Click Enforcement

The mouse feature vector includes `is_click`, so enrollment needs real clicks, not
just movement, or the model never learns click dynamics. The onboarding wizard and
"add more sessions" popup already gated their submit button on ≥10 real clicks, but
`ca-service`'s `/v1/mouse/enroll` never verified this itself — a request that
bypassed the popup (e.g. calling the endpoint directly) could train on
movement-only windows. `services/ca-service/lib/mouse.js` now reconstructs the
real click count from the overlapping enrollment windows (they overlap by stride,
so naively summing `is_click` across all of them would overcount) and rejects
enrollment below the threshold with a 422, regardless of the caller.

The enrollment/reinforcement popup itself (`sdk/guard.js`) was also reworked: a
larger pad (150px → 260px) and a single click target that jumps to a new random
position after each hit, instead of counting any click anywhere in the box —
forcing genuinely separate, deliberate clicks.

References

- Lu, X., Zhang, S., Hui, P., & Liò, P. (2020). _Continuous authentication by free-text keystroke based on CNN and RNN_. Computers & Security, 96, 101861.
- Prior work — keystroke-dynamics capstone (Elkoby & Gutchin, 2022): https://github.com/raf545/BioKey---Keystroke-dynamics-for-user-authentication
- W3C WebAuthn: https://www.w3.org/TR/webauthn-2/
