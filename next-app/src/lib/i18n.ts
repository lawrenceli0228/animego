import zh from "@/locales/zh";
import en from "@/locales/en";

export type Lang = "zh" | "en";
export type Dict = typeof zh;

// en.ts intentionally omits the deep `errors` map (the legacy
// LanguageContext fell back to the key string when the lookup missed),
// so its structural type narrows zh's. Cast through unknown to keep
// `Dict = typeof zh` (the richer shape) while accepting both dicts at
// runtime; landing/* code only reads `dict.landing.*` which exists in both.
const DICTS: Record<Lang, Dict> = { zh, en: en as unknown as Dict };

/**
 * Resolve the user's language from a server-side request.
 *
 * Resolution order:
 *   1. `lang` cookie (set by the legacy LanguageContext; will be
 *      reproduced by the next-app language toggle once landed)
 *   2. Accept-Language header (first preference matching zh* or en*)
 *   3. Default to 'zh' (project audience is Chinese-first)
 */
// ISR islanding: the server NO LONGER reads the `lang` cookie/header at
// render time (that forced every page dynamic, killing ISR). Every server
// render is the canonical default `zh`; the client (lang-client.tsx) reads
// the `lang` cookie after hydration and swaps the UI to `en` if set. SEO
// pages are zh-canonical (project is Chinese-first), which is the intended
// indexing target. Dynamic/app pages also render zh server-side, then the
// client provider swaps — same as before, just resolved client-side.
export async function getLang(): Promise<Lang> {
  return "zh";
}

export async function getDict(): Promise<Dict> {
  const lang = await getLang();
  return DICTS[lang];
}

export function getDictByLang(lang: Lang): Dict {
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
