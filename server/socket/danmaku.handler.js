const Danmaku = require('../models/Danmaku');

const lastSent = new Map(); // userId -> lastSentAt (in-memory rate limit)
const RATE_LIMIT_MS  = 5000;
const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

module.exports = function registerDanmakuHandlers(io, socket) {
  const userId = String(socket.user.id);

  socket.on('danmaku:join', ({ anilistId, episode }) => {
    socket.join(`danmaku:${anilistId}:${episode}`);
  });

  socket.on('danmaku:leave', ({ anilistId, episode }) => {
    socket.leave(`danmaku:${anilistId}:${episode}`);
  });

  socket.on('danmaku:send', async ({ anilistId, episode, content }) => {
    try {
      const now = Date.now();

      // Rate limit
      if (now - (lastSent.get(userId) ?? 0) < RATE_LIMIT_MS) return;
      lastSent.set(userId, now);

      // Validate
      if (!content || typeof content !== 'string') return;
      const trimmed = content.trim().slice(0, 50);
      if (!trimmed) return;

      const anilistIdNum = parseInt(anilistId);
      const episodeNum   = parseInt(episode);
      if (isNaN(anilistIdNum) || isNaN(episodeNum)) return;

      // Determine liveEndsAt from first danmaku in this episode, or start new window
      const earliest = await Danmaku.findOne(
        { anilistId: anilistIdNum, episode: episodeNum },
        { liveEndsAt: 1 },
        { sort: { createdAt: 1 } }
      ).lean();

      const liveEndsAt = earliest ? earliest.liveEndsAt : new Date(now + LIVE_WINDOW_MS);

      // Reject if window closed
      if (now > liveEndsAt.getTime()) return;

      const danmaku = await Danmaku.create({
        anilistId: anilistIdNum,
        episode:   episodeNum,
        userId:    socket.user.id,
        username:  socket.user.username,
        content:   trimmed,
        liveEndsAt,
      });

      io.to(`danmaku:${anilistIdNum}:${episodeNum}`).emit('danmaku:new', {
        _id:      danmaku._id,
        username: danmaku.username,
        content:  danmaku.content,
        createdAt: danmaku.createdAt,
      });
    } catch (err) {
      console.error('danmaku:send error', err.message);
    }
  });
};
