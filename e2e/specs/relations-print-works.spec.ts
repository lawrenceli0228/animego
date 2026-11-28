import { test, expect } from "@playwright/test";

/**
 * 关联作品 on /anime/[id]: a relation that is a print work (manga, novel,
 * one-shot) opens AniList in a new tab, and /api/anime/:id answers that id
 * with 404 — print works share AniList's id space but are not anime.
 *
 * Asserted as invariants over whatever the page lists rather than as fixed
 * ids, because a title's relations follow AniList's. 葬送的芙莉莲 第二季
 * (182255) is the page because its relations mix anime with the manga it
 * adapts, so both kinds of card are present.
 */
const PAGE_ID = 182255;
const PRINT_LABEL = /漫画|小说|单篇/;

type Card = { href: string; target: string | null; rel: string | null; text: string };

test("print-work relations open AniList; anime relations stay here", async ({ page }) => {
  await page.goto(`/anime/${PAGE_ID}`);
  const section = page.locator("section", { has: page.locator("h2", { hasText: "关联作品" }) }).first();
  await expect(section).toBeVisible();

  const cards: Card[] = await section.locator("a").evaluateAll((as) =>
    as.map((a) => ({
      href: a.getAttribute("href") ?? "",
      target: a.getAttribute("target"),
      rel: a.getAttribute("rel"),
      text: (a as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
    })),
  );
  const print = cards.filter((c) => !c.href.startsWith("/"));
  const anime = cards.filter((c) => c.href.startsWith("/"));
  expect(print.length, JSON.stringify(cards)).toBeGreaterThan(0);
  expect(anime.length, JSON.stringify(cards)).toBeGreaterThan(0);

  for (const c of print) {
    expect(c.href).toMatch(/^https:\/\/anilist\.co\/manga\/\d+$/);
    expect(c.target).toBe("_blank");
    expect(c.rel).toContain("noopener");
    expect(c.text).toMatch(PRINT_LABEL);
  }
  for (const c of anime) {
    expect(c.href).toMatch(/^\/anime\/\d+$/);
    expect(c.target).toBeNull();
    expect(c.text).not.toMatch(PRINT_LABEL);
  }
});

test("the API answers a print-work relation's id with 404", async ({ page, request }) => {
  await page.goto(`/anime/${PAGE_ID}`);
  const hrefs = await page
    .locator('section a[href^="https://anilist.co/manga/"]')
    .evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  expect(hrefs.length).toBeGreaterThan(0);

  for (const href of hrefs) {
    const id = href.split("/").pop();
    const res = await request.get(`/api/anime/${id}`);
    expect(res.status(), `/api/anime/${id}`).toBe(404);
  }
});
