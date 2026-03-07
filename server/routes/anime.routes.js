const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/anime.controller');

router.get('/seasonal', ctrl.getSeasonal);
router.get('/search',   ctrl.search);
router.get('/:anilistId', ctrl.getDetail);

module.exports = router;
