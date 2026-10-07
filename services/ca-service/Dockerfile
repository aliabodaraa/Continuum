# syntax=docker/dockerfile:1
# Three stages from one file. CI, the product bundle and Kubernetes run `runtime` (the last stage, the
# default); the development Compose stack and Tilt build `dev`.

# ---- deps: production dependencies exactly as locked; the compiler for better-sqlite3 stays here ----
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# ---- dev: local development only (the source is mounted over /app; restarts on change) ----
FROM node:24-bookworm-slim AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . ./
EXPOSE 4100
CMD ["node", "--watch", "server.js"]

# ---- runtime: every environment. No compiler, no npm in front of the process (signals reach node),
# not root. /app/data is where the database lives in the bundle; a new volume takes its owner.
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DB_PATH=/app/data/ca.db
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . ./
RUN mkdir -p /app/data && chown node:node /app/data
# numeric, so Kubernetes (runAsNonRoot) can verify it is not root; 1000 is the image's "node" user
USER 1000:1000
EXPOSE 4100
CMD ["node", "server.js"]
