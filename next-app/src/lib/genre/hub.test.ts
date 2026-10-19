import { describe, expect, test } from "bun:test";

import { overviewWire } from "@/lib/test-utils/genreFixtures";
import { EMPTY_HUB, buildHubData } from "./hub";
import { parseOverview } from "./overview";

const overview = () => parseOverview(overviewWire(), "Action");

describe("buildHubData", () => {
  test("no overview is an empty hub", () => {
    expect(buildHubData(null, "zh")).toBe(EMPTY_HUB);
  });

  test("the counts come through", () => {
    const hub = buildHubData(overview(), "zh");
    expect(hub.total).toBe(5241);
    expect(hub.airing).toBe(84);
  });

  test("rails in order, six cards each; a rail with fewer than four is left out", () => {
    const hub = buildHubData(overview(), "zh");
    // classic has three items in the fixture.
    expect(hub.rails.map((r) => r.key)).toEqual(["airing", "popular", "recent"]);
    expect(hub.rails.map((r) => r.items.length)).toEqual([6, 6, 6]);
    expect(hub.rails[0]?.count).toBe(84);
    expect(hub.rails[0]?.items[0]?.id).toBe(100);
  });

  test("the top ten, as items with their year", () => {
    const hub = buildHubData(overview(), "zh");
    expect(hub.top).toHaveLength(10);
    expect(hub.top[0]?.title).toBe("测试番 500");
    expect(hub.top[0]?.year).toBe(2019);
  });

  test("items carry no synopsis or search text into the page", () => {
    const hub = buildHubData(overview(), "zh");
    for (const item of [...hub.rails.flatMap((r) => r.items), ...hub.top]) {
      expect(item.synopsis).toBe("");
      expect(item.haystack).toBe("");
    }
  });

  test("tiles: covers are not repeated down the rows while there are new ones", () => {
    const hub = buildHubData(overview(), "zh");
    const covers = (t: { covers: { id: number }[] }) => t.covers.map((c) => c.id);
    expect(hub.decades.map(covers)).toEqual([
      [1, 2, 3],
      [5, 6, 1],
      [],
    ]);
    expect(hub.related.map(covers)).toEqual([
      [7, 8, 9],
      [10, 11, 12],
    ]);
    expect(hub.studios.map(covers)).toEqual([[13, 14, 15], [16]]);
  });

  test("a tile's ground is its first cover's hue; a tile with no cover is neutral", () => {
    const hub = buildHubData(overview(), "zh");
    expect(hub.decades[0]?.hue).not.toBeNull();
    expect(hub.decades[2]?.hue).toBeNull();
    expect(hub.related[0]?.hue).not.toBeNull();
    expect(hub.related[1]?.hue).toBeNull();
  });

  test("tiles keep their keys and counts", () => {
    const hub = buildHubData(overview(), "zh");
    expect(hub.decades.map((d) => [d.decade, d.count])).toEqual([
      ["2020", 1200],
      ["2010", 1600],
      ["old", 40],
    ]);
    expect(hub.related[0]).toMatchObject({ kind: "with", genre: "Fantasy", count: 900 });
    expect(hub.studios[1]).toMatchObject({ kind: "studio", studio: "MAPPA", count: 120 });
  });

  test("seven tiles to a row at most", () => {
    const wire = overviewWire();
    wire.studios = Array.from({ length: 10 }, (_, i) => ({ studio: `Studio ${i}`, count: 10 - i, covers: [] }));
    const hub = buildHubData(parseOverview(wire, "Action"), "zh");
    expect(hub.studios).toHaveLength(7);
  });
});
