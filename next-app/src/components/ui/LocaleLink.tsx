"use client";

// A `next/link` that keeps the reader in the locale they are already in.
//
// Root-relative hrefs are locale-blind: `<Link href="/search">` sends an
// English reader at /en/anime/21 to the bare /search, which the proxy
// resolves to Simplified Chinese. There are 62 such links across 41 files,
// so the fix is a drop-in replacement rather than 62 call-site edits — every
// one of those files changes its import and nothing else. Any `href` this
// does not recognise is passed through untouched.
//
// The locale comes from the URL rather than a prop or a context, which is
// what lets this work in three places at once: inside Server Components
// (a Client Component child still renders on the server), inside ordinary
// Client Components, and inside the `ssr: false` Library/Player islands,
// which resolve a separate React context instance and therefore cannot see
// the LanguageProvider at all.
//
// It is also correct on prerendered output. A page prerendered at
// /zh-Hans/anime/21 and served for the bare /anime/21 sees whichever of the
// two `usePathname` reports, and both resolve to the default locale:
// "zh-Hans" is not a public prefix (see PUBLIC_LOCALE_PREFIXES), so
// splitLocale leaves it in the path rather than reading it as a locale.

import NextLink from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, type ComponentProps } from "react";
import { localizePath, splitLocale, type Locale } from "@/lib/i18n/locale";

type NextLinkProps = ComponentProps<typeof NextLink>;
type AppRouter = ReturnType<typeof useRouter>;

/**
 * True when `href` names a page on this site by a root-relative path.
 *
 * Everything else is left alone: absolute URLs and other schemes belong to
 * someone else, a bare fragment or query stays on the current page, and
 * /api/* is not a page at all. Passing those through unchanged matters more
 * than catching every case — a wrongly prefixed href is a 404, while a
 * missed one merely fails to switch locale.
 */
function isLocalizablePath(href: string): boolean {
  if (!href.startsWith("/")) return false;
  if (href.startsWith("//")) return false; // protocol-relative
  if (href.startsWith("/api/")) return false;
  return true;
}

export function localizeHref(href: string, locale: Locale): string {
  if (!isLocalizablePath(href)) return href;

  // Split off the query and fragment: only the path takes the prefix.
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  const suffix = cut === -1 ? "" : href.slice(cut);

  // Already carries a prefix — an explicitly cross-locale link, e.g. the
  // language menu. Prefixing it again would produce /en/en/faq.
  if (splitLocale(path).path !== path) return href;

  return `${localizePath(path, locale)}${suffix}`;
}

/**
 * The locale of the page currently on screen.
 *
 * The same derivation LocaleLink and useLocaleRouter do, exported for the
 * handful of places that build a URL by hand and cannot go through either —
 * a raw <a> that needs target="_blank", or a `from` payload assembled from
 * something other than the current path.
 */
export function useLocale(): Locale {
  return splitLocale(usePathname() ?? "/").locale;
}

export default function LocaleLink({ href, ...props }: NextLinkProps) {
  const pathname = usePathname();
  const { locale } = splitLocale(pathname ?? "/");

  // `href` is UrlObject | string. Only strings are rewritten; a UrlObject
  // caller is doing something deliberate enough to localize its own pathname.
  const localized = typeof href === "string" ? localizeHref(href, locale) : href;

  return <NextLink href={localized} {...props} />;
}

/**
 * `useRouter`, with the same locale rule LocaleLink applies to an `href`
 * applied to `push`, `replace` and `prefetch`.
 *
 * A hook rather than a `localizeHref(...)` at each of the sixteen programmatic
 * navigations, for the same reason the Link fix is a wrapper rather than 62
 * call-site edits: at a call site the transform is invisible. A reviewer
 * reading `router.push("/library")` cannot tell whether the author considered
 * locales or forgot, and the next `router.push` added to the file inherits
 * whichever answer that file happens to hold. One swapped import moves the
 * decision to one place, mirrors what LocaleLink already does to every
 * `<Link>` in the very same components, and shares `localizeHref` with it so
 * the link rule and the router rule cannot drift apart.
 *
 * Navigations that carry no path — `router.replace("?page=2")`, as the
 * seasonal filters do — are resolved against the current URL by the browser
 * and are already locale-correct, so `localizeHref` passes them through and
 * those callers have no reason to swap.
 *
 * Everything that is not a navigation (`back`, `forward`, `refresh`, and the
 * experimental gesture API) is forwarded by the spread. That is safe here and
 * not merely convenient: Next builds its router as a plain object of arrow
 * closures with no `this` (next/dist/client/components/app-router-instance.js),
 * so spreading copies live functions rather than detaching methods from a
 * prototype.
 */
export function useLocaleRouter(): AppRouter {
  const router = useRouter();
  const pathname = usePathname();
  const { locale } = splitLocale(pathname ?? "/");

  return useMemo<AppRouter>(
    () => ({
      ...router,
      push: (href, options) => router.push(localizeHref(href, locale), options),
      replace: (href, options) =>
        router.replace(localizeHref(href, locale), options),
      prefetch: (href, options) =>
        router.prefetch(localizeHref(href, locale), options),
    }),
    [router, locale],
  );
}
