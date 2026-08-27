import { test, expect } from "@playwright/test";
import { closePg, ensureAnimeCached, removeAnimeFixture } from "../../fixtures/pg";

// The anime sitemap, end to end: Postgres row → go-api → Next → XML.
//
// This is the project that can fail a pull request. The prod-facing
// sitemap-robots.spec.ts runs against the deployed site, so it can only
// report a broken sitemap after it is already broken in public.
//
// What it is really guarding is a URL. The shards are published at
// /sitemaps/anime/sitemap/{id}.xml by Next's generateSitemaps convention,
// and robots.txt names those paths from a separate constant. If the two ever
// disagree — a rename, a shard-count change, a move under a different segment
// — nothing throws: /sitemap.xml still validates, each shard still serves,
// robots.txt still parses, and Google simply never reads the 17,603 anime
// URLs. That silence is the whole reason the catalogue went unlisted long
// enough to be discovered by reading the code rather than by anything failing.
//
// No authentication: these are the URLs a crawler fetches, and a signed-in
// session changes what the proxy does with them.
test.use({ storageState: { cookies: [], origins: [] } });

// One worker for the whole file. The config sets fullyParallel, which
// spreads a file's tests across workers — and beforeAll/afterAll run once
// per worker, so with one shared database and one set of fixture ids the
// first worker to finish deletes the rows the others are still reading.
// The result is an intermittent 404 in whichever spec drew the short straw.
test.describe.configure({ mode: "serial" });

// Ids picked for their remainder, not their meaning. `anilist_id % 4` is the
// shard, so this pair is the smallest thing that proves the Go query and the
// Next route agree about which file an anime belongs in — seed both, and each
// must appear in exactly one shard, and not the other's.
const IN_SHARD_0 = 990_000_000; // % 4 === 0
const IN_SHARD_3 = 990_000_003; // % 4 === 3

test.beforeAll(async () => {
  // Seeded before the first request on purpose. The route caches its upstream
  // fetch for an hour, so a shard read before its rows exist would answer
  // empty for the rest of the run.
  await ensureAnimeCached({ anilistId: IN_SHARD_0, titleRomaji: "Sitemap Shard Zero" });
  await ensureAnimeCached({ anilistId: IN_SHARD_3, titleRomaji: "Sitemap Shard Three" });
});

test.afterAll(async () => {
  await removeAnimeFixture(IN_SHARD_0);
  await removeAnimeFixture(IN_SHARD_3);
  await closePg();
});

test("each shard serves XML and carries only its own anime", async ({ page }) => {
  const shard0 = await page.request.get("/sitemaps/anime/sitemap/0.xml");
  expect(shard0.status(), "the shard URL must exist — robots.txt points at it").toBe(200);
  expect(shard0.headers()["content-type"] || "").toMatch(/^(application|text)\/xml/);

  const body0 = await shard0.text();
  expect(body0).toContain(`/anime/${IN_SHARD_0}`);
  expect(body0).not.toContain(`/anime/${IN_SHARD_3}`);

  const shard3 = await page.request.get("/sitemaps/anime/sitemap/3.xml");
  expect(shard3.status()).toBe(200);

  const body3 = await shard3.text();
  expect(body3).toContain(`/anime/${IN_SHARD_3}`);
  expect(body3).not.toContain(`/anime/${IN_SHARD_0}`);
});

test("a shard row carries every locale and a real lastmod", async ({ page }) => {
  const body = await (await page.request.get("/sitemaps/anime/sitemap/0.xml")).text();

  // hreflang has to agree with what the detail pages claim about themselves;
  // Google drops a reciprocal group whose two halves disagree.
  for (const prefix of ["", "/en", "/zh-Hant"]) {
    expect(body).toContain(`<loc>https://animegoclub.com${prefix}/anime/${IN_SHARD_0}</loc>`);
  }

  // A lastmod exists and is not the epoch — it comes from the row's
  // updated_at. The version this replaced stamped the current time on every
  // row of every fetch, which is a claim Google can disprove by crawling.
  const lastmod = body.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1];
  expect(lastmod, "every url needs a lastmod").toBeTruthy();
  expect(new Date(lastmod!).getFullYear()).toBeGreaterThan(2000);
});

test("robots.txt names every shard, and each name resolves", async ({ page }) => {
  const robots = await (await page.request.get("/robots.txt")).text();

  const listed = [...robots.matchAll(/^Sitemap:\s*(\S+)$/gim)].map((m) => m[1]);
  expect(listed.length, "the static sitemap plus one line per shard").toBeGreaterThan(1);

  // The assertion that matters: nothing robots.txt advertises is a 404. A
  // stale entry here is invisible from every other angle.
  for (const url of listed) {
    const res = await page.request.get(new URL(url).pathname);
    expect(res.status(), `${url} is advertised to crawlers`).toBe(200);
  }
});
