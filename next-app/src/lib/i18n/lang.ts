// The UI language vocabulary. One declaration, imported by everything.
//
// This module deliberately imports nothing. `lib/i18n.ts` pulls in both
// server dictionaries (67KB of .ts) and `lib/lang-client.tsx` pulls in both
// client ones, so neither could import a value from the other without
// dragging a dictionary into the wrong bundle — which is why `Lang` ended up
// declared three times, plus eight more anonymous `"zh" | "en"` unions
// written inline in function signatures and prop types. Eleven copies of one
// union, each of which has to be found and widened by hand.
//
// Distinct from `Locale` in ./locale.ts: a `Lang` selects a dictionary, a
// `Locale` names a published address. They will converge when the localized
// URL trees land, and keeping them apart until then is what stops the URL
// vocabulary from leaking into 44 files of UI code before it is settled.

/**
 * Every language the UI can render, in menu order.
 *
 * This tuple is the widening point. Adding an entry turns every
 * `Record<Lang, …>` lookup table in the codebase into a compile error until
 * it gains the new key — which is the whole purpose. There are around thirty
 * such tables; finding them by hand is not a plan.
 */
export const LANGS = ["zh", "en"] as const;

export type Lang = (typeof LANGS)[number];

/** What the server renders, and what an unrecognised cookie falls back to. */
export const DEFAULT_LANG: Lang = "zh";

export function isLang(value: string | null | undefined): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

/**
 * Coerce an untrusted string — a cookie, a query param — to a language.
 *
 * The client used to do this with a regex that tested for exactly one
 * alternative (`/lang=en/`) and returned the default for everything else, so
 * a third language could be written to the cookie and would silently read
 * back as Chinese.
 */
export function toLang(value: string | null | undefined): Lang {
  return isLang(value) ? value : DEFAULT_LANG;
}

// ─── Language tags for the platforms that do not speak our vocabulary ──────
//
// Three different spellings of the same fact, because three consumers each
// want their own. They were written inline at ten call sites across five
// files — `lang === "en" ? "en_US" : "zh_CN"` and friends — which is nine
// more places than a per-language constant needs to live, and every one of
// them silently answers for the wrong language once there are three.
//
// The values are deliberately NOT unified: `<html lang>` says "en" where
// Intl says "en-US", and changing either to match the other would change
// what ships. They are separate maps because they are separate facts.

/** BCP 47 tags for `Intl` and `toLocaleString`. */
export const BCP47_TAG: Record<Lang, string> = {
  zh: "zh-CN",
  en: "en-US",
};

/** The `lang` attribute on `<html>`. */
export const HTML_LANG: Record<Lang, string> = {
  zh: "zh-CN",
  en: "en",
};

/** OpenGraph `og:locale`, which uses an underscore rather than a hyphen. */
export const OG_LOCALE: Record<Lang, string> = {
  zh: "zh_CN",
  en: "en_US",
};

/**
 * `og:locale:alternate` for `lang` — every other language's OG locale.
 *
 * Derived rather than listed. The four hand-written copies of this were
 * each `lang === "en" ? ["zh_CN"] : ["en_US"]`, which is only correct while
 * there are exactly two languages and silently drops one the moment there
 * are three.
 */
export function alternateOgLocales(lang: Lang): string[] {
  return LANGS.filter((other) => other !== lang).map((other) => OG_LOCALE[other]);
}
