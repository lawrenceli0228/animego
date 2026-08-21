// Pure logic behind EpisodesGrid.tsx, split out so bun:test can reach it
// without rendering the client component — same split as
// episodeDiscussionState.ts and continueWatchingState.ts next door.

import type { DetailEpisodeTitle } from "@/lib/types";

/**
 * What the episode grid is allowed to draw, and where the number came from.
 *
 * A string discriminant rather than an `isInferred: boolean` on a single
 * shape: tsconfig runs with `strict: false`, and a boolean-literal member
 * does not narrow a union under it — both arms would stay visible in every
 * branch, so `total` would still typecheck on the case that has no total.
 * `kind` narrows either way.
 */
export type EpisodeSkeleton =
  | { kind: "authoritative"; total: number }
  | { kind: "inferred"; total: number }
  | { kind: "pending" };

/**
 * The largest episode number the titles actually carry.
 *
 * Deliberately NOT `episodeTitles.length`. The array is sparse by design
 * (see AnimeDetail.episodeTitles): the Bangumi enrichment pass writes one row
 * per episode it managed to fetch, so a partial pass leaves holes. Nine rows
 * numbered 1-8 and 12 is still nine rows, and a grid sized 9 would cut off
 * everything past it — including, for a show mid-season, the episode the
 * reader came for. Counting rows answers "how many titles do we hold", which
 * is a different question.
 *
 * Non-integers are floored: the grid draws whole cells, so a `.5` special
 * belongs inside the preceding episode's row rather than adding one after it.
 * Rows that are not usable episode numbers at all are skipped rather than
 * defaulted — this array arrives as parsed JSON over the wire, and one
 * malformed row should cost its own cell, not the whole section.
 */
function highestEpisode(
  rows: ReadonlyArray<Pick<DetailEpisodeTitle, "episode">>,
): number {
  let highest = 0;
  for (const row of rows) {
    const episode = row?.episode;
    if (typeof episode !== "number" || !Number.isFinite(episode)) continue;
    const drawable = Math.floor(episode);
    if (drawable > highest) highest = drawable;
  }
  return highest;
}

/**
 * How many cells the grid should draw, and how far the number can be trusted.
 *
 * The failure this replaces: the grid opened with
 * `if (!episodes || episodes <= 0) return null`, so a title whose catalogue
 * episode count is NULL lost its entire episode section. Nobody reads a
 * missing section as "the count is not known yet" — they read it as "this
 * show has no episodes", which is the opposite of true. A show still airing
 * is exactly the case with no confirmed total upstream, so the titles losing
 * the section are the ones whose readers are most likely to be mid-watch.
 *
 * Three outcomes rather than a bare number, because the caller has to say
 * something different in each case and `0` cannot carry the difference:
 *
 *   authoritative  the count came from the catalogue. Draw it, and publish
 *                  it — the detail page's badge prints this number.
 *   inferred       no count, but episode titles exist, so at least this many
 *                  episodes do. Draw the grid; do NOT print the number as a
 *                  total, because it is a floor rather than a fact.
 *   pending        nothing to size a grid from. The caller renders the "count
 *                  not known yet" copy — never `null`.
 */
export function resolveEpisodeSkeleton(
  episodes: number | null,
  episodeTitles: ReadonlyArray<Pick<DetailEpisodeTitle, "episode">>,
): EpisodeSkeleton {
  // Unchanged from the guard this replaces, and it has to stay that way:
  // every title with a real count renders the grid it rendered before.
  if (typeof episodes === "number" && episodes > 0) {
    return { kind: "authoritative", total: episodes };
  }
  const highest = highestEpisode(episodeTitles ?? []);
  return highest > 0
    ? { kind: "inferred", total: highest }
    : { kind: "pending" };
}
