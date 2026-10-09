import { describe, expect, test } from "bun:test";

import { DETAIL_TABS, detailTabHref } from "./tabs";

// The detail page's tabs are routes, not client state: each has its own URL
// under /anime/:id, so it can be shared, indexed and opened directly.

describe("detail tabs", () => {
  test("the overview comes first and owns the bare URL", () => {
    expect(DETAIL_TABS[0].key).toBe("overview");
    expect(detailTabHref(154587, "overview")).toBe("/anime/154587");
  });

  test("every other tab is a path segment under it", () => {
    expect(detailTabHref(154587, "characters")).toBe("/anime/154587/characters");
    expect(detailTabHref(154587, "staff")).toBe("/anime/154587/staff");
  });

  test("keys and segments are unique, so two tabs can never claim one URL", () => {
    const keys = DETAIL_TABS.map((t) => t.key);
    const segments = DETAIL_TABS.map((t) => t.segment);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(segments).size).toBe(segments.length);
  });
});
