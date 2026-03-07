const mongoose = require('mongoose');

const animeCacheSchema = new mongoose.Schema({
  anilistId:      { type: Number, required: true, unique: true },
  titleRomaji:    String,
  titleEnglish:   String,
  titleNative:    String,
  coverImageUrl:  String,
  bannerImageUrl: String,
  description:    String,
  episodes:       Number,
  status:         String,  // RELEASING, FINISHED, NOT_YET_RELEASED, CANCELLED
  season:         String,  // WINTER, SPRING, SUMMER, FALL
  seasonYear:     Number,
  averageScore:   Number,
  genres:         [String],
  format:         String,  // TV, OVA, MOVIE, SPECIAL, ONA, MUSIC
  cachedAt:       { type: Date, default: Date.now }
});

animeCacheSchema.index({ season: 1, seasonYear: 1 });
animeCacheSchema.index({ genres: 1 });

module.exports = mongoose.model('AnimeCache', animeCacheSchema);
