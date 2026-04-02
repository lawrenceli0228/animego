const Danmaku = require('../models/Danmaku');
const EpisodeWindow = require('../models/EpisodeWindow');

exports.getDanmaku = async (req, res, next) => {
  try {
    const anilistId = parseInt(req.params.anilistId);
    const episode   = parseInt(req.params.episode);

    if (isNaN(anilistId) || isNaN(episode)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid params' } });
    }

    const [danmakus, win] = await Promise.all([
      Danmaku.find({ anilistId, episode })
        .sort({ createdAt: -1 })
        .limit(500)
        .select('username content createdAt')
        .lean()
        .then(docs => docs.reverse()), // return up to 500 most recent in chronological order
      EpisodeWindow.findOne({ anilistId, episode }).lean(),
    ]);

    const liveEndsAt = win?.liveEndsAt ?? null;

    res.json({ data: danmakus, liveEndsAt });
  } catch (err) {
    next(err);
  }
};
