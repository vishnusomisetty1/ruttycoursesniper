# Optional deployment method. PM2 or systemd on the host is simpler; use Docker
# only if you prefer containers.
#
#   docker build -t rutgers-sniper .
#   docker run -d --name rutgers-sniper --restart unless-stopped \
#     --env-file .env -v "$(pwd)/data:/app/data" rutgers-sniper
#
# Run a CLI command inside the running container:
#   docker exec rutgers-sniper npm run cli -- list --chat-id 123456789

FROM node:20-slim

# better-sqlite3 ships prebuilt binaries, but keep build tools available in case
# a rebuild is needed for this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev=false

COPY . .

RUN mkdir -p data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/rutgers-sniper.sqlite

# CPU-only workload; no GPU runtime required.
CMD ["npx", "tsx", "src/worker/main.ts"]
