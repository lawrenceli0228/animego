// One builder for every canonical and hreflang tag on the site.
//
// Why this exists, concretely: nine route files each hand-wrote their own
// `alternates` block, and eight of them advertised
//
//     <link rel="alternate" hreflang="en-US" href="https://animegoclub.com/?lang=en">
//
// while `getLang()` returned "zh" unconditionally and the server never read
// `?lang=en`. That URL served byte-identical Chinese HTML. (getLang is gone;
// the server takes its language from the `[lang]` route segment now, and
// `?lang=en` was never a real address.) The
// bug was diagnosed and fixed in d91c753 — in `/anime/[id]` only. The other
// eight files kept making the false claim for the next two and a half months,
// because nothing connected them.
//
// hreflang is unusually unforgiving of exactly this. Google: "If two pages
// don't both point to each other, the tags will be ignored", and "Each
// language version must list itself as well as all other language versions."
// One page with a stale map silently voids the whole reciprocal group, and
// nothing in a build, a test run, or a screenshot shows it. A generated set
// cannot fall out of sync with itself; nine hand-written ones did.
//
// See lib/i18n/locale.ts for the locale list this derives from.

import { LOCALES, DEFAULT_LOCALE, localizePath, type Locale } from "@/lib/i18n/locale";

/**
 * The site's public origin.
 *
 * Also passed to `metadataBase` in the root layout, which is what resolves
 * the relative paths returned below into absolute URLs. Keep those two the
 * same value: a canonical is only self-referential if the origin matches.
 */
export const SITE_ORIGIN = "https://animegoclub.com";

/** What `generateMetadata` accepts for `alternates`. */
export interface Alternates {
  canonical: string;
  languages?: Record<string, string>;
}

/**
 * `alternates` for `path` as addressed in `locale`.
 *
 * `path` is root-relative with a leading slash and carries no locale prefix
 * — pass "/faq", not "/en/faq". Paths are returned relative; `metadataBase`
 * makes them absolute.
 *
 * The language map is emitted only once there is more than one locale to
 * describe. With a single locale it would be a page pointing at itself and
 * nothing else, which says nothing that the canonical has not already said
 * — and the site spent months emitting a map that was worse than saying
 * nothing at all.
 *
 * `locales` is injectable so the reciprocity rules can be tested against the
 * multi-locale shape before those locales exist. Callers should not pass it.
 */
export function buildAlternates(
  path: string,
  locale: Locale = DEFAULT_LOCALE,
  locales: readonly Locale[] = LOCALES,
): Alternates {
  const canonical = localizePath(path, locale);

  if (locales.length < 2) return { canonical };

  const languages: Record<string, string> = {};
  // Self-referential: this locale lists itself alongside the others. Omitting
  // it is the most common way to void a group.
  for (const other of locales) {
    languages[other] = localizePath(path, other);
  }
  // x-default is the fallback for a searcher whose language matches none of
  // the above. It points at the un-prefixed tree, which is where every
  // existing indexed URL already lives.
  languages["x-default"] = localizePath(path, DEFAULT_LOCALE);

  return { canonical, languages };
}

/**
 * `alternates` for a page that exists in the default locale only.
 *
 * /privacy, /terms and /copyright are hardcoded Chinese JSX with no English
 * body. Once LOCALES gained a second entry, the ordinary builder started
 * advertising an English version of them — which is precisely the bug this
 * module was written to remove, rebuilt from the other direction. Under this
 * one there is no language map at all, so the page makes no claim, and the
 * canonical still points at the URL the reader is on.
 *
 * Reach for this only when the CONTENT is untranslated. A page whose
 * translation is merely incomplete should still join the group; hreflang
 * describes which URL serves which language, not how good the copy is.
 */
export function buildAlternatesUntranslated(path: string, locale: Locale = DEFAULT_LOCALE): Alternates {
  return { canonical: localizePath(path, locale) };
}

/**
 * An absolute URL for `path`, for the places that cannot use a relative one
 * — JSON-LD `@id` and `url` fields, the sitemap, robots.txt. `metadataBase`
 * does not reach into those.
 */
export function absoluteUrl(path: string, locale: Locale = DEFAULT_LOCALE): string {
  return `${SITE_ORIGIN}${localizePath(path, locale)}`;
}
