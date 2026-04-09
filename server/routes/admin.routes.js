const router = require('express').Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const adminAuth = require('../middleware/adminAuth');
const ctrl = require('../controllers/admin.controller');

// All admin routes require auth + admin role
router.use(authenticateToken, adminAuth);

router.get('/stats',                   ctrl.getStats);
router.get('/enrichment',              ctrl.listEnrichment);
router.patch('/enrichment/:anilistId',        ctrl.updateEnrichment);
router.post('/enrichment/heal-cn',              ctrl.healCnTitles);
router.post('/enrichment/heal-cn/pause',        ctrl.pauseHeal);
router.post('/enrichment/heal-cn/resume',       ctrl.resumeHeal);
router.post('/enrichment/:anilistId/reset', ctrl.resetEnrichment);
router.post('/enrichment/:anilistId/flag',  ctrl.flagEnrichment);

router.get('/users',                   ctrl.listUsers);
router.post('/users',                  ctrl.createUser);
router.patch('/users/:userId',         ctrl.updateUser);
router.delete('/users/:userId',        ctrl.deleteUser);

module.exports = router;
