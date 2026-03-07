const express = require('express');
const { body } = require('express-validator');
const router = express.Router();
const ctrl = require('../controllers/subscription.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const createRules = [
  body('anilistId').isInt({ min: 1 }).withMessage('无效的番剧 ID'),
  body('status').isIn(['watching', 'completed', 'plan_to_watch', 'dropped']).withMessage('无效的状态')
];

const updateRules = [
  body('status').optional().isIn(['watching', 'completed', 'plan_to_watch', 'dropped']).withMessage('无效的状态'),
  body('currentEpisode').optional().isInt({ min: 0 }).withMessage('集数必须为非负整数')
];

router.use(authenticateToken);

router.get('/',              ctrl.getAll);
router.get('/:anilistId',   ctrl.getOne);
router.post('/',   createRules, ctrl.create);
router.patch('/:anilistId', updateRules, ctrl.update);
router.delete('/:anilistId', ctrl.remove);

module.exports = router;
