import zh from "@/locales/zh";
import en from "@/locales/en";

// Re-exported so the ~30 modules that already say `from "@/lib/i18n"` keep
// working. New code should import from "@/lib/i18n/lang" directly — this
// module drags both server dictionaries in with it.
export { LANGS, DEFAULT_LANG, isLang, toLang, type Lang } from "@/lib/i18n/lang";

import type { Lang as LangType } from "@/lib/i18n/lang";

export type Dict = typeof zh;

// en.ts intentionally omits the deep `errors` map (the legacy
// LanguageContext fell back to the key string when the lookup missed),
// so its structural type narrows zh's. Cast through unknown to keep
// `Dict = typeof zh` (the richer shape) while accepting both dicts at
// runtime; landing/* code only reads `dict.landing.*` which exists in both.
const DICTS: Record<LangType, Dict> = { zh, en: en as unknown as Dict };

/**
 * The language the server renders in. Always DEFAULT_LANG.
 *
 * Kept async so the ~28 call sites do not all have to change; the name and
 * the `await` are the only things left of the request-scoped version.
 */
// ISR islanding: the server NO LONGER reads the `lang` cookie/header at
// render time (that forced every page dynamic, killing ISR). Every server
// render is the canonical default `zh`; the client (lang-client.tsx) reads
// the `lang` cookie after hydration and swaps the UI to `en` if set. SEO
// pages are zh-canonical (project is Chinese-first), which is the intended
// indexing target. Dynamic/app pages also render zh server-side, then the
// client provider swaps — same as before, just resolved client-side.
export async function getLang(): Promise<LangType> {
  return "zh";
}

export async function getDict(): Promise<Dict> {
  const lang = await getLang();
  return DICTS[lang];
}

export function getDictByLang(lang: LangType): Dict {
  return DICTS[lang];
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
