const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

process.env.JWT_SECRET = 'test-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.JWT_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';

// Mock User model
const mockUser = {
  _id: 'user123',
  username: 'alice',
  email: 'alice@test.com',
  password: 'hashed',
  refreshToken: null,
  save: jest.fn().mockResolvedValue(true),
  comparePassword: jest.fn(),
};

jest.mock('../models/User', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
}));

jest.mock('../services/email.service', () => ({
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
}));

const User = require('../models/User');
const ctrl = require('../controllers/auth.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const errorHandler = require('../middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Auth routes (simplified, no validation middleware for unit tests)
  app.post('/api/auth/register', ctrl.register);
  app.post('/api/auth/login', ctrl.login);
  app.post('/api/auth/refresh', ctrl.refresh);
  app.post('/api/auth/logout', authenticateToken, ctrl.logout);
  app.get('/api/auth/me', authenticateToken, ctrl.me);
  app.post('/api/auth/forgot-password', ctrl.forgotPassword);
  app.post('/api/auth/reset-password/:token', ctrl.resetPassword);
  app.use(errorHandler);
  return app;
}

describe('auth.controller', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    mockUser.save.mockResolvedValue(true);
  });

  describe('POST /api/auth/register', () => {
    it('creates user and returns accessToken + cookie', async () => {
      User.findOne.mockResolvedValue(null); // no existing user
      User.create.mockResolvedValue({ ...mockUser, save: mockUser.save });

      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'alice', email: 'alice@test.com', password: '123456' });

      expect(res.status).toBe(201);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('returns 400 when user already exists', async () => {
      User.findOne.mockResolvedValue(mockUser);

      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'alice', email: 'alice@test.com', password: '123456' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('DUPLICATE_ERROR');
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns accessToken on valid credentials', async () => {
      const loginUser = { ...mockUser, comparePassword: jest.fn().mockResolvedValue(true), save: jest.fn().mockResolvedValue(true) };
      User.findOne.mockResolvedValue(loginUser);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'alice@test.com', password: '123456' });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
    });

    it('returns 401 on wrong password', async () => {
      const loginUser = { ...mockUser, comparePassword: jest.fn().mockResolvedValue(false) };
      User.findOne.mockResolvedValue(loginUser);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'alice@test.com', password: 'wrong' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('returns 401 when user not found', async () => {
      User.findOne.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@test.com', password: '123456' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('returns new accessToken on valid refresh cookie', async () => {
      const refreshToken = jwt.sign({ userId: 'user123' }, process.env.JWT_REFRESH_SECRET);
      const refreshUser = { ...mockUser, refreshToken, save: jest.fn().mockResolvedValue(true) };
      User.findById.mockResolvedValue(refreshUser);

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', `refreshToken=${refreshToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
    });

    it('returns 401 when no refresh cookie', async () => {
      const res = await request(app).post('/api/auth/refresh');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('NO_TOKEN');
    });

    it('returns 401 when refresh token does not match stored token', async () => {
      const refreshToken = jwt.sign({ userId: 'user123' }, process.env.JWT_REFRESH_SECRET);
      const refreshUser = { ...mockUser, refreshToken: 'different-token' };
      User.findById.mockResolvedValue(refreshUser);

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', `refreshToken=${refreshToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears refreshToken and cookie', async () => {
      const logoutUser = { ...mockUser, save: jest.fn().mockResolvedValue(true) };
      User.findById.mockResolvedValue(logoutUser);
      const token = jwt.sign({ userId: 'user123', username: 'alice' }, process.env.JWT_SECRET);

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe('已登出');
      expect(logoutUser.refreshToken).toBeNull();
    });

    it('returns 401 when not authenticated', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns current user', async () => {
      User.findById.mockResolvedValue(mockUser);
      const token = jwt.sign({ userId: 'user123', username: 'alice' }, process.env.JWT_SECRET);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.user.username).toBe('alice');
    });

    it('returns 404 when user not found', async () => {
      User.findById.mockResolvedValue(null);
      const token = jwt.sign({ userId: 'deleted', username: 'ghost' }, process.env.JWT_SECRET);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/auth/forgot-password', () => {
    it('returns success even when email not found (prevents enumeration)', async () => {
      User.findOne.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'nobody@test.com' });

      expect(res.status).toBe(200);
      expect(res.body.data.message).toContain('如果该邮箱已注册');
    });

    it('generates reset token and sends email for existing user', async () => {
      const forgotUser = { ...mockUser, save: jest.fn().mockResolvedValue(true) };
      User.findOne.mockResolvedValue(forgotUser);
      const { sendPasswordResetEmail } = require('../services/email.service');

      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'alice@test.com' });

      expect(res.status).toBe(200);
      expect(forgotUser.resetPasswordToken).toBeDefined();
      expect(sendPasswordResetEmail).toHaveBeenCalledWith('alice@test.com', expect.any(String));
    });
  });

  describe('POST /api/auth/reset-password/:token', () => {
    it('resets password with valid token', async () => {
      const resetUser = { ...mockUser, save: jest.fn().mockResolvedValue(true) };
      User.findOne.mockResolvedValue(resetUser);

      const res = await request(app)
        .post('/api/auth/reset-password/valid-token')
        .send({ password: 'newpassword' });

      expect(res.status).toBe(200);
      expect(resetUser.password).toBe('newpassword');
      expect(resetUser.resetPasswordToken).toBeNull();
      expect(resetUser.refreshToken).toBeNull();
    });

    it('returns 400 when password too short', async () => {
      const res = await request(app)
        .post('/api/auth/reset-password/valid-token')
        .send({ password: '123' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when token invalid or expired', async () => {
      User.findOne.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/auth/reset-password/expired-token')
        .send({ password: 'newpassword' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
    });
  });
});
