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
  cachedAt:       { type: Date, default: Date.now },
  // Phase 4 AniList fields
  studios:         [String],
  relations:       [{ anilistId: Number, relationType: String, title: String }],
  startDate:       { year: Number, month: Number, day: Number },
  duration:        Number,
  source:          String,
  // Bangumi enrichment
  titleChinese:    { type: String,  default: null },
  bgmId:           { type: Number,  default: null },
  bangumiScore:    Number,
  bangumiVotes:    Number,
  // 0 = unenriched, 1 = Phase 1-3 basic (title+bgmId), 2 = Phase 4 full (score+detail)
  bangumiVersion:  { type: Number,  default: 0 },
  // Phase 4 rich fields
  characters:    [{ nameEn: String, nameJa: String, nameCn: String, imageUrl: String, voiceActorEn: String, voiceActorJa: String, voiceActorCn: String }],
  staff:         [{ nameEn: String, nameJa: String, imageUrl: String, role: String }],
  recommendations: [{ anilistId: Number, title: String, coverImageUrl: String, averageScore: Number }],
  episodeTitles: [{ episode: Number, nameCn: String, name: String }]
});

animeCacheSchema.index({ season: 1, seasonYear: 1 });
animeCacheSchema.index({ genres: 1 });

module.exports = mongoose.model('AnimeCache', animeCacheSchema);
