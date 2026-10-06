// What the site header links to.
//
// One list, shared by the desktop bar and the phone drawer, so the two can
// never disagree about which pages exist or in what order. Labels are not
// here: they come from the client dictionaries through literal t("nav.…")
// calls in the components, which is what spaDictCoverage.test.ts can see.

import type { AuthChrome } from "@/lib/authChrome";
import { FILTER_GENRES, genreLabel, type FilterGenre } from "@/lib/contentLabels";
import { genrePath } from "@/lib/hubs/paths";
import type { Lang } from "@/lib/i18n/lang";
import { splitLocale } from "@/lib/i18n/locale";

export type NavKey = "home" | "schedule" | "season" | "genres" | "myList" | "about";

export interface NavEntry {
  readonly key: NavKey;
  /** Where the entry goes. The genres menu has no page of its own. */
  readonly href: string;
  /** The section it marks as current: itself and everything below it. */
  readonly section: string;
  /** "menu" is the 分类 dropdown; everything else is a plain link. */
  readonly kind: "link" | "menu";
  /**
   * An inert, invisible stand-in of the same width — never a link. Only the
   * signed-in entry uses it, and only while the session probe is in flight.
   */
  readonly placeholder: boolean;
}

const link = (key: NavKey, href: string, section = href): NavEntry => ({
  key,
  href,
  section,
  kind: "link",
  placeholder: false,
});

/**
 * The header's entries, in order: 首页 · 放送表 · 季度 · 分类 · [我的追番] · 关于.
 *
 * /library is deliberately absent in every state. It is the local-file player
 * (File System Access plus a granted folder, gated by proxy.ts either way), so
 * as a top-level entry it is pure confusion for a first-time visitor; it lives
 * in the account menu.
 *
 * 我的追番 (/profile) follows the auth tri-state (lib/authChrome):
 *
 *   anonymous → absent. Reserving its width for a visitor leaves a visible
 *               gap between 分类 and 关于 on every anonymous page view, and
 *               anonymous is most of the traffic.
 *   probing   → a same-width placeholder. Probing is only entered when the
 *               auth_hint cookie says a session is likely, so the real link
 *               is one round trip away; reserving its box stops 关于 from
 *               jumping right when it lands. It is never a live link here:
 *               /profile is gated, and a signed-in affordance shown before
 *               the probe answers is the 2026-06-05 phantom-login mistake.
 *   authed    → the real link.
 */
export function navEntries(chrome: AuthChrome, seasonHref: string): NavEntry[] {
  const myList: NavEntry[] =
    chrome === "anonymous"
      ? []
      : [{ ...link("myList", "/profile"), placeholder: chrome !== "authed" }];

  return [
    link("home", "/"),
    link("schedule", "/calendar"),
    // Any season is the 季度 section, not only the live one the link targets.
    link("season", seasonHref, "/seasonal"),
    { key: "genres", href: "/genre", section: "/genre", kind: "menu", placeholder: false },
    ...myList,
    link("about", "/welcome"),
  ];
}

/**
 * Whether `pathname` is inside `entry`'s section.
 *
 * Compares the path WITHOUT its locale prefix: the hrefs are written bare, and
 * matching the raw pathname is what left the old bar with no current link and
 * no aria-current anywhere under /en.
 */
export function isCurrent(pathname: string, entry: Pick<NavEntry, "section">): boolean {
  return isUnder(pathname, entry.section);
}

/** Whether a locale-prefixed `pathname` is `section` or below it. */
export function isUnder(pathname: string, section: string): boolean {
  const { path } = splitLocale(pathname);
  if (section === "/") return path === "/";
  return path === section || path.startsWith(`${section}/`);
}

export interface GenreNavItem {
  readonly genre: FilterGenre;
  readonly href: string;
  readonly label: string;
}

/**
 * The genre hubs, labelled in the reader's language.
 *
 * There is no genre index page; this list — the 分类 dropdown on a desktop,
 * the expandable group in the phone drawer — is the index. FILTER_GENRES is
 * the browsable subset (no adult genre), the same set /search offers as chips.
 */
export function genreNavItems(lang: Lang): GenreNavItem[] {
  return FILTER_GENRES.map((genre) => ({
    genre,
    href: genrePath(genre),
    label: genreLabel(genre, lang),
  }));
}
