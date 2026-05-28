const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const ctrl = require('../controllers/auth.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { authLimiter } = require('../middleware/rateLimiter');

// P9 cutover gate: when REGISTER_DISABLED is truthy, short-circuit the
// /register route with 503 BEFORE the rate limiter so the disabled state
// does not consume per-IP buckets. Read the env on every request so an
// operator flip + `docker compose restart` takes effect without a code change.
function registerDisabledGate(req, res, next) {
  if (process.env.REGISTER_DISABLED) {
    return res.status(503).json({ error: 'Registration temporarily disabled for scheduled maintenance' });
  }
  next();
}

const registerRules = [
  body('username').trim().isLength({ min: 3, max: 50 }).withMessage('用户名需 3-50 个字符'),
  body('email').isEmail().withMessage('邮箱格式不正确'),
  body('password').isLength({ min: 6 }).withMessage('密码至少 6 位')
];

const loginRules = [
  body('email').isEmail().withMessage('邮箱格式不正确'),
  body('password').notEmpty().withMessage('密码不能为空')
];

router.post('/register',                registerDisabledGate, authLimiter, registerRules, ctrl.register);
router.post('/login',                   authLimiter, loginRules,    ctrl.login);
router.post('/refresh',                 authLimiter, ctrl.refresh);
router.post('/logout',                  authenticateToken, ctrl.logout);
router.get('/me',                       authenticateToken, ctrl.me);
router.post('/forgot-password',         authLimiter, ctrl.forgotPassword);
router.post('/reset-password/:token',   authLimiter, ctrl.resetPassword);

module.exports = router;
