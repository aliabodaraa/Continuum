# Deploying Continuum

Continuum ships as a set of container images plus two client integration points.
Nothing is installed on the host except Docker.

## What ships

| Artifact | What it is | Who runs it |
|---|---|---|
| `docker-compose.bundle.yml` | **The product** — `gateway` + `ca-service` + `passkey-service` + `model-api`. Only the gateway is exposed. | A customer, next to their own app |
| `docker-compose.prod.yml` | **The reference demo** — the same services + the demo web app (`web-demo`). | You, to showcase |
| `docker-compose.yml` | Dev stack (bind mounts, hot reload). | You, while developing |
| `guard.js` (SDK) | Client script, served by the gateway. | Embedded in the customer's pages |
| `@continuum/node`, `continuum-python` | Server middleware that verifies signed verdicts. | The customer's backend |

A customer never deploys the demo/acme apps — those are living integration examples.
They run the **bundle** and embed the SDK + middleware in **their own** app.

## Base models are baked in
The `model-api` image bakes the pretrained base models (`ws50-gru` keystroke,
`mouse-fcn-a5` mouse) and both negative pools (`Mouse_A5_W50_base.h5` for mouse, `aalto_neg_A200.h5` for
keystroke; build the latter with `services/model-api/build_aalto_negatives.py`), so a fresh install works out of
the box. Per-user models are trained at enrollment and live on a **named volume**
(`continuum_user_models`), never in the image.

---

## 1) Publish images (maintainer, on the machine with the source)

```bash
docker login                      # or: docker login ghcr.io
REGISTRY=<your-dockerhub-user> TAG=0.1.0 ./scripts/release.sh
```

This builds and pushes `${REGISTRY}/{model-api,ca-service,passkey-service,gateway,web-demo}`
at `:0.1.0` and `:latest`. Use an explicit version tag (not `latest`) so a
deployment is reproducible. `model-api` is TensorFlow — if any target host is a
different CPU arch (e.g. Apple Silicon vs x86), build multi-arch with
`docker buildx build --platform linux/amd64,linux/arm64 --push`.

## 2) Install (customer / second machine — needs only the compose file + `.env`)

```bash
cp .env.example .env
# Fill in the REQUIRED secrets — compose refuses to start without them:
#   CA_SIGNING_SECRET=$(openssl rand -hex 32)       # signs verdicts + demo tenant
#   GATEWAY_SESSION_SECRET=$(openssl rand -hex 32)  # session tokens + user-id namespace (unique per deployment; never change it)
#   GATEWAY_ADMIN_KEY=$(openssl rand -hex 32)       # gates tenant registration (see "Register a tenant")
#   MODEL_API_KEY=$(openssl rand -hex 32)           # ca-service -> model-api service credential
#   SESSION_SECRET=$(openssl rand -hex 32)          # only needed for the demo stack
# Point at your published images:
#   REGISTRY=<your-dockerhub-user>   TAG=0.1.0

REGISTRY=<your-dockerhub-user> TAG=0.1.0 docker compose -f docker-compose.bundle.yml pull
docker compose -f docker-compose.bundle.yml up -d
```

The gateway is now on `http://localhost:8080`. No build step, no source needed.

> **Why the secrets are required:** `CA_SIGNING_SECRET` signs the risk verdicts;
> the host app verifies with the same value. A shared default would let any
> deployment forge another's verdicts, so compose fails fast if it is unset.

## 3) Serve on a real domain
WebAuthn passkeys are cryptographically bound to the origin. In `.env`:

```
PUBLIC_ORIGIN=https://auth.example.com
RP_ID=auth.example.com
COOKIE_SECURE=1
```

Put the gateway behind TLS (reverse proxy) on that domain.

## Register a tenant (one per app)

Each app that uses the gateway is a tenant with its own site key and secret. Register it once,
with the admin key from `.env` and the origin(s) the app is served from:

```bash
curl -s -X POST https://auth.example.com/v1/tenants \
  -H "Content-Type: application/json" -H "X-Admin-Key: $GATEWAY_ADMIN_KEY" \
  -d '{"name": "my-app", "origins": ["https://app.example.com"], "webhookUrl": "https://app.example.com/continuum/events"}'
```

The response holds two values:

| Value | Goes to | Secret? |
|---|---|---|
| `siteKey` (`pk_…`) | the page: `<script src=".../guard.js" data-site-key="pk_…">` | no, it is public |
| `secret` | the app's backend as `CONTINUUM_SECRET`, which signs the identity token (`@continuum/node`, `packages/continuum-python`) | **yes**: it is shown only once |

- `origins` is required. The gateway rejects the site key from any other origin (403).
- `webhookUrl` is optional. It is where risk-change events are pushed (CAEP).
- `GET /v1/tenants` (same header) lists the tenants, without their secrets.
- The registry lives in the gateway's data volume. If the gateway cannot save it, the registration
  fails with 500 and no credentials are issued. A registry file that cannot be read stops the
  gateway at boot instead of being treated as empty.
- The built-in `pk_demo` tenant accepts any origin. It is meant for the bundled demo only: do not
  use it for a real app.

**Two apps, two tenants.** Origin binding stops another site from reusing a stolen site key, but it
is not a tenancy boundary. Two apps on the *same* origin that share one site key share one user
namespace: their users, trained models, passkeys and verdicts are the same records, and a verdict
earned in one app verifies in the other. That is correct for one product with several surfaces (a
single-page app plus an admin panel). Two unrelated products must each register their own tenant.
Their origins may overlap, because users are keyed on the site key and each tenant's secret signs
its own identities. **The tenancy boundary is the secret, not the origin.**

---

## 4) Integrate into a host app (two touch points)

**Client** — one script tag; it renders the guard panel and does passkey step-up:
```html
<script src="https://auth.example.com/guard.js"
        data-site-key="YOUR_TENANT_KEY"
        data-keystroke="on" data-mouse="optional"></script>
```
For a sensitive action, attach the signed risk token: `Continuum.riskHeader()`.

**Server** — verify the verdict before honoring a protected request. Node:
```js
const continuum = require("@continuum/node")({ jwksUri: "https://auth.example.com/.well-known/jwks.json" });
app.use(continuum.protect());   // blocks a suspicious/locked verdict
```
Any language can verify via the gateway's JWKS (RS256); see `packages/continuum-python`
for a stdlib-only reference.

---

## Persistence & backup
State lives on named volumes — back these up:

| Volume | Contents |
|---|---|
| `continuum_gateway_data` | Tenant registry, user-id allocations, the gateway's signing keys |
| `continuum_user_models` | Per-user keystroke/mouse models |
| `continuum_ca_db` | Behavioral profiles + decisions |
| `continuum_passkey_db` | Registered passkeys + challenges |
| `continuum_db` (demo only) | Demo users |

## Portability smoke test (proving "runs anywhere")
On a second machine with only the compose file + `.env`:
```bash
REGISTRY=<user> TAG=0.1.0 docker compose -f docker-compose.bundle.yml pull
docker compose -f docker-compose.bundle.yml up -d
docker compose -f docker-compose.bundle.yml ps     # all healthy
curl -fsS http://localhost:8080/guard.js | head -1 # gateway serves the SDK
```
If that succeeds with no source checkout, the deployment is customer-ready.
