import zh from "@/locales/zh";
import en from "@/locales/en";

// Re-exported so the ~30 modules that already say `from "@/lib/i18n"` keep
// working. New code should import from "@/lib/i18n/lang" directly — this
// module drags both server dictionaries in with it.
export { LANGS, DEFAULT_LANG, isLang, toLang, type Lang } from "@/lib/i18n/lang";

// A re-export does not bind the name locally, so getDict() below needs its
// own value import of DEFAULT_LANG.
import { DEFAULT_LANG } from "@/lib/i18n/lang";
import type { Lang as LangType } from "@/lib/i18n/lang";

export type Dict = typeof zh;

// en.ts intentionally omits the deep `errors` map (the legacy
// LanguageContext fell back to the key string when the lookup missed),
// so its structural type narrows zh's. Cast through unknown to keep
// `Dict = typeof zh` (the richer shape) while accepting both dicts at
// runtime; landing/* code only reads `dict.landing.*` which exists in both.
const DICTS: Record<LangType, Dict> = { zh, en: en as unknown as Dict };

// There is deliberately no getLang() here any more.
//
// It used to answer the question "what language is the server rendering in?"
// with the constant "zh". That was correct while the site published exactly
// one locale at exactly one set of URLs: reading the `lang` cookie at render
// time forced every page dynamic and killed ISR, so the server rendered the
// canonical Chinese and let the client swap after hydration.
//
// Once the route tree moved under app/[lang]/ the constant became a lie with
// no error attached to it: /en/anything resolved "zh" and served Chinese from
// an English URL, on all ~28 call sites at once, silently. The language is a
// property of the request's PATH now, so it arrives as a route param and only
// the router can supply it — see lib/i18n/route.ts resolveLocale(), which is
// the one place that turns that param into a locale, a Lang and a dictionary.
//
// Removed rather than deprecated on purpose. A pinned getLang() that still
// compiles is a working-looking answer to a question it cannot answer, and it
// would be reintroduced by the next component that finds itself without a
// param. Server Components outside the route tree take `lang` as a prop;
// Client Components use useLang() (lib/lang-client.tsx).

/**
 * The dictionary for `lang`. The primary accessor — resolveLocale() calls it.
 *
 * Also for Server Components outside the route tree, which receive a `lang`
 * prop from their caller rather than reading one.
 */
export function getDictByLang(lang: LangType): Dict {
  return DICTS[lang];
}

/**
 * The DEFAULT dictionary — not the current request's.
 *
 * @deprecated Prefer `resolveLocale(params).dict` on anything under
 * app/[lang]/. This returns DEFAULT_LANG unconditionally, so a page that uses
 * it renders Chinese at every URL including /en/… — the same defect getLang()
 * was deleted for, one layer up.
 *
 * It survives because a dozen routes still call it (admin, login, register,
 * forgot-password, reset-password, and the library/player layouts) and
 * converting them is its own change. Behaviour is unchanged from when this
 * delegated to getLang(): those pages rendered the default language before and
 * render it now. Do not add call sites.
 */
/**
 * The default-language dictionary, for the handful of callers that cannot
 * reach the route param.
 *
 * The Server Actions in app/[lang]/admin/_actions/users.ts are the real
 * remaining users: an action runs outside the render tree, so there is no
 * `params` to resolve and the language would have to be threaded from each
 * client call site. Those messages are admin-only validation strings on a
 * noindex internal page, so they stay Chinese rather than earning a
 * signature change on four exported actions.
 *
 * Anything that renders a page has `params` — use resolveLocale.
 */
export async function getDict(): Promise<Dict> {
  return DICTS[DEFAULT_LANG];
}

/**
 * Path-based lookup helper for components ported from the legacy
 * `useLang().t('a.b.c')` pattern. Prefer typed access on the dict
 * object directly (e.g. `dict.landing.stats.s1Label`) when possible.
 *
 * @example
 *   const t = tFromDict(dict);
 *   t('landing.stats.s1Label')
 *   t('errors.NotFound', { defaultValue: 'fallback' })
 */
export function tFromDict(
  dict: Dict,
): (key: string, opts?: { defaultValue?: string }) => string {
  return (key, opts) => {
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
    if (opts?.defaultValue !== undefined) return opts.defaultValue;
    return key;
  };
}
