const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/comment.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

// Public
router.get('/:anilistId/:episode', ctrl.getComments);

// Auth required
router.post('/:anilistId/:episode', authenticateToken, ctrl.addComment);
router.delete('/:id', authenticateToken, ctrl.deleteComment);

module.exports = router;
