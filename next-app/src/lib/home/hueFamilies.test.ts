import { describe, expect, test } from "bun:test";
import { HUE_FAMILIES, colouredFirst, defaultFamily, groupByHueFamily, hueFamilyOf } from "./hueFamilies";

// "按色调逛" groups the season by the hue of each cover. The ranges are half-open
// [lo, hi) and red wraps through 0°, which is exactly where an off-by-one would
// hide: 345° and 0° must land in the same family, 344.9° must not.

describe("hueFamilyOf", () => {
  const cases: Array<[number, string]> = [
    [0, "red"],
    [10, "red"],
    [34.9, "red"],
    [345, "red"],
    [359.9, "red"],
    [35, "orange"],
    [74.9, "orange"],
    [75, "yellow"],
    [114.9, "yellow"],
    [115, "green"],
    [164.9, "green"],
    [165, "cyan"],
    [214.9, "cyan"],
    [215, "blue"],
    [274.9, "blue"],
    [275, "purple"],
    [344.9, "purple"],
  ];

  for (const [hue, family] of cases) {
    test(`${hue}° is ${family}`, () => {
      expect(hueFamilyOf(hue)).toBe(family as ReturnType<typeof hueFamilyOf>);
    });
  }

  test("angles outside 0–360 are normalised first", () => {
    expect(hueFamilyOf(360)).toBe("red");
    expect(hueFamilyOf(-10)).toBe("red");
    expect(hueFamilyOf(725)).toBe("red");
  });

  test("no hue is no family — the fallback violet is not purple", () => {
    expect(hueFamilyOf(null)).toBeNull();
    expect(hueFamilyOf(Number.NaN)).toBeNull();
  });

  test("the seven ranges tile the circle with no gap and no overlap", () => {
    for (let tenth = 0; tenth < 3600; tenth++) {
      const hue = tenth / 10;
      const hits = HUE_FAMILIES.filter((f) =>
        f.lo > f.hi ? hue >= f.lo || hue < f.hi : hue >= f.lo && hue < f.hi,
      );
      expect(hits.length).toBe(1);
    }
  });
});

describe("groupByHueFamily", () => {
  const item = (id: number, hue: number | null) => ({ id, hue });

  test("keeps family order, drops empty families, preserves item order", () => {
    const groups = groupByHueFamily([
      item(1, 230),
      item(2, 20),
      item(3, 240),
      item(4, null),
      item(5, 350),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["red", "blue"]);
    expect(groups[0].items.map((i) => i.id)).toEqual([2, 5]);
    expect(groups[1].items.map((i) => i.id)).toEqual([1, 3]);
  });

  test("items without a hue are left out entirely", () => {
    expect(groupByHueFamily([item(1, null)])).toEqual([]);
  });

  test("each group carries its family's representative hue for the dot", () => {
    const [red] = groupByHueFamily([item(1, 5)]);
    expect(red.hue).toBe(HUE_FAMILIES.find((f) => f.key === "red")?.hue as number);
  });
});

describe("defaultFamily", () => {
  const g = (key: string, n: number) => ({ key, items: Array.from({ length: n }) });

  test("is the largest family", () => {
    expect(defaultFamily([g("red", 2), g("blue", 5), g("purple", 3)] as never)).toBe("blue");
  });

  test("breaks ties by family order, so the choice is stable", () => {
    expect(defaultFamily([g("orange", 4), g("blue", 4)] as never)).toBe("orange");
  });

  test("is null when nothing has a hue", () => {
    expect(defaultFamily([])).toBeNull();
  });
});

// The hero opens on its first slide, and that slide's colour is the page's
// colour. A colourless first slide makes the whole homepage open grey — the
// one thing the hue design exists to avoid.
describe("colouredFirst", () => {
  const item = (id: number, hue: number | null) => ({ id, hue });

  test("moves colourless items behind coloured ones, keeping each group's order", () => {
    const ranked = [item(1, null), item(2, 200), item(3, null), item(4, 30), item(5, 120)];
    expect(colouredFirst(ranked).map((x) => x.id)).toEqual([2, 4, 5, 1, 3]);
  });

  test("leaves an already coloured-first list untouched", () => {
    const ranked = [item(1, 10), item(2, 20), item(3, null)];
    expect(colouredFirst(ranked).map((x) => x.id)).toEqual([1, 2, 3]);
  });

  test("an all-colourless list keeps its order", () => {
    const ranked = [item(1, null), item(2, null)];
    expect(colouredFirst(ranked).map((x) => x.id)).toEqual([1, 2]);
  });

  test("hue 0 is a colour, not a missing one", () => {
    const ranked = [item(1, null), item(2, 0)];
    expect(colouredFirst(ranked).map((x) => x.id)).toEqual([2, 1]);
  });

  test("returns a new array and does not reorder the input", () => {
    const ranked = [item(1, null), item(2, 200)];
    const out = colouredFirst(ranked);
    expect(out).not.toBe(ranked);
    expect(ranked.map((x) => x.id)).toEqual([1, 2]);
  });
});
