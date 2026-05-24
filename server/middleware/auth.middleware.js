const jwt = require('jsonwebtoken');

// P8.1: dual-track auth read.
//
// Legacy SPA (client/) uses Authorization: Bearer <token>. The token
// lives in browser localStorage and the SPA attaches it to every fetch.
// next-app RSC runs on the Node server, has no localStorage, but DOES
// receive the browser's Cookie header (lib/api.ts forwards it via
// next/headers cookies().toString()). The `session` cookie carries the
// same accessToken, HttpOnly so XSS can't read it, 15-minute TTL
// matching JWT_EXPIRES_IN.
//
// Bearer wins when both are present — keeps the SPA path's behaviour
// byte-identical to pre-P8.1 and avoids surprises during the cookie
// rollout window.
function readToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts[0] === 'Bearer' && parts[1]) return parts[1];
  }
  return (req.cookies && req.cookies.session) || null;
}

const authenticateToken = (req, res, next) => {
  const token = readToken(req);

  if (!token) {
    return res.status(401).json({ error: { code: 'NO_TOKEN', message: '需要登录' } });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { userId, username }
    next();
  } catch (err) {
    next(err);
  }
};

// Attaches req.user if valid token present, otherwise continues without error
const optionalAuth = (req, res, next) => {
  const token = readToken(req);
  if (!token) return next();
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_) { /* ignore invalid token */ }
  next();
};

module.exports = { authenticateToken, optionalAuth, readToken };
