// Which settings section the index marks as the one being read. The decision
// is here, pure, so it can be tested without a browser; useSectionSpy feeds
// it from an IntersectionObserver.

/** The page's sections, top to bottom; each is also its element id and #anchor. */
export const SETTINGS_SECTIONS = ["pass", "account", "devices", "privacy", "playback"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Pixels short of the true bottom that still count as scrolled to the end. */
const END_SLACK_PX = 2;

/**
 * Scrolled as far down as the page goes. A page too short to scroll is never
 * at its end, or the last section would be marked before anyone moved.
 */
export function isScrolledToEnd(scrollY: number, viewportHeight: number, documentHeight: number): boolean {
  if (documentHeight - viewportHeight <= END_SLACK_PX || scrollY <= 0) return false;
  return scrollY + viewportHeight >= documentHeight - END_SLACK_PX;
}

/**
 * The section to mark: the last one once the page is scrolled to its end
 * (it is often too short to ever climb into the band), else the first one in
 * the band, else null — between two sections, keep whatever is marked.
 */
export function pickSection<T extends string>(
  ids: readonly T[],
  inBand: ReadonlySet<string>,
  atEnd: boolean,
): T | null {
  if (atEnd && ids.length > 0) return ids[ids.length - 1];
  return ids.find((id) => inBand.has(id)) ?? null;
}
