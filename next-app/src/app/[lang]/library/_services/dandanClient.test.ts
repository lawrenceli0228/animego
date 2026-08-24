import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mockFetch } from "@/lib/test-utils/fetchMock";
import { createDandanClient } from "./dandanClient";

// The regression these tests exist for
// ------------------------------------
// `animes[0].animeId` is dandanplay id space. It reaches `Season.animeId` via
// importPipeline's `callDandan` → `applyEnrichment` → `buildSeasonRecord`, and
// that field is what season reuse and danmaku lookups key on.
//
// `POST /api/dandanplay/match` never emits a dandanplay animeId. Verified
// against go-api/internal/dandanplay/match.go: `phase1Anime` is titleNative +
// coverImageUrl, `phase2Anime` is anilistId + titles + episodes, phase 3 emits
// a literal `{}`, and `siteAnime` (site_anime.go `siteAnimePayload`) carries
// anilistId + bgmId. So the old `?? merged.bgmId` tail was not a fallback: it
// was the only term that could ever fire, and every matched import wrote a
// bgm.tv subject id into a dandanplay field.
//
// The two spaces collide numerically, so no downstream check can undo it. The
// tests below pin the shape of "absent": a falsy animeId, which re-enables the
// structural home guards (importPipeline.js:319) instead of silently disabling
// them with an id that will never match again.
//
// The client is only reachable through `fetch`, so these drive it end to end
// against the real envelope shapes rather than reaching into module-private
// helpers.

/** The `siteAnime` projection — present in phases 1 and 2, null in phase 3. */
const SITE_ANIME = {
  anilistId: 21,
  titleChinese: "航海王",
  titleNative: "ONE PIECE",
  titleRomaji: "ONE PIECE",
  coverImageUrl: "https://example.invalid/op.jpg",
  episodes: 1122,
  status: "RELEASING",
  season: null,
  seasonYear: 1999,
  averageScore: 88,
  bangumiScore: null,
  bangumiVotes: null,
  genres: ["Action"],
  format: "TV",
  // The trap. A bgm.tv subject id, in the same envelope, one `??` away from
  // the field that must never hold it.
  bgmId: 806,
  studios: ["Toei Animation"],
  source: "MANGA",
  duration: 24,
} as const;

/** Phase 1: hash/filename hit. `anime` is two fields and no id at all. */
const PHASE1 = {
  matched: true,
  anime: {
    titleNative: "ONE PIECE",
    coverImageUrl: "https://example.invalid/op-ddp.jpg",
  },
  siteAnime: SITE_ANIME,
  episodeMap: { 1: { episodeId: 1798001, episodeTitle: "第1话" } },
  source: "dandanplay",
};

/** Phase 2: animeCache keyword hit. `anime` carries an AniList id, not a dandan one. */
const PHASE2 = {
  matched: true,
  anime: {
    anilistId: 21,
    titleChinese: "航海王",
    titleNative: "ONE PIECE",
    titleRomaji: "ONE PIECE",
    coverImageUrl: "https://example.invalid/op.jpg",
    episodes: 1122,
  },
  siteAnime: SITE_ANIME,
  episodeMap: { 1: { episodeId: 1798001, episodeTitle: "第1话" } },
  source: "animeCache",
};

/** Phase 3: per-file hash fallback. `anime` is a literal `{}`, siteAnime null. */
const PHASE3 = {
  matched: true,
  anime: {},
  siteAnime: null,
  episodeMap: { 1: { episodeId: 999, episodeTitle: "" } },
  source: "dandanplay",
};

