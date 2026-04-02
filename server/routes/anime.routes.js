const express = require('express');
const router = express.Router();
const ctrl   = require('../controllers/anime.controller');
const detail = require('../controllers/detail.controller');

router.get('/seasonal', ctrl.getSeasonal);
router.get('/search',   ctrl.search);
router.get('/schedule', ctrl.getSchedule);  // must be before /:anilistId
router.get('/torrents', ctrl.getTorrents);  // must be before /:anilistId
router.get('/trending', ctrl.getTrending); // must be before /:anilistId
router.get('/:anilistId/watchers', ctrl.getWatchers);
router.get('/:anilistId', detail.getDetail);

module.exports = router;
