// db.js — tiny pg Pool wrapper used by danmakuHandler.
//
// One Pool per process; pg manages connection reuse internally.  index.js owns
// the SIGTERM path that calls pool.end() so in-flight queries can drain.
//
// Connection string comes from DATABASE_URL.  Format:
//   postgres://user:pass@host:5432/dbname?sslmode=disable
//
// Notes:
//   * max defaults to 10 — the only workload is short-lived danmaku writes,
//     and the Go API holds its own pool against the same Postgres.
//   * idleTimeoutMillis 30s + connectionTimeoutMillis 5s match Go's pgxpool
//     defaults documented in go-api/internal/db/pool.go.

const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

// Surface idle-client crashes loudly instead of letting them silently kill
// connections.  Without this listener pg emits 'error' on the Pool and the
// process can exit if no one handles it.
pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[ws-server] pg pool idle client error:', err.message)
})

module.exports = pool
