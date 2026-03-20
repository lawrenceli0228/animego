const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { validationResult } = require('express-validator');
const User = require('../models/User');
const { sendPasswordResetEmail } = require('../services/email.service');

const signTokens = (userId, username) => {
  const accessToken = jwt.sign(
    { userId, username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  const refreshToken = jwt.sign(
    { userId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
  return { accessToken, refreshToken };
};

const setRefreshCookie = (res, token) => {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('refreshToken', token, {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'strict',
    secure: isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
};

// POST /api/auth/register
exports.register = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: errors.array()[0].msg } });
    }

    const { username, email, password } = req.body;
    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      return res.status(400).json({ error: { code: 'DUPLICATE_ERROR', message: '用户名或邮箱已存在' } });
    }

    const user = await User.create({ username, email, password });
    const { accessToken, refreshToken } = signTokens(user._id, user.username);

    user.refreshToken = refreshToken;
    await user.save();

    setRefreshCookie(res, refreshToken);
    res.status(201).json({ data: { accessToken, user } });
  } catch (err) { next(err); }
};

// POST /api/auth/login
exports.login = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: errors.array()[0].msg } });
    }

    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' } });
    }

    const { accessToken, refreshToken } = signTokens(user._id, user.username);
    user.refreshToken = refreshToken;
    await user.save();

    setRefreshCookie(res, refreshToken);
    res.json({ data: { accessToken, user } });
  } catch (err) { next(err); }
};

// POST /api/auth/refresh
exports.refresh = async (req, res, next) => {
  try {
    const token = req.cookies.refreshToken;
    if (!token) {
      return res.status(401).json({ error: { code: 'NO_TOKEN', message: '需要重新登录' } });
    }
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user || user.refreshToken !== token) {
      return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: '无效的 token' } });
    }

    const { accessToken, refreshToken } = signTokens(user._id, user.username);
    user.refreshToken = refreshToken;
    await user.save();

    setRefreshCookie(res, refreshToken);
    res.json({ data: { accessToken } });
  } catch (err) { next(err); }
};

// POST /api/auth/logout
exports.logout = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (user) { user.refreshToken = null; await user.save(); }
    res.clearCookie('refreshToken');
    res.json({ data: { message: '已登出' } });
  } catch (err) { next(err); }
};

// GET /api/auth/me
exports.me = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '用户不存在' } });
    res.json({ data: { user } });
  } catch (err) { next(err); }
};

// POST /api/auth/forgot-password
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    // Always return success to prevent email enumeration
    if (!user) {
      return res.json({ data: { message: '如果该邮箱已注册，你将收到重置链接' } });
    }

    // Generate secure token
    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken   = token;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    await sendPasswordResetEmail(user.email, token);
    res.json({ data: { message: '如果该邮箱已注册，你将收到重置链接' } });
  } catch (err) { next(err); }
};

// POST /api/auth/reset-password/:token
exports.resetPassword = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '密码至少 6 位' } });
    }

    const user = await User.findOne({
      resetPasswordToken:   token,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ error: { code: 'INVALID_TOKEN', message: '链接无效或已过期，请重新申请' } });
    }

    user.password             = password; // pre-save hook will hash it
    user.resetPasswordToken   = null;
    user.resetPasswordExpires = null;
    user.refreshToken         = null;     // invalidate all sessions
    await user.save();

    res.json({ data: { message: '密码已重置，请重新登录' } });
  } catch (err) { next(err); }
};
