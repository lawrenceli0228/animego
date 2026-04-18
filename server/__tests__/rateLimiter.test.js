const express = require('express');
const request = require('supertest');

const { apiLimiter, authLimiter } = require('../middleware/rateLimiter');

function buildApp(limiter, route = '/test') {
  const app = express();
  app.set('trust proxy', false);
  app.get(route, limiter, (req, res) => res.json({ ok: true }));
  return app;
}

describe('rateLimiter middleware', () => {
  describe('apiLimiter', () => {
    it('allows requests under the limit', async () => {
      const app = buildApp(apiLimiter);
      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('sets RateLimit-* standard headers', async () => {
      const app = buildApp(apiLimiter);
      const res = await request(app).get('/test');
      expect(res.headers['ratelimit-limit']).toBeDefined();
      expect(res.headers['ratelimit-remaining']).toBeDefined();
    });

    it('does not set legacy X-RateLimit-* headers', async () => {
      const app = buildApp(apiLimiter);
      const res = await request(app).get('/test');
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    });

    it('returns TOO_MANY_REQUESTS payload after exceeding limit', async () => {
      // Build isolated limiter with max=1 to avoid cross-test state
      const rateLimit = require('express-rate-limit');
      const limiter = rateLimit({
        windowMs: 60 * 1000,
        max: 1,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: { code: 'TOO_MANY_REQUESTS', message: '请求过于频繁，请稍后再试' } }
      });
      const app = buildApp(limiter, '/rl');

      const first = await request(app).get('/rl');
      expect(first.status).toBe(200);

      const second = await request(app).get('/rl');
      expect(second.status).toBe(429);
      expect(second.body).toEqual({
        error: { code: 'TOO_MANY_REQUESTS', message: '请求过于频繁，请稍后再试' }
      });
    });
  });

  describe('authLimiter', () => {
    it('allows requests under the limit', async () => {
      const app = buildApp(authLimiter, '/auth');
      const res = await request(app).get('/auth');
      expect(res.status).toBe(200);
    });

    it('returns auth-specific TOO_MANY_REQUESTS message after exceeding limit', async () => {
      const rateLimit = require('express-rate-limit');
      const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 1,
        message: { error: { code: 'TOO_MANY_REQUESTS', message: '登录尝试过多，请 15 分钟后再试' } }
      });
      const app = buildApp(limiter, '/login');

      await request(app).get('/login');
      const blocked = await request(app).get('/login');

      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({
        error: { code: 'TOO_MANY_REQUESTS', message: '登录尝试过多，请 15 分钟后再试' }
      });
    });
  });
});
