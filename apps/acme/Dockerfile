# syntax=docker/dockerfile:1
# Reference integration (not part of the product). `runtime` (the default) for deployments, `dev` for
# the development Compose stack and Tilt.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . ./
EXPOSE 4200
CMD ["node", "--watch", "server.js"]

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . ./
# numeric, so Kubernetes (runAsNonRoot) can verify it is not root; 1000 is the image's "node" user
USER 1000:1000
EXPOSE 4200
CMD ["node", "server.js"]
