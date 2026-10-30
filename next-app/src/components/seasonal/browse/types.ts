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

/**
 * A show's place in a ranking (the top-100 pages), as its card draws it: the
 * number on the cover, the chart card's corner or the row's left column, and
 * what is read and shown around it. Absent everywhere else.
 */
export interface RankMark {
  /** 1 for the first. */
  n: number;
  /** "第 3 名": read before the title, never shown. */
  label: string;
  /** A phone cover's line under the title, beside the score: the year, or on a year's page the season. */
  meta: string;
  /** The chart card's first line: when the show is from. */
  when: string;
  /** The chart card's second line: its format and length. */
  info: string;
  /** A phone row's line under the title: when, then format and length. */
  sub: string;
}
