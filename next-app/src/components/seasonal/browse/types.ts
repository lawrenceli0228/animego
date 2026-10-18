// Shapes shared across the browse tree.

import type { ComponentType } from "react";

/** Where a follow button sits: a cover's corner, or a chart card's footer. */
export type FollowVariant = "cover" | "chart";

export interface FollowSlotProps {
  anilistId: number;
  /** Already language-resolved; used in the accessible name. */
  title: string;
  variant: FollowVariant;
}

/**
 * The follow control, passed in rather than imported by the cards.
 *
 * The real one (FollowButton) runs the site's subscribe flow, which pulls in
 * react-hot-toast — and that touches `document` while its module loads, so a
 * render test of the cards could not import them. The page passes
 * FollowButton; the render tests pass a stub.
 */
export type FollowSlot = ComponentType<FollowSlotProps>;

/** A season/year link was followed: the route is changing to it. */
export interface SeasonTarget {
  season: string;
  year: number;
}
