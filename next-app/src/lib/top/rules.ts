// Which shows a ranking counts, as the API ranks them (go-api
// internal/anime/top.go): not adult, rated, tracked by at least a thousand
// AniList users — below that an average rests on a handful of ratings — and
// not a music video. The detail page asks the same question of one show to
// know whether its year's ranking is a page that exists.
//
// Pure: no React, no DOM.

/** How many AniList users must track a show before it is ranked. */
export const TOP_MIN_POPULARITY = 1000;

/** Most shows a ranking lists. */
export const TOP_SIZE = 100;

export interface RankableFacts {
  isAdult?: boolean | null;
  averageScore?: number | null;
  popularity?: number | null;
  format?: string | null;
}

/** Whether the rankings count this show. Unknown facts count against it. */
export function isRankable(show: RankableFacts): boolean {
  return (
    show.isAdult !== true &&
    typeof show.averageScore === "number" &&
    show.averageScore > 0 &&
    typeof show.popularity === "number" &&
    show.popularity >= TOP_MIN_POPULARITY &&
    show.format !== "MUSIC"
  );
}
