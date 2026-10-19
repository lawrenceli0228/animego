import { describe, expect, test } from "bun:test";

import { FILTER_GENRES } from "@/lib/contentLabels";
import { stripEntries } from "./strip";

describe("stripEntries", () => {
  test("every browsable genre, in the site's order, with the counts the hubs answer has", () => {
    const got = stripEntries({
      genres: [
        { key: "Romance", count: 2100 },
        { key: "Action", count: 5241 },
        { key: "Hentai", count: 900 },
      ],
    });
    expect(got.map((e) => e.genre)).toEqual([...FILTER_GENRES]);
    expect(got.find((e) => e.genre === "Action")?.count).toBe(5241);
    expect(got.find((e) => e.genre === "Romance")?.count).toBe(2100);
    // Not in the answer: still a link, with no number.
    expect(got.find((e) => e.genre === "Mecha")?.count).toBeNull();
    expect(got.some((e) => (e.genre as string) === "Hentai")).toBe(false);
  });

  test("no answer: every count unknown", () => {
    for (const bad of [null, undefined, "x", { genres: "x" }]) {
      const got = stripEntries(bad);
      expect(got).toHaveLength(18);
      expect(got.every((e) => e.count === null)).toBe(true);
    }
  });
});
