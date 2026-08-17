import { describe, expect, test } from "bun:test";
import {
  normalizeRematchHit,
  toPositiveInt,
  type RematchPayload,
} from "./rematchPayload";

// The regression these tests exist for
// ------------------------------------
// `/api/dandanplay/search` returns two DISJOINT row shapes (verified against
// go-api/internal/dandanplay/handlers.go — `cacheSearchItem` declares
// `anilistId` and no `dandanAnimeId`, `dandanSearchItem` the reverse). The old
// normalize read `Number(it.dandanAnimeId ?? it.anilistId ?? NaN)`, so EVERY
// pick from the animeCache section — the richer one, listed first — fell
// through to the AniList id, which was then written into dandanplay id space.
//
// The damage was identity, not display: season reuse matches on dandanplay ids,
// so a poisoned row could never match again (duplicate card on the next import,
// danmaku pointed at whatever title shares that number).
//
// Every test below that mentions "id space" is pinning that fix. If someone
// reintroduces a `??` between the two fields, the first describe block fails.

const CACHE_HIT = {
  source: "animeCache",
  anilistId: 21,
  title: "One Piece",
  titleChinese: "海贼王",
  coverImageUrl: "https://example.invalid/op.jpg",
  format: "TV",
} as const;

const DANDAN_HIT = {
  source: "dandanplay",
  dandanAnimeId: 1798,
  title: "ワンピース",
  imageUrl: "https://example.invalid/op-ddp.jpg",
  type: "tvseries",
} as const;

describe("normalizeRematchHit — the two id spaces never substitute", () => {
  test("an animeCache row yields only anilistId, never a dandanplay id", () => {
    // Arrange — the shape the server actually sends for cache rows.
    const hit = { ...CACHE_HIT };

    // Act
    const payload = normalizeRematchHit(hit);

    // Assert — the AniList id must NOT leak into dandanplay id space.
    expect(payload?.anilistId).toBe(21);
    expect(payload?.dandanAnimeId).toBeUndefined();
  });

  test("a dandanplay row yields only dandanAnimeId, never an AniList id", () => {
    // Arrange
    const hit = { ...DANDAN_HIT };

    // Act
    const payload = normalizeRematchHit(hit);

    // Assert
    expect(payload?.dandanAnimeId).toBe(1798);
    expect(payload?.anilistId).toBeUndefined();
  });

  test("a row carrying both keeps both, with neither overwriting the other", () => {
    // Arrange — not a shape the server sends today, but the type permits it and
    // a future merged endpoint would.
    const hit = { dandanAnimeId: 1798, anilistId: 21 };

    // Act
    const payload = normalizeRematchHit(hit);

    // Assert
    expect(payload?.dandanAnimeId).toBe(1798);
    expect(payload?.anilistId).toBe(21);
  });

  test("rejects a hit carrying neither id", () => {
    // Arrange — a result row with titles but no usable identity.
    const hit = { title: "Some Show", titleChinese: "某番", format: "TV" };

    // Act / Assert — null, not a payload with two undefined ids.
    expect(normalizeRematchHit(hit)).toBeNull();
  });

  test("an unusable id does not fall through to the other field", () => {
    // Arrange — a cache row whose anilistId is garbage. The old `??` chain
    // treated only null/undefined as absent, so this is the shape where a
    // naive rewrite could still cross the two spaces.
    const hit = { source: "animeCache", anilistId: 0, dandanAnimeId: 1798 };

    // Act
    const payload = normalizeRematchHit(hit);

    // Assert — the bad AniList id is dropped, and 1798 stays where it belongs.
    expect(payload?.anilistId).toBeUndefined();
    expect(payload?.dandanAnimeId).toBe(1798);
  });
});

describe("normalizeRematchHit — untrusted input", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "not an object"],
    ["a number", 42],
  ])("rejects %s", (_label, input) => {
    expect(normalizeRematchHit(input)).toBeNull();
  });

  test("accepts a numeric string id, because search JSON is not schema-checked", () => {
    // Arrange
    const hit = { anilistId: "21" };

    // Act / Assert
    expect(normalizeRematchHit(hit)?.anilistId).toBe(21);
  });

  test("drops ids that are not positive integers", () => {
    // Arrange — one row per rejected shape, each also carrying a good
    // dandanplay id so the row itself stays valid.
    const rejected = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "abc", null, {}];

    // Act / Assert
    for (const bad of rejected) {
      const payload = normalizeRematchHit({ anilistId: bad, dandanAnimeId: 7 });
      expect(payload?.anilistId).toBeUndefined();
    }
  });
});

// Annotated rather than inferred: without it the table widens to string and
// `toBe` has no overload against the literal union `RematchPayload["type"]`.
const FORMAT_CASES: ReadonlyArray<[string, RematchPayload["type"]]> = [
  ["TV", "tv"],
  ["MOVIE", "movie"],
  ["OVA", "ova"],
  ["ONA / web", "web"],
  ["SPECIAL", "tv"],
];

describe("normalizeRematchHit — derived fields", () => {
  test.each(FORMAT_CASES)("format %s maps to type %s", (format, expected) => {
    expect(normalizeRematchHit({ anilistId: 1, format })?.type).toBe(expected);
  });

  test("defaults to tv when format is absent or not a string", () => {
    expect(normalizeRematchHit({ anilistId: 1 })?.type).toBe("tv");
    expect(normalizeRematchHit({ anilistId: 1, format: 7 })?.type).toBe("tv");
  });

  test("carries titles and poster across, preferring coverImageUrl", () => {
    // Arrange — cache rows use coverImageUrl, dandanplay rows use imageUrl.
    const hit = {
      anilistId: 21,
      title: "One Piece",
      titleChinese: "海贼王",
      coverImageUrl: "cover.jpg",
      imageUrl: "fallback.jpg",
    };

    // Act
    const payload = normalizeRematchHit(hit);

    // Assert
    expect(payload?.titleEn).toBe("One Piece");
    expect(payload?.titleZh).toBe("海贼王");
    expect(payload?.posterUrl).toBe("cover.jpg");
  });

  test("falls back to imageUrl when there is no coverImageUrl", () => {
    expect(
      normalizeRematchHit({ dandanAnimeId: 1798, imageUrl: "ddp.jpg" })?.posterUrl,
    ).toBe("ddp.jpg");
  });

  test("leaves empty-string titles undefined rather than empty", () => {
    // Arrange — the server sends "" for missing optional strings often enough
    // that `|| undefined` is load-bearing downstream.
    const payload = normalizeRematchHit({ anilistId: 21, title: "", titleChinese: "" });

    // Assert
    expect(payload?.titleEn).toBeUndefined();
    expect(payload?.titleZh).toBeUndefined();
  });
});

describe("toPositiveInt", () => {
  test.each([
    [21, 21],
    ["21", 21],
    [0, undefined],
    [-3, undefined],
    [1.5, undefined],
    ["", undefined],
    ["abc", undefined],
    [null, undefined],
    [undefined, undefined],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
  ])("%p → %p", (input, expected) => {
    expect(toPositiveInt(input)).toBe(expected as number | undefined);
  });
});
