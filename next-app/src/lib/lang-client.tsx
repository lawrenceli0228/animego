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
  useEffect,
  useState,
  type ReactNode,
} from "react";
// locales/*-spa.js are unchecked JS dicts copied from the legacy SPA.
// Keeping them in .js form avoids a 638-line type rewrite; tsc resolves
// them fine because tsconfig allows JS module resolution.
import zh from "@/locales/zh-spa.js";
import en from "@/locales/en-spa.js";
// From @/lib/i18n/lang, NOT @/lib/i18n: the latter imports both *server*
// dictionaries (67KB of .ts) and would drag them into every client chunk
// that touches useLang(). lang.ts imports nothing, so it is safe on both
// sides — that is the entire reason it exists as a separate module.
// `Lang` comes in as a type-only binding so it is erased outright.
import { DEFAULT_LANG, LANGS, toLang, type Lang } from "@/lib/i18n/lang";

type Dict = Record<string, unknown>;

const DICTS: Record<Lang, Dict> = { zh, en };

const LANG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
const LANG_CHANGE_EVENT = "animego:langchange";

/**
 * Persist the language choice in the `lang` cookie — the single place the
 * server (getLang) reads from. Root path + lax same-site so every route
 * sees the switch on the next request. Shared by this provider's toggle
 * and the Navbar button so the cookie attributes never drift.
 */
export function writeLangCookie(lang: Lang): void {
  document.cookie = `lang=${lang}; max-age=${LANG_COOKIE_MAX_AGE}; path=/; samesite=lax`;
  // Notify provider-less islands (the ssr:false Library/Player chunks — see
  // useLang) to re-read the cookie so they switch in lockstep with the
  // Navbar toggle even though they can't see the RootLayout provider.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(LANG_CHANGE_EVENT));
  }
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
  lang: seed,
  children,
}: {
  lang: Lang;
  children: ReactNode;
}) {
  // ISR islanding: the server renders the canonical default (`seed` = "zh")
  // and no longer reads the `lang` cookie at render (that forced every page
  // dynamic). Resolve the real language on the CLIENT from the cookie after
  // hydration, and stay reactive to the Navbar toggle via the langchange
  // event — the same source the ssr:false island fallback (useLang) reads,
  // so server content + chrome + islands all switch in lockstep.
  const [lang, setLang] = useState<Lang>(seed);

  useEffect(() => {
    const sync = () => setLang(cookieLang());
    sync(); // reconcile after mount (SSR seeded zh; cookie may be en)
    window.addEventListener(LANG_CHANGE_EVENT, sync);
    return () => window.removeEventListener(LANG_CHANGE_EVENT, sync);
  }, []);

  const toggle = useCallback(() => {
    // writeLangCookie dispatches langchange → sync() re-reads the cookie.
    writeLangCookie(nextLang(lang));
  }, [lang]);

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

/**
 * Advance to the next language in LANGS, wrapping at the end.
 *
 * The single control in the chrome is a *cycle* button, so this has to stay
 * total over LANGS rather than a two-state flip: `lang === "zh" ? "en" : "zh"`
 * would strand a third language permanently — reachable only by hand-editing
 * the cookie, and one click away from being lost again. A language absent
 * from LANGS (a stale cookie value that toLang already rejected) restarts the
 * cycle at LANGS[0].
 *
 * For a jump-to-language menu rather than a cycle, call `writeLangCookie`
 * directly: it is exported, and it already dispatches the langchange event
 * that keeps the provider and the ssr:false islands in step. There is
 * deliberately no second `setLang` wrapper around it.
 *
 * Exported only so lang-client.test.ts can reach it. It is pure — no
 * `document`, no React — which is the point: the suite must not have to stub a
 * DOM global to test it (bun shares one process across files, so a stray
 * `globalThis.document` changes how unrelated suites behave).
 */
export function nextLang(current: Lang): Lang {
  const at = LANGS.indexOf(current);
  return at === -1 ? LANGS[0] : LANGS[(at + 1) % LANGS.length];
}

/**
 * Read one cookie out of a `document.cookie` jar by name.
 *
 * Deliberately not a regex over the whole jar. The version this replaced was
 * `/(?:^|;\s*)lang=en\b/` — a test for one specific value that answered a
 * yes/no question the caller then turned into "en or zh". Any third language
 * written to the cookie read back as Chinese, silently, forever.
 *
 * No decodeURIComponent: language tags are `[a-zA-Z-]` and writeLangCookie
 * never percent-encodes, so decoding would only add a throw path on a
 * malformed jar. A value we did not write simply fails toLang and falls back.
 *
 * Takes the jar as an argument rather than reading `document.cookie` itself
 * so it stays testable without a DOM stub — see nextLang.
 */
export function readCookie(jar: string, name: string): string | null {
  for (const part of jar.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

/** Read the `lang` cookie on the client; DEFAULT_LANG during SSR (no document). */
function cookieLang(): Lang {
  if (typeof document === "undefined") return DEFAULT_LANG;
  return toLang(readCookie(document.cookie, "lang"));
}

/**
 * Returns the RootLayout provider's context when present. When it is NOT —
 * inside an `ssr: false` dynamic island (library/player), whose async chunk
 * resolves a *separate* LanguageContext instance and so can't see the
 * provider — fall back to the `lang` cookie (the same source the server
 * reads) instead of hardcoding zh, staying reactive to Navbar toggles via
 * the langchange event. Hooks run unconditionally (rules-of-hooks).
 */
export const useLang = (): LangContextValue => {
  const ctx = useContext(LanguageContext);
  const [fallbackLang, setFallbackLang] = useState<Lang>(cookieLang);

  useEffect(() => {
    if (ctx) return; // provider present — fallback unused
    const sync = () => setFallbackLang(cookieLang());
    sync(); // reconcile after mount (SSR seeded zh; cookie may be en)
    window.addEventListener(LANG_CHANGE_EVENT, sync);
    return () => window.removeEventListener(LANG_CHANGE_EVENT, sync);
  }, [ctx]);

  if (ctx) return ctx;
  return {
    lang: fallbackLang,
    toggle: () => writeLangCookie(nextLang(fallbackLang)),
    t: (key, opts) => resolve(DICTS[fallbackLang], key, opts),
  };
};
