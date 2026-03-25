const express = require('express');
const router  = express.Router();
const followCtrl  = require('../controllers/follow.controller');
const profileCtrl = require('../controllers/profile.controller');
const { authenticateToken, optionalAuth } = require('../middleware/auth.middleware');

// Public profile (optionalAuth attaches req.user if token present, otherwise null)
router.get('/:username',            optionalAuth,    profileCtrl.getProfile);

// Follow / unfollow (auth required)
router.post('/:username/follow',    authenticateToken, followCtrl.follow);
router.delete('/:username/follow',  authenticateToken, followCtrl.unfollow);

// Followers / following lists (public)
router.get('/:username/followers',  followCtrl.getFollowers);
router.get('/:username/following',  followCtrl.getFollowing);

module.exports = router;
