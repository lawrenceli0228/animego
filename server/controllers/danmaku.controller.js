const Danmaku = require('../models/Danmaku');

exports.getDanmaku = async (req, res, next) => {
  try {
    const anilistId = parseInt(req.params.anilistId);
    const episode   = parseInt(req.params.episode);

    if (isNaN(anilistId) || isNaN(episode)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid params' } });
    }

    const danmakus = await Danmaku.find({ anilistId, episode })
      .sort({ createdAt: 1 })
      .select('username content createdAt liveEndsAt')
      .lean();

    const liveEndsAt = danmakus.length > 0 ? danmakus[0].liveEndsAt : null;

    res.json({ data: danmakus, liveEndsAt });
  } catch (err) {
    next(err);
  }
};
