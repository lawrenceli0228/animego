"use client";

// Client-side i18n provider, unified with the RSC i18n in @/lib/i18n.
// Single source of truth = the `lang` cookie. The server reads it
// (getLang) and renders RSC in that language; RootLayout passes the same
// resolved lang into this provider as a *controlled* prop, so the ported
// Library + Player client components (hundreds of `t('foo.bar')` call
// sites) stay in lockstep with the rest of the site. Toggling writes the
// cookie and router.refresh()es — the server re-resolves and streams a
// new `lang` prop down, switching server + client together.
//
// Previously this kept its own localStorage + useState copy that never
// synced with the cookie: Library had no provider at all (fell through to
// the zh FALLBACK) and Player was stuck at its localStorage value. That
// split was the "language switch doesn't stick across pages" bug.

import {
  createContext,
  useCallback,
  useContext,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
// locales/*-spa.js are unchecked JS dicts copied from the legacy SPA.
// Keeping them in .js form avoids a 638-line type rewrite; tsc resolves
// them fine because tsconfig allows JS module resolution.
import zh from "@/locales/zh-spa.js";
import en from "@/locales/en-spa.js";

type Dict = Record<string, unknown>;
export type Lang = "zh" | "en";

const DICTS: Record<Lang, Dict> = { zh, en };

const LANG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

/**
 * Persist the language choice in the `lang` cookie — the single place the
 * server (getLang) reads from. Root path + lax same-site so every route
 * sees the switch on the next request. Shared by this provider's toggle
 * and the Navbar button so the cookie attributes never drift.
 */
export function writeLangCookie(lang: Lang): void {
  document.cookie = `lang=${lang}; max-age=${LANG_COOKIE_MAX_AGE}; path=/; samesite=lax`;
}

interface LangContextValue {
  lang: Lang;
  toggle: () => void;
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
 * Controlled by `lang` (server-resolved from the cookie). The value is the
 * prop, not internal state, so a router.refresh() that re-renders the
 * server layout with a new cookie flows a new `lang` down and every
 * useLang() consumer re-renders in lockstep.
 */
export function LanguageProvider({
  lang,
  children,
}: {
  lang: Lang;
  children: ReactNode;
}) {
  const router = useRouter();

  const toggle = useCallback(() => {
    writeLangCookie(lang === "zh" ? "en" : "zh");
    router.refresh();
  }, [lang, router]);

  const t = useCallback(
    (key: string, opts?: { defaultValue?: string }) =>
      resolve(DICTS[lang], key, opts),
    [lang],
  );

  return (
    <LanguageContext.Provider value={{ lang, toggle, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

// Fallback dict resolves against zh — keeps tests + accidental
// bare-mounted components from crashing or showing raw keys.
const FALLBACK: LangContextValue = {
  lang: "zh",
  toggle: () => {},
  t: (key, opts) => resolve(DICTS.zh, key, opts),
};

export const useLang = (): LangContextValue =>
  useContext(LanguageContext) ?? FALLBACK;
