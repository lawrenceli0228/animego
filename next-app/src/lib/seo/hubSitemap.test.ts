import { describe, expect, test } from "bun:test";
import { hubSitemapRows, type HubsPayload } from "./hubSitemap";

const now = new Date("2026-09-15T00:00:00Z");

const hubs: HubsPayload = {
  genres: [
    { key: "Action", count: 5000 },
    { key: "Slice of Life", count: 2700 },
    { key: "Hentai", count: 1070 },
  ],
  studios: [{ key: "Studio DEEN", count: 276 }],
  years: [{ key: "2024", count: 900 }],
  seasons: [{ season: "WINTER", year: 2024, count: 200 }],
};

describe("hubSitemapRows", () => {
  test("emits every hub kind, each expanded to every locale", () => {
    const rows = hubSitemapRows(hubs, now);
    const urls = rows.map((r) => r.url);
    expect(urls).toContain("https://animegoclub.com/genre/action");
    expect(urls).toContain("https://animegoclub.com/en/genre/slice-of-life");
    expect(urls).toContain("https://animegoclub.com/studio/Studio%20DEEN");
    expect(urls).toContain("https://animegoclub.com/year/2024");
    expect(urls).toContain("https://animegoclub.com/seasonal/winter/2024");
  });

  test("the adult genre is not a hub even when the API lists it", () => {
    const urls = hubSitemapRows(hubs, now).map((r) => r.url);
    expect(urls.some((u) => u.includes("/genre/hentai"))).toBe(false);
  });

  test("every row carries hreflang alternates", () => {
    for (const row of hubSitemapRows(hubs, now)) {
      expect(row.alternates?.languages).toBeDefined();
    }
  });
});
