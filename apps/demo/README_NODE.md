Node.js Backend for continuum

Features

- User registration and login with password hashing
- Protected dashboard for authenticated users
- Long-text submission with keystroke dynamics capture
- Keystroke event tracking (keydown/keyup timings)
- Keystroke timing analysis (dwell time, flight time)
- Submission history and browsing
- Model inference endpoint `/api/predict` for continuous authentication
- WebAuthn/passkey skeleton endpoints (needs completion)

Install

```bash
cd continuum/server
npm install
```

Run

```bash
npm start
```

Then open http://localhost:3000 in your browser.

Workflow

1. User creates account at `/register.html`
2. User logs in at `/login.html`
3. On dashboard (`/dashboard.html`), user types or pastes long text
4. Keystroke events (keydown/keyup) are captured with relative timestamps
5. Keystroke timings are analyzed (dwell time, flight time, event count)
6. Text + keystroke data submitted to `/api/text/submit`
7. Data stored in SQLite database for later model training
8. User can view submission history

Database

- SQLite database: `continuum/server/db/continuum.db`
- Tables: `users`, `keystroke_texts`, `keystroke_events`

API Endpoints

- `POST /api/auth/register` — Create user
- `POST /api/auth/login` — Login user
- `POST /api/auth/logout` — Logout user
- `GET /api/auth/me` — Get current user info
- `POST /api/text/submit` — Submit text + keystroke data
- `GET /api/text/history` — Get user's submission history
- `POST /api/predict` — Inference endpoint (to be wired to model)
- `POST /api/webauthn/register/options` — Start passkey registration
- `POST /api/webauthn/auth/options` — Start passkey authentication

Model Integration

- Currently, `/api/predict` supports loading TFJS models or proxying to a Python Flask server
- After training the Continuum CNN+RNN model with `train.py`, convert to TFJS and place in `continuum/artifacts/tfjs_model`
- Or run the Python inference server at `http://localhost:5000` as a fallback

Next Steps

1. Complete WebAuthn verification logic in `routes/webauthn.js`
2. Train the keystroke model using collected text submissions
3. Wire the trained model to `/api/predict` endpoint
4. Test continuous authentication on the dashboard
5. Trigger passkey verification when model detects suspicious behavior
