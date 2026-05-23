import { cookies, headers } from "next/headers";
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
export async function getLang(): Promise<Lang> {
  const cookieStore = await cookies();
  const cookieLang = cookieStore.get("lang")?.value;
  if (cookieLang === "zh" || cookieLang === "en") return cookieLang;

  const hdrs = await headers();
  const accept = hdrs.get("accept-language") ?? "";
  for (const tag of accept.split(",").map((s) => s.trim().toLowerCase())) {
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }

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
