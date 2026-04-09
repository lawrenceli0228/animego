const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  anilistId:      { type: Number, required: true },
  status:         {
    type: String,
    enum: ['watching', 'completed', 'plan_to_watch', 'dropped'],
    required: true
  },
  currentEpisode: { type: Number, default: 0, min: 0 },
  score:          { type: Number, default: null, min: 1, max: 10 },
  lastWatchedAt:  { type: Date, default: null }
}, { timestamps: true });

// One subscription per user per anime
subscriptionSchema.index({ userId: 1, anilistId: 1 }, { unique: true });
subscriptionSchema.index({ userId: 1, status: 1 });
subscriptionSchema.index({ anilistId: 1 });  // for trending aggregate

module.exports = mongoose.model('Subscription', subscriptionSchema);
