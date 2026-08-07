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
 *
 * meta-externalagent is Meta's AI-training crawler (NOT facebookexternalhit,
 * which renders link previews and stays allowed). It was the single largest
 * crawler of cold /anime/{id} pages during the 2026-08 AniList rate-limit
 * storm (267 of ~1,000 5xx in 17h) and brings no search or referral value,
 * so it is barred site-wide. It documents robots.txt compliance, so this
 * is effective, unlike the residential-proxy scrapers we can't name.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "meta-externalagent",
        disallow: "/",
      },
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
