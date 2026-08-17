// The locale vocabulary — one list, and everything else derives from it.
//
// This is deliberately separate from `Lang` in lib/i18n.ts. `Lang` ("zh" |
// "en") names a UI dictionary; a `Locale` names a published address. They
// coincide today only because there is exactly one of each. When the
// zh-Hant and en URL trees land, a `Locale` will select both the dictionary
// and the path prefix, and `Lang` will be retired into it.
//
// The identifiers are the ones Google documents for Chinese script variants
// (ISO 15924: "zh-Hans", "zh-Hant"), so a locale id doubles as its own
// hreflang value with no mapping table in between — one fewer place for the
// two to drift apart.

/**
 * Every locale the site actually publishes, in the order they should appear.
 *
 * Adding an entry here is the whole switch: it grows the hreflang set on
 * every page (lib/seo/alternates.ts), the sitemap's locale expansion, and
 * the proxy's accepted path prefixes. That is the point of keeping the list
 * in one module — the previous arrangement had nine files each hand-writing
 * their own language map, and when one of them was corrected the other eight
 * kept advertising the old, wrong answer for two and a half months.
 *
 * Do not add a locale before its URLs resolve. An hreflang pointing at a 404
 * is worse than no hreflang: Google drops the whole reciprocal group.
 */
export const LOCALES = ["zh-Hans"] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * The locale served at the un-prefixed path.
 *
 * Simplified Chinese keeps the bare URLs it has always had. Every indexed
 * page on the site is a bare path today, and moving them under a prefix
 * would 301 the entire existing index — the one cost this migration is
 * designed to avoid.
 */
export const DEFAULT_LOCALE: Locale = "zh-Hans";

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * The path prefix for a locale: "" for the default, "/<locale>" otherwise.
 */
export function localePrefix(locale: Locale): string {
  return locale === DEFAULT_LOCALE ? "" : `/${locale}`;
}

/**
 * A root-relative path as it is addressed in `locale`.
 *
 * Takes and returns paths with a leading slash. "/" is special-cased so the
 * default locale yields "/" rather than "", and a prefixed locale yields
 * "/en" rather than "/en/".
 */
export function localizePath(path: string, locale: Locale): string {
  const prefix = localePrefix(locale);
  if (!prefix) return path;
  return path === "/" ? prefix : `${prefix}${path}`;
}
