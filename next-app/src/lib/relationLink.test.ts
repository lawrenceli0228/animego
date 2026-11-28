import { describe, expect, test } from "bun:test";

import { relationLink } from "./relationLink";

describe("relationLink", () => {
  test.each(["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"])(
    "an anime format (%s) opens the detail page here",
    (format) => {
      expect(relationLink({ anilistId: 154587, format })).toEqual({ kind: "anime", href: "/anime/154587" });
    },
  );

  test("an unknown format is treated as an anime", () => {
    expect(relationLink({ anilistId: 154587, format: null })).toEqual({ kind: "anime", href: "/anime/154587" });
  });

  test.each(["MANGA", "NOVEL", "ONE_SHOT"] as const)("a print work (%s) opens AniList's /manga/ page", (format) => {
    expect(relationLink({ anilistId: 118586, format })).toEqual({
      kind: "print",
      href: "https://anilist.co/manga/118586",
      format,
    });
  });

  test("a lower-case format is not mistaken for a print work", () => {
    expect(relationLink({ anilistId: 1, format: "manga" }).kind).toBe("anime");
  });
});
