// The detail page's tabs. Each is its own route under /anime/[id] — a URL
// that can be shared, indexed and opened directly — and the tab bar is drawn
// from this list.
//
// Adding a tab (社区 is next) is one entry here, its label in the
// dictionaries (detail.tab*) and in DetailTabs' TAB_LABEL, and its page.

export type DetailTabKey = "overview" | "characters" | "staff";

export interface DetailTabDef {
  key: DetailTabKey;
  /** The path segment after /anime/:id; "" for the overview. */
  segment: string;
}

export const DETAIL_TABS: readonly DetailTabDef[] = [
  { key: "overview", segment: "" },
  { key: "characters", segment: "characters" },
  { key: "staff", segment: "staff" },
];

/** The count beside a tab's name, where it has one. */
export type DetailTabCounts = Partial<Record<DetailTabKey, number | null>>;

export function detailTabHref(anilistId: number, key: DetailTabKey): string {
  const tab = DETAIL_TABS.find((t) => t.key === key);
  const base = `/anime/${anilistId}`;
  return tab?.segment ? `${base}/${tab.segment}` : base;
}
