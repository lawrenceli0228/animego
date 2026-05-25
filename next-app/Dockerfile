# syntax=docker/dockerfile:1.7

# next-app multi-stage Docker build.
#
#   builder  : install dev + prod deps, run `next build`. Bun resolves the
#              workspace standalone (next-app is NOT a root workspace
#              member since P4.1.0 to avoid Turbopack hoisting issues).
#   runner   : copy the standalone bundle + .next/static + public assets,
#              run with raw `node server.js`. Bun is only used for the
#              build phase; the runtime is plain Node 22-alpine because
#              standalone server.js has no Bun-specific runtime needs and
#              keeps the image small.
#
# Build:   docker compose build next-app
# Image:   ~120-150MB final layer (vs ~600MB without standalone)

FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
COPY next-app/package.json next-app/bun.lock ./
# --frozen-lockfile pins to bun.lock exactly; fails the build if the
# lockfile is stale instead of silently resolving to newer versions.
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.14-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY next-app/ ./
# Disable Next telemetry at build time. Production opt-out lives in the
# runner stage too.
ENV NEXT_TELEMETRY_DISABLED=1
# P6.6 pin: --webpack. Next 16's turbopack default deadlocks on the
# Library + Player port surface (23k LOC + 4.5 MB jassub WASM + worker
# URLs in usePlaybackSession). Webpack mode compiles in ~15 s. Drop
# the flag when turbopack stabilises asset-handling for those paths.
RUN bun --bun next build --webpack

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user for runtime. UID 1001 matches the node:alpine convention
# used by Next.js official samples.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# `output: "standalone"` produces .next/standalone with a minimal
# server.js + only the deps server-side actually imports. Static assets
# and the public dir must be copied alongside since standalone does NOT
# bundle them.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Use 127.0.0.1 instead of localhost: localhost resolves to ::1 first on
# node:alpine, but next 16 standalone server only listens on the IPv4
# wildcard (HOSTNAME=0.0.0.0). wget then connects to v6, fails, marks
# the container unhealthy even though every external request works.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
