# Deploying Continuum

Continuum ships as a set of container images plus two client integration points.
Nothing is installed on the host except Docker.

## What ships

| Artifact | What it is | Who runs it |
|---|---|---|
| `docker-compose.bundle.yml` | **The product** — `gateway` + `ca-service` + `passkey-service` + `model-api`. Only the gateway is exposed. | A customer, next to their own app |
| `docker-compose.prod.yml` | **The reference demo** — the bundle above (included as is) + the demo web app as an ordinary tenant that reaches Continuum only through the gateway. | You, to showcase |
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
#   GATEWAY_ADMIN_KEY=$(openssl rand -hex 32)       # the operator's key (see "Register a tenant")
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

Each app that uses the gateway is a tenant with its own site key and secret. There are two ways:

- **The developer console** (`https://auth.example.com/console.html`): the app's developer signs in
  with a Continuum account (email + passkey), runs the four-step wizard, and gets the keys and
  ready-to-copy code. The organisation then waits for the operator's approval (below), unless
  `GATEWAY_AUTO_APPROVE_TENANTS=1`.
- **The admin API**, by the operator directly, as below.

### The operator page and the admin API answer only on the gateway's machine

`/operator.html` (approve, revoke, user counts, the whole activity log) and every admin route
(`/v1/tenants`, `/v1/admin/*`) answer only when the request's Host is in `GATEWAY_OPERATOR_HOSTS`
(default `localhost,127.0.0.1,[::1]`). Anywhere else they return 404, even with the right key. On a
server, reach them through an SSH tunnel:

```bash
ssh -L 8080:localhost:8080 you@server      # then open http://localhost:8080/operator.html
```

or set `GATEWAY_OPERATOR_HOSTS` to a name that only your internal network resolves. Sign-in is
the admin key; 10 wrong keys pause operator sign-in for 15 minutes.

> **Reverse proxy:** forward the public Host header (nginx: `proxy_set_header Host $host;`, Caddy
> does it by default). With the default operator hosts, a request carrying `Forwarded` or
> `X-Forwarded-*` headers is treated as coming from outside; a proxy that sends neither and
> rewrites Host to `localhost` would make every visitor look local. The admin key still guards
> every admin action either way.

Every change to a tenant or an account (created, approved, revoked, deleted, given to an account,
secret rotated, webhook tested, account deleted, operator lockout) is appended to `audit.jsonl` in
the gateway's data volume. The console shows each organisation its own entries; the operator page
shows all.

### Settings: the operator's defaults and each organisation's own

Each organisation sets how protection behaves in its apps in its console (**Protection** tab): the
panel on its pages (shown or hidden), the typing and mouse channels (on or off), enrolment
(required at first sign-in, or on demand from the panel), the windows in a typing decision (6, 10
or 20; 20 by default: fewer decide sooner but flag the real user more often), adaptive retraining
(on or off) and its pause after each retrain (3 hours by default), and the field types never watched.

Adaptive retraining runs in cycles: three clean samples that share no keystrokes (each starts 50 keys
after the previous one), kept pending; the user retrains with them and must pass the passkey in that
request (gateway `POST /v1/sdk/keystroke/adaptive/retrain`); then the pause. Nothing else turns typing
into training data.
The operator page (**Settings**) sets the defaults for all organisations, the server switches
(auto-approve, private webhooks), the study's logging, and shows the whole environment read-only
(secrets only as "set" / "not set").

Precedence: the organisation's value, then the operator's default, then `.env`, then the built-in
default. The gateway signs the effective values into the identity assertion it sends with every
request, so ca-service applies them (it refuses data from a channel that is off) without storing
them. Operator defaults live in `settings.json` in the gateway's data volume; organisation values
in the tenant registry. A page's own `data-*` attributes still apply where neither the
organisation nor the operator chose a value.

To let a console account manage a tenant the operator registered (or the built-in demo), give it to
that account (an empty email takes it back):

```bash
curl -s -X POST http://localhost:8080/v1/admin/tenants/pk_demo/owner \
  -H "Content-Type: application/json" -H "X-Admin-Key: $GATEWAY_ADMIN_KEY" -d '{"email": "dev@example.com"}'
```

The owner can then manage its websites, extension and alerts. The built-in demo's secret is
`CA_SIGNING_SECRET` (the demo app reads it too), so the console won't rotate it, revoke it or
delete it, and deleting the owner's account only detaches it.

In the console, an owner can also **delete** an organisation (Settings, typing its name): its key
stops at once and every one of its users is erased the way an account deletion erases one person
(passkeys, typing model, mouse model and samples, identity record). The typing reset keeps the
typed samples in ca-service (marked not for training). If some users can't be erased, the
organisation is revoked instead and a retry finishes the job.

