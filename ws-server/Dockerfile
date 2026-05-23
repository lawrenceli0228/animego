## ws-server — AnimeGo standalone socket.io danmaku service
##
## Multi-stage Node 20 alpine image.  ~80 MB final.  No build step is needed
## (plain CommonJS, no TS), so the "build" stage is purely an npm-ci layer
## we can throw away to keep the runtime image lean.
##
## Build & run locally:
##   docker build -t animego-ws-server ws-server
##   docker run --rm -p 3001:3001 \
##     -e JWT_SECRET=$JWT_SECRET \
##     -e DATABASE_URL=postgres://animego:devpassword@host.docker.internal:5432/animego \
##     animego-ws-server

# ─── deps stage ─────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Use npm ci when a lockfile is committed; fall back to npm install for the
# first build (before package-lock.json lands in git).
RUN if [ -f package-lock.json ]; then \
        npm ci --omit=dev; \
    else \
        npm install --omit=dev --no-package-lock; \
    fi

# ─── runtime stage ──────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Drop root for runtime — node:20-alpine ships a non-root `node` user we can
# reuse without an explicit useradd.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node

EXPOSE 3001

# /health responds on the same port socket.io runs on; wget is in busybox
# already so no extra apk install.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --spider http://localhost:3001/health || exit 1

CMD ["node", "src/index.js"]
