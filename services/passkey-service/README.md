# Passkey Service

A standalone FIDO2/WebAuthn microservice. It owns passkey **credentials** and
**challenges** and performs all WebAuthn crypto. It is **stateless w.r.t. the
calling app** — every request carries an explicit `userId`; there is no session,
no user table, no behavioral-CA knowledge. The application (BFF) authenticates
users and decides *when* to register or step-up; this service just does the
FIDO2 work.

## Run

```bash
npm install
PORT=4000 RP_ID=localhost ORIGIN=http://localhost:3000 npm start
```

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `4000` | Listen port |
| `RP_ID` | `localhost` | Default WebAuthn RP ID (overridable per request via `rpId`) |
| `ORIGIN` | `http://localhost:3000` | Default expected origin (overridable per request via `origin`) |
| `RP_NAME` | `Continuum` | Relying-party display name |
| `DB_PATH` | `./passkey.db` | SQLite location (mount a volume in prod) |
| `PASSKEY_API_KEY` | _(unset)_ | If set, callers must send `X-Api-Key` |

## API (`/v1`)

All bodies are JSON. `rpId` / `origin` may be included on any call to override
the defaults (multi-tenant / multi-domain).

| Method + path | Body | Returns |
|---|---|---|
| `GET  /health` | — | `{ ok, service }` |
| `GET  /v1/users/:userId/passkeys` | — | `{ userId, count, hasPasskey }` |
| `POST /v1/users/:userId/reset` | — | `{ ok }` — delete a user's credentials |
| `POST /v1/register/options` | `{ userId, username }` | WebAuthn creation options |
| `POST /v1/register/complete` | `{ userId, credential }` | `{ ok }` |
| `POST /v1/auth/options` | `{ userId }` | auth options + `challengeId` |
| `POST /v1/auth/complete` | `{ userId, challengeId, assertion }` | `{ ok, verified }` |

### Design notes

- **Registration challenge** is stored in this service's DB (not a session), so
  the service scales horizontally and the app never holds WebAuthn state.
- **Authorization is the caller's job.** This service assumes the caller already
  verified that the request is legitimate for `userId`. Protect it on the
  network (private compose network + optional `PASSKEY_API_KEY`); never expose
  it directly to browsers.
- Credential-id hex/base64url compatibility shims are preserved from the
  original implementation so existing credentials keep working.