### Register through the admin API

With the admin key from `.env` and the origin(s) the app is served from, on the gateway's machine
(or through the tunnel):

```bash
curl -s -X POST http://localhost:8080/v1/tenants \
  -H "Content-Type: application/json" -H "X-Admin-Key: $GATEWAY_ADMIN_KEY" \
  -d '{"name": "my-app", "origins": ["https://app.example.com"], "webhookUrl": "https://app.example.com/continuum/events"}'
```

The response holds two values:

| Value | Goes to | Secret? |
|---|---|---|
| `siteKey` (`pk_…`) | the page: `<script src=".../guard.js" data-site-key="pk_…">` | no, it is public |
| `secret` | the app's backend as `CONTINUUM_SECRET`, which signs the identity token (`@continuum/node`, `packages/continuum-python`) | **yes**: it is shown only once |

- `origins` is required. The gateway rejects the site key from any other origin (403).
- `webhookUrl` is optional. It is where risk-change events are pushed (CAEP). A webhook set in the
  console must be a public `https://` address (not localhost, a private IP or an internal name),
  since the gateway itself calls it; the console's "Send test alert" checks it.
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

**Server, acting for a user (the tenant API, `/v1/server/*`)** — when the app's own backend runs
Continuum's flows itself (its own passkey screens, its own checks, its own lock policy), as the demo app
does. The reference is `apps/demo/services/continuumApi.js` (transport), `caClient.js` and
`passkeyClient.js`. Every call carries the organisation's site key and an identity token, a standard
HS256 JWT signed with the tenant secret, naming one of its own users and expiring within 10 minutes:
```
POST https://auth.example.com/v1/server/keystroke/check
X-Continuum-Site-Key: YOUR_TENANT_KEY
Authorization: Bearer <HS256 JWT {sub: "<your user id>", aud: "continuum-server", exp: now+120}>
```
Typing: `GET keystroke/config | keystroke/status | keystroke/history | keystroke/stats |
keystroke/decisions | keystroke/decisions-all | keystroke/metrics`, `POST keystroke/enroll |
keystroke/check | keystroke/contribute | keystroke/reset | keystroke/retrain |
keystroke/adaptive/confirm`. Mouse: `GET mouse/status`, `POST mouse/enroll | mouse/check | mouse/reset |
mouse/streak/reset`. Lock: `GET lock/status`, `POST lock/set | lock/clear`. `GET onboarding`.
Passkeys: `GET passkey/status`, `POST passkey/reset | passkey/register/options |
passkey/register/complete | passkey/auth/options | passkey/auth/complete` — each passkey call names
`origin`, which must be one of the organisation's registered websites (the passkey's relying party).
Checks come back with a signed `riskToken` and push risk changes to the organisation's webhook.
`keystroke/adaptive/confirm` needs `stepUpToken`, returned by `passkey/auth/complete`: proof of a
passkey verified through Continuum in the last 2 minutes, valid once. The app's backend never needs an
address or key for an internal service; in the stacks it has none (it sits only on the `edge` network).
The `aud` is required: the identity tokens an app gives its users' browsers for the SDK
(`/continuum/identity`) have none, so a browser — or an impostor at an unlocked session — cannot use one
here. Calls from browsers (any request with an `Origin` header) are refused outright.

---

## Persistence & backup
State lives on named volumes — back these up:

