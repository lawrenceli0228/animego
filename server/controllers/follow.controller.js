const Follow = require('../models/Follow');
const User   = require('../models/User');

// POST /api/users/:username/follow  — requires auth
exports.follow = async (req, res, next) => {
  try {
    const followee = await User.findOne({ username: req.params.username });
    if (!followee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '用户不存在' } });

    if (followee._id.equals(req.user.userId)) {
      return res.status(400).json({ error: { code: 'INVALID_ACTION', message: '不能关注自己' } });
    }

    await Follow.findOneAndUpdate(
      { followerId: req.user.userId, followeeId: followee._id },
      {},
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).json({ data: { following: true } });
  } catch (err) { next(err); }
};

// DELETE /api/users/:username/follow  — requires auth
exports.unfollow = async (req, res, next) => {
  try {
    const followee = await User.findOne({ username: req.params.username });
    if (!followee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '用户不存在' } });

    await Follow.findOneAndDelete({ followerId: req.user.userId, followeeId: followee._id });
    res.json({ data: { following: false } });
  } catch (err) { next(err); }
};

// Shared paginator for followers/following
async function paginateFollows(req, res, next, direction) {
  try {
    const user = await User.findOne({ username: req.params.username }).select('_id');
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '用户不存在' } });

    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const skip  = (page - 1) * limit;

    const isFollowers  = direction === 'followers';
    const filterKey    = isFollowers ? 'followeeId' : 'followerId';
    const populateKey  = isFollowers ? 'followerId' : 'followeeId';

    const [follows, total] = await Promise.all([
      Follow.find({ [filterKey]: user._id })
        .populate(populateKey, 'username')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Follow.countDocuments({ [filterKey]: user._id }),
    ]);

    const data    = follows.filter(f => f[populateKey]).map(f => ({ username: f[populateKey].username }));
    const hasMore = skip + limit < total;
    res.json({ data, total, page, hasMore, nextPage: hasMore ? page + 1 : null });
  } catch (err) { next(err); }
}

// GET /api/users/:username/followers?page=1
exports.getFollowers = (req, res, next) => paginateFollows(req, res, next, 'followers');

// GET /api/users/:username/following?page=1
exports.getFollowing = (req, res, next) => paginateFollows(req, res, next, 'following');
