// The tab bar under the hero: 概览 / 角色 N / 制作 N.
//
// Links, not buttons: every tab is a route of its own (lib/detail/tabs.ts),
// so a tab can be opened in a new window, shared, and crawled, and the
// active one is decided by the page that renders the bar — server-side, with
// no pathname to read on the client.
//
// scroll={false}: a tab switch keeps the reader where they are. The hero is
// the same height on every tab at desktop widths, so the bar they clicked
// stays under the pointer and the new list appears below it, which is what
// switching a tab should feel like. Where the heights differ (a phone),
// TabsInView brings the bar back into view, and it puts focus back on the
// chosen tab. prefetch={false} like the rest of this page's links: a crawl
// renders these pages by the thousand, and a prefetch per tab per visit
// would multiply the renders for nobody.

import Link from "@/components/ui/LocaleLink";
import type { Dict } from "@/lib/i18n";
import { DETAIL_TABS, detailTabHref, type DetailTabCounts, type DetailTabKey } from "@/lib/detail/tabs";
import TabsInView from "./TabsInView";
import s from "./DetailTabs.module.css";

/** The bar's id, for TabsInView and for anything that links to the tabs. */
export const DETAIL_TABS_ID = "detail-tabs";

/** Each tab's name. A new tab adds its line here and its key to the dictionaries. */
const TAB_LABEL: Record<DetailTabKey, (dict: Dict) => string> = {
  overview: (dict) => dict.detail.tabOverview,
  characters: (dict) => dict.detail.tabCharacters,
  staff: (dict) => dict.detail.tabStaff,
};

export default function DetailTabs({
  anilistId,
  active,
  counts,
  dict,
}: {
  anilistId: number;
  active: DetailTabKey;
  counts: DetailTabCounts;
  dict: Dict;
}) {
  return (
    <nav className={s.bar} aria-label={dict.detail.tabsAria} id={DETAIL_TABS_ID}>
      <TabsInView targetId={DETAIL_TABS_ID} />
      <div className={`container ${s.row}`}>
        {DETAIL_TABS.map((tab) => {
          const isActive = tab.key === active;
          const count = counts[tab.key];
          return (
            <Link
              key={tab.key}
              href={detailTabHref(anilistId, tab.key)}
              className={s.tab}
              aria-current={isActive ? "page" : undefined}
              data-active={isActive ? "true" : undefined}
              prefetch={false}
              scroll={false}
            >
              {TAB_LABEL[tab.key](dict)}
              {/* A real space, so the link's name reads 「角色 100」, not 「角色100」;
                  the flex gap draws the visible one. */}
              {typeof count === "number" ? <> <span className={s.count}>{count}</span></> : null}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