| Volume | Contents |
|---|---|
| `continuum_gateway_data` | Tenant registry, user-id allocations, the gateway's signing keys |
| `continuum_user_models` | Per-user keystroke/mouse models |
| `continuum_ca_db` | Behavioral profiles + decisions (with `CA_STORAGE=postgres` they live in the CA service's own database instead) |
| `continuum_passkey_db` | Registered passkeys + challenges (with `PASSKEY_STORAGE=postgres` they live in the passkey service's own database instead) |
| `continuum_db` (demo only) | Demo users |

### Upgrading an install made before the Node 24 images (2026-10)
The gateway, ca-service, passkey-service and demo images now run as user 1000, not root. A **new**
volume takes the right owner by itself; a volume created by an older image belongs to root, and the
service cannot write to it (`EACCES` in its log). Give those volumes to user 1000 once, with the stack
stopped:
```bash
docker compose -f docker-compose.bundle.yml down
for v in continuum_gateway_data continuum_ca_db continuum_passkey_db continuum_user_models; do
  docker run --rm -v "$v:/v" alpine chown -R 1000:1000 /v
done
docker compose -f docker-compose.bundle.yml up -d
```
(The model-api image runs as user 1000 too since the model versions, 2026-10.) In Kubernetes the pod's
`fsGroup` does this.

### Per-user models: versions, and where they are stored (2026-10)
Every training now writes a new model version (`users/user-<id>/<kind>-<UTC time>-<hex>`) and never
changes it; ca-service keeps which one each user is on, a rejected retrain is discarded, and only the
newest few per user and kind are kept. Models trained before stay where they are and keep working.
`MODEL_STORE=fs` (default) keeps them on the `continuum_user_models` volume; `MODEL_STORE=s3` keeps them
in object storage (`MODEL_S3_*` in `.env`), so several model-service copies serve the same models. To
move to s3, upload the existing ones once: `docker compose ... exec model-api python model_store.py
publish-all`. The production model image now carries only the serving code and the two base models.

### Logs
`LOG_FORMAT=json` in `.env` makes every service log one JSON object per line (time, level, service,
message) for a log collector; empty keeps readable text. Each service also answers `/ready` (its own
storage reachable) next to `/health` (the process is up), and stops cleanly on `docker stop`.

## Kubernetes on this PC (Docker Desktop's cluster, 2026-10)
The same services run in Kubernetes from `deploy/k8s` (base + an overlay), in namespaces of their own
(`continuum`, `continuum-storage`, `continuum-demo`); nothing else in the cluster is touched and no tool is
installed on the PC beyond Docker Desktop (whose `kubectl` includes Kustomize). Moving the live system from
Compose into it: [docs/cutover-runbook.md](docs/cutover-runbook.md).

```bash
scripts/k8s-local.sh platform     # once: metrics-server, CloudNativePG (PostgreSQL), Envoy Gateway
scripts/k8s-local.sh secrets      # once: random secrets in deploy/k8s/overlays/local/secrets (git-ignored;
                                  # the operator key is taken from .env)
scripts/k8s-local.sh up           # build the images (:local), deploy, wait until ready
scripts/k8s-local.sh status
```

Two overlays, the same system on different addresses (one at a time: they share the namespaces):

| Overlay | API | demo | Acme | extension |
|---|---|---|---|---|
| `local` (default) | http://localhost:28080 | :23000 | :24200 | this checkout's (beside the Compose stack) |
| `live` (`K8S_OVERLAY=live`) | http://localhost:8080 | :3000 | :4200 | the main checkout's (in place of the Compose stack) |

Both use the secrets in `deploy/k8s/overlays/local/secrets`. The operator page and the admin API are
**never routed by the edge** (they answer "Not found" there, even with the key): reach them through a
private port-forward, the Kubernetes form of the SSH tunnel above. It follows the gateway to a new pod by
itself:

```bash
scripts/k8s-local.sh operator     # then open http://localhost:28081/operator.html
```

Data in and out:

```bash
scripts/k8s-import.sh ../continuum                    # a Compose checkout's data into the cluster, each part
                                                      # verified (replaces what the cluster held; the source
                                                      # is only read; its stack must be stopped)
BACKUP_PASSPHRASE=... scripts/k8s-backup.sh           # everything, online: pg_dump per database with its
                                                      # checksums from the same snapshot, the demo's users,
                                                      # every model from the object store, secrets, paper/
scripts/k8s-restore.sh <backup> --verify-only         # restore drill touching nothing (throwaway PostgreSQL)
scripts/k8s-restore.sh <backup> --restore             # into the cluster, compared table by table afterwards
scripts/k8s-restore.sh <backup> --secrets             # a new PC: the secrets first, then k8s-local.sh deploy
```

The end-to-end suites run against the cluster with `CONTINUUM_K8S_CONTEXT=docker-desktop
CONTINUUM_NETPOL_UNENFORCED=1 CONTINUUM_GATEWAY=<API> CONTINUUM_DEMO=<demo> CONTINUUM_OPERATOR=http://localhost:28081`
and `CA_SIGNING_SECRET` from the secrets file (the operator forward running); on `overlays/live` also
`CONTINUUM_EXTENSION_DIR=../continuum/extension`, the extension that gateway admits.

Docker Desktop's Kubernetes does not enforce NetworkPolicies, so on this PC the internal services are
kept apart by their service keys alone (every internal route refuses a caller without its key); the
policies take effect on a cluster whose network plugin enforces them.

## Portability smoke test (proving "runs anywhere")
On a second machine with only the compose file + `.env`:
```bash
REGISTRY=<user> TAG=0.1.0 docker compose -f docker-compose.bundle.yml pull
docker compose -f docker-compose.bundle.yml up -d
docker compose -f docker-compose.bundle.yml ps     # all healthy
curl -fsS http://localhost:8080/guard.js | head -1 # gateway serves the SDK
```
If that succeeds with no source checkout, the deployment is customer-ready.
