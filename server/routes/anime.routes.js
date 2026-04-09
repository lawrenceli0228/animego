const express = require('express');
const router = express.Router();
const ctrl   = require('../controllers/anime.controller');
const detail = require('../controllers/detail.controller');

router.get('/seasonal',       ctrl.getSeasonal);
router.get('/search',         ctrl.search);
router.get('/schedule',       ctrl.getSchedule);
router.get('/torrents',       ctrl.getTorrents);
router.get('/trending',       ctrl.getTrending);
router.get('/yearly-top',     ctrl.getYearlyTop);
router.get('/completed-gems', ctrl.getCompletedGems);
router.get('/:anilistId/watchers', ctrl.getWatchers);
router.get('/:anilistId', detail.getDetail);

module.exports = router;
