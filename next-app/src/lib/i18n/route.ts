// Resolving the `[lang]` route segment, once, for every page and layout.
//
// Every route now lives under app/[lang]/, so the locale arrives as a route
// param rather than being pinned to "zh" by getLang(). This is the only
// place that turns that param into the three things a page actually wants —
// the locale (for URLs and hreflang), the language (for dictionaries and
// label tables), and the dictionary itself.
//
// It is a helper rather than three lines copied into ~28 files because the
// validation is the load-bearing part. `[lang]` matches ANY first segment:
// without a guard, "/wp-admin" would render the homepage with lang="wp-admin"
// and a 200, which is a soft 404 on every unmatched URL on the site. The
// proxy already rewrites unknown segments under the default locale so they
// fall through to not-found, but a page must not depend on the proxy having
// run — the matcher excludes paths, and an excluded path that still matched
// a route would arrive here unguarded.

import { notFound } from "next/navigation";
import { getDictByLang, type Dict } from "@/lib/i18n";
import { isLocale, LOCALE_LANG, LOCALES, type Locale } from "./locale";
import { type Lang } from "./lang";

/** The shape Next hands a page or layout under app/[lang]/. */
export interface LangParams {
  params: Promise<{ lang: string }>;
}

export interface ResolvedLocale {
  locale: Locale;
  lang: Lang;
  dict: Dict;
}

/**
 * The locale, language and dictionary for this request.
 *
 * 404s on a segment that is not a published locale. Note that this accepts
 * the DEFAULT locale as a segment value even though "/zh-Hans/…" is not a
 * public URL: the default locale is what the proxy rewrites bare paths to,
 * so it is the value this sees on the overwhelming majority of requests.
 * Keeping "/zh-Hans/…" from being publicly addressable is the proxy's job,
 * not this function's — see PUBLIC_LOCALE_PREFIXES.
 */
export async function resolveLocale(params: LangParams["params"]): Promise<ResolvedLocale> {
  const { lang: segment } = await params;
  if (!isLocale(segment)) notFound();
  const lang = LOCALE_LANG[segment];
  return { locale: segment, lang, dict: getDictByLang(lang) };
}

/**
 * The `[lang]` values to prerender.
 *
 * Exported for routes that compose it with their own params — the anime
 * detail route needs the product of this and its id list, and getting that
 * product wrong is how a whole locale silently stops being prerendered.
 */
export function localeParams(): Array<{ lang: Locale }> {
  return LOCALES.map((locale) => ({ lang: locale }));
}
