const mongoose = require('mongoose');

const danmakuSchema = new mongoose.Schema({
  anilistId:  { type: Number, required: true },
  episode:    { type: Number, required: true },
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username:   { type: String, required: true },
  content:    { type: String, required: true, maxlength: 50 },
  liveEndsAt: { type: Date, required: true },
}, { timestamps: true });

danmakuSchema.index({ anilistId: 1, episode: 1, createdAt: 1 });
danmakuSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 }); // auto-delete after 1 year

module.exports = mongoose.model('Danmaku', danmakuSchema);
