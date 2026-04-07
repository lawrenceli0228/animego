const AnimeCache = require('../models/AnimeCache');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const Follow = require('../models/Follow');
const { enqueueEnrichment } = require('../services/bangumi.service');

// GET /api/admin/stats
exports.getStats = async (req, res, next) => {
  try {
    const [
      totalUsers,
      totalAnime,
      enrichV0,
      enrichV1,
      enrichV2,
      flaggedCount,
      totalSubs,
      totalFollows,
    ] = await Promise.all([
      User.countDocuments(),
      AnimeCache.countDocuments(),
      AnimeCache.countDocuments({ bangumiVersion: 0 }),
      AnimeCache.countDocuments({ bangumiVersion: 1 }),
      AnimeCache.countDocuments({ bangumiVersion: { $gte: 2 } }),
      AnimeCache.countDocuments({ adminFlag: { $ne: null } }),
      Subscription.countDocuments(),
      Follow.countDocuments(),
    ]);

    res.json({
      data: {
        users: totalUsers,
        anime: totalAnime,
        enrichment: { v0: enrichV0, v1: enrichV1, v2: enrichV2 },
        flagged: flaggedCount,
        subscriptions: totalSubs,
        follows: totalFollows,
      },
    });
  } catch (err) { next(err); }
};

// GET /api/admin/enrichment?page=1&filter=needs-review&q=keyword
exports.listEnrichment = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 30;
    const skip  = (page - 1) * limit;

    const filter = {};
    const f = req.query.filter;
    if (f === 'needs-review')            filter.adminFlag = 'needs-review';
    else if (f === 'manually-corrected') filter.adminFlag = 'manually-corrected';
    else if (f === 'unenriched')         filter.bangumiVersion = 0;

    // Search by title or anilistId
    const q = (req.query.q || '').trim();
    if (q) {
      const num = parseInt(q, 10);
      if (!isNaN(num) && String(num) === q) {
        filter.anilistId = num;
      } else {
        const regex = { $regex: q, $options: 'i' };
        filter.$or = [{ titleRomaji: regex }, { titleChinese: regex }, { titleNative: regex }];
      }
    }

    const [items, total] = await Promise.all([
      AnimeCache.find(filter)
        .select('anilistId titleRomaji titleChinese bgmId bangumiVersion bangumiScore adminFlag')
        .sort({ cachedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AnimeCache.countDocuments(filter),
    ]);

    const hasMore = skip + limit < total;
    res.json({ data: items, hasMore, total, page });
  } catch (err) { next(err); }
};

// POST /api/admin/enrichment/:anilistId/reset
exports.resetEnrichment = async (req, res, next) => {
  try {
    const anilistId = parseInt(req.params.anilistId, 10);
    if (!anilistId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '无效的 anilistId' } });

    const doc = await AnimeCache.findOne({ anilistId });
    if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '番剧不存在' } });

    // Reset enrichment fields
    doc.bangumiVersion = 0;
    doc.titleChinese   = null;
    doc.bgmId          = null;
    doc.bangumiScore   = undefined;
    doc.bangumiVotes   = undefined;
    doc.episodeTitles  = undefined;
    doc.characters     = undefined;
    doc.adminFlag      = null;
    await doc.save();

    // Re-enqueue with priority so it processes next
    enqueueEnrichment([{
      anilistId:   doc.anilistId,
      titleNative: doc.titleNative,
      titleRomaji: doc.titleRomaji,
      bangumiVersion: 0,
    }], true);

    console.log(`[Admin] ${req.user.username} reset enrichment for anilistId=${anilistId}`);
    res.json({ data: { anilistId, reset: true } });
  } catch (err) { next(err); }
};

