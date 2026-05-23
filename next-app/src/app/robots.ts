import type { MetadataRoute } from "next";

const SITE = "https://animegoclub.com";

/**
 * robots.txt generator.
 *
 * Allowlist policy: anything not explicitly disallowed is crawlable. The
 * disallow list covers surfaces that either have no SEO value or are not
 * yet migrated to the RSC stack:
 *
 *   /library  - logged-in personal lists, no public content
 *   /player   - streaming surface, login-gated and not yet migrated
 *   /api/     - Go API JSON, never meant for SERPs
 *   /admin    - operator console
 *
 * SEO-relevant routes ('/', '/anime/{id}', '/seasonal/{season}/{year}',
 * '/search') are not listed and therefore allowed by default.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/library", "/player", "/api/", "/admin"],
      },
    ],
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
