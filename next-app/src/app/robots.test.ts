import { describe, expect, test } from "bun:test";
import robots from "./robots";
import { ANIME_SITEMAP_SHARDS, animeSitemapPath } from "@/lib/seo/animeSitemap";
import { SITE_ORIGIN } from "@/lib/seo/alternates";

// robots.txt is the only thing that makes the sharded anime sitemaps
// discoverable. There is no sitemap index — Next's sitemap convention emits
// <urlset> and cannot emit <sitemapindex> — so a shard missing from this
// list is a shard Google never reads, and nothing about that failure is
// visible: /sitemap.xml still validates, the shard still serves, the URLs
// just never get crawled. That is the same shape as the defect this whole
// change fixes, which is why it gets a test.

const doc = robots();
const sitemaps = Array.isArray(doc.sitemap) ? doc.sitemap : [doc.sitemap];

describe("sitemap discovery", () => {
  test("the static sitemap keeps the URL Search Console has on file", () => {
    // Moving this would retire a submitted sitemap. The anime catalogue was
    // sharded into new files specifically so this one could stay put.
    expect(sitemaps).toContain(`${SITE_ORIGIN}/sitemap.xml`);
  });

  test("every anime shard is listed", () => {
    for (let id = 0; id < ANIME_SITEMAP_SHARDS; id++) {
      expect(sitemaps).toContain(`${SITE_ORIGIN}${animeSitemapPath(id)}`);
    }
  });

  test("lists nothing beyond the static sitemap and the shards", () => {
    // Catches the reverse mistake: a stale entry left behind after the
    // shard count changes points a crawler at a file that no longer exists.
    expect(sitemaps).toHaveLength(ANIME_SITEMAP_SHARDS + 1);
  });

  test("every sitemap url is absolute and on the canonical origin", () => {
    for (const url of sitemaps) {
      expect(url.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
    }
  });
});

describe("crawl policy", () => {
  test("nothing the sitemaps advertise is disallowed", () => {
    // A sitemap listing URLs robots.txt blocks is a contradiction Search
    // Console reports as an error against the whole document. /anime/ is
    // the surface the shards enumerate, so it must stay crawlable.
    const wildcard = doc.rules;
    const rules = Array.isArray(wildcard) ? wildcard : [wildcard];
    const forEveryone = rules.find((r) => r.userAgent === "*");
    expect(forEveryone).toBeDefined();

    const disallow = forEveryone?.disallow;
    const blocked = Array.isArray(disallow) ? disallow : disallow ? [disallow] : [];
    for (const path of blocked) {
      expect("/anime/1".startsWith(path)).toBe(false);
      expect("/sitemaps/anime/sitemap/0.xml".startsWith(path)).toBe(false);
    }
  });
});