// POST /api/admin/enrichment/:anilistId/flag
exports.flagEnrichment = async (req, res, next) => {
  try {
    const anilistId = parseInt(req.params.anilistId, 10);
    if (!anilistId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '无效的 anilistId' } });

    const { flag } = req.body;
    const allowed = ['needs-review', 'manually-corrected', null];
    if (!allowed.includes(flag)) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '无效的 flag 值' } });
    }

    const doc = await AnimeCache.findOneAndUpdate(
      { anilistId },
      { adminFlag: flag },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '番剧不存在' } });

    console.log(`[Admin] ${req.user.username} flagged anilistId=${anilistId} as ${flag}`);
    res.json({ data: { anilistId, adminFlag: flag } });
  } catch (err) { next(err); }
};

// ==================== User Management ====================

// GET /api/admin/users?page=1&q=keyword
exports.listUsers = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 30;
    const skip  = (page - 1) * limit;

    const filter = {};
    const q = (req.query.q || '').trim();
    if (q) {
      const regex = { $regex: q, $options: 'i' };
      filter.$or = [{ username: regex }, { email: regex }];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('username email role createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    // Batch fetch subscription and follow counts
    const userIds = users.map(u => u._id);
    const [subCounts, followerCounts] = await Promise.all([
      Subscription.aggregate([
        { $match: { userId: { $in: userIds } } },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
      ]),
      Follow.aggregate([
        { $match: { followeeId: { $in: userIds } } },
        { $group: { _id: '$followeeId', count: { $sum: 1 } } },
      ]),
    ]);

    const subMap = Object.fromEntries(subCounts.map(s => [s._id.toString(), s.count]));
    const followerMap = Object.fromEntries(followerCounts.map(f => [f._id.toString(), f.count]));

    const data = users.map(u => ({
      ...u,
      subscriptions: subMap[u._id.toString()] || 0,
      followers: followerMap[u._id.toString()] || 0,
    }));

    const hasMore = skip + limit < total;
    res.json({ data, hasMore, total, page });
  } catch (err) { next(err); }
};

// POST /api/admin/users
exports.createUser = async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '用户名、邮箱和密码为必填项' } });
    }

    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) {
      const field = existing.username === username ? '用户名' : '邮箱';
      return res.status(409).json({ error: { code: 'CONFLICT', message: `${field}已存在` } });
    }

    const user = await User.create({ username, email, password });
    console.log(`[Admin] ${req.user.username} created user ${username}`);
    res.status(201).json({ data: { _id: user._id, username: user.username, email: user.email } });
  } catch (err) { next(err); }
};

// PATCH /api/admin/users/:userId
exports.updateUser = async (req, res, next) => {
  try {
    const { username, email } = req.body;
    if (!username && !email) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '至少提供用户名或邮箱' } });
    }

    const updates = {};
    if (username) updates.username = username;
    if (email) updates.email = email;

    // Check for duplicates
    const conditions = [];
    if (username) conditions.push({ username });
    if (email) conditions.push({ email });
    const dup = await User.findOne({ $or: conditions, _id: { $ne: req.params.userId } });
    if (dup) {
      const field = dup.username === username ? '用户名' : '邮箱';
      return res.status(409).json({ error: { code: 'CONFLICT', message: `${field}已存在` } });
    }

    const user = await User.findByIdAndUpdate(req.params.userId, updates, { new: true })
      .select('username email role createdAt');
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '用户不存在' } });

    console.log(`[Admin] ${req.user.username} updated user ${user.username}`);
    res.json({ data: user });
  } catch (err) { next(err); }
};

// DELETE /api/admin/users/:userId
exports.deleteUser = async (req, res, next) => {
  try {
    // Prevent self-deletion
    if (req.params.userId === req.user.userId) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '不能删除自己' } });
    }

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '用户不存在' } });

    // Cascade delete related data
    await Promise.all([
      Subscription.deleteMany({ userId: user._id }),
      Follow.deleteMany({ $or: [{ followerId: user._id }, { followeeId: user._id }] }),
      User.deleteOne({ _id: user._id }),
    ]);

    console.log(`[Admin] ${req.user.username} deleted user ${user.username}`);
    res.json({ data: { deleted: true, username: user.username } });
  } catch (err) { next(err); }
};
