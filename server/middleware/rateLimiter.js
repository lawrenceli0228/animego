const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 分钟
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: '请求过于频繁，请稍后再试' } }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: '登录尝试过多，请 15 分钟后再试' } }
});

module.exports = { apiLimiter, authLimiter };
