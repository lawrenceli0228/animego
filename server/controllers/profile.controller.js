const User         = require('../models/User');
const Subscription = require('../models/Subscription');
const AnimeCache   = require('../models/AnimeCache');
const Follow       = require('../models/Follow');

// GET /api/users/:username  — public profile + watching list
exports.getProfile = async (req, res, next) => {
  try {
    const user = await User.findOne({ username: req.params.username }).select('username createdAt');
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '用户不存在' } });

    const requesterId = req.user?.userId;

    const [subs, followerCount, followingCount, isFollowing] = await Promise.all([
      Subscription.find({ userId: user._id }).sort({ updatedAt: -1 }),
      Follow.countDocuments({ followeeId: user._id }),
      Follow.countDocuments({ followerId: user._id }),
      requesterId
        ? Follow.exists({ followerId: requesterId, followeeId: user._id })
        : Promise.resolve(null),
    ]);

    const anilistIds = subs.map(s => s.anilistId);
    const animes     = await AnimeCache.find({ anilistId: { $in: anilistIds } });
    const animeMap   = Object.fromEntries(animes.map(a => [a.anilistId, a]));

    const watching = subs.map(s => ({
      ...(animeMap[s.anilistId]?.toObject() || { anilistId: s.anilistId }),
      subscriptionStatus: s.status,
      currentEpisode:     s.currentEpisode,
      lastWatchedAt:      s.lastWatchedAt,
    }));

    res.json({
      data: {
        username:       user.username,
        createdAt:      user.createdAt,
        followerCount,
        followingCount,
        isFollowing:    isFollowing !== null ? !!isFollowing : null,
        watching,
      }
    });
  } catch (err) { next(err); }
};

// GET /api/feed  — activity feed of followed users (requires auth)
exports.getFeed = async (req, res, next) => {
  try {
    const follows    = await Follow.find({ followerId: req.user.userId }).select('followeeId');
    const followeeIds = follows.map(f => f.followeeId);

    if (followeeIds.length === 0) return res.json({ data: [] });

    const recentSubs = await Subscription.find({
      userId:       { $in: followeeIds },
      lastWatchedAt: { $ne: null },
    })
      .populate('userId', 'username')
      .sort({ lastWatchedAt: -1 })
      .limit(40);

    const anilistIds = [...new Set(recentSubs.map(s => s.anilistId))];
    const animes     = await AnimeCache.find({ anilistId: { $in: anilistIds } });
    const animeMap   = Object.fromEntries(animes.map(a => [a.anilistId, a]));

    const data = recentSubs
      .filter(s => s.userId)
      .map(s => ({
        username:      s.userId.username,
        anilistId:     s.anilistId,
        title:         animeMap[s.anilistId]?.titleRomaji   || `Anime #${s.anilistId}`,
        titleChinese:  animeMap[s.anilistId]?.titleChinese  || null,
        coverImageUrl: animeMap[s.anilistId]?.coverImageUrl || null,
        episode:       s.currentEpisode,
        status:        s.status,
        lastWatchedAt: s.lastWatchedAt,
      }));

    res.json({ data });
  } catch (err) { next(err); }
};
