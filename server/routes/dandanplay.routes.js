const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/dandanplay.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

router.post('/match',                  authenticateToken, ctrl.match);
router.get('/search',                  authenticateToken, ctrl.search);
router.get('/comments/:episodeId',     authenticateToken, ctrl.getComments);
router.get('/episodes/:animeId',       authenticateToken, ctrl.getEpisodes);

module.exports = router;
