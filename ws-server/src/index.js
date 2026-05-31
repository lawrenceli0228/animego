// index.js — ws-server entry.
//
// Boots a minimal Node HTTP server (only for /health) and attaches a
// socket.io instance.  No Express, no REST: those live in go-api.  This
// process exists solely so we keep the socket.io v4 wire protocol while the
// rest of the backend moves to Go (Go's socket.io ecosystem is not mature
// enough — see MIGRATION_PLAN.md § 1 决策日志 "socket.io 实现").
//
// Wire order:
//   1. fail-fast env validation
//   2. http.Server (serves /health, 404s everything else)
//   3. socket.io attached, CORS scoped to CLIENT_ORIGIN
//   4. socketAuth handshake middleware
//   5. on connection: per-event exp re-check + danmakuHandler registration
//   6. listen on PORT_WS
//   7. SIGTERM → server.close + pool.end (graceful drain for Docker stop)

const http = require('http')
const { Server } = require('socket.io')
const socketAuth = require('./socketAuth')
const registerDanmakuHandlers = require('./danmakuHandler')
const pool = require('./db')

// ─── Env validation (fail-fast) ─────────────────────────────────────
// JWT_SECRET and DATABASE_URL are non-negotiable — silent defaults would
// either forge-able tokens or a writes-to-nowhere danmaku black hole.
function requireEnv(name) {
  const v = process.env[name]
  if (!v || v.trim() === '') {
    // eslint-disable-next-line no-console
    console.error(`[ws-server] FATAL: required env var ${name} is missing or empty`)
    process.exit(1)
  }
  return v
}

const PORT_WS = parseInt(process.env.PORT_WS || '3001', 10)
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173'

// Allow tests to import this file without exiting; only fail-fast when run as
// the main entrypoint.
const IS_MAIN = require.main === module
if (IS_MAIN) {
  requireEnv('JWT_SECRET')
  requireEnv('DATABASE_URL')
}

// ─── HTTP server (health only) ──────────────────────────────────────
// socket.io needs an HTTP listener to attach to.  We serve /health for
// container probes (Docker HEALTHCHECK, k8s liveness) and 404 everything
// else.  Anyone hitting / on :3001 is misrouted; nginx should be sending
// only /socket.io/* here.
function createHealthHandler() {
  return (req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('ok')
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}

// ─── socket.io wiring ───────────────────────────────────────────────
// CORS scoped to a single origin.  In dev that's :3000 (Next.js) or :5173
// (Vite legacy); prod is the public domain.  credentials:true so the
// browser will include the auth header on the WebSocket upgrade request.
function attachSocketIo(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: CLIENT_ORIGIN,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  })

  io.use(socketAuth)

  io.on('connection', (socket) => {
    // Lightweight per-event expiry check.  socketAuth's jwt.verify ran once
    // on handshake; for a long-lived connection (hours) we re-check exp on
    // every packet without re-verifying the signature — cheap mtime compare
    // vs full HMAC.  Cost is sub-microsecond per packet.
    socket.use((packet, next) => {
      if (socket.user?.exp && socket.user.exp * 1000 < Date.now()) {
        socket.emit('auth:expired')
        socket.disconnect(true)
        return next(new Error('token expired'))
      }
      next()
    })

    registerDanmakuHandlers(io, socket)
  })

  return io
}

// ─── Boot (only when run as main) ───────────────────────────────────
function start() {
  const httpServer = http.createServer(createHealthHandler())
  const io = attachSocketIo(httpServer)

  httpServer.listen(PORT_WS, () => {
    // eslint-disable-next-line no-console
    console.log(`[ws-server] listening on :${PORT_WS} (cors origin: ${CLIENT_ORIGIN})`)
  })

  // Graceful shutdown.  Docker sends SIGTERM, gives 10 s grace before
  // SIGKILL.  We stop accepting new connections, then drain the pool.
  // io.close() also broadcasts disconnect to current sockets.
  let shuttingDown = false
  function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    // eslint-disable-next-line no-console
    console.log(`[ws-server] ${signal} received, draining...`)
    io.close(() => {
      httpServer.close(() => {
        pool
          .end()
          .then(() => {
            // eslint-disable-next-line no-console
            console.log('[ws-server] pool drained, exiting cleanly')
            process.exit(0)
          })
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[ws-server] pool.end failed:', err.message)
            process.exit(1)
          })
      })
    })
    // Hard timeout fallback — Docker won't wait forever, neither should we.
    setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('[ws-server] graceful shutdown timeout, forcing exit')
      process.exit(1)
    }, 8000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  return { httpServer, io }
}

if (IS_MAIN) {
  start()
}

// Exported for tests and embedding (e.g. P9 cutover scripts that want to
// spin up a one-off server with a custom port).
module.exports = {
  createHealthHandler,
  attachSocketIo,
  start,
}
