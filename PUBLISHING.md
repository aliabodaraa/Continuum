# Publishing Continuum images to Docker Hub (`aliabodaraa/*`)

Two mechanisms: a **one-time / occasional manual ship** (covers everything, incl.
`model-api`), and **automatic re-publish on every push** (the frequently-changing
Node services) via GitHub Actions.

Images published: `aliabodaraa/{model-api, ca-service, passkey-service, gateway, web-demo}`.

---

## 1. Manual ship (run from this machine — has the datasets model-api needs)
```bash
docker login -u aliabodaraa            # paste a Docker Hub access token as the password
REGISTRY=aliabodaraa TAG=0.1.0 ./scripts/release.sh
```
Builds + pushes all five images at `:0.1.0` and `:latest`. Use this for the **first**
publish and whenever `model-api` changes (its build bakes a 119 MB mouse dataset that
is too large for git, so CI can't rebuild it).

## 2. Automatic re-publish on every push (GitHub Actions)
`.github/workflows/publish.yml` rebuilds + pushes `ca-service`, `passkey-service`,
`gateway`, and `web-demo` on every push to `main` that touches `services/**`, `sdk/**`,
or `apps/demo/**` (and via manual "Run workflow"). Each image gets `:latest` + `:<short-sha>`.

### One-time setup
1. **Create a Docker Hub access token**: hub.docker.com → Account Settings → Security →
   New Access Token (Read/Write). Copy it.
2. **Add GitHub repo secrets** (Settings → Secrets and variables → Actions → New secret):
   - `DOCKERHUB_USERNAME` = `aliabodaraa`
   - `DOCKERHUB_TOKEN` = the token from step 1
3. Push the repo to GitHub. From then on, every push auto-publishes.

> `model-api` is deliberately excluded from CI (dataset too large for git; rarely changes).
> Re-publish it with the manual command in §1 when its code or base models change.

## 3. How a customer / PC #2 consumes them
```bash
REGISTRY=aliabodaraa TAG=latest docker compose -f docker-compose.bundle.yml pull
docker compose -f docker-compose.bundle.yml up -d
```
Pin `TAG` to a version (e.g. `0.1.0`) or a short SHA for reproducibility instead of `latest`.

## Note on secrets in the images
`gateway` bakes `gateway-verdict-key.pem` + `tenants.json` (currently tracked in git). Fine
for a private setup; if the **repo or the images** are public, rotate/externalize these (see
`HANDOFF.md` §6). Runtime secrets (`CA_SIGNING_SECRET`, `SESSION_SECRET`) are NOT baked — they
are injected via `.env` at run time; the release script uses throwaway placeholders only so the
build can parse the compose files.
