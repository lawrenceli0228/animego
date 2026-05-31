// socketAuth.js — handshake middleware that verifies the JWT supplied via
// socket.handshake.auth.token and stuffs the decoded claims onto socket.user.
//
// Ported verbatim from server/middleware/socketAuth.js so tokens signed by
// either the legacy Express stack or the new Go API verify here, provided
// the shared JWT_SECRET env var matches.
//
// JWT shape (Go signs the same — see go-api/internal/jwtx/jwt.go AccessClaims):
//   { userId: <uuid-string>, username: <string>, role?: 'admin', exp, iat }
//
// On failure we call next(new Error(...)) which socket.io serializes to a
// 'connect_error' event on the client.  No detailed reason is sent over the
// wire to avoid leaking expired-vs-invalid signal to attackers.

const jwt = require('jsonwebtoken')

module.exports = function socketAuth(socket, next) {
  const token = socket.handshake.auth && socket.handshake.auth.token
  if (!token) return next(new Error('Authentication required'))
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    next(new Error('Invalid token'))
  }
}
