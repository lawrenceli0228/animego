import { describe, expect, test } from "bun:test";

import { BATCH_MEMORY_KEY, MAX_REMEMBERED_PAGES, batchMemory, memoryUrl, rememberedPages } from "./batchMemory";

describe("memoryUrl", () => {
  test("the pathname alone when there is no query", () => {
    expect(memoryUrl("/seasonal/fall/2026", "")).toBe("/seasonal/fall/2026");
    expect(memoryUrl("/seasonal/fall/2026", "?")).toBe("/seasonal/fall/2026");
  });

  test("one spelling of a query, so the URL bar's and the page's agree", () => {
    expect(memoryUrl("/en/seasonal/fall/2026", "?q=a%20b&genre=Action")).toBe(memoryUrl("/en/seasonal/fall/2026", "q=a+b&genre=Action"));
  });
});

describe("rememberedPages", () => {
  const url = memoryUrl("/seasonal/fall/2026", "?genre=Action");

  test("what the entry remembers for this address", () => {
    expect(rememberedPages({ __NA: true, ...batchMemory(url, 3) }, url)).toBe(3);
  });

  test("nothing remembered, or remembered for another address, is one batch", () => {
    expect(rememberedPages(null, url)).toBe(1);
    expect(rememberedPages({ __NA: true }, url)).toBe(1);
    expect(rememberedPages(batchMemory("/seasonal/summer/2026", 3), url)).toBe(1);
    expect(rememberedPages(batchMemory("/seasonal/fall/2026", 3), url)).toBe(1);
  });

  test("a damaged or hand-made entry cannot unroll the page", () => {
    expect(rememberedPages({ [BATCH_MEMORY_KEY]: { url, pages: "4" } }, url)).toBe(1);
    expect(rememberedPages({ [BATCH_MEMORY_KEY]: { url, pages: 2.5 } }, url)).toBe(1);
    expect(rememberedPages({ [BATCH_MEMORY_KEY]: { url, pages: 0 } }, url)).toBe(1);
    expect(rememberedPages({ [BATCH_MEMORY_KEY]: "3" }, url)).toBe(1);
    expect(rememberedPages(batchMemory(url, 1e6), url)).toBe(MAX_REMEMBERED_PAGES);
  });
});
