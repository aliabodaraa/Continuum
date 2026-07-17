FROM node:20-bookworm-slim

WORKDIR /app

# better-sqlite3 needs a toolchain to build its native binding.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . ./

EXPOSE 4100

CMD ["npm", "start"]
