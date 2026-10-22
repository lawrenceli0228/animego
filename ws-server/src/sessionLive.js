// sessionLive.js — whether the session an access token names still stands.
//
// go-api refuses an access token once its session has ended: the device was
// signed out from another device's settings page (登录设备 → 退出), logged
// out, or its password changed (jwtx.WithSessionCheck).  The token itself
// still verifies for up to 15 minutes, so this channel — which writes
// danmaku as the user — has to ask the same question, at the handshake and
// before each write, or a signed-out device keeps posting until it expires.

const pool = require('./db')

const SESSION_LIVE_SQL = `SELECT EXISTS (
  SELECT 1 FROM user_sessions
  WHERE id = $1 AND user_id = $2 AND expires_at > now()
) AS live`

// A token minted before access tokens named their session (no sid) cannot
// be looked up, and runs out within the access TTL on its own.
async function sessionLive(user) {
  if (!user || !user.sid) return true
  const { rows } = await pool.query(SESSION_LIVE_SQL, [user.sid, user.userId])
  return rows[0]?.live === true
}

module.exports = sessionLive
