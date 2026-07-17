FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . ./
# Bake the shared SDK (top-level sdk/, injected as the named "sdk" build context)
# so the demo serves /guard.js + capture libs in prod. Dev bind-mounts ./sdk over
# /app/sdk-assets instead.
COPY --from=sdk . ./sdk-assets/

EXPOSE 3000

CMD ["npm", "start"]
