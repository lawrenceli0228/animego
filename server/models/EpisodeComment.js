const mongoose = require('mongoose');

const episodeCommentSchema = new mongoose.Schema({
  anilistId: { type: Number, required: true },
  episode:   { type: Number, required: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username:  { type: String, required: true },
  content:   { type: String, required: true, maxlength: 500 },
}, { timestamps: true });

episodeCommentSchema.index({ anilistId: 1, episode: 1 });
episodeCommentSchema.index({ userId: 1 });

module.exports = mongoose.model('EpisodeComment', episodeCommentSchema);
