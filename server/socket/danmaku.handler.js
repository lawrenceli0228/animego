const Danmaku = require('../models/Danmaku');
const EpisodeWindow = require('../models/EpisodeWindow');

const lastSent = new Map(); // userId -> lastSentAt (in-memory rate limit)
const RATE_LIMIT_MS  = 5000;
const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

module.exports = function registerDanmakuHandlers(io, socket) {
  const userId = String(socket.user.id);

  socket.on('danmaku:join', ({ anilistId, episode }) => {
    const id  = parseInt(anilistId);
    const ep  = parseInt(episode);
    if (isNaN(id) || isNaN(ep) || id <= 0 || ep <= 0) return;
    // Limit per-socket room membership to prevent memory abuse
    const danmakuRooms = [...socket.rooms].filter(r => r.startsWith('danmaku:'));
    if (danmakuRooms.length >= 10) return;
    socket.join(`danmaku:${id}:${ep}`);
  });

  socket.on('danmaku:leave', ({ anilistId, episode }) => {
    const id = parseInt(anilistId);
    const ep = parseInt(episode);
    if (isNaN(id) || isNaN(ep)) return;
    socket.leave(`danmaku:${id}:${ep}`);
  });

  socket.on('danmaku:send', async ({ anilistId, episode, content }) => {
    try {
      const now = Date.now();

      // Rate limit: under attack (>10k concurrent senders) we stop tracking to bound memory;
      // this means rate limiting is intentionally sacrificed during extreme load events.
      if (now - (lastSent.get(userId) ?? 0) < RATE_LIMIT_MS) return;
      if (lastSent.size < 10000) {
        lastSent.set(userId, now);
        // Auto-expire entry so the map stays bounded
        setTimeout(() => { if (lastSent.get(userId) === now) lastSent.delete(userId) }, RATE_LIMIT_MS * 2);
      }

      // Validate
      if (!content || typeof content !== 'string') return;
      const trimmed = content.trim().slice(0, 50);
      if (!trimmed) return;
      if (!socket.user.username || !socket.user.username.trim()) return;

      const anilistIdNum = parseInt(anilistId);
      const episodeNum   = parseInt(episode);
      if (isNaN(anilistIdNum) || isNaN(episodeNum)) return;

      // Atomically get-or-create the live window for this episode (race-safe)
      const win = await EpisodeWindow.findOneAndUpdate(
        { anilistId: anilistIdNum, episode: episodeNum },
        { $setOnInsert: { liveEndsAt: new Date(now + LIVE_WINDOW_MS) } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      const liveEndsAt = win.liveEndsAt;

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
