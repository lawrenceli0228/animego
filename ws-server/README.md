# ws-server

Standalone Node + socket.io process for AnimeGo's real-time danmaku (bullet
comments).  Split out of the Express monolith during the
[`feat/go-backend`](../docs/migration/MIGRATION_PLAN.md) migration so the rest
of the backend can move to Go without dragging socket.io behind.

This service does **two** things:

1. Accepts socket.io WebSocket connections from the React client.
2. Reads and writes danmaku to the same Postgres database the Go API uses.

It does not serve any REST endpoints (those all live in `go-api/`).  A `/health`
GET on the same HTTP listener exists for Docker / k8s probes.

## Why a separate process

socket.io v4's protocol surface is wide enough that re-implementing it in Go
would burn weeks for negligible product gain.  The frontend already talks
socket.io-client — keeping the protocol contract stable lets the cutover (P9)
happen with zero frontend changes.  When the Go socket.io ecosystem catches up
we can revisit; until then this microservice is permanent.

## Boundaries

| Concern | Lives in | Wire format |
|---------|----------|-------------|
| `/api/danmaku/:anilistId/:episode` (history fetch) | `go-api` | HTTP JSON |
| `/socket.io/*` (live broadcast) | `ws-server` (this) | socket.io v4 |
| User auth (sign + verify) | `go-api` issues, both `go-api` and `ws-server` verify | shared HS256 JWT |
| `danmakus` + `episode_windows` tables | shared, same Postgres | pgx (Go) / pg (Node) |

The JWT secret is shared via the `JWT_SECRET` env var.  Tokens signed by the Go
API verify here without re-issuing — see `src/socketAuth.js` and Go's
[`internal/jwtx/jwt.go`](../go-api/internal/jwtx/jwt.go).

## Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `danmaku:join` | client → server | `{ anilistId, episode }` |
| `danmaku:leave` | client → server | `{ anilistId, episode }` |
| `danmaku:send` | client → server | `{ anilistId, episode, content }` |
| `danmaku:new` | server → room | `{ _id, username, content, createdAt }` |
| `danmaku:error` | server → socket | `{ code, message }` (soft errors only) |
| `auth:expired` | server → socket | (no payload; followed by disconnect) |

The `_id` key on `danmaku:new` is a stringified Postgres bigint and is named
with the legacy `_id` prefix for byte-compat with the existing React hook
(`client/src/hooks/useDanmaku.js`).  Renaming to `id` is a frontend follow-up.

## Environment

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `JWT_SECRET` | yes | — | HS256 secret shared with `go-api`; tokens fail fast otherwise |
| `DATABASE_URL` | yes | — | Postgres connection string (e.g. `postgres://animego:devpassword@localhost:5432/animego?sslmode=disable`) |
| `PORT_WS` | no | `3001` | TCP port for the HTTP + socket.io listener |
| `CLIENT_ORIGIN` | no | `http://localhost:5173` | CORS allow-list (set to `http://localhost:3000` once Next.js 16 replaces Vite) |

Missing `JWT_SECRET` or `DATABASE_URL` aborts boot — never run with silent
defaults for either.

## Run

### Local (npm)

```bash
cd ws-server
npm install
JWT_SECRET=$(grep ^JWT_SECRET= ../.env | cut -d= -f2) \
DATABASE_URL=$(grep ^DATABASE_URL= ../.env | cut -d= -f2) \
PORT_WS=3001 \
CLIENT_ORIGIN=http://localhost:5173 \
npm start
```

### Local (Docker)

```bash
docker build -t animego-ws-server ws-server
docker run --rm -p 3001:3001 \
  -e JWT_SECRET=$JWT_SECRET \
  -e DATABASE_URL=postgres://animego:devpassword@host.docker.internal:5432/animego \
  animego-ws-server
```

### Verify

```bash
curl -i http://localhost:3001/health
# HTTP/1.1 200 OK
# Content-Type: text/plain; charset=utf-8
# ok

# Then in the browser, open the React app on :5173 (or :3000 post-cutover),
# log in, open an episode player, send a danmaku — confirm it shows up on a
# second browser tab tuned to the same episode.
```

## Tests

```bash
cd ws-server
npm test
```

Three suites:

- `__tests__/socketAuth.test.js` — JWT verify on handshake, including
  cross-secret rejection and `exp` claim preservation.
- `__tests__/danmakuHandler.test.js` — join/leave/send happy + sad paths,
  pg query shape + bind arg assertions, rate limit enforcement, DB error
  swallow, 50-char content trim.
- `__tests__/index.test.js` — health handler 200/404 routing, socket.io wire
  order, per-packet expiry middleware mirror of the legacy Express test.

## Deployment

ws-server runs as its own container.  See `docker-compose.yml` (post-P8) for
the prod wiring.  Cutover sequence (P9) — see `MIGRATION_PLAN.md`:

1. Stop `ws-server` first (wait < 60 s for live WebSocket connections to
   close naturally; no new danmaku writes accepted).
2. Stop Express.
3. Run Postgres migration.
4. Nginx flip `/socket.io/` upstream → `ws-server` (this container) and
   `/api/` → `go-api`.

## Operational notes

- **No socket.io adapter (yet).**  Single-instance only.  Horizontal scaling
  requires a Redis pub/sub adapter — tracked in `TODO.md` item 5.
- **Rate limit is in-process.**  5 s per user, bounded to a 10 k-entry Map.
  Under sustained spam beyond that cap the limit silently stops tracking —
  intentional bound on memory; LRU upgrade is planned post-cutover.
- **Live window is 2 h.**  Once the first danmaku for an `(anilist_id,
  episode)` is sent, that episode accepts danmaku for the next two hours and
  then closes.  Background pg_cron deletes anything older than 1 year
  (see `go-api/migrations`).

## File layout

```
ws-server/
├── package.json
├── Dockerfile
├── jest.config.js
├── .dockerignore
├── .gitignore
├── README.md
├── src/
│   ├── index.js              entry: HTTP + socket.io + graceful shutdown
│   ├── socketAuth.js         handshake JWT verify
│   ├── danmakuHandler.js     join/leave/send + pg writes
│   └── db.js                 pg Pool wrapper
└── __tests__/
    ├── index.test.js
    ├── socketAuth.test.js
    └── danmakuHandler.test.js
```
