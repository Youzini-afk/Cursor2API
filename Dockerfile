# syntax=docker/dockerfile:1
#
# Self-hosted API gateway image (Zeabur / plain Docker).
#
# Two runtimes are required and are NOT interchangeable:
#   - Node  : runs the SDK bridge. `@cursor/sdk` needs Node (gRPC over HTTP/2 +
#             native deps) and declares `engines.node >= 22.13`.
#   - Bun   : runs `sidecar/server.ts`. The sidecar imports the worker helpers
#             with extensionless TypeScript specifiers, which Node's own type
#             stripping cannot resolve.
#
# Debian (glibc) is used on purpose: `@cursor/sdk` ships prebuilt platform
# packages, so musl/Alpine is the riskier base here.
#
# The Bun binary is copied out of the official image, so both bases must be the
# same Debian release or the copied binary hits a glibc version mismatch.
# `oven/bun:1-debian` is built on Debian trixie, hence `node:22-trixie-slim`.
#
# `scripts/start-zeabur.mjs` is the foreground supervisor for both processes.

FROM oven/bun:1-debian AS bun

FROM node:22-trixie-slim AS admin
WORKDIR /admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY admin/ ./
RUN npm run build

FROM node:22-trixie-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    CURSOR_SDK_BRIDGE_HOST=127.0.0.1 \
    CURSOR_SDK_BRIDGE_PORT=8792 \
    CURSOR_SDK_WORKING_DIRECTORY=/app/.workspace

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# Only the bridge needs npm dependencies; the sidecar and worker helpers have none.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY scripts/cursor-sdk-local-agent-bridge.mjs ./scripts/cursor-sdk-local-agent-bridge.mjs
COPY scripts/start-zeabur.mjs ./scripts/start-zeabur.mjs
COPY sidecar ./sidecar
COPY worker ./worker
COPY --from=admin /admin/dist ./admin/dist

# The SDK's local agent runs with a working directory; give it a writable one
# since /app itself stays root-owned and the process runs as `node`.
# /app/data holds the admin SQLite file and must be a mounted volume in production.
RUN mkdir -p /app/.workspace /app/data && chown -R node:node /app/.workspace /app/data

ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/start-zeabur.mjs"]
