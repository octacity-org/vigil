# The Vigil web app (#261, decision 0008). Build from the repository root:
#   docker build -f apps/web/Dockerfile -t vigil-web .
#
# - Production build with Next.js's standalone output: the image holds the built app and the files it needs only.
# - Runs as the image's non-root `bun` user and listens on every container interface; docker-compose.yml publishes
#   the port on 127.0.0.1 only.
# - The server's address comes from the compose file: `VIGIL_API_URL` (read at run time) for server-side requests,
#   on the compose network (`http://server:8787`). The browser reaches the API at `NEXT_PUBLIC_API_URL`, set when the
#   image is built; its default 127.0.0.1:8787 is the port compose publishes on the user's computer.

FROM oven/bun:1.4.4-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/api-types/package.json packages/api-types/
# Every workspace, with dev dependencies: next build type-checks with the root TypeScript.
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY packages/api-types packages/api-types
COPY apps/web apps/web
ARG NEXT_PUBLIC_API_URL=http://127.0.0.1:8787
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && bun run build

FROM oven/bun:1.4.4-slim
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=bun:bun /app/apps/web/.next/standalone ./
COPY --from=build --chown=bun:bun /app/apps/web/.next/static apps/web/.next/static
USER bun
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/bulgular').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "apps/web/server.js"]
