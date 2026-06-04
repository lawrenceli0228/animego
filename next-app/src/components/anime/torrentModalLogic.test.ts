import { describe, expect, test } from "bun:test";
import {
  buildTorrentRequest,
  epRelevance,
  fmtDate,
  parseTags,
  seederColor,
} from "./torrentModalLogic";

describe("seederColor", () => {
  test("green when well-seeded (>=20)", () => {
    expect(seederColor(20)).toBe("#34d399");
    expect(seederColor(999)).toBe("#34d399");
  });
  test("amber when thin (1..19)", () => {
    expect(seederColor(1)).toBe("#f5a623");
    expect(seederColor(19)).toBe("#f5a623");
  });
  test("muted when dead/zero", () => {
    expect(seederColor(0)).toBe("rgba(235,235,245,0.30)");
  });
});

describe("buildTorrentRequest", () => {
  test("no override → anilistId path + id cache key", () => {
    expect(buildTorrentRequest(21, null)).toEqual({
      skip: false,
      path: "/api/anime/torrents?anilistId=21",
      cacheKey: "id:21",
    });
  });

  test("keyword override → q path (url-encoded) + lowercased q cache key", () => {
    const r = buildTorrentRequest(21, "Frieren 葬送");
    expect(r.skip).toBe(false);
    expect(r.path).toBe("/api/anime/torrents?q=" + encodeURIComponent("Frieren 葬送"));
    expect(r.cacheKey).toBe("q:frieren 葬送");
  });

  test("empty / whitespace-only manual query → skip (nothing to fetch)", () => {
    expect(buildTorrentRequest(21, "")).toEqual({ skip: true, path: "", cacheKey: "" });
    expect(buildTorrentRequest(21, "   ")).toEqual({ skip: true, path: "", cacheKey: "" });
  });

  test("id-mode and keyword-mode never share a cache key", () => {
    // The footgun this guards: anilistId 7 and a literal '7' keyword search.
    expect(buildTorrentRequest(7, null).cacheKey).not.toBe(
      buildTorrentRequest(7, "7").cacheKey,
    );
  });
});

describe("epRelevance", () => {
  test("matches common single-episode patterns (padded + unpadded)", () => {
    expect(epRelevance("[Group] Show - 05 [1080p]", "05")).toBe(1);
    expect(epRelevance("[Group] Show [05]", "05")).toBe(1);
    expect(epRelevance("[Group] Show - 5 (WEB)", "05")).toBe(1); // unpadded epNum
  });
  test("0 when this episode isn't present (other ep / batch)", () => {
    expect(epRelevance("[Group] Show - 12 [1080p]", "05")).toBe(0);
    expect(epRelevance("[Group] Show 01-12 Batch", "05")).toBe(0);
  });
});

describe("parseTags", () => {
  test("extracts resolution (uppercased) + codec + source", () => {
    const r = parseTags("[Group] Show - 01 [1080p][HEVC][WEB-DL]");
    expect(r.resolution).toBe("1080P");
    expect(r.tags).toContain("HEVC");
    expect(r.tags).toContain("WEB-DL");
  });
  test("null resolution + empty tags when none present", () => {
    const r = parseTags("[Group] Show - 01");
    expect(r.resolution).toBeNull();
    expect(r.tags).toEqual([]);
  });
});

describe("fmtDate", () => {
  test("formats local ISO to zero-padded YYYY/MM/DD", () => {
    // Local-time input (no trailing Z) keeps the assertion timezone-independent.
    expect(fmtDate("2026-03-09T12:00:00")).toBe("2026/03/09");
  });
  test("empty string for null or unparseable input", () => {
    expect(fmtDate(null)).toBe("");
    expect(fmtDate("not-a-date")).toBe("");
  });
});
