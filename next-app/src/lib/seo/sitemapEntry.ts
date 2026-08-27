import type { MetadataRoute } from "next";
import { DEFAULT_LOCALE, LOCALES, localizePath, type Locale } from "@/lib/i18n/locale";
import { SITE_ORIGIN as SITE } from "@/lib/seo/alternates";

/**
 * A sitemap row before locale expansion: a site-relative path plus the
 * metadata that is the same in every language.
 *
 * The path is relative on purpose. Every URL a crawler reads has to be
 * absolute and on the canonical origin, and the one place that turns a path
 * into a URL is expandLocales below — so a caller cannot accidentally emit a
 * relative or wrong-origin `<loc>`, which makes Google reject the whole
 * document rather than the one row.
 */
export type SitemapEntry = Omit<MetadataRoute.Sitemap[number], "url"> & {
  path: string;
};

/**
 * Pages whose CONTENT exists only in the default locale.
 *
 * The legal pages are hardcoded Chinese JSX with no English body. Listing an
 * /en/ URL for them, or advertising one as an alternate, would tell Google
 * about an English page that serves Chinese — the exact defect this project
 * spent a commit removing from eight route files. They ship as a single
 * default-locale URL with no alternates until someone translates them.
 */
const UNTRANSLATED_PATHS = new Set(["/terms", "/privacy", "/copyright"]);

/**
 * One sitemap row per locale, cross-linked.
 *
 * Google reads sitemap `alternates.languages` the same way it reads the
 * `<link rel="alternate">` tags in the head, reciprocity requirement
 * included — so every row lists every locale, itself among them. Both
 * surfaces derive from LOCALES for that reason: a sitemap that disagrees
 * with the pages it lists is worse than one that says nothing.
 *
 * Shared rather than duplicated because the site now publishes more than one
 * sitemap document. Two copies of this rule is two chances for the anime
 * sitemap and the static one to make different hreflang claims about the
 * same site, and Google resolves that disagreement by dropping the group.
 */
export function expandLocales(entry: SitemapEntry): MetadataRoute.Sitemap {
  const { path, ...rest } = entry;

  if (UNTRANSLATED_PATHS.has(path)) {
    return [{ ...rest, url: `${SITE}${localizePath(path, DEFAULT_LOCALE)}` }];
  }

  const languages = Object.fromEntries(
    LOCALES.map((locale) => [locale, `${SITE}${localizePath(path, locale)}`]),
  );

  return LOCALES.map((locale: Locale) => ({
    ...rest,
    url: `${SITE}${localizePath(path, locale)}`,
    alternates: { languages },
  }));
}
