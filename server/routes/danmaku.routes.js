const express = require('express');
const router  = express.Router();
const danmakuCtrl = require('../controllers/danmaku.controller');

router.get('/:anilistId/:episode', danmakuCtrl.getDanmaku);

module.exports = router;
