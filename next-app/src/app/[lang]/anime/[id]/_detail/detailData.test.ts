import { describe, expect, test } from "bun:test";

import { parseAnimeId } from "./detailData";

// The id in /anime/[id]/… decides whether go-api is asked at all: anything
// that is not an AniList id is a 404 before any request.

describe("parseAnimeId", () => {
  test("a positive int32 in plain digits is an id", () => {
    expect(parseAnimeId("154587")).toBe(154587);
    expect(parseAnimeId("1")).toBe(1);
    expect(parseAnimeId("2147483647")).toBe(2147483647);
  });

  test("anything else is not", () => {
    for (const raw of ["", "0", "-1", "1.5", "abc", "1e3", "0154587", " 1", "1 ", "+1", "2147483648", "99999999999"]) {
      expect(parseAnimeId(raw)).toBeNull();
    }
  });
});
