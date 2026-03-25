const Follow = require('../models/Follow');
const User   = require('../models/User');

// POST /api/users/:username/follow  — requires auth
exports.follow = async (req, res, next) => {
  try {
    const followee = await User.findOne({ username: req.params.username });
    if (!followee) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '用户不存在' } });

    if (followee._id.toString() === req.user.userId) {
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

// GET /api/users/:username/followers?page=1
exports.getFollowers = async (req, res, next) => {
  try {
    const user = await User.findOne({ username: req.params.username }).select('_id');
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '用户不存在' } });

    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const skip  = (page - 1) * limit;

    const [follows, total] = await Promise.all([
      Follow.find({ followeeId: user._id })
        .populate('followerId', 'username')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Follow.countDocuments({ followeeId: user._id }),
    ]);

    const data = follows.filter(f => f.followerId).map(f => ({ username: f.followerId.username }));
    res.json({ data, total, page });
  } catch (err) { next(err); }
};

// GET /api/users/:username/following?page=1
exports.getFollowing = async (req, res, next) => {
  try {
    const user = await User.findOne({ username: req.params.username }).select('_id');
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '用户不存在' } });

    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const skip  = (page - 1) * limit;

    const [follows, total] = await Promise.all([
      Follow.find({ followerId: user._id })
        .populate('followeeId', 'username')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Follow.countDocuments({ followerId: user._id }),
    ]);

    const data = follows.filter(f => f.followeeId).map(f => ({ username: f.followeeId.username }));
    res.json({ data, total, page });
  } catch (err) { next(err); }
};
