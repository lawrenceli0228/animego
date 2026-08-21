// The locale vocabulary — one list, and everything else derives from it.
//
// A `Locale` names a published address; a `Lang` (./lang.ts) names a UI
// dictionary. They are still two types because they answer to two different
// authorities: Google documents the script-variant identifiers ("zh-Hans",
// "zh-Hant" — ISO 15924) that a URL and its hreflang must use, while the
// dictionaries are keyed by the shorter names the codebase has always used.
// LOCALE_LANG below is the only bridge, and it is exhaustive in both
// directions, so neither list can grow without the other being considered.
//
// A locale id doubles as its own hreflang value — no mapping table between
// the URL and the tag it advertises.

import { type Lang } from "./lang";

/**
 * Every locale the site actually publishes, in the order they should appear.
 *
 * Adding an entry here is the whole switch: it grows the hreflang set on
 * every page (lib/seo/alternates.ts), the sitemap's locale expansion, the
 * prefixes the proxy accepts, and the `[lang]` segments the router
 * prerenders. That is the point of keeping the list in one module — the
 * previous arrangement had nine files each hand-writing their own language
 * map, and when one of them was corrected the other eight kept advertising
 * the old, wrong answer for two and a half months.
 *
 * Do not add a locale before its URLs resolve and its content exists. An
 * hreflang pointing at a 404 is worse than no hreflang: Google drops the
 * whole reciprocal group.
 *
 * zh-Hant was held out of this list through the entire build for that reason,
 * and the order mattered more than it looks. Widening LOCALES is SILENT —
 * measured on this branch: adding it produced zero tsc errors and a green
 * build while the sitemap and hreflang immediately advertised a full
 * /zh-Hant/* tree serving Simplified bodies. It was `LANGS` in lang.ts that
 * produced the real worklist (44 errors across 16 files). So the sequence was:
 * widen LANGS, land the dictionaries and the chrome, then this line last.
 *
 * It is here now because all three are true:
 *   - both dictionaries exist and are complete (locales/zh-Hant*.{ts,js})
 *   - no `lang === "zh"` branch is left routing zh-Hant to English copy
 *   - the content pipeline landed: migration 0022 plus the hantbackfill CLI
 */
export const LOCALES = ["zh-Hans", "en", "zh-Hant"] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * The locale served at the un-prefixed path.
 *
 * Simplified Chinese keeps the bare URLs it has always had. Every indexed
 * page on the site is a bare path today, and moving them under a prefix
 * would 301 the entire existing index — the one cost this migration is
 * designed to avoid. It also keeps the Cloudflare cache rule
 * (`starts_with(uri.path, "/anime/")`) matching without being touched.
 */
export const DEFAULT_LOCALE: Locale = "zh-Hans";

/**
 * Which dictionary each locale reads.
 *
 * One-to-one, and it has to stay that way: this map has no "fall back to zh"
 * case, because every locale that can appear in a URL has a dictionary of its
 * own and tsc enforces that.
 *
 * Note this map is a completeness gate, not a correctness one. When zh-Hant
 * was added to LOCALES ahead of LANGS during a spike, `"zh-Hant": "zh"` was
 * the only value that typechecked — and it is wrong in the worst way, since
 * it serves Simplified text under a Traditional URL without erring.
 */
export const LOCALE_LANG: Record<Locale, Lang> = {
  "zh-Hans": "zh",
  en: "en",
  "zh-Hant": "zh-Hant",
};

/**
 * How each locale names ITSELF, for the language menu.
 *
 * Endonyms, not translations: a reader looking for Traditional Chinese is
 * looking for the characters 繁體中文, and a menu that renders "Traditional
 * Chinese" to an English reader and "繁体中文" to a Simplified one is a menu
 * that is unreadable to exactly the person who needs it. So this table is NOT
 * keyed by the reader's language — every entry is the same in every locale,
 * which is why it lives here rather than in the dictionaries.
 *
 * `short` is the compact form for the navbar trigger, which sits in a 56px
 * bar that already overflows at 375px; `endonym` is the menu row.
 *
 * Exhaustive over Locale, so adding a locale to LOCALES is a compile error
 * here until it has named itself — which is the point. Nothing else about the
 * menu needs touching: it maps over LOCALES.
 */
