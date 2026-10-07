# syntax=docker/dockerfile:1
# Three stages from one file. CI, the product bundle and Kubernetes run `runtime` (the last stage, the
# default); the development Compose stack and Tilt build `dev`. The customer SDK (top-level sdk/) comes
# in as the named build context "sdk" and is served from /app/sdk-public (dev mounts ./sdk over it).

# ---- deps: production dependencies exactly as locked ----
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# ---- dev: local development only (the source is mounted over /app; restarts on change) ----
FROM node:24-bookworm-slim AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . ./
COPY --from=sdk . ./sdk-public/
EXPOSE 8080
CMD ["node", "--watch", "server.js"]

# ---- runtime: every environment. No npm in front of the process (signals reach node), not root.
# /app/data holds the signing keys (a mounted secret in Kubernetes) and, with STORAGE=json, the records;
# a new volume takes its owner.
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/app/data
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . ./
COPY --from=sdk --chown=node:node . ./sdk-public/
RUN mkdir -p /app/data && chown node:node /app/data
# numeric, so Kubernetes (runAsNonRoot) can verify it is not root; 1000 is the image's "node" user
USER 1000:1000
EXPOSE 8080
CMD ["node", "server.js"]
