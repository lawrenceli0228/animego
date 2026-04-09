const { validationResult } = require('express-validator');
const Subscription = require('../models/Subscription');
const AnimeCache   = require('../models/AnimeCache');
const anilistService = require('../services/anilist.service');

// GET /api/subscriptions
exports.getAll = async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = { userId: req.user.userId };
    if (status) filter.status = status;

    const subs = await Subscription.find(filter).sort({ updatedAt: -1 });
    const anilistIds = subs.map(s => s.anilistId);
    const animes = await AnimeCache.find({ anilistId: { $in: anilistIds } });
    const animeMap = Object.fromEntries(animes.map(a => [a.anilistId, a]));

    const result = subs.map(s => ({
      ...animeMap[s.anilistId]?.toObject() || { anilistId: s.anilistId },
      subscriptionId: s._id,
      status: s.status,
      currentEpisode: s.currentEpisode,
      score: s.score,
      lastWatchedAt: s.lastWatchedAt,
      subscribedAt: s.createdAt
    }));

    res.json({ data: result });
  } catch (err) { next(err); }
};

// GET /api/subscriptions/:anilistId
exports.getOne = async (req, res, next) => {
  try {
    const sub = await Subscription.findOne({
      userId: req.user.userId,
      anilistId: parseInt(req.params.anilistId)
    });
    if (!sub) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '未找到订阅' } });
    res.json({ data: sub });
  } catch (err) { next(err); }
};

// POST /api/subscriptions
exports.create = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: errors.array()[0].msg } });
    }

    const { anilistId, status } = req.body;

    // Ensure anime exists in cache
    await anilistService.getAnimeDetail(anilistId);

    const sub = await Subscription.findOneAndUpdate(
      { userId: req.user.userId, anilistId: parseInt(anilistId) },
      { status },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).json({ data: sub });
  } catch (err) { next(err); }
};

// PATCH /api/subscriptions/:anilistId
exports.update = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: errors.array()[0].msg } });
    }

    const { status, currentEpisode, score } = req.body;
    const updates = {};
    if (status !== undefined) updates.status = status;
    if (currentEpisode !== undefined) {
      updates.currentEpisode = currentEpisode;
      updates.lastWatchedAt = new Date();
    }
    if (score !== undefined) {
      updates.score = score === null ? null : Math.min(10, Math.max(1, Math.round(score)));
    }

    const sub = await Subscription.findOneAndUpdate(
      { userId: req.user.userId, anilistId: parseInt(req.params.anilistId) },
      updates,
      { new: true }
    );
    if (!sub) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '未找到订阅' } });
    res.json({ data: sub });
  } catch (err) { next(err); }
};

// DELETE /api/subscriptions/:anilistId
exports.remove = async (req, res, next) => {
  try {
    const sub = await Subscription.findOneAndDelete({
      userId: req.user.userId,
      anilistId: parseInt(req.params.anilistId)
    });
    if (!sub) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '未找到订阅' } });
    res.json({ data: { message: '已删除' } });
  } catch (err) { next(err); }
};
