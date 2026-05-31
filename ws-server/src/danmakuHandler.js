// danmakuHandler.js — per-connection socket.io handlers for the danmaku
// (bullet-comment) feature.  Ported from server/socket/danmaku.handler.js with
// MongoDB (Mongoose) calls replaced by Postgres (pg) queries against the
// same tables the Go API uses (see go-api/migrations/0001_init.up.sql).
//
// Events handled:
//   danmaku:join   { anilistId, episode }            — join a per-episode room
//   danmaku:leave  { anilistId, episode }            — leave a room
//   danmaku:send   { anilistId, episode, content }   — broadcast a new danmaku
//
// Events emitted:
//   danmaku:error  { code, message }                 — soft errors (room cap, ...)
//   danmaku:new    { _id, username, content, createdAt }  — broadcast on send
//
// Wire-format note: the frontend (client/src/hooks/useDanmaku.js) consumes
// `_id` as the message key.  Postgres returns a bigint identity column we
// stringify and emit under the legacy `_id` field so the React renderer keeps
// working unchanged after cutover.  Renaming to `id` is a frontend follow-up
// (see MIGRATION_PLAN.md § P2.8 schema diff).
//
// In-process rate limit + room cap are intentionally identical to the Express
// implementation so the cutover doesn't drift behavior:
//   * 5 s per-user send cooldown (Map up to 10 000 entries, evicts via timeout)
//   * 10 concurrent danmaku rooms per socket
//   * 2 h LIVE_WINDOW once the first message of an episode is sent

const pool = require('./db')

const lastSent = new Map() // userId -> lastSentAt (in-memory rate limit)
const RATE_LIMIT_MS = 5000
const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000 // 2 hours
const MAX_ROOMS_PER_SOCKET = 10
const RATE_LIMIT_MAP_CAP = 10000

// INSERT-or-read the canonical live window for (anilist_id, episode).  The
// DO UPDATE branch is a no-op (sets anilist_id to itself) so RETURNING
// always emits the surviving row — equivalent to Mongoose's
// `findOneAndUpdate({...}, {$setOnInsert:{...}}, {upsert:true, new:true})`.
//
// Why no-op DO UPDATE rather than DO NOTHING + follow-up SELECT: a single
// round-trip beats two, and the no-op write touches only the row we'd be
// reading anyway (no extra index pressure, no logical replication churn —
// PG short-circuits write-amplification when the row hasn't changed).
const EPISODE_WINDOW_UPSERT_SQL = `
  INSERT INTO episode_windows (anilist_id, episode, live_ends_at)
  VALUES ($1, $2, $3)
  ON CONFLICT (anilist_id, episode) DO UPDATE SET anilist_id = EXCLUDED.anilist_id
  RETURNING live_ends_at
`

const DANMAKU_INSERT_SQL = `
  INSERT INTO danmakus (anilist_id, episode, user_id, username, content, live_ends_at)
  VALUES ($1, $2, $3, $4, $5, $6)
  RETURNING id, created_at
`

module.exports = function registerDanmakuHandlers(io, socket) {
  const userId = String(socket.user.userId)

  socket.on('danmaku:join', ({ anilistId, episode }) => {
    const id = parseInt(anilistId, 10)
    const ep = parseInt(episode, 10)
    if (isNaN(id) || isNaN(ep) || id <= 0 || ep <= 0) return
    // Limit per-socket room membership to prevent memory abuse.
    const danmakuRooms = [...socket.rooms].filter((r) => r.startsWith('danmaku:'))
    if (danmakuRooms.length >= MAX_ROOMS_PER_SOCKET) {
      socket.emit('danmaku:error', { code: 'ROOM_LIMIT', message: 'Too many rooms' })
      return
    }
    socket.join(`danmaku:${id}:${ep}`)
  })

  socket.on('danmaku:leave', ({ anilistId, episode }) => {
    const id = parseInt(anilistId, 10)
    const ep = parseInt(episode, 10)
    if (isNaN(id) || isNaN(ep)) return
    socket.leave(`danmaku:${id}:${ep}`)
  })

  socket.on('danmaku:send', async ({ anilistId, episode, content }) => {
    try {
      const now = Date.now()

      // Rate limit: under attack (>10k concurrent senders) we stop tracking to
      // bound memory; this means rate limiting is intentionally sacrificed
      // during extreme load events.  Matches Express behavior — the planned
      // LRU upgrade lives in MIGRATION_PLAN.md § P2.8 review 2P.
      if (now - (lastSent.get(userId) ?? 0) < RATE_LIMIT_MS) return
      if (lastSent.size < RATE_LIMIT_MAP_CAP) {
        lastSent.set(userId, now)
        // Auto-expire entry so the map stays bounded under normal load.
        setTimeout(() => {
          if (lastSent.get(userId) === now) lastSent.delete(userId)
        }, RATE_LIMIT_MS * 2).unref?.()
      }

      // Validate input.
      if (!content || typeof content !== 'string') return
      const trimmed = content.trim().slice(0, 50)
      if (!trimmed) return
      if (!socket.user.username || !socket.user.username.trim()) return

      const anilistIdNum = parseInt(anilistId, 10)
      const episodeNum = parseInt(episode, 10)
      if (
        isNaN(anilistIdNum) ||
        isNaN(episodeNum) ||
        anilistIdNum <= 0 ||
        episodeNum <= 0
      ) {
        return
      }

      // Atomically get-or-create the live window for this episode (race-safe).
      const windowRes = await pool.query(EPISODE_WINDOW_UPSERT_SQL, [
        anilistIdNum,
        episodeNum,
        new Date(now + LIVE_WINDOW_MS),
      ])
      const liveEndsAt = windowRes.rows[0].live_ends_at

      // Reject if window has already closed (an old episode whose 2 h has elapsed).
      if (now > new Date(liveEndsAt).getTime()) return

      const insertRes = await pool.query(DANMAKU_INSERT_SQL, [
        anilistIdNum,
        episodeNum,
        socket.user.userId,
        socket.user.username,
        trimmed,
        liveEndsAt,
      ])
      const row = insertRes.rows[0]

      io.to(`danmaku:${anilistIdNum}:${episodeNum}`).emit('danmaku:new', {
        // _id (not id) for backward compat with the existing frontend hook
        // (client/src/hooks/useDanmaku.js).  pg returns bigint as a JS string;
        // forcing String() keeps the contract stable even if a future pg
        // upgrade or types: { 20: <parser> } config flips it to a Number.
        _id: String(row.id),
        username: socket.user.username,
        content: trimmed,
        createdAt: row.created_at,
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ws-server] danmaku:send error:', err.message)
    }
  })
}

// Exported for tests so we can reset the module-level rate-limit map between
// runs without reaching into private state via Jest's module cache tricks.
module.exports._clearRateLimitState = function _clearRateLimitState() {
  lastSent.clear()
}
