// Shapes shared across the genre page's client tree.

import type { FilterGenre } from "@/lib/contentLabels";
import type { GridView } from "@/lib/genre/views";
import type { Lang } from "@/lib/i18n/lang";
import type { AiringVariant } from "@/lib/seasonal/display";
import type { ZoneOffset } from "@/lib/seasonal/clock";
import type { Layout } from "@/lib/seasonal/batch";
import type { SeasonalItem } from "@/lib/seasonal/model";
import type { BrowseCopy } from "@/components/seasonal/browse/useBrowseCopy";
import type { FollowSlot } from "@/components/seasonal/browse/types";

/**
 * A link inside the page was followed and its view is on the way. The page
 * shows that view's header at once — the genre pressed in the strip, the
 * grid's heading and count — and its skeleton below.
 */
export type PendingTarget =
  | { kind: "hub"; genre: FilterGenre }
  | { kind: "grid"; view: GridView; count: number | null };

/** "Open this grid view": what a rail, a tile or the ranking says when its link is followed. */
export type OpenGrid = (view: GridView, count: number | null) => void;

/** What every cover card on the page needs besides its show. */
export interface CardEnv {
  nowMs: number;
  zone: ZoneOffset;
  lang: Lang;
  copy: BrowseCopy;
  Follow: FollowSlot;
  layout: Layout;
  /** The genre cards' airing line (lib/genre/display.ts), bound to the language. */
  airing: (item: SeasonalItem, nowMs: number, variant: AiringVariant) => string;
}
