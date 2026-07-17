FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . ./
# Bake the customer SDK (top-level sdk/, injected as the named "sdk" build
# context) so the gateway serves guard.js + capture libs in prod. Dev instead
# bind-mounts ./sdk over /app/sdk-public for hot reload.
COPY --from=sdk . ./sdk-public/
EXPOSE 8080
CMD ["npm", "start"]
