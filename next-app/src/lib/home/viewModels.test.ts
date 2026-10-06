import { describe, expect, test } from "bun:test";
import {
  bangumiScoreText,
  continueCard,
  continueCards,
  episodesText,
  gemCard,
  heroSlide,
  hueCard,
  scoreText,
  seasonCard,
  todayCard,
  trendCard,
  yearCard,
  type AnimeRow,
} from "./viewModels";

const copy = { epUnit: "集", epUnitOne: "集" };

const row = (over: Partial<AnimeRow> = {}): AnimeRow => ({
  anilistId: 1,
  titleChinese: "测试番",
  titleNative: "テスト",
  titleRomaji: "Tesuto",
  titleEnglish: null,
  coverImageUrl: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/1.jpg",
  posterAccent: "#09afd8",
  averageScore: 85,
  bangumiScore: 7.9,
  episodes: 12,
  season: "SUMMER",
  seasonYear: 2026,
  status: "RELEASING",
  format: "TV",
  ...over,
});

describe("score text", () => {
  test("AniList's 0–100 score reads as one decimal", () => {
    expect(scoreText(85)).toBe("8.5");
    expect(scoreText(80)).toBe("8.0");
  });

  test("no score is null, not '0.0' or 'N/A'", () => {
    expect(scoreText(null)).toBeNull();
    expect(scoreText(0)).toBeNull();
    expect(scoreText(undefined)).toBeNull();
  });

  test("Bangumi's 0–10 score keeps one decimal", () => {
    expect(bangumiScoreText(7.85)).toBe("7.9");
    expect(bangumiScoreText(7)).toBe("7.0");
    expect(bangumiScoreText(null)).toBeNull();
  });
});

describe("episodesText", () => {
  test("uses the singular unit for one episode", () => {
    expect(episodesText(1, { epUnit: "Eps", epUnitOne: "Ep" })).toBe("1 Ep");
    expect(episodesText(12, { epUnit: "Eps", epUnitOne: "Ep" })).toBe("12 Eps");
  });

  test("unknown counts are null", () => {
    expect(episodesText(null, copy)).toBeNull();
    expect(episodesText(0, copy)).toBeNull();
  });
});

describe("titles", () => {
  test("follow the language's ladder", () => {
    expect(heroSlide(row(), [], "zh").title).toBe("测试番");
  });

  test("never render blank when the ladder runs out", () => {
    // en stops at English → Romaji; a row with only a Japanese title would
    // otherwise be an empty card.
    const r = row({ titleEnglish: null, titleRomaji: null, titleChinese: null });
    expect(trendCard({ ...r, rank: 1, watcherCount: 3 }, "en").title).toBe("テスト");
  });
});

describe("heroSlide", () => {
  test("falls back to the cover when there is no banner", () => {
    const s = heroSlide(row({ bannerImageUrl: null }), [], "zh");
    expect(s.banner).toBe(row().coverImageUrl);
    expect(s.hasBanner).toBe(false);
  });

  test("uses the banner when there is one", () => {
    const s = heroSlide(row({ bannerImageUrl: "https://s4.anilist.co/b.jpg" }), [], "zh");
    expect(s.banner).toBe("https://s4.anilist.co/b.jpg");
    expect(s.hasBanner).toBe(true);
  });

  test("localises at most three genres", () => {
    const s = heroSlide(row({ genres: ["Action", "Drama", "Comedy", "Romance"] }), [], "zh");
    expect(s.genres).toEqual(["动作", "剧情", "喜剧"]);
  });

  test("reads the Chinese synopsis, without HTML", () => {
    const s = heroSlide(
      row({ description: "<b>English</b>", descriptionCn: "中文<br>简介" }),
      [],
      "zh",
    );
    expect(s.synopsis).toBe("中文简介");
  });

  test("turns the schedule's seconds into sorted epoch-ms airings for this show only", () => {
    const s = heroSlide(
      row({ anilistId: 7 }),
      [
        { anilistId: 7, airingAt: 200, episode: 5 },
        { anilistId: 8, airingAt: 100, episode: 1 },
        { anilistId: 7, airingAt: 100, episode: 4 },
      ],
      "zh",
    );
    expect(s.airings).toEqual([
      { at: 100_000, ep: 4 },
      { at: 200_000, ep: 5 },
    ]);
  });

  test("the brand-fallback accent gives no hue", () => {
    expect(heroSlide(row({ posterAccent: "#8B5CF6" }), [], "zh").hue).toBeNull();
  });

  test("tokens are the title's reveal pieces", () => {
    expect(heroSlide(row({ titleChinese: "鬼灭 ZERO" }), [], "zh").tokens).toEqual(["鬼", "灭", " ", "ZERO"]);
  });
});

