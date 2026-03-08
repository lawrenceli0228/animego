const EpisodeComment = require('../models/EpisodeComment');

// GET /api/comments/:anilistId/:episode
exports.getComments = async (req, res, next) => {
  try {
    const { anilistId, episode } = req.params;
    const comments = await EpisodeComment
      .find({ anilistId: Number(anilistId), episode: Number(episode) })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ data: comments });
  } catch (err) { next(err); }
};

// POST /api/comments/:anilistId/:episode  (auth required)
exports.addComment = async (req, res, next) => {
  try {
    const { anilistId, episode } = req.params;
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Content is required' } });
    }
    if (content.length > 500) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Content too long' } });
    }
    const comment = await EpisodeComment.create({
      anilistId: Number(anilistId),
      episode:   Number(episode),
      userId:    req.user.userId,
      username:  req.user.username,
      content:   content.trim(),
    });
    res.status(201).json({ data: comment });
  } catch (err) { next(err); }
};

// DELETE /api/comments/:id  (auth required, own comment only)
exports.deleteComment = async (req, res, next) => {
  try {
    const comment = await EpisodeComment.findById(req.params.id);
    if (!comment) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Comment not found' } });
    if (comment.userId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not your comment' } });
    }
    await comment.deleteOne();
    res.json({ data: { success: true } });
  } catch (err) { next(err); }
};
