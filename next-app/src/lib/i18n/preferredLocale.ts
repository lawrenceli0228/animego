import { DEFAULT_LOCALE, LOCALES, type Locale } from "./locale";

/**
 * Which published locale a browser's language list is asking for.
 *
 * This is the whole decision behind the locale hint, kept out of the
 * component so it can be tested without a browser — `navigator.languages` is
 * the one input that cannot be reproduced in a unit test, and it is also the
 * only part of this that is genuinely simple.
 *
 * ## What the tags actually look like
 *
 * Chinese is the case that needs care, because the script is what matters to
 * us and most browsers send a region instead:
 *
 *   zh-TW, zh-HK, zh-MO   Taiwan, Hong Kong, Macau — Traditional
 *   zh-CN, zh-SG, zh-MY   mainland, Singapore, Malaysia — Simplified
 *   zh-Hant, zh-Hans      the script stated outright, rare but unambiguous
 *   zh                    bare, and ambiguous
 *
 * Bare `zh` resolves to Simplified. It is a genuine coin flip in the
 * standard, but a browser configured by someone reading Traditional
 * overwhelmingly carries a region or script subtag, whereas bare `zh` is what
 * a default install emits. Guessing Simplified also fails softer: it is the
 * un-prefixed tree the visitor is already on, so the hint simply does not
 * appear rather than appearing wrongly.
 *
 * ## Why only the first match counts
 *
 * The list is ordered by preference. If the first tag we recognise is the
 * locale already being served, the visitor is reading what they asked for and
 * there is nothing to suggest — even if a lower-ranked tag maps elsewhere.
 * Scanning past it would let `["zh-CN", "en"]` pull a Simplified reader onto
 * the English tree, which is the opposite of the point.
 */
export function preferredLocale(
  languages: readonly string[] | undefined,
  current: Locale = DEFAULT_LOCALE,
  published: readonly Locale[] = LOCALES,
): Locale | null {
  for (const tag of languages ?? []) {
    const match = localeForTag(tag, published);
    if (!match) continue;
    // First recognised tag wins, whichever way it goes.
    return match === current ? null : match;
  }
  return null;
}

/** One BCP-47 tag to a published locale, or null if we do not serve it. */
function localeForTag(tag: string, published: readonly Locale[]): Locale | null {
  const lower = (tag ?? "").trim().toLowerCase();
  if (!lower) return null;

  const [base, ...rest] = lower.split("-");
  const subtags = new Set(rest);

  let candidate: Locale | null = null;

  if (base === "zh") {
    if (subtags.has("hant") || subtags.has("tw") || subtags.has("hk") || subtags.has("mo")) {
      candidate = "zh-Hant";
    } else {
      // hans / cn / sg / my, and bare zh — see the note above.
      candidate = "zh-Hans";
    }
  } else if (base === "en") {
    candidate = "en";
  }

  // A locale we can name but do not publish is not a suggestion. This is what
  // keeps the function honest when LOCALES shrinks: dropping a locale must
  // stop it being offered, not leave a hint pointing at a 404.
  return candidate && published.includes(candidate) ? candidate : null;
}