function jsonResponse(payload: unknown) {
  return mockFetch(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

const HASH = "0123456789abcdef0123456789abcdef";
const FILE = "[Sub] One Piece - 01 [1080p].mkv";

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("match — animeId stays in dandanplay id space", () => {
  test("a phase 2 hit yields no animeId, never the bgmId beside it", async () => {
    // Arrange — the envelope that produced the poisoned rows in the field.
    globalThis.fetch = jsonResponse(PHASE2);

    // Act
    const result = await createDandanClient().match(HASH, FILE);

    // Assert — 806 is `siteAnime.bgmId`. Reading it here would mean claiming
    // dandanplay anime 806, an entirely different show.
    expect(result?.animes[0]?.animeId).not.toBe(806);
    expect(result?.animes[0]?.animeId).toBe(0);
  });

  test("a phase 1 hit yields no animeId either — the value is not in the envelope", async () => {
    // Arrange — phase 1 HAS the right id server-side (match.go:186) and drops
    // it before serializing, so the client has nothing to read.
    globalThis.fetch = jsonResponse(PHASE1);

    // Act
    const result = await createDandanClient().match(HASH, FILE);

    // Assert
    expect(result?.animes[0]?.animeId).toBe(0);
  });

  test("a phase 3 hit — `anime: {}`, no siteAnime — yields no animeId", async () => {
    // Arrange
    globalThis.fetch = jsonResponse(PHASE3);

    // Act
    const result = await createDandanClient().match(HASH, FILE);

    // Assert
    expect(result?.animes[0]?.animeId).toBe(0);
  });

  test("an AniList id is not a substitute either", async () => {
    // Arrange — `anime.anilistId` is right there in the phase 2 projection,
    // and it is the id space `Series.anilistId` owns, not `Season.animeId`.
    globalThis.fetch = jsonResponse(PHASE2);

    // Act
    const result = await createDandanClient().match(HASH, FILE);

    // Assert
    expect(result?.animes[0]?.animeId).not.toBe(21);
  });

  test("absent reads as falsy, which is what re-enables the home guards", async () => {
    // Arrange — importPipeline.js gates on truthiness twice: `dandanResult
    // .animeId` (:256) decides whether a Season is minted at all, and
    // `seasonRecord.animeId` (:319) decides whether the folder/title home
    // heuristics still run. Both need this value to be falsy, not merely wrong.
    globalThis.fetch = jsonResponse(PHASE2);

    // Act
    const result = await createDandanClient().match(HASH, FILE);

    // Assert
    expect(Boolean(result?.animes[0]?.animeId)).toBe(false);
    expect(Number.isNaN(result?.animes[0]?.animeId)).toBe(false);
  });

  test("a real dandanplay animeId is used verbatim once the server emits one", async () => {
    // Arrange — not a shape go-api sends today. This is the forward contract:
    // when phase 1 starts forwarding `combined.AnimeID`, it must land here
    // unchanged, and the bgmId in the same envelope must still be ignored.
    globalThis.fetch = jsonResponse({
      ...PHASE1,
      anime: { ...PHASE1.anime, dandanAnimeId: 1798 },
    });

    // Act
    const result = await createDandanClient().match(HASH, FILE);

    // Assert
    expect(result?.animes[0]?.animeId).toBe(1798);
  });
});

describe("match — enrichment is independent of the id", () => {
  test("titles, poster and episode count still ride along without an animeId", async () => {
    // Arrange — dropping the bogus id must not drop the metadata beside it.
    // (The import pipeline currently gates enrichment on a truthy animeId, so
    // this is the layer that has to keep carrying it.)
    globalThis.fetch = jsonResponse(PHASE2);

    // Act
    const result = await createDandanClient().match(HASH, FILE);

    // Assert
    expect(result?.isMatched).toBe(true);
    expect(result?.enrichment?.titleZh).toBe("航海王");
    expect(result?.enrichment?.titleEn).toBe("ONE PIECE");
    expect(result?.enrichment?.posterUrl).toBe("https://example.invalid/op.jpg");
    expect(result?.enrichment?.totalEpisodes).toBe(1122);
  });

  test("the title falls back to the filename when the envelope carries none", async () => {
    // Arrange — phase 3 has no titles anywhere, and an empty `animeTitle`
    // would render as a blank library card.
    globalThis.fetch = jsonResponse(PHASE3);

    // Act
    const result = await createDandanClient().match(HASH, FILE);

    // Assert
    expect(result?.animes[0]?.animeTitle).toBe(FILE);
    expect(result?.enrichment).toBeUndefined();
  });
});

describe("match — refusals", () => {
  test("a miss envelope returns null rather than a zero-id match", async () => {
    // Arrange — `{matched:false}` is the total-miss shape (missResponse).
    globalThis.fetch = jsonResponse({ matched: false });

    // Act / Assert — null, not `{isMatched:true, animes:[{animeId:0}]}`.
    expect(await createDandanClient().match(HASH, FILE)).toBeNull();
  });

  test("a missing hash or filename short-circuits before the request", async () => {
    // Arrange
    const spy = jsonResponse(PHASE2);
    globalThis.fetch = spy;

    // Act
    const noHash = await createDandanClient().match("", FILE);
    const noName = await createDandanClient().match(HASH, "");

    // Assert
    expect(noHash).toBeNull();
    expect(noName).toBeNull();
    expect(spy.mock.calls.length).toBe(0);
  });

  test("an HTTP failure swallows to null so the import keeps its fileRefs", async () => {
    // Arrange
    globalThis.fetch = mockFetch(async () => new Response("", { status: 502 }));

    // Act / Assert
    expect(await createDandanClient().match(HASH, FILE)).toBeNull();
  });
});