export const LOCALE_LABEL: Record<Locale, { endonym: string; short: string }> = {
  "zh-Hans": { endonym: "简体中文", short: "简" },
  en: { endonym: "English", short: "EN" },
  "zh-Hant": { endonym: "繁體中文", short: "繁" },
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * The next locale in LOCALES, wrapping at the end.
 *
 * No longer what the chrome renders — the cycle button became a menu
 * (components/layout/LanguageMenu.tsx), which is what a set of three or more
 * wants. Kept because it is still the right answer for a keyboard-free
 * programmatic "advance one" and because it is total over LOCALES, which
 * `a === x ? y : x` never was.
 */
export function nextLocale(current: Locale): Locale {
  const at = LOCALES.indexOf(current);
  return at === -1 ? LOCALES[0] : LOCALES[(at + 1) % LOCALES.length];
}

/**
 * The inverse of LOCALE_LANG: which locale publishes a given dictionary.
 *
 * Needed by the language menu (a reader picks a language, the menu needs the
 * URL) and by the proxy's redirect off the legacy `?lang=` parameter.
 * Derived rather than hand-written so the two directions cannot disagree.
 */
export function localeForLang(lang: Lang): Locale {
  const found = LOCALES.find((locale) => LOCALE_LANG[locale] === lang);
  // Unreachable while LOCALE_LANG is exhaustive over LOCALES and every Lang
  // has a locale — but LANGS can legitimately gain an entry before its URL
  // tree exists (that is the whole zh-Hant sequencing), so this returns the
  // default rather than undefined.
  return found ?? DEFAULT_LOCALE;
}

/**
 * The path prefix for a locale: "" for the default, "/<locale>" otherwise.
 */
export function localePrefix(locale: Locale): string {
  return locale === DEFAULT_LOCALE ? "" : `/${locale}`;
}

/**
 * The locale prefixes that may appear in a real URL.
 *
 * The default locale is absent on purpose: it is served bare, so
 * "/zh-Hans/anime/21" is NOT a valid public address even though "zh-Hans" is
 * a valid locale. That distinction is what stops the migration from
 * producing a second, duplicate URL for every page on the site — the proxy
 * treats an incoming "/zh-Hans/…" as an unknown segment and lets it 404.
 */
export const PUBLIC_LOCALE_PREFIXES: readonly Locale[] = LOCALES.filter(
  (locale) => locale !== DEFAULT_LOCALE,
);

/**
 * Split a request path into the locale it addresses and the path within it.
 *
 * Returns the default locale and the path unchanged when there is no public
 * prefix — including for "/zh-Hans/x", which is not a public address (see
 * PUBLIC_LOCALE_PREFIXES) and therefore stays part of `path` so the router
 * can fail to match it.
 */
export function splitLocale(pathname: string): { locale: Locale; path: string } {
  for (const locale of PUBLIC_LOCALE_PREFIXES) {
    const prefix = `/${locale}`;
    if (pathname === prefix) return { locale, path: "/" };
    if (pathname.startsWith(`${prefix}/`)) {
      return { locale, path: pathname.slice(prefix.length) };
    }
  }
  return { locale: DEFAULT_LOCALE, path: pathname };
}

/**
 * A root-relative path as it is addressed in `locale`.
 *
 * Takes and returns paths with a leading slash, and expects `path` to carry
 * no locale prefix of its own. "/" is special-cased so the default locale
 * yields "/" rather than "", and a prefixed locale yields "/en" rather than
 * "/en/".
 */
export function localizePath(path: string, locale: Locale): string {
  const prefix = localePrefix(locale);
  if (!prefix) return path;
  return path === "/" ? prefix : `${prefix}${path}`;
}

/**
 * The internal path the router actually matches, which always carries a
 * locale segment — including the default one.
 *
 * This is the rewrite target, not a URL: a visitor asking for "/anime/21"
 * gets "/[lang]/anime/[id]" with lang="zh-Hans" and never sees this string.
 * Keeping the default locale in the router path is what lets a single route
 * tree serve every locale.
 */
export function routerPath(path: string, locale: Locale): string {
  return path === "/" ? `/${locale}` : `/${locale}${path}`;
}
