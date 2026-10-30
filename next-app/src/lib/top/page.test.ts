import { describe, expect, test } from "bun:test";
import { getDictByLang } from "@/lib/i18n";
import { topMetadata } from "./page";
import { NO_FILTERS, type TopState } from "./query";

const base: TopState = { year: null, ...NO_FILTERS, view: "grid" };

describe("topMetadata", () => {
  test("an unfiltered ranking is indexable, canonical to itself", () => {
    const meta = topMetadata({ ...base, year: 2019 }, "zh", "zh-Hans", getDictByLang("zh"));
    expect(meta.title).toEqual({ absolute: "2019 年度 Top 100" });
    expect(meta.alternates?.canonical).toBe("/top/2019");
    expect(meta.robots).toBeUndefined();
    expect(String(meta.description)).toContain("2019 年度 Top 100 — ");
  });

  test("the view is no part of the canonical", () => {
    expect(topMetadata({ ...base, view: "table" }, "en", "en", getDictByLang("en")).alternates?.canonical).toBe("/en/top");
  });

  test("a filtered ranking is noindex, follow; its canonical is its own, filters in one order", () => {
    const meta = topMetadata(
      { ...base, year: 2019, genre: "Action", format: "MOVIE", season: "FALL", view: "chart" },
      "zh-Hant",
      "zh-Hant",
      getDictByLang("zh-Hant"),
    );
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.alternates?.canonical).toBe("/zh-Hant/top/2019?format=movie&genre=action&season=fall");
    expect(meta.title).toEqual({ absolute: "2019 年度 Top 100 · 秋季 · 劇場版 · 動作" });
  });
});
