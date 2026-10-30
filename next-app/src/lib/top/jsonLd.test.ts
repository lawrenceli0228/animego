import { describe, expect, test } from "bun:test";
import { jsonLdHtml, topItemListJsonLd } from "./jsonLd";
import { topTitle } from "./titles";

describe("topItemListJsonLd", () => {
  test("each show's place, absolute address in the reader's locale, and name", () => {
    const doc = topItemListJsonLd(
      "Top 100 Anime of 2019",
      "/top/2019",
      [
        { id: 7, title: "One", place: 1 },
        { id: 9, title: "Two", place: 2 },
      ],
      "en",
    );
    expect(doc["@type"]).toBe("ItemList");
    expect(doc.url).toBe("https://animegoclub.com/en/top/2019");
    expect(doc.numberOfItems).toBe(2);
    expect(doc.itemListElement[1]).toEqual({
      "@type": "ListItem",
      position: 2,
      url: "https://animegoclub.com/en/anime/9",
      name: "Two",
    });
  });

  test("no title can close the script it is written into", () => {
    expect(jsonLdHtml({ name: "</script><script>x()</script>" })).not.toContain("<");
  });
});

describe("topTitle", () => {
  test("the heading, then what narrows it", () => {
    expect(topTitle({ year: null, format: null, genre: null, season: null }, "zh")).toBe("历代 Top 100");
    expect(topTitle({ year: 2025, format: "MOVIE", genre: "Action", season: "FALL" }, "zh")).toBe(
      "2025 年度 Top 100 · 秋季 · 剧场版 · 动作",
    );
    expect(topTitle({ year: 2025, format: null, genre: null, season: null }, "en")).toBe("Top 100 Anime of 2025");
    expect(topTitle({ year: null, format: null, genre: null, season: null }, "zh-Hant")).toBe("歷代 Top 100");
  });
});
