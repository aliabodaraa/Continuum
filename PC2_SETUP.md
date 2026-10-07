# Building Continuum on a second machine

This is the personal migration guide (moving your working project to another PC).
For shipping to a customer, see [DEPLOY.md](DEPLOY.md).

## What to carry to PC #2

| Item | How it travels | Size |
|---|---|---|
| **Code + base models** | `git clone` (this repo) | ~15 MB |
| **User training data** (accounts, keystroke/mouse samples, per-user models) | `continuum-data-*.tgz` snapshot — copy via **USB / private drive** (not GitHub) | ~18 MB |
| **Raw HDF datasets** (`data/*.h5`) | Only if you will **retrain** — copy `data/` separately | ~555 MB |

You do **not** need the raw datasets just to run with your existing users — their
trained models are inside the snapshot, and scoring doesn't touch the datasets.

## Prerequisites
- **Docker Desktop** (running).
- **Git** (Git Bash on Windows — the scripts are bash).

## Steps

### 1. Get the code
```bash
git clone <your-github-repo-url> continuum
cd continuum
```

### 2. Restore the users' training data
Copy `continuum-data-*.tgz` into the repo folder, then:
```bash
./scripts/data-import.sh continuum-data-*.tgz
```
This restores `ca.db`, `continuum.db`, and every per-user model under `artifacts/users/`.

### 3. Set the secrets
```bash
cp .env.example .env
```
Fill in `.env` (compose refuses to start without these):
```
CA_SIGNING_SECRET=<openssl rand -hex 32>
SESSION_SECRET=<openssl rand -hex 32>
```

### 4. Build and run (dev stack — same as PC #1)
The dev stack bind-mounts the source, so the build needs only the code + npm — no
datasets. `--profile model` also starts the TensorFlow scoring service.
```bash
ONBOARDING_MODE=lazy docker compose --profile model up -d --build
```
First build pulls the TensorFlow image and installs deps (several minutes). Then:
- App: http://localhost:3000
- Gateway (SDK/API): http://localhost:8080

### 5. Re-register passkeys
Passkeys are bound to PC #1's hardware (Windows Hello / TPM) and cannot move. On
first login, each user (ali, aiham, …) registers a fresh passkey on PC #2. All
their keystroke/mouse training and models are already intact — only the passkey
re-enrolls.

## Verify
```bash
docker compose ps                              # services Up
curl -fsS http://localhost:8080/guard.js | head -1   # gateway serves the SDK
```
Then log in as an existing user and type a paragraph — the guard panel should
reach **verified** using the restored model (no re-enrollment of typing).

## Only if you will retrain or enroll NEW mouse users
Copy the datasets over first (they're the public keystroke/SapiMouse sets; see
`docs/download_instructions.md`):
```bash
# place data/mouse_only/Mouse_A5_W50_base.h5 (mouse negatives; regenerate with
# services/model-api/train_mouse_fcn.py from data/sapimouse/) and data/Rand_WS*.h5
# (keystroke base training) into ./data/ before training.
```
- **Mouse enrollment** of a new user needs `data/mouse_only/Mouse_A5_W50_base.h5`.
- **Keystroke base retraining** needs `data/Rand_WS*.h5`.
- Scoring and keystroke enrollment of existing users need neither.

## Alternative: pull prebuilt images instead of building
If you published images from PC #1 (`./scripts/release.sh`), PC #2 can skip the
build entirely — the images already bake in the base models and mouse dataset:
```bash
REGISTRY=<your-dockerhub-user> TAG=<version> docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```
Since 2026-10 this file is the product bundle (gateway, ca-service, passkey-service, model-api) plus
the demo as a tenant, so `.env` needs the bundle's secrets too (`CA_SIGNING_SECRET`,
`GATEWAY_SESSION_SECRET`, `GATEWAY_ADMIN_KEY`, `MODEL_API_KEY`, and `SESSION_SECRET` for the demo), and,
for the demo's extension sign-in and risk pushes, `DEMO_SIGNIN_URL=http://localhost:3000/continuum/link`
and `DEMO_WEBHOOK_URL=http://web:3000/continuum/events`.

## Troubleshooting
- **`CA_SIGNING_SECRET ... is missing`** — you didn't set `.env` (step 3).
- **Model service not scoring** — ensure you passed `--profile model` so `model-api` starts.
- **Docker engine not running** — start Docker Desktop, wait for the whale icon, retry.
