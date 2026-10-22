// The words on a signed-in device tile: "Mac · Chrome", "上海 · 2 小时前",
// "10月21日登录".
//
// Pure: no DOM, no React. The tiles are server-rendered and then hydrated, so
// whatever runs on both sides must give byte-identical output in Node and in
// the browser. Two rules keep it that way, the same two lib/home/time.ts
// follows: Intl is only asked for numbers (en-US parts), and the words come
// from the tables below, keyed by Lang so a new language is a compile error
// here rather than a silent fallthrough to English.
//
// placeLabel is the exception, and it is server-only: see its note.

import type { Lang } from "@/lib/i18n/lang";
import { formatRelativeTime } from "@/lib/formatters";
import { SITE_TZ } from "@/lib/home/time";

const UNKNOWN_DEVICE: Record<Lang, string> = {
  zh: "未知设备",
  en: "Unknown device",
  "zh-Hant": "未知裝置",
};

const ACTIVE_NOW: Record<Lang, string> = {
  zh: "正在使用",
  en: "Active now",
  "zh-Hant": "正在使用",
};

// The browsers whose names are not the same word in every language. Anything
// else the API reports ("Chrome", "Safari", "Edge" …) is shown as given.
const BROWSER_NAMES: Record<Lang, Readonly<Record<string, string>>> = {
  zh: { WeChat: "微信", QQ: "QQ 浏览器", UC: "UC 浏览器", Samsung: "三星浏览器" },
  en: { WeChat: "WeChat", QQ: "QQ Browser", UC: "UC Browser", Samsung: "Samsung Internet" },
  "zh-Hant": { WeChat: "微信", QQ: "QQ 瀏覽器", UC: "UC 瀏覽器", Samsung: "三星瀏覽器" },
};

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const SIGNED_IN: Record<Lang, (month: number, day: number) => string> = {
  zh: (m, d) => `${m}月${d}日登录`,
  en: (m, d) => `Signed in ${EN_MONTHS[m - 1]} ${d}`,
  "zh-Hant": (m, d) => `${m}月${d}日登入`,
};

// zh-TW rather than zh-Hant for the region names: the dictionaries write
// Taiwan's vocabulary, and the region table differs between the two (南韓).
const REGION_LOCALE: Record<Lang, string> = {
  zh: "zh-CN",
  en: "en",
  "zh-Hant": "zh-TW",
};

const COUNTRY_CODE = /^[A-Z]{2}$/;

/** "微信" for WeChat; any browser the table does not know is shown as given. */
export function browserLabel(browser: string, lang: Lang): string {
  const name = browser.trim();
  const table = BROWSER_NAMES[lang];
  // An own-property check, not `table[name]`: the name comes off the wire,
  // and "constructor" would otherwise find Object.prototype's.
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : name;
}

/** "Mac · Chrome", or whichever half is known, or "未知设备" when neither is. */
export function deviceName(os: string, browser: string, lang: Lang): string {
  const system = os.trim();
  const app = browserLabel(browser, lang);
  if (system && app) return `${system} · ${app}`;
  return system || app || UNKNOWN_DEVICE[lang];
}

/**
 * Where a session was last used: the city when the server knows it, else the
 * country's name, else "".
 *
 * SERVER ONLY. Intl.DisplayNames is the one Intl call here that returns words,
 * and the engines do not agree on them: Node names CN 中国 and HK
 * 中国香港特别行政区, WebKit (and Bun) 中国大陆 and 香港. Called during render
 * on both sides it would mismatch hydration in Safari for exactly the readers
 * this site has most of, so page.tsx resolves it once and the tile is handed
 * the string.
 */
export function placeLabel(
  city: string | null | undefined,
  country: string | null | undefined,
  lang: Lang,
): string {
  const town = city?.trim();
  if (town) return town;
  const code = country?.trim().toUpperCase();
  if (!code || !COUNTRY_CODE.test(code)) return "";
  try {
    const names = new Intl.DisplayNames([REGION_LOCALE[lang]], { type: "region", fallback: "none" });
    return names.of(code) ?? "";
  } catch {
    return "";
  }
}

/** "正在使用" for the session this page was loaded with, else "2 小时前". */
export function lastActiveLabel(lastUsedAt: string, current: boolean, lang: Lang, nowMs: number): string {
  if (current) return ACTIVE_NOW[lang];
  return formatRelativeTime(lastUsedAt, lang, nowMs);
}

const dayParts = new Intl.DateTimeFormat("en-US", {
  timeZone: SITE_TZ,
  month: "numeric",
  day: "numeric",
});

/** "10月21日登录" / "Signed in Oct 21", on the site's own calendar. "" if unparseable. */
export function signedInLabel(createdAt: string, lang: Lang): string {
  const ms = new Date(createdAt).getTime();
  if (!Number.isFinite(ms)) return "";
  let month = 0;
  let day = 0;
  for (const part of dayParts.formatToParts(new Date(ms))) {
    if (part.type === "month") month = Number(part.value);
    if (part.type === "day") day = Number(part.value);
  }
  if (!month || !day) return "";
  return SIGNED_IN[lang](month, day);
}

/** The place, the separator, then the time; either half alone when the other is missing. */
export function metaPrefix(place: string, when: string): string {
  if (!place) return "";
  return when ? `${place} · ` : place;
}
