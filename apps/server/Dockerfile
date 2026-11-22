# The Vigil server (#260, decision 0008): collector, processor and API in one process (#168).
# Build from the repository root:  docker build -f apps/server/Dockerfile -t vigil-server .
#
# - Bun base image; production dependencies of the server and its workspace packages only.
# - Runs as the image's non-root `bun` user; everything it keeps is in the /data volume (Zova, DuckDB, settings).
# - Listens on every container interface (VIGIL_HOST=0.0.0.0); docker-compose.yml publishes the port on 127.0.0.1 only.
# - Healthy once /v1/ready answers 200 (#200): start-up finished, not shutting down.
# - SIGTERM (`docker compose down`) stops it gracefully (#198); give it the 30 s it may take (`stop_grace_period`).

FROM oven/bun:1.4.4-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/api-types/package.json packages/api-types/
RUN bun install --frozen-lockfile --production --filter @vigil/server

FROM oven/bun:1.4.4-slim
WORKDIR /app
ENV NODE_ENV=production \
    VIGIL_DATA_DIR=/data \
    VIGIL_HOST=0.0.0.0 \
    VIGIL_PORT=8787
COPY package.json bun.lock tsconfig.json ./
COPY packages/core packages/core
COPY packages/api-types packages/api-types
COPY apps/server/package.json apps/server/
COPY apps/server/src apps/server/src
COPY apps/server/reference apps/server/reference
COPY config config
# Bun links each workspace's dependencies in its own node_modules, from the store in the root one.
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/server/node_modules apps/server/node_modules
COPY --from=deps /app/packages/core/node_modules packages/core/node_modules
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8787/v1/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "apps/server/src/cli/start.ts", "/data"]
