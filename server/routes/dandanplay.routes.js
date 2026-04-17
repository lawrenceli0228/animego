const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/dandanplay.controller');

// Pass-through proxy for public dandanplay data. No user-scoped state, so no auth.
// IP-level apiLimiter (server/middleware/rateLimiter.js) already bounds abuse.
router.post('/match',                  ctrl.match);
router.get('/search',                  ctrl.search);
router.get('/comments/:episodeId',     ctrl.getComments);
router.get('/episodes/:animeId',       ctrl.getEpisodes);

module.exports = router;
