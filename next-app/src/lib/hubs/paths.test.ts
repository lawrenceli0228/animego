import { describe, expect, test } from "bun:test";
import { FILTER_GENRES } from "@/lib/contentLabels";
import { genreFromSlug, genrePath, genreSlug, parseHubYear, studioPath } from "./paths";

describe("hub paths", () => {
  test("every filter genre round-trips through its slug", () => {
    for (const g of FILTER_GENRES) {
      expect(genreFromSlug(genreSlug(g))).toBe(g);
    }
  });

  test("slugs are lowercase-hyphenated and stable", () => {
    expect(genrePath("Slice of Life")).toBe("/genre/slice-of-life");
    expect(genrePath("Sci-Fi")).toBe("/genre/sci-fi");
    expect(genrePath("Mahou Shoujo")).toBe("/genre/mahou-shoujo");
  });

  test("an unknown slug is not a hub — including the adult genre", () => {
    expect(genreFromSlug("hentai")).toBeNull();
    expect(genreFromSlug("action-")).toBeNull();
  });

  test("studio names survive spaces and punctuation", () => {
    expect(studioPath("Studio DEEN")).toBe("/studio/Studio%20DEEN");
    expect(studioPath("J.C.STAFF")).toBe("/studio/J.C.STAFF");
    expect(decodeURIComponent(studioPath("P.A. Works").slice("/studio/".length))).toBe("P.A. Works");
  });

  test("year bounds", () => {
    expect(parseHubYear("2024")).toBe(2024);
    expect(parseHubYear("1850")).toBeNull();
    expect(parseHubYear("abcd")).toBeNull();
    expect(parseHubYear("3000")).toBeNull();
  });
});
