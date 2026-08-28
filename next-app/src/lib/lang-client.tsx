"use client";

// Client-side i18n provider, paired with the RSC i18n in @/lib/i18n.
//
// RootLayout seeds the provider with the language of the URL's `[lang]`
// segment, which is what the SSR pass renders, and that value is used as
// given. The URL is the only source; server and client cannot disagree.
//
// The paragraph that stood here said the opposite, in detail: that "after
// hydration the effect below replaces it with the `lang` COOKIE", so client
// leaves followed a stored preference while the server-rendered content around
// them followed the address, and that the resulting gap was "deliberate and
// unreconciled". There is no such effect. This file imports neither useEffect
// nor useState, reads no cookie, and LanguageProvider has no reconciliation
// step (see its own note below, which was right all along).
//
// It matters because it was load-bearing for other people's reasoning: the
// same claim is repeated in about a dozen files — including the note beside
// SeasonalFilterChips in app/[lang]/seasonal/[season]/[year]/page.tsx, which
// cites it to justify a design decision — and it was cited as the reason the
// 404 page could not be trusted to render in the URL's language. It does; that
// is now asserted in a browser, in all three locales, by
// e2e/specs/sandbox/not-found-status.spec.ts. Cleaning up the other copies is
// its own pass; see TODOS.md.
//
// The provider is what keeps the ported Library + Player client components
// (hundreds of `t('foo.bar')` call sites) in lockstep with each other.
//
// Previously this kept its own localStorage + useState copy that never
// synced with the cookie: Library had no provider at all (fell through to
// the zh FALLBACK) and Player was stuck at its localStorage value. That
// split was the "language switch doesn't stick across pages" bug.

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, type ReactNode } from "react";
// locales/*-spa.js are unchecked JS dicts copied from the legacy SPA.
// Keeping them in .js form avoids a 638-line type rewrite; tsc resolves
// them fine because tsconfig allows JS module resolution.
import zh from "@/locales/zh-spa.js";
import en from "@/locales/en-spa.js";
import zhHant from "@/locales/zh-Hant-spa.js";
// From @/lib/i18n/lang, NOT @/lib/i18n: the latter imports both *server*
// dictionaries (67KB of .ts) and would drag them into every client chunk
// that touches useLang(). lang.ts imports nothing, so it is safe on both
// sides — that is the entire reason it exists as a separate module.
// `Lang` comes in as a type-only binding so it is erased outright.
import { type Lang } from "@/lib/i18n/lang";
import {
  LOCALE_LANG,
  localizePath,
  splitLocale,
  type Locale,
} from "@/lib/i18n/locale";

type Dict = Record<string, unknown>;

const DICTS: Record<Lang, Dict> = { zh, en, "zh-Hant": zhHant };


interface LangContextValue {
  lang: Lang;
  /**
   * Navigate to `locale`, keeping the current path and query.
   *
   * Takes the target rather than advancing a cycle. The cycle it replaced
   * (`toggle`) was fine at two locales and became a lie at three: it invited a
   * reader on a Traditional page to "switch to Chinese" while they were
   * already reading Chinese. The control is a menu now — see
   * components/layout/LanguageMenu.tsx — and a menu names its destination.
   */
  switchTo: (locale: Locale) => void;
  t: (key: string, opts?: { defaultValue?: string }) => string;
}

const LanguageContext = createContext<LangContextValue | null>(null);

function resolve(
  dict: Dict,
  key: string,
  opts?: { defaultValue?: string },
): string {
  const parts = key.split(".");
  let val: unknown = dict;
  for (const p of parts) {
    if (val && typeof val === "object" && p in (val as Record<string, unknown>)) {
      val = (val as Record<string, unknown>)[p];
    } else {
      val = undefined;
      break;
    }
  }
  if (val !== undefined && val !== null) return String(val);
  if (opts && Object.prototype.hasOwnProperty.call(opts, "defaultValue")) {
    return opts.defaultValue ?? key;
  }
  return key;
}

/**
 * Controlled by `lang`, which RootLayout resolves from the `[lang]` route
 * segment. The value is the prop, not internal state, so a navigation that
 * re-renders the server layout under a different locale flows a new `lang`
 * down and every useLang() consumer re-renders in lockstep.
 *
 * ("server-resolved from the cookie" is what this said; there is no cookie in
 * that path — see the correction at the top of this file.)
 */
export function LanguageProvider({
  lang,
  children,
}: {
  lang: Lang;
  children: ReactNode;
}) {
  // `lang` is used as given. There is no reconciliation step and no local
  // state: the route segment already decided, the server rendered that
  // decision, and anything that disagreed with it here would be a repaint
  // contradicting the page's own <html lang> and canonical.
  return (
    <LanguageContext.Provider value={{ lang, switchTo: useLocaleSwitch(), t: useT(lang) }}>
      {children}
    </LanguageContext.Provider>
  );
}

function useT(lang: Lang) {
  return useCallback(
    (key: string, opts?: { defaultValue?: string }) => resolve(DICTS[lang], key, opts),
    [lang],
  );
}

/**
 * Switching language is a navigation, because the language lives in the URL.
 *
 * Reads the PATH, not the language: the path is what is about to change, and
 * deriving the rewrite from the thing being changed is one fewer place for the
 * two vocabularies to disagree.
 *
 * The query string rides along — switching language on /search?q=frieren
 * should keep the search.
 */
function useLocaleSwitch() {
  const pathname = usePathname();

  return useCallback((target: Locale) => {
    const { path } = splitLocale(pathname ?? "/");
    // The query is read from the document at click time rather than through
    // useSearchParams(). That hook forces a client-side bailout in any
    // component not wrapped in a Suspense boundary, and this provider sits in
    // the ROOT layout — using it here took every route in the app with it,
    // including /anime/[id], whose prerendering is the only reason the
    // Cloudflare edge cache has anything to hold. The build catches it, but
    // only as "Error occurred prerendering page", which does not name the
    // cause.
    //
    // A click handler never runs during render or on the server, so there is
    // nothing a hook would buy here anyway.
    if (typeof window === "undefined") return;
    // A full navigation rather than router.push. Two reasons, and the second
    // is the one that bit:
    //
    //   - The locale lives in the ROOT layout's own segment, so switching it
    //     replaces the entire server tree anyway. There is no partial render
    //     to preserve.
    //   - useRouter() throws "invariant expected app router to be mounted"
    //     with no router context, and useLang() — which calls this — is used
    //     by 73 components, several of which are exercised by bare
    //     renderToString tests. Requiring a router here made fourteen admin
    //     rendering tests fail for a reason that had nothing to do with what
    //     they assert.
    window.location.assign(localizePath(path, target) + window.location.search);
  }, [pathname]);
}

/**
 * The provider's context when it is reachable, and an equivalent derived
 * from the URL when it is not.
 *
 * It is not reachable inside the `ssr: false` Library and Player islands:
 * their async chunk resolves a separate LanguageContext instance, so
 * useContext returns null no matter what the layout rendered. That fallback
 * used to read the `lang` cookie. It reads the path instead, which is the
 * same source the provider itself is fed from, so the two cannot disagree —
 * and it keeps working after the cookie was removed.
 *
 * Hooks run unconditionally either way (rules of hooks).
 */
export const useLang = (): LangContextValue => {
  const ctx = useContext(LanguageContext);
  const pathname = usePathname();
  const fallbackLang = LOCALE_LANG[splitLocale(pathname ?? "/").locale];
  const switchTo = useLocaleSwitch();
  const t = useT(fallbackLang);

  return ctx ?? { lang: fallbackLang, switchTo, t };
};
