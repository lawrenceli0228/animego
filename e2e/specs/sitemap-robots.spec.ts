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
  // Sitemap must contain at least the homepage and at least one anime
  // detail URL absolutized to the canonical host.
  expect(body).toContain("https://animegoclub.com/");
  expect(body).toMatch(/https:\/\/animegoclub\.com\/(anime\/|seasonal\/)/);
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
