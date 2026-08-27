import { test, expect } from "@playwright/test";

/**
 * SEO route handlers — /sitemap.xml + /robots.txt.
 *
 * These are Next 16 metadata route handlers (src/app/sitemap.ts and
 * src/app/robots.ts). The sitemap must serve absolute URLs rooted at
 * https://animegoclub.com (Google rejects relative entries). Robots
 * must respond as text/plain.
 */

test("sitemap.xml serves application/xml with absolute https URLs", async ({ request }) => {
  const res = await request.get("/sitemap.xml");
  expect(res.status()).toBe(200);

  const contentType = res.headers()["content-type"] || "";
  // Accept either application/xml or text/xml — both are valid per RFC.
  expect(contentType).toMatch(/^(application|text)\/xml/);

  const body = await res.text();
  // The homepage and the current season, absolutized to the canonical host.
  //
  // Not the anime URLs: this document holds the static pages, and the
  // catalogue moved to the sharded sitemaps under /sitemaps/anime/ when it
  // outgrew Google's 50,000-URL cap. The shards are covered end to end by
  // specs/sandbox/sitemap-shards.spec.ts, which runs against a stack built
  // from the branch rather than against whatever is already deployed.
  expect(body).toContain("https://animegoclub.com/");
  expect(body).toMatch(/https:\/\/animegoclub\.com\/seasonal\//);
});

test("robots.txt serves text/plain with a User-agent directive", async ({ request }) => {
  const res = await request.get("/robots.txt");
  expect(res.status()).toBe(200);

  const contentType = res.headers()["content-type"] || "";
  expect(contentType).toMatch(/^text\/plain/);

  const body = await res.text();
  // Next.js MetadataRoute.Robots output begins with `User-Agent:` —
  // case-insensitive match handles either capitalization.
  expect(body).toMatch(/^User-Agent:/im);
  // Sitemap reference must absolutize to the canonical host.
  expect(body).toMatch(/Sitemap:\s*https:\/\/animegoclub\.com\/sitemap\.xml/i);
});

test("every sitemap robots.txt advertises actually resolves", async ({ request }) => {
  // Derived from robots.txt rather than hardcoded, which is what lets this
  // run green both before and after the sharded sitemaps deploy — it checks
  // whatever the live site currently claims, however many that is.
  //
  // The failure it catches is the one with no other symptom: robots.txt is
  // the only thing that makes a sitemap discoverable (there is no index
  // document), so a name that 404s costs the entire file's URLs and nothing
  // anywhere reports it.
  const robots = await (await request.get("/robots.txt")).text();
  const listed = [...robots.matchAll(/^Sitemap:\s*(\S+)$/gim)].map((m) => m[1]);

  expect(listed.length, "robots.txt must advertise at least one sitemap").toBeGreaterThan(0);

  for (const url of listed) {
    const res = await request.get(new URL(url).pathname);
    expect(res.status(), `${url} is advertised to crawlers`).toBe(200);
  }
});
