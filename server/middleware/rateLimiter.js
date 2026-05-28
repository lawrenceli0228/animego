const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 分钟
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: '请求过于频繁，请稍后再试' } }
});

// Override via AUTH_RATELIMIT_MAX for e2e sandboxes that hammer /login.
// Prod leaves it unset so the default 10/15min still bounds brute force.
// NaN/invalid value falls back to the safe default — a malformed env
// would otherwise turn into max=NaN, which express-rate-limit treats as
// "always over limit" and locks out auth entirely.
const _envMax = parseInt(process.env.AUTH_RATELIMIT_MAX || '', 10);
const _authMax = Number.isFinite(_envMax) && _envMax > 0 ? _envMax : 10;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: _authMax,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: '登录尝试过多，请 15 分钟后再试' } }
});

module.exports = { apiLimiter, authLimiter };