describe("seasonCard", () => {
  test("meta is format · status, localised", () => {
    expect(seasonCard(row(), null, "zh", copy).meta).toBe("TV · 连载中");
  });

  test("the popover's line omits the episode count for a film", () => {
    expect(seasonCard(row({ format: "MOVIE", episodes: 1 }), null, "zh", copy).popMeta).toBe("剧场版 · 2026 夏季");
    expect(seasonCard(row(), null, "zh", copy).popMeta).toBe("TV · 12 集 · 2026 夏季");
  });

  test("carries the next airing it was given", () => {
    expect(seasonCard(row(), { at: 5, ep: 3 }, "zh", copy).nextAiring).toEqual({ at: 5, ep: 3 });
  });
});

describe("gemCard", () => {
  test("prefers the Bangumi score and says so", () => {
    const g = gemCard(row({ status: "FINISHED" }), "zh", copy);
    expect(g.score).toBe("7.9");
    expect(g.scoreSource).toBe("Bangumi");
  });

  test("falls back to AniList when Bangumi has none", () => {
    const g = gemCard(row({ bangumiScore: null }), "zh", copy);
    expect(g).toMatchObject({ score: "8.5", scoreSource: "AniList" });
  });

  test("meta is season · format and count", () => {
    expect(gemCard(row(), "zh", copy).meta).toBe("2026 夏季 · TV · 12 集");
    expect(gemCard(row({ format: "MOVIE", episodes: 1 }), "zh", copy).meta).toBe("2026 夏季 · 剧场版");
  });
});

describe("trendCard / yearCard / hueCard / todayCard", () => {
  test("trend line prefers AniList, then Bangumi", () => {
    expect(trendCard({ ...row(), rank: 2, watcherCount: 40 }, "zh").scoreLine).toBe("AniList 8.5");
    expect(trendCard({ ...row({ averageScore: null }), rank: 2, watcherCount: 40 }, "zh").scoreLine).toBe("Bangumi 7.9");
    expect(trendCard({ ...row({ averageScore: null, bangumiScore: null }), rank: 2, watcherCount: 40 }, "zh").scoreLine).toBe("");
  });

  test("year rows carry the bare season word", () => {
    expect(yearCard(row({ season: "FALL" }), 3, "zh")).toMatchObject({ rank: 3, season: "秋季", score: "8.5" });
  });

  test("hue cards know their hue", () => {
    expect(hueCard(row(), "zh").hue).not.toBeNull();
  });

  test("today cards convert seconds to ms", () => {
    const t = todayCard(
      { scheduleId: 9, airingAt: 1_000, episode: 3, anilistId: 1, titleChinese: "x", coverImageUrl: null, posterAccent: null },
      "zh",
    );
    expect(t).toMatchObject({ key: 9, at: 1_000_000, ep: 3, hue: null });
  });
});

describe("continueCard", () => {
  test("total falls back to the inferred Bangumi count", () => {
    const c = continueCard({ ...row({ episodes: null }), currentEpisode: 3, episodesBgm: 24 }, "zh");
    expect(c.total).toBe(24);
    expect(c.current).toBe(3);
  });

  test("the next episode never runs past the total", () => {
    expect(continueCard({ ...row(), currentEpisode: 12 }, "zh").nextEpisode).toBe(12);
    expect(continueCard({ ...row(), currentEpisode: 3 }, "zh").nextEpisode).toBe(4);
    expect(continueCard({ ...row({ episodes: null }), currentEpisode: 0 }, "zh").nextEpisode).toBe(1);
  });
});

describe("continueCards", () => {
  test("keeps the API's order — most recently updated first — and every row", () => {
    // The 全部在追 page's first three must be the homepage section's three.
    const rows = [7, 3, 11, 5].map((id, i) => ({ ...row({ anilistId: id }), currentEpisode: i }));
    const out = continueCards(rows, "zh");
    expect(out.map((c) => c.id)).toEqual([7, 3, 11, 5]);
    expect(out[2]).toEqual(continueCard(rows[2], "zh"));
  });

  test("an empty list is an empty list", () => {
    expect(continueCards([], "zh")).toEqual([]);
  });
});
