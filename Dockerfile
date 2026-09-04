# Worlds server — Bun runtime. Serves static sites, the homepage, /worlds.js, and
# the /api/v1 platform. No runtime npm deps; `tar` is used to unpack deploy bundles.
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends tar \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install (dev-only deps: bun-types, typescript) + build the SDK artifact from sdk/src
# and the generated reference from the same source, so /worlds.js and
# /docs/reference.md can never disagree with the code in this image.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY sdk ./sdk
COPY server ./server
COPY docs ./docs
COPY spec ./spec
COPY scripts ./scripts
RUN bun run build:sdk && bun run build:docs

# served assets. The universe ships so first boot can seed it as the
# initial world (server/seed.ts).
COPY homepage ./homepage
COPY tutorial ./tutorial
COPY docsite ./docsite
COPY universe ./universe

ENV WORLDS_PORT=8420 \
    WORLDS_DATA_DIR=/data
RUN mkdir -p /data && chown bun:bun /data
EXPOSE 8420

# The server only ever writes under WORLDS_DATA_DIR, and it unpacks caller-supplied
# tarballs — no reason to give that root.
USER bun

# Prod note: WORLDS_BASE_DOMAIN, DATABASE_URL, GEMINI_API_KEY, SLACK_BOT_TOKEN come
# from the deployment (secrets); /data is backed by the sites/uploads object store.
CMD ["bun", "server/index.ts"]
