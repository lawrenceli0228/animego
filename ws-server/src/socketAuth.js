// socketAuth.js — handshake middleware that verifies the JWT supplied via
// socket.handshake.auth.token and stuffs the decoded claims onto socket.user.
//
// Ported verbatim from server/middleware/socketAuth.js so tokens signed by
// either the legacy Express stack or the new Go API verify here, provided
// the shared JWT_SECRET env var matches.
//
// JWT shape (Go signs the same — see go-api/internal/jwtx/jwt.go AccessClaims):
//   { userId: <uuid-string>, sid: <uuid-string>, username: <string>, role?: 'admin', exp, iat }
//
// A token that names its session (sid) is let in only while that session
// stands (sessionLive.js); one minted before tokens named their session is
// not looked up.
//
// On failure we call next(new Error(...)) which socket.io serializes to a
// 'connect_error' event on the client.  No detailed reason is sent over the
// wire to avoid leaking expired-vs-invalid signal to attackers.

const jwt = require('jsonwebtoken')
const sessionLive = require('./sessionLive')

module.exports = function socketAuth(socket, next) {
  const token = socket.handshake.auth && socket.handshake.auth.token
  if (!token) return next(new Error('Authentication required'))
  let user
  try {
    user = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return next(new Error('Invalid token'))
  }
  if (!user.sid) {
    socket.user = user
    return next()
  }
  // A token whose session has ended is refused like a bad one.  A failed
  // lookup refuses too: this is a write channel, and the client reconnects.
  sessionLive(user).then(
    (live) => {
      if (!live) return next(new Error('Invalid token'))
      socket.user = user
      next()
    },
    () => next(new Error('Authentication unavailable'))
  )
}
