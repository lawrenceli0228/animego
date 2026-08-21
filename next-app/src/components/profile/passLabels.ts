import type { Lang } from "@/lib/i18n/lang";

// The two record labels that appear on BOTH faces of the member identity:
// once inside the holo card (MemberPass) and once again in the stats rail
// beside it (ProfileHero). They were four separate `lang === "zh" ? … : …`
// ternaries — two copies of each string, in two files, which is how the card
// and the rail beside it end up disagreeing about what the same number means.
//
// Kept as local Records rather than dictionary keys: both components take a
// `lang` prop and neither is inside a LanguageProvider on every page that
// renders them (MemberPass also appears on the /welcome landing), so there is
// no t() to call. They are also component-coupled — a unit suffix sized to a
// card plate, not prose a translator would rewrite.

/**
 * The `aria-label` on the identity <section> — the same landmark on /profile
 * and on the public /u/[username] page, so it is named once.
 */
export const HERO_ARIA: Record<Lang, string> = {
  zh: "会员身份",
  en: "Member identity",
  "zh-Hant": "會員身份",
};

/** Completed-subscription count. Chinese reads "<n> 部" around the number. */
export const WATCHED_LABEL: Record<Lang, string> = {
  zh: "看过 · 部",
  en: "Watched",
  "zh-Hant": "看過 · 部",
};

/** The member's most-active anime season, e.g. "2024 秋季". */
export const TOP_SEASON_LABEL: Record<Lang, string> = {
  zh: "最活跃赛季",
  en: "Top Season",
  "zh-Hant": "最活躍賽季",
};
