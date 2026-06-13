# Worlds server — Bun runtime. Serves static sites, the homepage, /worlds.js, and
# the /api/v1 platform. No runtime npm deps; `tar` is used to unpack deploy bundles.
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends tar \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install (dev-only deps: bun-types) + build the SDK artifact from sdk/src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY sdk ./sdk
RUN bun run build:sdk

# server + served assets. The universe ships so first boot can seed it as the
# initial world (server/seed.ts); other examples are not baked in.
COPY server ./server
COPY homepage ./homepage
COPY docs ./docs
COPY spec ./spec
COPY tutorial ./tutorial
COPY examples/universe ./examples/universe

ENV WORLDS_PORT=8420 \
    WORLDS_DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 8420

# Prod note: WORLDS_BASE_DOMAIN, DATABASE_URL, GEMINI_API_KEY, SLACK_BOT_TOKEN come
# from the deployment (secrets); /data is backed by the sites/uploads object store.
CMD ["bun", "server/index.ts"]
