const mongoose = require('mongoose');

// Stores the canonical live-window expiry for each episode.
// Using a dedicated collection with a unique index ensures the first-danmaku
// race condition cannot create two conflicting liveEndsAt values.
const episodeWindowSchema = new mongoose.Schema({
  anilistId:  { type: Number, required: true },
  episode:    { type: Number, required: true },
  liveEndsAt: { type: Date, required: true },
}, { timestamps: false });

episodeWindowSchema.index({ anilistId: 1, episode: 1 }, { unique: true });
// Note: no TTL index — docs must persist forever so closed windows stay closed (null liveEndsAt → canSend=true re-open bug)

module.exports = mongoose.model('EpisodeWindow', episodeWindowSchema);
