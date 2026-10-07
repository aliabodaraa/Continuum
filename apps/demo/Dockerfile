# syntax=docker/dockerfile:1
# Reference integration (not part of the product). `runtime` (the default) for deployments, `dev` for
# the development Compose stack and Tilt. The shared SDK (top-level sdk/) comes in as the named build
# context "sdk" and is served from /app/sdk-assets (dev mounts ./sdk over it).

# ---- deps: dependencies exactly as locked; the compiler for better-sqlite3 stays here ----
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . ./
COPY --from=sdk . ./sdk-assets/
EXPOSE 3000
CMD ["node", "--watch", "app.js"]

# ---- runtime: not root; the database directory and the profile-photo uploads are its only writes ----
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DB_PATH=/app/data/continuum.db
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . ./
COPY --from=sdk --chown=node:node . ./sdk-assets/
RUN mkdir -p /app/data /app/public/uploads && chown node:node /app/data /app/public/uploads
# numeric, so Kubernetes (runAsNonRoot) can verify it is not root; 1000 is the image's "node" user
USER 1000:1000
EXPOSE 3000
CMD ["node", "app.js"]
