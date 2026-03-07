const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const ctrl = require('../controllers/auth.controller');
const { authenticateToken } = require('../middleware/auth.middleware');
const { authLimiter } = require('../middleware/rateLimiter');

const registerRules = [
  body('username').trim().isLength({ min: 3, max: 50 }).withMessage('用户名需 3-50 个字符'),
  body('email').isEmail().withMessage('邮箱格式不正确'),
  body('password').isLength({ min: 6 }).withMessage('密码至少 6 位')
];

const loginRules = [
  body('email').isEmail().withMessage('邮箱格式不正确'),
  body('password').notEmpty().withMessage('密码不能为空')
];

router.post('/register', authLimiter, registerRules, ctrl.register);
router.post('/login',    authLimiter, loginRules,    ctrl.login);
router.post('/refresh',  ctrl.refresh);
router.post('/logout',   authenticateToken, ctrl.logout);
router.get('/me',        authenticateToken, ctrl.me);

module.exports = router;
