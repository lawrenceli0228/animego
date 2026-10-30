import { describe, expect, test } from "bun:test";
import { buildTorrentRequest, episodeOffsetPath, readOffsetAnswer } from "./request";

describe("buildTorrentRequest", () => {
  test("no keyword → by anilistId", () => {
    expect(buildTorrentRequest(21, null)).toEqual({
      skip: false,
      path: "/api/anime/torrents?anilistId=21",
      cacheKey: "id:21",
    });
  });

  test("keyword → ?q= (encoded), cache key lowercased and trimmed", () => {
    const r = buildTorrentRequest(21, "  Frieren 葬送 ");
    expect(r.skip).toBe(false);
    expect(r.path).toBe("/api/anime/torrents?q=" + encodeURIComponent("Frieren 葬送"));
    expect(r.cacheKey).toBe("q:frieren 葬送");
  });

  test("blank keyword → nothing to fetch", () => {
    expect(buildTorrentRequest(21, "")).toEqual({ skip: true, path: "", cacheKey: "" });
    expect(buildTorrentRequest(21, "   ")).toEqual({ skip: true, path: "", cacheKey: "" });
  });

  test("an id answer and a keyword answer never share a cache slot", () => {
    expect(buildTorrentRequest(7, null).cacheKey).not.toBe(buildTorrentRequest(7, "7").cacheKey);
  });
});

describe("episode offset", () => {
  test("path", () => {
    expect(episodeOffsetPath(182255)).toBe("/api/anime/182255/episode-offset");
  });

  test("known offsets read, in or out of the envelope", () => {
    expect(readOffsetAnswer({ data: { known: true, offset: 28 } })).toBe(28);
    expect(readOffsetAnswer({ known: true, offset: 0 })).toBe(0);
  });

  test("unknown is undefined, never 0", () => {
    expect(readOffsetAnswer({ data: { known: false, offset: 0 } })).toBeUndefined();
    expect(readOffsetAnswer({ data: { offset: 28 } })).toBeUndefined();
    expect(readOffsetAnswer({ data: { known: true, offset: -1 } })).toBeUndefined();
    expect(readOffsetAnswer(null)).toBeUndefined();
    expect(readOffsetAnswer("oops")).toBeUndefined();
  });
});
